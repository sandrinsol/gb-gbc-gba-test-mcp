// Save captured frames ([{ frame, png }], see EmuHarness#record) as a video:
//   .png / .apng  animated PNG — lossless, no dependencies
//   .gif          animated GIF — plays everywhere (GitHub, Slack); <= 30 fps
//   .webm         VP8 via ffmpeg — small files. Playwright's bundled ffmpeg works
//                 (it only reads JPEG, so frames go through `toJpeg`)
//   .mp4          H.264 via an ffmpeg with libx264 on PATH (or GBTEST_FFMPEG)
//   .wav          the audio alone
// Audio (captured deterministically with the frames) is muxed into .mp4/.webm
// when a full ffmpeg is available; Playwright's has no audio encoders.
// Frames are upscaled with nearest-neighbour so pixels stay sharp.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePng, crc32, scalePng } from './png.mjs';

const FPS = 60; // GB/GBA run at ~59.7 Hz; 60 is what players expect

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Decode + upscale frames to RGB, merging consecutive identical frames into one
 *  longer frame. → [{ rgb, w, h, frames }] where `frames` is the duration in
 *  emulated frames. */
function prepare(captures, scale) {
  const out = [];
  captures.forEach((c, i) => {
    const next = captures[i + 1];
    const dur = next ? next.frame - c.frame : (i > 0 ? c.frame - captures[i - 1].frame : 1);
    const img = decodePng(scalePng(c.png, scale));
    let rgb = img.data;
    if (img.channels === 4) {
      rgb = new Uint8Array(img.width * img.height * 3);
      for (let p = 0, q = 0; p < img.data.length; p += 4, q += 3) { rgb[q] = img.data[p]; rgb[q + 1] = img.data[p + 1]; rgb[q + 2] = img.data[p + 2]; }
    }
    const last = out[out.length - 1];
    if (last && Buffer.compare(Buffer.from(last.rgb), Buffer.from(rgb)) === 0) last.frames += dur;
    else out.push({ rgb, w: img.width, h: img.height, frames: Math.max(1, dur) });
  });
  return out;
}

