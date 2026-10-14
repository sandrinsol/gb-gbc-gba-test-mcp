// Game data generators: sound effects for the GBA's DirectSound channels (signed
// 8-bit PCM at a timer-exact sample rate) or as clean WAVs for Maxmod/Butano, and
// fixed-point lookup tables (sine, cosine, reciprocal).

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CPU_HZ = 16777216;

/** Parse a WAV file (PCM 8/16/24/32-bit, float, extensible) → { rate, channels, samples: Float32Array mono -1..1 }. */
export function decodeWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file (RIFF/WAVE header missing)');
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('latin1', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = buf.subarray(p + 8, p + 8 + size);
    else if (id === 'data') data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV has no fmt or data chunk');
  let format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
  if (format === 0xfffe) format = fmt.readUInt16LE(24); // extensible: sub-format GUID starts with the format tag
  const bytes = bits / 8, frames = Math.floor(data.length / (bytes * channels));
  const read = format === 3
    ? (o) => (bits === 64 ? data.readDoubleLE(o) : data.readFloatLE(o))
    : bits === 8 ? (o) => (data[o] - 128) / 128
      : bits === 16 ? (o) => data.readInt16LE(o) / 32768
        : bits === 24 ? (o) => data.readIntLE(o, 3) / 8388608
          : bits === 32 ? (o) => data.readInt32LE(o) / 2147483648 : null;
  if ((format !== 1 && format !== 3) || !read) throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit); use PCM or float`);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < channels; c++) v += read((i * channels + c) * bytes);
    samples[i] = v / channels;
  }
  return { rate, channels, samples };
}

/** Linear resampling. */
export function resample(samples, from, to) {
  if (from === to) return samples;
  const n = Math.max(1, Math.round(samples.length * to / from)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * from / to, j = Math.floor(x), f = x - j;
    out[i] = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? samples[j] ?? 0) * f;
  }
  return out;
}

/** Timer reload for a sample rate, and the rate it really gives. */
export function timerFor(rate) {
  const reload = 65536 - Math.round(CPU_HZ / rate);
  return { reload, rate: CPU_HZ / (65536 - reload) };
}

/** WAV → GBA DirectSound data: signed 8-bit mono at `rate` (snapped to what a
 *  timer can produce), padded to 16 bytes (one FIFO refill). */
export function convertSound(wav, { rate = 18157, normalize = false } = {}) {
  const src = decodeWav(wav);
  const t = timerFor(rate);
  let s = resample(src.samples, src.rate, t.rate);
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  if (normalize && peak > 0) { const k = 0.99 / peak; s = s.map((v) => v * k); }
  let clipped = 0;
  const pcm = Buffer.alloc(Math.ceil(s.length / 16) * 16);
  s.forEach((v, i) => {
    let q = Math.round(v * 127);
    if (q > 127 || q < -128) { clipped++; q = Math.max(-128, Math.min(127, q)); }
    pcm.writeInt8(q, i);
  });
  return { pcm, length: s.length, rate: t.rate, reload: t.reload, seconds: s.length / t.rate, sourceRate: src.rate, channels: src.channels, peak, clipped, frames: Math.ceil(s.length / (t.rate / 59.7275)) };
}

/** 8-bit unsigned mono WAV (what Maxmod's mmutil and Butano's audio folder take). */
export function encodeWav8(pcm, length, rate) {
  const b = Buffer.alloc(44 + length);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + length, 4); b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(Math.round(rate), 24);
  b.writeUInt32LE(Math.round(rate), 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(length, 40);
  for (let i = 0; i < length; i++) b[44 + i] = (pcm.readInt8(i) + 128) & 0xff;
  return b;
}

/** Fixed-point lookup table. kind sin/cos: `size` steps per turn, value × 2^bits;
 *  reciprocal: entry i = 2^bits / i (entry 0 = 0). */
export function makeTable(kind, { size = 512, bits = 12 } = {}) {
  const one = 2 ** bits;
  let values;
  if (kind === 'sin' || kind === 'cos') values = Array.from({ length: size }, (_, i) => Math.round((kind === 'sin' ? Math.sin : Math.cos)((2 * Math.PI * i) / size) * one));
  else if (kind === 'reciprocal') values = Array.from({ length: size }, (_, i) => (i ? Math.round(one / i) : 0));
  else throw new Error('table must be sin, cos or reciprocal');
  const min = Math.min(...values), max = Math.max(...values);
  const type = min >= 0 ? (max < 65536 ? 'unsigned short' : 'unsigned int') : (min >= -32768 && max < 32768 ? 'short' : 'int');
  return { kind, size, bits, values, type };
}

const list = (vals, digits, perLine, fmt) => {
  const out = [];
  for (let i = 0; i < vals.length; i += perLine) out.push('  ' + vals.slice(i, i + perLine).map(fmt).join(', '));
  return out.join(',\n');
};

/** Write converted sound: .c (+ .h), .h, .s, .bin (raw s8) or .wav (8-bit for Maxmod/Butano). */
export async function writeSound(conv, file, name) {
  const id = name.replace(/\W/g, '_'), ID = id.toUpperCase(), ext = path.extname(file).toLowerCase();
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  if (ext === '.wav') { await writeFile(file, encodeWav8(conv.pcm, conv.length, conv.rate)); return [file]; }
  if (ext === '.bin') { await writeFile(file, conv.pcm); return [file]; }
  const info = `${conv.length} samples, ${conv.seconds.toFixed(2)} s at ${conv.rate.toFixed(1)} Hz, signed 8-bit mono (DirectSound)`;
  const defs = [`#define ${ID}_LENGTH ${conv.length} /* samples */`, `#define ${ID}_RATE ${Math.round(conv.rate)}`, `#define ${ID}_TIMER_RELOAD ${conv.reload} /* TMxCNT_L with prescaler 1 */`];
  const body = list([...conv.pcm].map((v) => (v << 24) >> 24), 4, 16, (v) => String(v));
  if (ext === '.s') {
    const lines = [`@ ${info}`, '.section .rodata', '.align 2', `.global ${id}`, `${id}:`];
    for (let i = 0; i < conv.pcm.length; i += 16) lines.push(`  .byte ${[...conv.pcm.subarray(i, i + 16)].map((v) => '0x' + v.toString(16).padStart(2, '0')).join(', ')}`);
    await writeFile(file, lines.join('\n') + '\n');
    return [file];
  }
  const decl = `const signed char ${id}[${conv.pcm.length}] __attribute__((aligned(4)))`;
  if (ext === '.h') {
    await writeFile(file, [`// ${info}`, `#ifndef ${ID}_SND_H`, `#define ${ID}_SND_H`, ...defs, `static ${decl} = {\n${body}\n};`, '#endif', ''].join('\n'));
    return [file];
  }
  if (ext === '.c') {
    const h = file.replace(/\.c$/i, '.h');
    await writeFile(h, [`// ${info}`, `#ifndef ${ID}_SND_H`, `#define ${ID}_SND_H`, ...defs, `extern const signed char ${id}[${conv.pcm.length}];`, '#endif', ''].join('\n'));
    await writeFile(file, [`// ${info}`, `#include "${path.basename(h)}"`, '', `${decl} = {\n${body}\n};`, ''].join('\n'));
    return [file, h];
  }
  throw new Error(`unknown sound output "${ext}" (use .c, .h, .s, .bin or .wav)`);
}

