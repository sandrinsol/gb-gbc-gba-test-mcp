// Development tools: symbols, build (with a stand-in Makefile, so no toolchain is
// needed), describe/screen text, watch, hardware checks, background conversion,
// Tiled maps and new_project. Fixtures are the built starter templates.
//
//   node tests/devtools.mjs   (exit 0 = pass, 1 = fail)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFile, readFile, mkdir, rm, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../mcp-server.mjs';
import { decodePng, encodePng } from '../png.mjs';
import { compare } from '../assert.mjs';
import { loadSymbols, findSymbols, parseAddress } from '../symbols.mjs';
import { parseDiagnostics, formatDiagnostic } from '../build.mjs';
import { romHeaderIssues, RunChecker } from '../checks.mjs';
import { convertBackground, renderTiledMap } from '../background.mjs';
import { EmuHarness } from '../driver.mjs';
import { screenText, learnCharmap } from '../screentext.mjs';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(HARNESS, 'tests', 'fixtures', 'templates');
const OUT = path.join(HARNESS, 'out', 'devtools-test');
const REPO = path.resolve(HARNESS, '..');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// ---- Symbols ----
{
  const asm = await loadSymbols(await findSymbols(path.join(FIX, 'gb-asm', 'hello.gb')));
  ok('RGBDS .sym: variable', asm.resolve('wPlayerX') === 0xc0a0, String(asm.resolve('wPlayerX')));
  ok('RGBDS .sym: name+offset', asm.resolve('wPlayerX+1') === 0xc0a1);
  ok('RGBDS .sym: address → label+offset', asm.nameOf(asm.resolve('MainLoop') + 2) === 'MainLoop+2');
  const c = await loadSymbols(await findSymbols(path.join(FIX, 'gb-c', 'hello.gb')));
  ok('GBDK .noi: C name without the underscore', c.resolve('player_x') === c.resolve('_player_x') && c.resolve('player_x') >= 0xc000);
  ok('GBDK .noi: code symbols name addresses', c.nameOf(c.resolve('vsync') + 1) === '_vsync+1' || c.nameOf(c.resolve('vsync') + 1) === '_wait_vbl_done+1', String(c.nameOf(c.resolve('vsync') + 1)));
  const gba = await loadSymbols(await findSymbols(path.join(FIX, 'gba-c', 'hello.gba')));
  ok('ELF: variable in IWRAM', gba.resolve('player_x') === 0x03000000, String(gba.resolve('player_x')));
  ok('ELF: function size bounds the lookup', gba.nameOf(gba.resolve('main') + 4)?.startsWith('main+'));
  ok('parseAddress: hex still wins over names', parseAddress('0xc0a0', asm) === 0xc0a0 && parseAddress('wPlayerY', asm) === 0xc0a1);
  let threw = '';
  try { parseAddress('nope', asm); } catch (e) { threw = e.message; }
  ok('parseAddress: unknown name names the symbol file', threw.includes('hello.sym'), threw);
}

// ---- Diagnostics ----
{
  const out = `error: src/main.asm(12):
    syntax error, unexpected newline
error: main.asm(3): Unknown symbol "Nowhere"
src/main.c:2: error 20: Undefined identifier 'y'
src/main.c:2: warning 112: function 'foo' implicit declaration
game.c:1:25: error: 'y' undeclared (first use in this function)
/usr/bin/arm-none-eabi-ld: /tmp/x.o: in function \`main':
main.c:(.text+0x8): undefined reference to \`g'
collect2: error: ld returned 1 exit status
make: *** [Makefile:3: all] Error 1`;
  const d = parseDiagnostics(out).map(formatDiagnostic);
  ok('diagnostics: RGBDS message on the next line', d[0] === 'src/main.asm:12: error: syntax error, unexpected newline', d[0]);
  ok('diagnostics: SDCC error and warning', d.includes("src/main.c:2: error: Undefined identifier 'y'") && d.includes("src/main.c:2: warning: function 'foo' implicit declaration"));
  ok('diagnostics: GCC with column', d.includes("game.c:1:25: error: 'y' undeclared (first use in this function)"));
  ok('diagnostics: linker undefined reference', d.includes('main.c: error: undefined reference to "g"'), d.join(' | '));
  ok('diagnostics: no noise lines', d.length === 6, String(d.length));
}