/** Animated PNG (APNG): lossless, loops forever. */
export function encodeApng(captures, { scale = 2 } = {}) {
  const frames = prepare(captures, scale);
  const { w, h } = frames[0];
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const actl = Buffer.alloc(8); actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(0, 4);
  const parts = [SIG, chunk('IHDR', ihdr), chunk('acTL', actl)];
  let seq = 0;
  frames.forEach((f, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0); fctl.writeUInt32BE(w, 4); fctl.writeUInt32BE(h, 8);
    fctl.writeUInt16BE(Math.min(f.frames, 65535), 20); fctl.writeUInt16BE(FPS, 22); // delay = frames/60 s
    parts.push(chunk('fcTL', fctl));
    const raw = Buffer.alloc(h * (w * 3 + 1));
    for (let y = 0; y < h; y++) Buffer.from(f.rgb.buffer, f.rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
    const data = zlib.deflateSync(raw, { level: 9 });
    if (i === 0) parts.push(chunk('IDAT', data));
    else { const s = Buffer.alloc(4); s.writeUInt32BE(seq++); parts.push(chunk('fdAT', Buffer.concat([s, data]))); }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---- GIF ----

/** Map RGB pixels to <= 256 palette indices (exact when the frame has <= 256
 *  colours, otherwise median-cut). → { indices, palette: Uint8Array(768) } */
function indexFrame(rgb) {
  const n = rgb.length / 3;
  const key = (i) => (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
  const colors = new Map();
  for (let i = 0; i < n; i++) { const k = key(i); if (!colors.has(k)) colors.set(k, colors.size); if (colors.size > 256) break; }
  let lookup;
  let pal = [...colors.keys()];
  if (colors.size > 256) {
    pal = medianCut(rgb, 256);
    const cache = new Map();
    lookup = (k) => {
      let v = cache.get(k);
      if (v === undefined) {
        let best = 0, bd = Infinity;
        const r = k >> 16, g = (k >> 8) & 255, b = k & 255;
        pal.forEach((p, j) => { const d = (r - (p >> 16)) ** 2 + (g - ((p >> 8) & 255)) ** 2 + (b - (p & 255)) ** 2; if (d < bd) { bd = d; best = j; } });
        cache.set(k, v = best);
      }
      return v;
    };
  } else lookup = (k) => colors.get(k);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = lookup(key(i));
  const palette = new Uint8Array(768);
  pal.forEach((p, j) => { palette[j * 3] = p >> 16; palette[j * 3 + 1] = (p >> 8) & 255; palette[j * 3 + 2] = p & 255; });
  return { indices, palette };
}

/** Median-cut colour quantization → `count` colours as 0xRRGGBB. */
export function medianCut(rgb, count) {
  const px = [];
  for (let i = 0; i < rgb.length; i += 3) px.push((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2]);
  let boxes = [px];
  const ch = (c, s) => (c >> s) & 255;
  while (boxes.length < count) {
    let bi = -1, bestRange = -1, bestShift = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (const s of [16, 8, 0]) {
        let lo = 255, hi = 0;
        for (const c of b) { const v = ch(c, s); if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo > bestRange) { bestRange = hi - lo; bi = i; bestShift = s; }
      }
    });
    if (bi < 0 || bestRange === 0) break;
    const b = boxes[bi].sort((x, y) => ch(x, bestShift) - ch(y, bestShift));
    boxes.splice(bi, 1, b.slice(0, b.length >> 1), b.slice(b.length >> 1));
  }
  return boxes.filter((b) => b.length).map((b) => {
    let r = 0, g = 0, bl = 0;
    for (const c of b) { r += c >> 16; g += (c >> 8) & 255; bl += c & 255; }
    return (Math.round(r / b.length) << 16) | (Math.round(g / b.length) << 8) | Math.round(bl / b.length);
  });
}

function lzw(indices, minCodeSize) {
  const out = [];
  let bitBuf = 0, bitLen = 0;
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  let dict = new Map();
  const emit = (code) => { bitBuf |= code << bitLen; bitLen += codeSize; while (bitLen >= 8) { out.push(bitBuf & 255); bitBuf >>>= 8; bitLen -= 8; } };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else { emit(clear); dict = new Map(); codeSize = minCodeSize + 1; next = eoi + 1; }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bitLen > 0) out.push(bitBuf & 255);
  const blocks = [];
  for (let i = 0; i < out.length; i += 255) blocks.push(Buffer.from([Math.min(255, out.length - i)]), Buffer.from(out.slice(i, i + 255)));
  blocks.push(Buffer.from([0]));
  return Buffer.concat(blocks);
}

/** Animated GIF. GIF delays are in 1/100 s and browsers slow down anything
 *  under 2/100, so frames are thinned to <= 30 fps. Loops forever. */
export function encodeGif(captures, { scale = 2 } = {}) {
  // Thin to >= 2 emulated frames apart.
  const thin = [];
  for (const c of captures) if (!thin.length || c.frame - thin[thin.length - 1].frame >= 2) thin.push(c);
  const frames = prepare(thin, scale);
  const { w, h } = frames[0];
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1'); head.writeUInt16LE(w, 6); head.writeUInt16LE(h, 8);
  const loop = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00]);
  const parts = [head, loop];
  let t = 0, shown = 0; // accumulate time so rounding doesn't drift
  for (const f of frames) {
    t += f.frames * 100 / FPS;
    const delay = Math.max(2, Math.round(t - shown));
    shown += delay;
    const { indices, palette } = indexFrame(f.rgb);
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, delay & 255, delay >> 8, 0x00, 0x00]);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c; desc.writeUInt16LE(w, 5); desc.writeUInt16LE(h, 7); desc[9] = 0x87; // local table, 256 entries
    parts.push(gce, desc, Buffer.from(palette), Buffer.from([8]), lzw(indices, 8));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// ---- Audio ----

/** 16-bit PCM WAV from { rate, channels, pcm } (pcm: s16le interleaved). */
export function encodeWav({ rate, channels, pcm }) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---- ffmpeg (WebM / MP4) ----

const onPath = (name) => (process.env.PATH || '').split(path.delimiter).some((d) => d && existsSync(path.join(d, name)));

/** An ffmpeg binary → { bin, bundled }: GBTEST_FFMPEG, a full ffmpeg on PATH, or
 *  the minimal one Playwright installs with Chromium (bundled: reads JPEG only,
 *  encodes VP8 only). */
export function findFfmpeg() {
  // Playwright's build is named ffmpeg-linux / ffmpeg-mac / ffmpeg-win64.exe.
  const bundled = (p) => /^ffmpeg-(linux|mac|win64)/.test(path.basename(p));
  if (process.env.GBTEST_FFMPEG) return { bin: process.env.GBTEST_FFMPEG, bundled: bundled(process.env.GBTEST_FFMPEG) };
  if (onPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')) return { bin: 'ffmpeg', bundled: false };
  const home = os.homedir();
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || home, 'ms-playwright')
        : path.join(home, '.cache', 'ms-playwright')].filter(Boolean);
  const exe = { linux: 'ffmpeg-linux', darwin: 'ffmpeg-mac', win32: 'ffmpeg-win64.exe' }[process.platform];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const d of readdirSync(r).filter((x) => x.startsWith('ffmpeg')).sort().reverse()) {
      const p = path.join(r, d, exe);
      if (existsSync(p)) return { bin: p, bundled: true };
    }
  }
  return null;
}

