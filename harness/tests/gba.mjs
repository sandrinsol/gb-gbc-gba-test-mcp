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
import { decodeIo, formatDisplay, formatSound, renderLayers, gbaDisplayIssues, gbaSaveType, dmaPurpose, vramBudget } from '../gba.mjs';
import { decodeWav, convertSound, encodeWav8, makeTable, writeSound, writeTable, timerFor } from '../gamedata.mjs';
import { loadSymbols } from '../symbols.mjs';
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

// ---- Sound, memory budget, CPU load, data tool ----
/** A 16-bit stereo WAV of a sine tone. */
const toneWav = (freq, rate = 44100, seconds = 1, { bits = 16, channels = 2 } = {}) => {
  const n = rate * seconds, bps = bits / 8, b = Buffer.alloc(44 + n * bps * channels);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * bps * channels, 28); b.writeUInt16LE(bps * channels, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(n * bps * channels, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) {
    const v = Math.sin(2 * Math.PI * freq * i / rate) * 0.6, o = 44 + (i * channels + c) * bps;
    if (bits === 16) b.writeInt16LE(Math.round(v * 32767), o); else b[o] = Math.round(v * 127 + 128);
  }
  return b;
};
{
  const w16 = decodeWav(toneWav(440)), w8 = decodeWav(toneWav(440, 22050, 1, { bits: 8, channels: 1 }));
  ok('WAV decode: 16-bit stereo and 8-bit mono', w16.rate === 44100 && w16.channels === 2 && w16.samples.length === 44100 && w8.channels === 1 && Math.abs(Math.max(...w8.samples) - 0.6) < 0.02);
  ok('timer reload for 18157 Hz is 64612 (304 samples per frame)', timerFor(18157).reload === 64612 && Math.round(280896 / (16777216 / timerFor(18157).rate)) === 304);
  const c = convertSound(toneWav(440), { rate: 18157 });
  ok('sound conversion: length, rate, padding, no clipping', Math.abs(c.length - 18157) <= 1 && c.pcm.length % 16 === 0 && c.clipped === 0 && Math.abs(c.peak - 0.6) < 0.01);
  const files = await writeSound(c, path.join(OUT, 'tone.c'), 'tone');
  const h = await readFile(files[1], 'utf8');
  ok('sound .c/.h with rate and timer reload', h.includes('#define TONE_TIMER_RELOAD 64612') && h.includes('#define TONE_LENGTH'));
  const w = decodeWav(encodeWav8(c.pcm, c.length, c.rate));
  ok('sound .wav (8-bit, for Maxmod/Butano) round-trips', w.rate === 18157 && w.samples.length === c.length);
  const sin = makeTable('sin', { size: 512, bits: 12 }), cos = makeTable('cos'), rec = makeTable('reciprocal', { size: 256, bits: 16 });
  ok('sin/cos tables in .12 fixed point', sin.values[128] === 4096 && sin.values[0] === 0 && cos.values[0] === 4096 && sin.type === 'short');
  ok('reciprocal table', rec.values[3] === Math.round(65536 / 3) && rec.values[0] === 0 && rec.type === 'unsigned int');
  const tf = await writeTable(sin, path.join(OUT, 'sin.h'), 'sin_lut');
  ok('table header', (await readFile(tf[0], 'utf8')).includes('static const short sin_lut[512]'));
  ok('DMA purpose: FIFO, scroll and mode 7 per line', /FIFO A/.test(dmaPurpose({ dst: 0x040000a0, timing: 'special' })) && /BG0HOFS.*scroll/.test(dmaPurpose({ dst: 0x04000010, timing: 'hblank' })) && /BG2PA.*mode 7/.test(dmaPurpose({ dst: 0x04000020, timing: 'hblank' })) && dmaPurpose({ dst: 0x06000000, timing: 'now' }) === null);
  const syms = await loadSymbols(path.join(FIX, 'templates', 'gba-c', 'hello.elf'));
  ok('symbol names prefer variables over linker markers', syms.nameOf(syms.resolve('frame_counter')) === 'frame_counter');

  // tone.gba: the gba-c starter playing a 440 Hz tone converted by convertSound,
  // through DirectSound A (timer 0 + DMA1).
  const e = await EmuHarness.launch(path.join(FIX, 'sound', 'tone.gba'), { reuse: true, fast: false });
  await e.waitFrames(10);
  const d = decodeIo((await e.readRegions()).io);
  ok('sound decode: DirectSound A at 18157 Hz fed by DMA1', formatSound(d).join('\n').includes('DirectSound A 100% L+R · timer 0 18157 Hz · fed by DMA1'), formatSound(d).join(' | '));
  await e.startRecording({ every: 1, maxFrames: 60 });
  await e.waitFrames(40);
  const a = /** @type {any} */ (await e.stopRecording()).audio;
  const n = a.pcm.length / 2 / a.channels, x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = a.pcm.readInt16LE(i * 2 * a.channels);
  const ac = (lag) => { let sum = 0; for (let i = 0; i + lag < n; i++) sum += x[i] * x[i + lag]; return sum; };
  let bestLag = 0, best = -Infinity;
  for (let lag = Math.floor(a.rate / 600); lag <= Math.ceil(a.rate / 300); lag++) { const v = ac(lag); if (v > best) { best = v; bestLag = lag; } }
  const freq = a.rate / bestLag;
  ok('the converted tone plays at its pitch (440 Hz ± 3%)', Math.abs(freq - 440) < 13, `${freq.toFixed(1)} Hz`);
  await e.close();
}
{
  const e = await EmuHarness.launch(GBA_C, { reuse: true });
  await e.waitFrames(30);
  const b = vramBudget(await e.readRegions());
  ok('memory budget: player tiles, one palette bank each', b.objUsed === 4 && b.objPal === 1 && b.bgPal === 1 && b.bgBytes > 0, b.lines[0]);
  await e.close();
}
{
  const { server, close } = createServer({ root: OUT });
  const client = new Client({ name: 'test', version: '0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  /** @returns {Promise<any>} */
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try {
    await import('node:fs/promises').then((fs) => fs.writeFile(path.join(OUT, 'beep.wav'), toneWav(880, 32000, 0.25)));
    let r = await call('data', { kind: 'sound', wav: 'beep.wav', out: 'snd/beep.c' });
    ok('data sound tool', !r.isError && /at 18157\.2 Hz \(timer reload 64612\)/.test(textOf(r)), textOf(r));
    r = await call('data', { kind: 'table', table: 'sin', out: 'lut/sin.c' });
    ok('data table tool', !r.isError && /512 short entries, 12 fractional bits/.test(textOf(r)), textOf(r));
    await call('load_rom', { rom: path.join(FIX, 'sound', 'tone.gba') });
    await call('wait_frames', { frames: 10 });
    r = await call('describe', { io: true });
    ok('describe io: sound and memory lines', /sound: master on · DirectSound A/.test(textOf(r)) && /memory: BG VRAM .* OBJ tiles 4\/1024/.test(textOf(r)), textOf(r));
    r = await call('check', { frames: 20 });
    ok('check: CPU load from cpu_usage and no sound problems', /ok: CPU \d+-\d+% of a frame/.test(textOf(r)) && !/ERROR/.test(textOf(r)), textOf(r));
    await call('write_memory', { address: '0x04000102', value: 0, as: 'u16' });   // stop timer 0
    await call('write_memory', { address: '0x04000084', value: 0, as: 'u16' });   // master off
    r = await call('check', { frames: 5 });
    ok('check: stopped sample timer and master switch off', /ERROR: DMA1 feeds DirectSound FIFO A but the sound master switch is off/.test(textOf(r)) && /ERROR: DirectSound A is clocked by timer 0, which is stopped/.test(textOf(r)), textOf(r));
  } finally {
    await client.close();
    await close();
  }
}

ok('templates include the GBA starters', ['gba-c', 'gba-tonc', 'gba-butano'].every((t) => TEMPLATES[t]));

await EmuHarness.shutdown();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