/** Write a lookup table as .c (+ .h), .h or .s. */
export async function writeTable(t, file, name) {
  const id = name.replace(/\W/g, '_'), ID = id.toUpperCase(), ext = path.extname(file).toLowerCase();
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const info = t.kind === 'reciprocal' ? `${id}[i] = 2^${t.bits} / i (i = 1..${t.size - 1})` : `${id}[i] = ${t.kind}(i * 2pi / ${t.size}) * 2^${t.bits}`;
  const defs = [`#define ${ID}_SIZE ${t.size}`, `#define ${ID}_SHIFT ${t.bits} /* fractional bits */`];
  const body = list(t.values, 0, 12, String);
  if (ext === '.s') {
    const dir = t.type.includes('int') && !t.type.includes('short') ? '.word' : '.hword';
    const lines = [`@ ${info}`, '.section .rodata', '.align 2', `.global ${id}`, `${id}:`];
    for (let i = 0; i < t.values.length; i += 12) lines.push(`  ${dir} ${t.values.slice(i, i + 12).join(', ')}`);
    await writeFile(file, lines.join('\n') + '\n');
    return [file];
  }
  const decl = `const ${t.type} ${id}[${t.size}]`;
  if (ext === '.h') {
    await writeFile(file, [`// ${info}`, `#ifndef ${ID}_LUT_H`, `#define ${ID}_LUT_H`, ...defs, `static ${decl} = {\n${body}\n};`, '#endif', ''].join('\n'));
    return [file];
  }
  if (ext === '.c') {
    const h = file.replace(/\.c$/i, '.h');
    await writeFile(h, [`// ${info}`, `#ifndef ${ID}_LUT_H`, `#define ${ID}_LUT_H`, ...defs, `extern ${decl};`, '#endif', ''].join('\n'));
    await writeFile(file, [`// ${info}`, `#include "${path.basename(h)}"`, '', `${decl} = {\n${body}\n};`, ''].join('\n'));
    return [file, h];
  }
  throw new Error(`unknown table output "${ext}" (use .c, .h or .s)`);
}