// ---- ROM header checks ----
{
  const gb = await readFile(path.join(FIX, 'gb-asm', 'hello.gb'));
  ok('header: template GB ROM valid', romHeaderIssues(gb, 'gb').every((f) => f.level === 'ok'), JSON.stringify(romHeaderIssues(gb, 'gb')));
  const bad = Buffer.from(gb); bad[0x14d] ^= 0xff; bad[0x105] = 0;
  const issues = romHeaderIssues(bad, 'gb').filter((f) => f.level === 'error').map((f) => f.msg).join('; ');
  ok('header: GB logo + checksum errors', /logo/.test(issues) && /checksum 0x14D/.test(issues), issues);
  const big = Buffer.alloc(65536); gb.copy(big);
  ok('header: ROM ONLY cart over 32 KB', romHeaderIssues(big, 'gb').some((f) => /need an MBC/.test(f.msg)));
  const gba = await readFile(path.join(FIX, 'gba-c', 'hello.gba'));
  ok('header: template GBA ROM valid (gbafix)', romHeaderIssues(gba, 'gba').every((f) => f.level === 'ok'));
  ok('header: anguna.gba valid', romHeaderIssues(await readFile(path.join(REPO, 'anguna.gba')), 'gba').every((f) => f.level === 'ok'));
  const gbaBad = Buffer.from(gba); gbaBad[0xbd] ^= 1; gbaBad.fill(0, 4, 20);
  ok('header: GBA logo + complement errors', romHeaderIssues(gbaBad, 'gba').filter((f) => f.level === 'error').length === 2);
}

// ---- Screen text (library) ----
{
  for (const [t, rom, want] of [['gb-c', 'hello.gb', 'HELLO FROM GBDK!'], ['gba-c', 'hello.gba', 'HELLO, GAME BOY ADVANCE!']]) {
    const e = await EmuHarness.launch(path.join(FIX, t, rom), { reuse: true });
    await e.waitFrames(30);
    const r = await e.readRegions();
    const text = screenText(e.system, r, 'ascii').flatMap((l) => l.lines.map((x) => x.trim()));
    ok(`screen text: ${t}`, text.includes(want) && text.includes('D-PAD TO MOVE'), JSON.stringify(text));
    ok(`learn charmap: ${t}`, learnCharmap(e.system, r, 'MOVE')?.first === 32);
    // Lag detection: a frame counter that doesn't advance on one frame.
    const chk = new RunChecker(e.system, { frameCounter: 0, counterWidth: 1 });
    const cpu = await e.readCpu();
    for (const v of [1, 2, 2, 3]) chk.observe(r, cpu, Buffer.from([v]));
    ok(`run checks: one lag frame counted (${t})`, chk.findings().some((f) => /^1 of 3 frames lagged/.test(f.msg)), JSON.stringify(chk.findings()));
    await e.close();
  }
}

