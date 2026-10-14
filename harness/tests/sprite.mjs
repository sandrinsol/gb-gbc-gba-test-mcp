// Sprite pipeline: PNG decoding of every PNG flavour, PNG → tile conversion for
// each target (checked by decoding the tiles back), source output (compiled with
// a C compiler when one is installed), hot-swap into running GBA / DMG / GBC
// games (read back from VRAM and seen on screen), overlay, and hardware limits.
//
//   node tests/sprite.mjs   (exit 0 = pass, 1 = fail)

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmuHarness } from '../driver.mjs';
import { decodePng, encodePng } from '../png.mjs';
import { convertSprite, writeSpriteSource, injectSprite, renderSprite, framePng, overlayFrame, spriteLimitWarnings, from555 } from '../sprite.mjs';
import { gbaSprites, gbSprites } from '../video.mjs';
import { makeVblankGbRom, makeCgbRom } from './gb-roms.mjs';

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve('out', 'sprite-test');
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// ---- PNG decoding (fixtures made with Pillow; expected RGBA alongside) ----
{
  const dir = path.join(HERE, 'fixtures', 'png');
  const expected = JSON.parse(await readFile(path.join(dir, 'expected.json'), 'utf8'));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.png'))) {
    const im = decodePng(await readFile(path.join(dir, f)));
    const bad = expected[f].filter((p, i) => {
      const o = i * im.channels, a = im.channels === 4 ? im.data[o + 3] : 255;
      return a !== p[3] || (a > 0 && [0, 1, 2].some((c) => im.data[o + c] !== p[c]));
    }).length;
    ok(`decodePng ${f}`, bad === 0, bad ? `${bad} pixels differ` : '');
  }
}

// ---- Test art: 16x16, transparent background, up to 4 colours ----
const art = (colors, w = 16, h = 16) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = null;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c = colors[0];
    else if (x === y) c = colors[1];
    else if (x + y === w - 1) c = colors[2 % colors.length];
    else if (x < 4 && y > h - 6) c = colors[3 % colors.length];
    if (c) { data.set(c, (y * w + x) * 4); data[(y * w + x) * 4 + 3] = 255; }
  }
  return encodePng({ width: w, height: h, data, channels: 4 });
};
const RGBY = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
const GREYS = [[0, 0, 0], [96, 96, 96], [176, 176, 176]];

// Unpack converted tiles back to per-frame indices (row-major tiles).
const unpack = (c) => c.indices.map((_, f) => {
  const idx = new Uint8Array(c.width * c.height), bpp = { gba4: 4, gba8: 8, gbc: 2, gb: 2 }[c.target], tb = bpp * 8;
  for (let t = 0; t < c.tilesPerFrame; t++) {
    const tx = (t % (c.width / 8)) * 8, ty = Math.floor(t / (c.width / 8)) * 8, o = (f * c.tilesPerFrame + t) * tb;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      let v;
      if (bpp === 4) { const b = c.tiles[o + y * 4 + (x >> 1)]; v = x & 1 ? b >> 4 : b & 15; }
      else if (bpp === 8) v = c.tiles[o + y * 8 + x];
      else v = ((c.tiles[o + y * 2] >> (7 - x)) & 1) | (((c.tiles[o + y * 2 + 1] >> (7 - x)) & 1) << 1);
      idx[(ty + y) * c.width + tx + x] = v;
    }
  }
  return idx;
});

