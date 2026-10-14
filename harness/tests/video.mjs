// Video recording: frame-exact capture, the APNG/GIF/WAV encoders (checked by
// decoding them back), WebM via ffmpeg, deterministic audio, and recording a
// run that fails.
//
//   node tests/video.mjs   (exit 0 = pass, 1 = fail)

import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { EmuHarness } from '../driver.mjs';
import { compare } from '../assert.mjs';
import { decodePng, encodePng, scalePng } from '../png.mjs';
import { saveVideo, encodeApng, encodeGif, findFfmpeg } from '../recording.mjs';
import { runSteps } from '../steps.mjs';

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};
const OUT = path.resolve('out', 'video-test');
await rm(OUT, { recursive: true, force: true });

// ---- Minimal decoders, to check the encoders independently ----

/** APNG → [{ rgb, delayFrames }] (RGB, filter 0 only — what encodeApng writes). */
function decodeApng(buf) {
  let p = 8, w = 0, h = 0, cur = null;
  const frames = [];
  const flush = () => {
    if (!cur) return;
    const raw = zlib.inflateSync(Buffer.concat(cur.data));
    const rgb = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) raw.copy(rgb, y * w * 3, y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
    frames.push({ rgb, delay: cur.delay });
  };
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); }
    if (type === 'fcTL') { flush(); cur = { data: [], delay: d.readUInt16BE(20) / d.readUInt16BE(22) }; }
    if (type === 'IDAT') cur.data.push(d);
    if (type === 'fdAT') cur.data.push(d.subarray(4));
    p += 12 + len;
  }
  flush();
  return { w, h, frames };
}

/** GIF → [{ rgb, delay(cs) }] (local colour tables, full-frame images). */
function decodeGif(buf) {
  const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
  let p = 13 + (buf[10] & 0x80 ? 3 * (2 << (buf[10] & 7)) : 0), delay = 0;
  const frames = [];
  while (p < buf.length && buf[p] !== 0x3b) {
    if (buf[p] === 0x21) {
      if (buf[p + 1] === 0xf9) delay = buf.readUInt16LE(p + 4);
      p += 2;
      while (buf[p]) p += buf[p] + 1;
      p++;
    } else if (buf[p] === 0x2c) {
      const flags = buf[p + 9];
      const ct = buf.subarray(p + 10, p + 10 + 3 * (2 << (flags & 7)));
      p += 10 + ct.length;
      const min = buf[p++];
      const data = [];
      while (buf[p]) { data.push(...buf.subarray(p + 1, p + 1 + buf[p])); p += buf[p] + 1; }
      p++;
      // LZW decode
      const clear = 1 << min, eoi = clear + 1;
      let size = min + 1, dict = [], prev = null, bit = 0;
      const out = [];
      const reset = () => { dict = Array.from({ length: clear + 2 }, (_, i) => [i]); size = min + 1; prev = null; };
      reset();
      for (;;) {
        let code = 0;
        for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
        if (code === clear) { reset(); continue; }
        if (code === eoi) break;
        let entry;
        if (code < dict.length) entry = dict[code];
        else entry = [...dict[prev], dict[prev][0]];
        out.push(...entry);
        if (prev !== null && dict.length < 4096) dict.push([...dict[prev], entry[0]]);
        if (dict.length === (1 << size) && size < 12) size++;
        prev = code;
      }
      const rgb = Buffer.alloc(w * h * 3);
      for (let i = 0; i < w * h; i++) ct.copy(rgb, i * 3, out[i] * 3, out[i] * 3 + 3);
      frames.push({ rgb, delay });
    } else break;
  }
  return { w, h, frames };
}
const rgbOf = (png, scale) => {
  const im = decodePng(scalePng(png, scale));
  if (im.channels === 3) return Buffer.from(im.data);
  const rgb = Buffer.alloc(im.width * im.height * 3);
  for (let i = 0, j = 0; i < im.data.length; i += 4, j += 3) { rgb[j] = im.data[i]; rgb[j + 1] = im.data[i + 1]; rgb[j + 2] = im.data[i + 2]; }
  return rgb;
};

// ---- Capture is frame-exact ----
const emu = await EmuHarness.launch('../anguna.gba', { reuse: true });
await emu.waitFrames(20);
const caps = await emu.record(240); // the boot sequence animates
ok('record captures every frame', caps.length === 241 && caps[0].frame === 20 && caps[240].frame === 260, `${caps.length} frames`);
ok('record leaves the clock at the end', (await emu.frameNum()) === 260);
ok('audio captured with the frames', caps.audio && caps.audio.rate === 44100 && Math.abs(caps.audio.pcm.length / 4 - 241 * 44100 / 60) < 1500,
  caps.audio && `${caps.audio.pcm.length / 4} samples`);
const ref = await EmuHarness.launch('../anguna.gba', { reuse: true });
let exact = 0;
for (const c of caps.filter((_, i) => i % 30 === 0)) {
  await ref.waitUntilFrame(c.frame);
  if (compare(c.png, await ref.screenshot()).fraction === 0) exact++;
}
ok('captures equal exact screenshots of the same frames', exact === 9, `${exact}/9`);
await ref.close();