// ---- Background conversion + Tiled ----
const font = await readFile(path.join(REPO, 'templates', 'gb-asm', 'assets', 'font.png'));
{
  for (const t of ['gb', 'gbc', 'gba4', 'gba8']) {
    const c = convertBackground(font, { target: t, dedupe: false });
    ok(`background ${t}: font round-trips`, c.tileCount === 96 && compare(font, c.previewPng, { tolerance: 8 }).fraction === 0);
  }
  // A picture made of one tile and its mirror images reuses one tile on GBC/GBA.
  const tile = decodePng(convertBackground(font, { target: 'gb', dedupe: false }).previewPng);
  const W = 16, H = 16, data = new Uint8Array(W * H * 3);
  // The 'F' glyph (asymmetric) and its three mirror images.
  const gx = (('F'.charCodeAt(0) - 32) % 16) * 8, gy = Math.floor(('F'.charCodeAt(0) - 32) / 16) * 8;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const s = ((gy + y) * tile.width + gx + x) * tile.channels;
    for (const [dx, dy] of [[x, y], [15 - x, y], [x, 15 - y], [15 - x, 15 - y]]) {
      const o = (dy * W + dx) * 3; data[o] = tile.data[s]; data[o + 1] = tile.data[s + 1]; data[o + 2] = tile.data[s + 2];
    }
  }
  const mirrored = encodePng({ width: W, height: H, data });
  const c = convertBackground(mirrored, { target: 'gba4' });
  ok('background: mirrored tiles merged', c.tileCount === 1 && c.flipped === 3 && compare(mirrored, c.previewPng, { tolerance: 8 }).fraction === 0, `${c.tileCount} tiles, ${c.flipped} flipped`);
  ok('background: DMG has no flips', convertBackground(mirrored, { target: 'gb' }).tileCount === 4);
  let err = '';
  try { convertBackground(Buffer.from(encodePng({ width: 12, height: 8, data: new Uint8Array(12 * 8 * 3) })), { target: 'gb' }); } catch (e) { err = e.message; }
  ok('background: size must be a multiple of 8', /multiples of 8/.test(err), err);

  // Tiled map (JSON) with a flipped tile, using the font sheet as an 8x8 tileset.
  await copyFile(path.join(REPO, 'templates', 'gb-asm', 'assets', 'font.png'), path.join(OUT, 'font.png'));
  const gid = (ch) => ch.charCodeAt(0) - 32 + 1;
  await writeFile(path.join(OUT, 'map.tmj'), JSON.stringify({
    width: 3, height: 1, tilewidth: 8, tileheight: 8, infinite: false,
    tilesets: [{ firstgid: 1, image: 'font.png', imagewidth: 128, imageheight: 48, tilewidth: 8, tileheight: 8, columns: 16, margin: 0, spacing: 0 }],
    layers: [{ type: 'tilelayer', width: 3, height: 1, data: [gid('H'), gid('I'), (gid('F') | 0x80000000) >>> 0] }],
  }));
  const map = decodePng(await renderTiledMap(path.join(OUT, 'map.tmj')));
  const glyph = (ch, flipX) => { const i = ch.charCodeAt(0) - 32, gx = (i % 16) * 8, gy = Math.floor(i / 16) * 8; const p = []; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p.push(tile.data[((gy + y) * tile.width + gx + (flipX ? 7 - x : x)) * tile.channels]); return p.join(); };
  const cell = (n) => { const p = []; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p.push(map.data[(y * map.width + n * 8 + x) * map.channels]); return p.join(); };
  ok('Tiled JSON: tiles drawn in place', map.width === 24 && cell(0) === glyph('H') && cell(1) === glyph('I'));
  ok('Tiled JSON: horizontal flip flag', cell(2) === glyph('F', true));
  // Same map as TMX with CSV data and an external .tsx tileset.
  await writeFile(path.join(OUT, 'font.tsx'), '<?xml version="1.0"?>\n<tileset name="font" tilewidth="8" tileheight="8" tilecount="96" columns="16">\n <image source="font.png" width="128" height="48"/>\n</tileset>\n');
  await writeFile(path.join(OUT, 'map.tmx'), `<?xml version="1.0"?>\n<map version="1.10" orientation="orthogonal" width="3" height="1" tilewidth="8" tileheight="8" infinite="0">\n <tileset firstgid="1" source="font.tsx"/>\n <layer id="1" name="l" width="3" height="1">\n  <data encoding="csv">\n${gid('H')},${gid('I')},${(gid('F') | 0x80000000) >>> 0}\n</data>\n </layer>\n</map>\n`);
  const tmx = await renderTiledMap(path.join(OUT, 'map.tmx'));
  ok('Tiled TMX + .tsx: same picture as the JSON map', compare(tmx, encodePng({ width: 24, height: 8, data: map.data, channels: map.channels })).fraction === 0);
}