// ---- Conversion ----
{
  for (const target of /** @type {const} */ (['gba4', 'gba8', 'gbc'])) {
    const n = target === 'gbc' ? 3 : 4; // GBC sprites: 3 colours + transparent
    const c = convertSprite(art(RGBY.slice(0, n)), { target });
    ok(`${target}: ${n} colours + transparent`, c.palette.length === n && c.frames === 1 && c.tilesPerFrame === 4);
    ok(`${target}: tiles decode back to the art`, unpack(c)[0].every((v, i) => v === c.indices[0][i]));
    ok(`${target}: colours in BGR555`, from555(c.palette[0]).join() === '255,0,0' && from555(c.palette[2]).join() === '0,0,255');
  }
  const g = convertSprite(art(GREYS, 8, 16), { target: 'gb' });
  ok('gb: shades + OBP value', g.palette.join() === '3,2,1' && g.obp === ((3 << 2) | (2 << 4) | (1 << 6)), `palette ${g.palette} obp ${g.obp.toString(16)}`);
  ok('gb: tiles decode back', unpack(g)[0].every((v, i) => v === g.indices[0][i]));

  const sheet = encodePng({ width: 32, height: 16, data: Buffer.concat([...Array(16)].map((_, y) => Buffer.concat([...Array(32)].map((__, x) => Buffer.from(x < 16 ? (x === y ? [255, 0, 0, 255] : [0, 0, 0, 0]) : (x - 16 === 15 - y ? [0, 0, 255, 255] : [0, 0, 0, 0])))))), channels: 4 });
  const s2 = convertSprite(sheet, { target: 'gba4', width: 16, height: 16 });
  ok('sprite sheet -> frames', s2.frames === 2 && s2.palette.length === 2 && s2.indices[1][15] === 2);
  ok('preview is one image of all frames', decodePng(s2.previewPng).width > 32);

  const rainbow = encodePng({ width: 8, height: 8, data: new Uint8Array(64 * 3).map((_, i) => (i * 37) & 255) });
  let err = '';
  try { convertSprite(rainbow, { target: 'gba4' }); } catch (e) { err = e.message; }
  ok('too many colours is an error', /colours, but gba4/.test(err), err);
  const q = convertSprite(rainbow, { target: 'gba4', quantize: true });
  ok('quantize reduces to 15', q.palette.length <= 15 && q.warnings.some((w) => /reduced/.test(w)));
  ok('odd GBA size warns', convertSprite(art(RGBY, 24, 8), { target: 'gba4' }).warnings.some((w) => /not a GBA sprite size/.test(w)));
  ok('size must be a multiple of 8', (() => { try { convertSprite(art(RGBY, 12, 8), { target: 'gba4' }); return false; } catch { return true; } })());
  const keyed = convertSprite(encodePng({ width: 8, height: 8, data: new Uint8Array(64 * 3).fill(255) }), { target: 'gba4', transparent: '#ffffff' });
  ok('transparent colour key', keyed.palette.length === 0 && keyed.indices[0].every((v) => v === 0));
}

// ---- Source output ----
{
  const c = convertSprite(art(RGBY), { target: 'gba4' });
  const files = [
    ...(await writeSpriteSource(c, path.join(OUT, 'hero.h'), 'hero')),
    ...(await writeSpriteSource(c, path.join(OUT, 'hero.c'), 'hero')),
    ...(await writeSpriteSource(c, path.join(OUT, 'hero.s'), 'hero')),
    ...(await writeSpriteSource(convertSprite(art(GREYS, 8, 16), { target: 'gb' }), path.join(OUT, 'dot.asm'), 'dot')),
    ...(await writeSpriteSource(c, path.join(OUT, 'hero.bin'), 'hero')),
  ];
  ok('writes .h .c(+.h) .s .asm .bin', files.length === 7, files.map((f) => path.basename(f)).join(' '));
  ok('.bin tiles are the raw tiles', (await readFile(path.join(OUT, 'hero.tiles.bin'))).equals(c.tiles));
  ok('.asm has RGBDS labels + OBP', /dot_tiles::/.test(await readFile(path.join(OUT, 'dot.asm'), 'utf8')) && /DOT_OBP EQU/.test(await readFile(path.join(OUT, 'dot.asm'), 'utf8')));
  let cc = null;
  try { execFileSync('cc', ['--version'], { stdio: 'ignore' }); cc = 'cc'; } catch {}
  if (cc) {
    const main = path.join(OUT, 'main.c');
    await writeFile(main, '#include "hero.h"\nint main(void) { return hero_tiles[0] == 0 && hero_pal[1] == 0 ? 1 : 0; }\n');
    let compiled = true;
    try { execFileSync(cc, ['-Wall', '-Werror', '-Wno-unused-variable', '-fsyntax-only', main]); execFileSync(cc, ['-Wall', '-Werror', '-c', path.join(OUT, 'hero.c'), '-o', path.join(OUT, 'hero.o')]); } catch (e) { compiled = false; console.log(String(e.stderr || e)); }
    ok('generated C compiles', compiled);
  } else console.log('SKIP: C compile (no cc)');
}

