// GBA-specific tools: decoded registers, the layer view, display-mistake checks,
// save-type detection, LZ77 (checked against the BIOS decompressor) and BMP output.
//
//   node tests/gba.mjs   (exit 0 = pass, 1 = fail)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from '../mcp-server.mjs';
import { EmuHarness } from '../driver.mjs';
import { decodePng } from '../png.mjs';
import { decodeIo, formatDisplay, renderLayers, gbaDisplayIssues, gbaSaveType } from '../gba.mjs';
import { lz77Compress, lz77Decompress } from '../lz77.mjs';
import { encodeIndexedBmp } from '../bmp.mjs';
import { convertSprite, writeSpriteSource } from '../sprite.mjs';
import { convertBackground, writeBackgroundSource } from '../background.mjs';
import { TEMPLATES } from '../templates.mjs';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HARNESS, '..');
const FIX = path.join(HARNESS, 'tests', 'fixtures');
const OUT = path.join(HARNESS, 'out', 'gba-test');
const GBA_C = path.join(FIX, 'templates', 'gba-c', 'hello.gba');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// ---- LZ77 ----
{
  const inputs = { random: randomBytes(3000), zeros: Buffer.alloc(5000), text: Buffer.from('abcabcabcabd'.repeat(300)), tiny: Buffer.from([1, 2]), empty: Buffer.alloc(0) };
  for (const [k, v] of Object.entries(inputs)) {
    const c = lz77Compress(v);
    ok(`LZ77 round trip: ${k}`, lz77Decompress(c).equals(v) && c.length % 4 === 0 && c[0] === 0x10);
  }
  // VRAM-safe: no match may copy from 1 byte back.
  const c = lz77Compress(Buffer.alloc(64, 7));
  let safe = true;
  for (let i = 4, o = 0; o < 64;) {
    const flags = c[i++];
    for (let bit = 7; bit >= 0 && o < 64; bit--) {
      if (flags & (1 << bit)) { const v = (c[i] << 8) | c[i + 1]; i += 2; if ((v & 0xfff) === 0) safe = false; o += (v >> 12) + 3; } else { i++; o++; }
    }
  }
  ok('LZ77 is VRAM-safe (no distance-1 matches)', safe);
  ok('LZ77 shrinks repetitive data', lz77Compress(Buffer.alloc(9000)).length < 1200);
}

// ---- BMP ----
{
  const bmp = encodeIndexedBmp({ width: 16, height: 8, pixels: Uint8Array.from({ length: 128 }, (_, i) => i % 16), palette: [[255, 0, 255], [10, 20, 30]], bpp: 4 });
  ok('BMP 4bpp header (40-byte info, 16 colours, bottom-up)', bmp.toString('latin1', 0, 2) === 'BM' && bmp.readUInt32LE(14) === 40 && bmp.readUInt16LE(28) === 4 && bmp.readUInt32LE(46) === 16 && bmp.readInt32LE(22) === 8);
  ok('BMP 4bpp: high nibble is the left pixel', bmp[bmp.readUInt32LE(10)] === 0x01);
  const conv = convertSprite(await readFile(path.join(REPO, 'templates', 'gba-butano', 'assets', 'player.png')), { target: 'gba4', transparent: '#ff00ff' });
  const files = await writeSpriteSource(conv, path.join(OUT, 'player.bmp'), 'player', { compress: 'lz77' });
  const json = JSON.parse(await readFile(path.join(OUT, 'player.json'), 'utf8'));
  ok('sprite .bmp + Butano json', files.length === 2 && json.type === 'sprite' && json.height === 16 && json.compression === 'lz77');
  ok('sprite .bmp matches the committed Butano starter art', (await readFile(path.join(OUT, 'player.bmp'))).equals(await readFile(path.join(REPO, 'templates', 'gba-butano', 'graphics', 'player.bmp'))));
  const bg = convertBackground(await readFile(path.join(REPO, 'templates', 'gba-c', 'assets', 'font.png')), { target: 'gba4', dedupe: false });
  await writeBackgroundSource(bg, path.join(OUT, 'bg.bmp'), 'bg');
  ok('background .bmp + regular_bg json', JSON.parse(await readFile(path.join(OUT, 'bg.json'), 'utf8')).type === 'regular_bg');
  const lzc = await writeBackgroundSource(bg, path.join(OUT, 'bg.c'), 'bg', { compress: 'lz77' });
  const h = await readFile(lzc[1], 'utf8');
  ok('background C with LZ77 tiles + map', h.includes('#define BG_LZ77 1') && h.includes('BG_TILES_SIZE 3072'));
  let err = '';
  try { await writeSpriteSource(convertSprite(await readFile(path.join(REPO, 'templates', 'gb-asm', 'assets', 'player.png')), { target: 'gb', transparent: '#ffffff' }), path.join(OUT, 'x.c'), 'x', { compress: 'lz77' }); } catch (e) { err = e.message; }
  ok('LZ77 refused for GB targets', /GBA/.test(err));
}

// ---- Save type ----
ok('save type from the ID string', gbaSaveType(Buffer.from('....SRAM_V113....')) === 'SRAM' && gbaSaveType(Buffer.from('xxFLASH1M_V102')) === 'Flash 128 KB' && gbaSaveType(Buffer.from('none')) === null);