// ---- MCP: new_project, build, describe, watch, check, background ----
const proj = path.join(OUT, 'game');
{
  // new_project needs no server root other than the output folder.
  const { server, close } = createServer({ root: OUT });
  const client = new Client({ name: 'test', version: '0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const r = await client.callTool({ name: 'new_project', arguments: { template: 'gb-asm', path: 'game' } });
  ok('new_project: copies the template', !r.isError && existsSync(path.join(proj, 'src', 'main.asm')) && existsSync(path.join(proj, 'gbtest.json')) && existsSync(path.join(proj, '.gitignore')));
  const again = await client.callTool({ name: 'new_project', arguments: { template: 'gb-asm', path: 'game' } });
  ok('new_project: refuses a non-empty folder', !!again.isError);
  await client.close(); await close();
}
// Stand-in build: copies the prebuilt ROM + symbols, prints a warning.
await writeFile(path.join(proj, 'Makefile'), [
  'all:', '\tmkdir -p build', `\tcp ${path.join(FIX, 'gb-asm', 'hello.gb')} ${path.join(FIX, 'gb-asm', 'hello.sym')} build/`,
  '\t@echo "warning: src/main.asm(40): [-Wtruncation] value truncated"',
  'broken:', '\t@echo "src/main.asm:3:1: error: nope"; exit 2', ''].join('\n'));

const { server, close } = createServer({ root: proj });
const client = new Client({ name: 'test', version: '0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);
/** @returns {Promise<any>} */
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

try {
  const { tools } = await client.listTools();
  for (const n of ['build', 'describe', 'check', 'background', 'new_project']) ok(`tool listed: ${n}`, tools.some((t) => t.name === n));

  let r = await call('build', { command: 'make broken' });
  ok('build: failure lists the compiler error', r.isError && textOf(r).includes('src/main.asm:3:1: error: nope') && textOf(r).includes('exit 2'), textOf(r));

  r = await call('build');
  const bt = textOf(r);
  ok('build: runs gbtest.json "build" and reports warnings', !r.isError && bt.includes('Built with `make`') && bt.includes('src/main.asm:40: warning:'), bt);
  ok('build: loads the ROM with its symbols', /Loaded build\/hello\.gb \(GB\/GBC, 30 symbols from hello\.sym\)/.test(bt), bt);
  ok('build: header is clean (nothing reported)', !bt.includes('ROM header'));
  ok('build: watch line from gbtest.json', /watch: wPlayerX=\d+ wPlayerY=\d+/.test(bt));

  r = await call('run_sequence', { steps: [{ wait: 30 }, { hold: 'RIGHT', frames: 20 }, { assertRam: 'wPlayerX', min: 90 }] });
  ok('run_sequence: symbol names in steps + watch line', !r.isError && /watch: wPlayerX=96 wPlayerY=64/.test(textOf(r)), textOf(r));

  r = await call('read_memory', { address: 'wPlayerX', as: 'u8' });
  ok('read_memory: by name, labelled', textOf(r) === '0xc0a0 (wPlayerX) u8: 96 (0x60)', textOf(r));
  r = await call('wait_until', { address: 'wPlayerY', op: 'gt', value: 64, maxFrames: 30 });
  ok('wait_until: by name (not met: nobody pressed DOWN)', !r.structuredContent.met);

  r = await call('describe');
  let dt = textOf(r);
  ok('describe: text from the charmap in gbtest.json', dt.includes('HELLO, GAME BOY!') && dt.includes('D-PAD TO MOVE'), dt);
  ok('describe: sprites and watch', /sprites: #0 96,64 8x16 t0 · #1 104,64 8x16 t2/.test(dt) && dt.includes('watch: wPlayerX=96'), dt);
  ok('describe: no image unless asked', !r.content.some((c) => c.type === 'image'));
  await call('press', { button: 'LEFT', hold: 8 });
  dt = textOf(await call('describe', { image: true }));
  ok('describe: reports change since the last one', /screen: [\d.]+% changed since the last describe/.test(dt), dt);

  r = await call('describe', { watch: ['wPlayerY', 'wFrameCounter'] });
  ok('describe watch: replaces the list', /\nwatch: wPlayerY=64 wFrameCounter=\d+\n/.test(textOf(r)), textOf(r));
  r = await call('wait_frames', { frames: 1 });
  ok('watch: shown after waits', /watch: wPlayerY=64 wFrameCounter=\d+/.test(textOf(r)));

  const before = (await call('status')).structuredContent.frame;
  r = await call('check', { frames: 60 });
  const ct2 = textOf(r);
  ok('check: clean template', /^No errors, 0 warning\(s\) over 60 frames \(frame counter 0xc0a2 \(wFrameCounter\)\)/.test(ct2) && ct2.includes('no lag frames in 60 frames'), ct2);
  ok('check: state restored', (await call('status')).structuredContent.frame === before);

  // build + replay returns to the same spot.
  const x = (await call('read_memory', { address: 'wPlayerX', as: 'u8' })).structuredContent.values[0];
  const f = (await call('status')).structuredContent.frame;
  r = await call('build', { replay: true });
  const x2 = (await call('read_memory', { address: 'wPlayerX', as: 'u8' })).structuredContent.values[0];
  ok('build replay: same frame and state', /Replayed \d+ steps/.test(textOf(r)) && x2 === x && (await call('status')).structuredContent.frame === f, `${x} vs ${x2}; ${textOf(r)}`);

  // A crash: jump into VRAM at start-up.
  const crash = Buffer.from(await readFile(path.join(FIX, 'gb-asm', 'hello.gb')));
  crash.set([0xc3, 0x00, 0x80], 0x150 + 0x640); // Start: jp $8000
  await writeFile(path.join(proj, 'crash.gb'), crash);
  await call('load_rom', { rom: 'crash.gb' });
  r = await call('check', { frames: 30 });
  ok('check: crash detected', /^[1-9]\d* error\(s\)/.test(textOf(r)) && /ERROR: (CPU executing|CPU looping|stack pointer)/.test(textOf(r)), textOf(r));
  ok('check: missing frame-counter symbol is a note, not a failure', textOf(r).includes('(frame counter: '));

  // background tool writes sources + returns a preview
  r = await call('background', { png: path.join(REPO, 'templates', 'gb-asm', 'assets', 'font.png'), target: 'gb', dedupe: false, out: 'gfx/font.asm', name: 'font' });
  ok('background tool: font as RGBDS source', !r.isError && existsSync(path.join(proj, 'gfx', 'font.asm')) && /96 unique tiles of 96/.test(textOf(r)) && r.content.some((c) => c.type === 'image'), textOf(r));
  r = await call('background', { tiled: path.join(OUT, 'map.tmx'), target: 'gba4', out: 'gfx/map.c' });
  ok('background tool: Tiled map to C', !r.isError && existsSync(path.join(proj, 'gfx', 'map.c')) && existsSync(path.join(proj, 'gfx', 'map.h')), textOf(r));

  // describe on a GBA ROM without gbtest.json charmap: learn it.
  await rm(path.join(proj, 'gbtest.json'));
  await call('load_rom', { rom: path.join(FIX, 'gba-c', 'hello.gba') });
  await call('wait_frames', { frames: 20 });
  dt = textOf(await call('describe'));
  ok('describe: asks for a charmap when unknown', dt.includes('text: unknown font'), dt);
  dt = textOf(await call('describe', { learn: 'GAME BOY' }));
  ok('describe: learns the charmap from visible text', dt.includes('charmap learned: first tile 32') && dt.includes('HELLO, GAME BOY ADVANCE!'), dt);
  r = await call('read_memory', { address: 'player_y', as: 's32' });
  ok('ELF symbols on GBA', textOf(r).startsWith('0x3000004 (player_y) s32: 64'), textOf(r));
  // A frame ends at the VBlank interrupt (pc 0x40): no symbol there, and none of
  // GBDK's register constants (_rRAMG = 0) may be used as a name.
  await call('load_rom', { rom: path.join(FIX, 'gb-c', 'hello.gb') });
  await call('wait_frames', { frames: 20 });
  r = await call('read_cpu');
  ok('read_cpu: no bogus symbol for the interrupt vector', !/\nin _r/.test(textOf(r)), textOf(r));
} finally {
  await client.close();
  await close();
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