// ---- Encoders, decoded back ----
const distinct = [];
for (const c of caps) if (!distinct.length || compare(c.png, distinct[distinct.length - 1].png).fraction > 0) distinct.push(c);
const apng = decodeApng(encodeApng(caps, { scale: 2 }));
ok('APNG: one frame per distinct picture', apng.frames.length === distinct.length, `${apng.frames.length} vs ${distinct.length}`);
ok('APNG: pixels exact (2x)', apng.w === 480 && apng.frames.every((f, i) => f.rgb.equals(rgbOf(distinct[i].png, 2))));
ok('APNG: timing adds up', Math.abs(apng.frames.reduce((n, f) => n + f.delay, 0) - 241 / 60) < 0.02);
const gif = decodeGif(encodeGif(caps, { scale: 1 }));
const sources = new Set(caps.map((c) => rgbOf(c.png, 1).toString('base64')));
ok('GIF: decodes to exact source frames', gif.frames.length > 1 && gif.frames.every((f) => sources.has(f.rgb.toString('base64'))), `${gif.frames.length} frames`);
ok('GIF: timing adds up (<= 30 fps)', Math.abs(gif.frames.reduce((n, f) => n + f.delay, 0) / 100 - 241 / 60) < 0.1 && gif.frames.every((f) => f.delay >= 2));

// Noise stresses the LZW dictionary (fills to 4096 and resets) and colour limits.
{
  let seed = 1;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const noise = (colors) => {
    const pal = Array.from({ length: colors }, () => [rand() * 256 | 0, rand() * 256 | 0, rand() * 256 | 0]);
    const data = new Uint8Array(160 * 144 * 3);
    for (let i = 0; i < 160 * 144; i++) data.set(pal[rand() * colors | 0], i * 3);
    return encodePng({ width: 160, height: 144, data });
  };
  const few = [0, 2, 4].map((f) => ({ frame: f, png: noise(200) }));
  const g = decodeGif(encodeGif(few, { scale: 1 }));
  ok('GIF: noise with 200 colours round-trips exactly', g.frames.length === 3 && g.frames.every((f, i) => f.rgb.equals(rgbOf(few[i].png, 1))));
  const many = [{ frame: 0, png: noise(5000) }];
  const g2 = decodeGif(encodeGif(many, { scale: 1 }));
  ok('GIF: > 256 colours are reduced, not broken', g2.frames.length === 1 && g2.frames[0].rgb.length === 160 * 144 * 3);
}

const wav = await readFile((await saveVideo(caps, path.join(OUT, 'a.wav'))).file);
ok('WAV: RIFF header + all samples', wav.toString('latin1', 0, 4) === 'RIFF' && wav.readUInt32LE(40) === caps.audio.pcm.length);
if (findFfmpeg()) {
  const r = await saveVideo(caps, path.join(OUT, 'a.webm'), { toJpeg: (p, k) => emu.toJpeg(p, k) });
  const head = await readFile(r.file);
  ok('WebM via ffmpeg', head.readUInt32BE(0) === 0x1a45dfa3, `audio: ${r.audio}`);
} else console.log('SKIP: WebM (no ffmpeg)');
await emu.close();

// ---- Audio ----
const audioRun = async (fast) => {
  const e = await EmuHarness.launch('../anguna.gba', { reuse: true, fast });
  await e.waitFrames(300);
  await e.tap('START', 6, 20);
  await e.startRecording({ every: 60, maxFrames: 100 });
  await e.waitFrames(400);
  const r = await e.stopRecording();
  await e.close();
  return { pcm: /** @type {any} */ (r).audio.pcm };
};
// Audio follows the frames but isn't bit-exact (see page.html): runs may differ
// by a chunk, so compare lengths.
const s1 = await audioRun(false), s2 = await audioRun(false), f1 = await audioRun(true);
const near = (a, b) => Math.abs(a.pcm.length - b.pcm.length) <= 4 * 1024;
ok('audio length stable across runs', near(s1, s2), `${s1.pcm.length} vs ${s2.pcm.length} bytes`);
ok('fast-forward keeps the audio length', near(f1, s1), `${f1.pcm.length} vs ${s1.pcm.length} bytes`);

// ---- Recording a run that fails ----
{
  const e = await EmuHarness.launch('../anguna.gba', { reuse: true });
  const pass = await runSteps(e, [{ wait: 30 }, { assertRam: '0x02000000', min: 0 }], { baseDir: OUT, video: { path: 'pass.gif', seconds: 1 } });
  ok('passing run keeps no video', pass.video === null && !existsSync(path.join(OUT, 'pass.gif')));
  const fail = await runSteps(e, [{ wait: 120 }, { assertRam: '0x02000000', equals: 999 }], { baseDir: OUT, video: { path: 'fail.png', seconds: 1 } });
  const clip = fail.video ? decodeApng(await readFile(fail.video)) : null;
  ok('failing run saves the last seconds', fail.failures === 1 && !!clip, fail.video);
  ok('clip is limited to `seconds`', clip && Math.abs(clip.frames.reduce((n, f) => n + f.delay, 0) - 1) < 0.05);
  const step = await runSteps(e, [{ video: { frames: 30, path: 'step.gif' } }], { baseDir: OUT });
  ok('video step writes a file', existsSync(path.join(OUT, 'step.gif')) && step.timeline[0].file);
  await e.close();
}

await EmuHarness.shutdown();
process.exit(failed ? 1 : 0);