// ---- Registers, layers, display checks (library) ----
{
  const e = await EmuHarness.launch(GBA_C, { reuse: true });
  await e.waitFrames(30);
  let r = await e.readRegions();
  const d = decodeIo(r.io);
  ok('decodeIo: mode 0, BG0 + 1D sprites', d.mode === 0 && d.bgs[0].on && !d.bgs[1].on && d.obj.on && d.obj.oneD && d.bgs[0].screenBase === 31);
  ok('decodeIo: VBlank interrupt', d.irq.ime && d.irq.ie.includes('vblank') && d.dispstat.vblankIrq);
  ok('formatDisplay names the map block', formatDisplay(d).some((l) => l.includes('map screen block 31 (0x600f800)')));
  const layers = renderLayers(r);
  ok('renderLayers: BG0-3 + OBJ', layers.map((l) => l.name).join() === 'BG0,BG1,BG2,BG3,OBJ');
  const px = (png, x, y) => { const i = decodePng(png); const o = (y * i.width + x) * i.channels; return [i.data[o], i.data[o + 1], i.data[o + 2]]; };
  const obj = layers[4].png, bg0 = layers[0].png;
  ok('OBJ layer has the player and BG0 does not', px(obj, 120, 72).join() !== px(obj, 5, 5).join() && px(bg0, 120, 72).join() === px(bg0, 4, 4).join());
  ok('clean starter: no display issues', gbaDisplayIssues(r).length === 0);
  await e.writeU16(0x04000008, 1 << 8);                                   // map inside its tiles
  await e.writeU16(0x07000000, (await e.readU16(0x07000000)) | 0x100);    // affine, matrix 0 = zero
  for (let i = 0; i < 16; i++) await e.writeU16(0x05000200 + i * 2, 0);   // OBJ palette 0 black
  await e.writeU16(0x04000000, (1 << 8) | (1 << 12));                     // 2D mapping
  r = await e.readRegions();
  const keys = gbaDisplayIssues(r).map((f) => f.key).sort().join();
  ok('display issues: overlap, 2D mapping, black palette, zero affine', keys === 'aff0,obj2d,objpal0,overlap00', keys);
  await e.close();
}

// ---- Same, end to end ----
const { server, close } = createServer({ root: OUT });
const client = new Client({ name: 'test', version: '0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);
/** @returns {Promise<any>} */
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
try {
  await call('load_rom', { rom: GBA_C });
  await call('wait_frames', { frames: 20 });
  let r = await call('view_vram', { what: 'layers' });
  const img = r.content.find((c) => c.type === 'image');
  const sheet = img && decodePng(Buffer.from(img.data, 'base64'));
  ok('view_vram layers: sheet of 5 layers + decoded display', !!sheet && sheet.width === 3 * 240 + 4 && /BG0, BG1 \(off\), BG2 \(off\), BG3 \(off\), OBJ/.test(textOf(r)) && textOf(r).includes('BG0 on'), textOf(r).split('\n')[0]);
  r = await call('describe', { io: true });
  ok('describe io: display + system registers', /mode 0 · sprites on, 1D/.test(textOf(r)) && /interrupts: IME on · enabled vblank/.test(textOf(r)) && /waitcnt 0x0000/.test(textOf(r)), textOf(r));
  r = await call('check', { frames: 30 });
  ok('check: clean GBA starter (header + save type line)', /^No errors/.test(textOf(r)) && textOf(r).includes('save type none declared'), textOf(r));
  await call('write_memory', { address: '0x04000008', value: 1 << 8, as: 'u16' });
  r = await call('check', { frames: 5 });
  ok('check: map/tile overlap reported as an error', /ERROR: BG0's tiles .* overlap BG0's map/.test(textOf(r)), textOf(r));
  await call('load_rom', { rom: path.join(FIX, 'templates', 'gb-asm', 'hello.gb') });
  await call('wait_frames', { frames: 20 });
  r = await call('describe', { io: true });
  ok('describe io on GB: LCDC and interrupts', /LCDC 0x97: LCD on · BG on map 0x9800 tiles 0x8000/.test(textOf(r)) && /enabled vblank/.test(textOf(r)), textOf(r));
  r = await call('view_vram', { what: 'layers' });
  ok('view_vram layers refused on GB', !!r.isError);
} finally {
  await client.close();
  await close();
}

// ---- LZ77 through the real BIOS call ----
// font-lz77.gba is the gba-c starter loading its font with LZ77UnCompVram from
// data written by writeSpriteSource({ compress: 'lz77' }).
{
  const a = await EmuHarness.launch(path.join(FIX, 'lz77', 'font-lz77.gba'), { reuse: true });
  const b = await EmuHarness.launch(GBA_C, { reuse: true });
  await a.waitFrames(30); await b.waitFrames(30);
  ok('BIOS LZ77UnCompVram rebuilds the exact font tiles', (await a.readMemory(0x06000400, 3072)).equals(await b.readMemory(0x06000400, 3072)));
  await a.close(); await b.close();
}

ok('templates include the GBA starters', ['gba-c', 'gba-tonc', 'gba-butano'].every((t) => TEMPLATES[t]));

await EmuHarness.shutdown();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
