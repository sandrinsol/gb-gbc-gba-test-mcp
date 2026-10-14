// Indexed BMP files (4 or 8 bits per pixel, 40-byte header, bottom-up rows): the
// format Butano and grit read for GBA graphics, palette index 0 = transparent.

/** @param {{ width: number, height: number, pixels: Uint8Array, palette: number[][], bpp: 4 | 8 }} img
 *  pixels: one palette index per pixel, row-major; palette: [r, g, b] entries. */
export function encodeIndexedBmp({ width, height, pixels, palette, bpp }) {
  const colors = bpp === 4 ? 16 : Math.max(16, Math.min(256, Math.ceil(palette.length / 16) * 16));
  const rowBytes = Math.ceil((width * bpp) / 32) * 4;
  const pixOffset = 14 + 40 + colors * 4;
  const size = pixOffset + rowBytes * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(pixOffset, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(bpp, 28);
  b.writeUInt32LE(rowBytes * height, 34);
  b.writeUInt32LE(colors, 46);
  for (let i = 0; i < colors; i++) {
    const [r, g, bl] = palette[i] ?? [0, 0, 0];
    b[54 + i * 4] = bl; b[54 + i * 4 + 1] = g; b[54 + i * 4 + 2] = r;
  }
  for (let y = 0; y < height; y++) {
    const o = pixOffset + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const v = pixels[y * width + x];
      if (bpp === 8) b[o + x] = v;
      else b[o + (x >> 1)] |= x & 1 ? v & 15 : (v & 15) << 4;
    }
  }
  return b;
}
