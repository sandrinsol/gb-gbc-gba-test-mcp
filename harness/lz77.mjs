// LZ77 in the GBA BIOS format (type 0x10), as decompressed by LZ77UnCompWram
// (swi 0x11) and LZ77UnCompVram (swi 0x12). Output is VRAM-safe: matches never
// copy from the previous byte, because VRAM is written 16 bits at a time.
//
// Layout: u32 header (0x10 | size << 8), then groups of one flag byte (MSB
// first, 1 = match) and 8 blocks: a literal byte, or a match of 2 bytes
// ((length - 3) << 12 | (distance - 1)), big-endian; length 3-18, distance 1-4096.

/** Compress `data` (≤ 16 MB). Returns a Buffer padded to a multiple of 4. */
export function lz77Compress(data) {
  const src = Buffer.from(data);
  if (src.length >= 1 << 24) throw new Error('LZ77: data must be under 16 MB');
  const out = [0x10, src.length & 0xff, (src.length >> 8) & 0xff, (src.length >> 16) & 0xff];
  // Hash chains of 3-byte prefixes keep the search fast.
  const head = new Map(), prev = new Int32Array(src.length).fill(-1);
  const key = (i) => (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
  const insert = (i) => { if (i + 2 < src.length) { const k = key(i); prev[i] = head.get(k) ?? -1; head.set(k, i); } };
  let i = 0;
  while (i < src.length) {
    const flagPos = out.length;
    out.push(0);
    for (let bit = 7; bit >= 0 && i < src.length; bit--) {
      let bestLen = 0, bestDist = 0;
      if (i + 2 < src.length) {
        for (let j = head.get(key(i)) ?? -1, tries = 0; j >= 0 && tries < 256; j = prev[j], tries++) {
          const dist = i - j;
          if (dist > 4096) break;
          if (dist < 2) continue; // VRAM-safe
          let len = 0;
          while (len < 18 && i + len < src.length && src[j + len] === src[i + len]) len++;
          if (len > bestLen) { bestLen = len; bestDist = dist; if (len === 18) break; }
        }
      }
      if (bestLen >= 3) {
        out[flagPos] |= 1 << bit;
        const v = ((bestLen - 3) << 12) | (bestDist - 1);
        out.push(v >> 8, v & 0xff);
        for (let k = 0; k < bestLen; k++) insert(i + k);
        i += bestLen;
      } else {
        out.push(src[i]);
        insert(i);
        i++;
      }
    }
  }
  while (out.length % 4) out.push(0);
  return Buffer.from(out);
}

/** Decompress BIOS LZ77 data (to check output). */
export function lz77Decompress(buf) {
  if (buf[0] !== 0x10) throw new Error('not LZ77 data (header type must be 0x10)');
  const size = buf[1] | (buf[2] << 8) | (buf[3] << 16);
  const out = Buffer.alloc(size);
  let o = 0, i = 4;
  while (o < size) {
    const flags = buf[i++];
    for (let bit = 7; bit >= 0 && o < size; bit--) {
      if (flags & (1 << bit)) {
        const v = (buf[i] << 8) | buf[i + 1];
        i += 2;
        const len = (v >> 12) + 3, dist = (v & 0xfff) + 1;
        for (let k = 0; k < len && o < size; k++, o++) out[o] = out[o - dist];
      } else out[o++] = buf[i++];
    }
  }
  return out;
}