/** Encode with ffmpeg at a constant 60/every fps (gaps repeat the last frame). */
async function encodeFfmpeg(captures, file, { scale, every, codec, toJpeg, wav }) {
  const ff = findFfmpeg();
  if (codec === 'h264' && (!ff || ff.bundled)) throw new Error('MP4 needs an ffmpeg with libx264 on PATH (or set GBTEST_FFMPEG); use .webm, .gif or .png');
  if (!ff) throw new Error('no ffmpeg found (install Chromium via Playwright, or set GBTEST_FFMPEG); use .gif or .png');
  const step = every;
  const idx = [];
  let ci = 0;
  for (let f = captures[0].frame; f <= captures[captures.length - 1].frame; f += step) {
    while (ci + 1 < captures.length && captures[ci + 1].frame <= f) ci++;
    idx.push(ci);
  }
  // The bundled ffmpeg only decodes JPEG: convert (already upscaled) via the caller.
  let images = captures.map((c) => c.png), input = ['-c:v', 'png'], vf = ['-vf', `scale=iw*${scale}:ih*${scale}:flags=neighbor`];
  if (ff.bundled) {
    if (!toJpeg) throw new Error('the bundled ffmpeg needs JPEG frames; save through EmuHarness/the MCP tools, or use .gif/.png');
    images = await toJpeg(images, scale);
    input = ['-c:v', 'mjpeg']; vf = [];
  }
  const audioArgs = wav ? ['-i', wav, '-c:a', codec === 'vp8' ? 'libvorbis' : 'aac', '-b:a', '128k', '-shortest'] : [];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS / step), ...input, '-i', 'pipe:0',
    ...audioArgs, ...vf, '-pix_fmt', 'yuv420p',
    ...(codec === 'vp8' ? ['-c:v', 'libvpx', '-b:v', '2M', '-auto-alt-ref', '0'] : ['-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart']),
    file];
  return new Promise((resolve, reject) => {
    const { bin } = ff;
    const p = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`ffmpeg not found (${bin}): ${e.message}. Use .gif/.png, or set GBTEST_FFMPEG.`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(
      `ffmpeg failed${codec === 'h264' ? ' (MP4 needs an ffmpeg with libx264; Playwright\'s only does WebM)' : ''}: ${err.trim().split('\n').pop()}`))));
    p.stdin.on('error', () => {});
    for (const i of idx) p.stdin.write(images[i]);
    p.stdin.end();
  });
}

/** Save captures to `file`; the format comes from the extension. Options:
 *  - toJpeg(pngs, scale) → JPEG Buffers: needed for .webm with Playwright's ffmpeg
 *    (EmuHarness provides one: emu.toJpeg)
 *  - audio: 'auto' (mux into .mp4/.webm when possible), 'on' (mux, else write a
 *    .wav next to the file), 'off'. Audio comes from `captures.audio`.
 *  → { file, audio: 'muxed' | <wav path> | null } */
export async function saveVideo(captures, file, { scale = 2, every = 1, toJpeg = undefined, audio = 'auto' } = {}) {
  if (!captures.length) throw new Error('no frames captured');
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const ext = path.extname(file).toLowerCase();
  const sound = audio === 'off' ? null : /** @type {any} */ (captures).audio;
  if (ext === '.wav') {
    if (!sound) throw new Error('no audio was captured');
    await writeFile(file, encodeWav(sound));
    return { file, audio: file };
  }
  let muxed = false;
  if (ext === '.png' || ext === '.apng') await writeFile(file, encodeApng(captures, { scale }));
  else if (ext === '.gif') await writeFile(file, encodeGif(captures, { scale }));
  else if (ext === '.webm' || ext === '.mp4') {
    const codec = ext === '.webm' ? 'vp8' : 'h264';
    const ff = findFfmpeg();
    let wav, tmp;
    if (sound && ff && !ff.bundled) {
      tmp = await mkdtemp(path.join(os.tmpdir(), 'gbtest-'));
      wav = path.join(tmp, 'audio.wav');
      await writeFile(wav, encodeWav(sound));
    }
    try { await encodeFfmpeg(captures, file, { scale, every, codec, toJpeg, wav }); } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
    muxed = !!wav;
  } else throw new Error(`unknown format "${ext}" (use .gif, .png/.apng, .webm, .mp4 or .wav)`);
  if (muxed) return { file, audio: 'muxed' };
  if (sound && audio === 'on') {
    const side = file.replace(/\.[^.]+$/, '') + '.wav';
    await writeFile(side, encodeWav(sound));
    return { file, audio: side };
  }
  return { file, audio: null };
}