// ---- Hot-swap into running games, read back, and on screen ----
async function injectCheck(name, rom, conv, { oam = 0, x = 40, y = 30 } = {}) {
  const emu = await EmuHarness.launch(rom, { reuse: true });
  await emu.waitFrames(120);
  const r = await injectSprite(emu, conv, { x, y, oam });
  await emu.waitFrames(1);
  const reg = await emu.readRegions();
  const s = (emu.system === 'gba' ? gbaSprites(reg) : gbSprites(reg, { cgb: !!reg.isCgbWram }))[oam];
  ok(`${name}: OAM entry`, s.x === x && s.y === y && s.w === conv.width && s.h === conv.height && s.onScreen, JSON.stringify({ x: s.x, y: s.y, w: s.w, h: s.h, tile: s.tile }));
  const back = decodePng(renderSprite(emu.system, reg, s)), want = decodePng(framePng(conv, conv.indices[0]));
  const idx = conv.indices[0];
  const readBad = idx.filter((v, i) => !!back.data[i * 4 + 3] !== !!v || (v && [0, 1, 2].some((c) => back.data[i * 4 + c] !== want.data[i * 3 + c]))).length;
  ok(`${name}: renderSprite reads it back`, readBad === 0, `${readBad} differ`);
  const shot = decodePng(await emu.screenshot());
  let seen = 0;
  idx.forEach((v, i) => {
    if (!v) return;
    const px = i % conv.width, py = Math.floor(i / conv.width), o = ((y + py) * shot.width + x + px) * shot.channels;
    if ([0, 1, 2].every((c) => Math.abs(shot.data[o + c] - want.data[i * 3 + c]) <= 8)) seen++;
  });
  ok(`${name}: drawn on screen`, seen === idx.filter(Boolean).length, `${seen}/${idx.filter(Boolean).length} pixels`);
  await emu.close();
  return r;
}
await writeFile(path.join(OUT, 'vblank.gb'), makeVblankGbRom());
await writeFile(path.join(OUT, 'cgb.gbc'), makeCgbRom());
await injectCheck('GBA 4bpp', '../anguna.gba', convertSprite(art(RGBY), { target: 'gba4' }), { oam: 127 });
await injectCheck('GBA 8bpp', '../anguna.gba', convertSprite(art(RGBY), { target: 'gba8' }), { oam: 126 });
const dmg = await injectCheck('DMG 8x16', path.join(OUT, 'vblank.gb'), convertSprite(art(GREYS, 8, 16), { target: 'gb' }));
ok('DMG: notes the switch to 8x16 sprites', dmg.notes.some((n) => /8x16/.test(n)));
await injectCheck('GBC 8x8', path.join(OUT, 'cgb.gbc'), convertSprite(art(RGBY.slice(0, 3), 8, 8), { target: 'gbc' }));
{
  const emu = await EmuHarness.launch(path.join(OUT, 'vblank.gb'), { reuse: true });
  await emu.waitFrames(30);
  const r = await injectSprite(emu, convertSprite(art(GREYS, 16, 8), { target: 'gb' }), { x: 20, y: 20, oam: 5 });
  ok('GB: a 16x8 frame uses 2 OAM entries', r.oamEntries === 2);
  let err = '';
  try { await injectSprite(emu, convertSprite(art(RGBY), { target: 'gba4' })); } catch (e) { err = e.message; }
  ok('GBA art into a GB game is refused', /can't go into/.test(err));
  await emu.close();
}

// ---- Overlay preview ----
{
  const conv = convertSprite(art(RGBY), { target: 'gba4' });
  const bg = encodePng({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 3).fill(10) });
  const out = decodePng(overlayFrame(bg, conv, 0, 8, 8));
  const at = (x, y) => [...out.data.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)].join();
  ok('overlay draws the sprite', at(8, 8) === '255,0,0' && at(10, 10) === '0,255,0');
  ok('overlay keeps the background behind transparency', at(10, 8 + 5) === '10,10,10' && at(0, 0) === '10,10,10');
}

// ---- Hardware limits ----
{
  const gbRegs = { io: Buffer.alloc(0x80) };
  const many = Array.from({ length: 12 }, (_, i) => ({ x: i * 8, y: 40, w: 8, h: 8, onScreen: true, affine: false }));
  const w = spriteLimitWarnings('gb', many, gbRegs);
  ok('GB: >10 sprites on a line warns', w.length === 1 && /lines 40-47: 12 sprites \(max 10\)/.test(w[0]), w[0]);
  ok('GB: 10 sprites is fine', spriteLimitWarnings('gb', many.slice(0, 10), gbRegs).length === 0);
  const io = Buffer.alloc(0x400); io.writeUInt16LE(0x1000, 0);
  const big = Array.from({ length: 20 }, () => ({ x: 0, y: 0, w: 64, h: 64, onScreen: true, affine: false }));
  ok('GBA: per-line cycle budget warns', /1280 sprite cycles \(max 1210\)/.test(spriteLimitWarnings('gba', big, { io })[0] || ''));
}

await EmuHarness.shutdown();
process.exit(failed ? 1 : 0);
