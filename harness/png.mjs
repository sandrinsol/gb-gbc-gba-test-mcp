// Minimal zero-dependency PNG decode/encode for 8-bit RGB/RGBA, no interlace.
// Enough to diff emulator screenshots and write diff images.

import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Decode a PNG buffer → { width, height, channels, data:Uint8Array }: RGB
 *  (channels 3) for opaque truecolour/greyscale, else RGBA (channels 4). Handles
 *  every non-interlaced PNG: greyscale, truecolour, palette (+ tRNS transparency),
 *  with/without alpha, bit depths 1-16. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let p = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!samples) throw new Error(`unsupported color type ${colorType}`);
  if (colorType === 3 && !plte) throw new Error('palette PNG without PLTE');

  // Undo the per-row filters on raw bytes.
  const bpp = Math.max(1, (samples * bitDepth) >> 3);
  const stride = Math.ceil((width * samples * bitDepth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytes = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1, rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? bytes[rowOut + x - bpp] : 0;
      const b = y > 0 ? bytes[rowOut - stride + x] : 0;
      const c = x >= bpp && y > 0 ? bytes[rowOut - stride + x - bpp] : 0;
      let v = raw[rowIn + x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff; break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      bytes[rowOut + x] = v;
    }
  }

  // Read sample i of row y (scaled to 8 bits; palette indices stay raw).
  const sample = (y, i) => {
    if (bitDepth === 8) return bytes[y * stride + i];
    if (bitDepth === 16) return bytes[y * stride + i * 2];
    const bit = i * bitDepth, byte = bytes[y * stride + (bit >> 3)];
    const v = (byte >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
    return colorType === 3 ? v : Math.round(v * 255 / ((1 << bitDepth) - 1));
  };
  const keyed = trns && (colorType === 0 || colorType === 2);
  const channels = colorType === 4 || colorType === 6 || colorType === 3 || keyed ? 4 : 3;
  const out = new Uint8Array(width * height * channels);
  const trnsKey = keyed ? (colorType === 0 ? [trns.readUInt16BE(0)] : [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)])
    .map((v) => (bitDepth === 16 ? v >> 8 : bitDepth < 8 ? Math.round(v * 255 / ((1 << bitDepth) - 1)) : v)) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r, g, b, al = 255;
      if (colorType === 3) {
        const i = sample(y, x);
        r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2];
        if (trns && i < trns.length) al = trns[i];
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = sample(y, x * samples);
        if (colorType === 4) al = sample(y, x * 2 + 1);
      } else {
        r = sample(y, x * samples); g = sample(y, x * samples + 1); b = sample(y, x * samples + 2);
        if (colorType === 6) al = sample(y, x * 4 + 3);
      }
      if (trnsKey && (colorType === 0 ? r === trnsKey[0] : r === trnsKey[0] && g === trnsKey[1] && b === trnsKey[2])) al = 0;
      const o = (y * width + x) * channels;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
      if (channels === 4) out[o + 3] = al;
    }
  }
  return { width, height, channels, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode { width, height, data:Uint8Array, channels? } → PNG buffer.
 *  channels 3 (RGB, default) or 4 (RGBA). */
export function encodePng({ width, height, data, channels = 3 }) {
  const stride = width * channels;
  const rawWithFilters = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    rawWithFilters[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride)
      .copy(rawWithFilters, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawWithFilters)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Nearest-neighbour upscale a PNG by an integer factor (pixel-exact, no blur) so
 *  small console frames are legible to vision models. Returns a PNG buffer. */
export function scalePng(buf, factor = 1) {
  if (factor === 1) return buf;
  const src = decodePng(buf);
  const w = src.width * factor, h = src.height * factor;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = (y / factor) | 0;
    for (let x = 0; x < w; x++) {
      const si = (sy * src.width + ((x / factor) | 0)) * src.channels, o = (y * w + x) * 3;
      out[o] = src.data[si]; out[o + 1] = src.data[si + 1]; out[o + 2] = src.data[si + 2];
    }
  }
  return encodePng({ width: w, height: h, data: out });
}

/** Tile same-sized PNG frames into one grid image (a "contact sheet"), so a whole
 *  animation can be seen in a single image. `gap` px of dark grey between tiles. */
export function contactSheet(bufs, { cols = 4, gap = 2, scale = 1 } = {}) {
  const frames = bufs.map(decodePng);
  const fw = frames[0].width, fh = frames[0].height;
  cols = Math.max(1, Math.min(cols, frames.length));
  const rows = Math.ceil(frames.length / cols);
  const w = cols * fw + (cols - 1) * gap, h = rows * fh + (rows - 1) * gap;
  const out = new Uint8Array(w * h * 3).fill(40);
  frames.forEach((f, i) => {
    if (f.width !== fw || f.height !== fh) throw new Error('contactSheet: frames differ in size');
    const ox = (i % cols) * (fw + gap), oy = Math.floor(i / cols) * (fh + gap);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const si = (y * fw + x) * f.channels, o = ((oy + y) * w + ox + x) * 3;
      out[o] = f.data[si]; out[o + 1] = f.data[si + 1]; out[o + 2] = f.data[si + 2];
    }
  });
  return scalePng(encodePng({ width: w, height: h, data: out }), scale);
}
