// Sprite graphics for GBA and GB/GBC: convert PNG art into the console's tile
// and palette formats (with source output for your toolchain), check it against
// hardware limits, and render sprites back out of a running game's video memory.
//
//   const s = convertSprite(png, { target: 'gba4', width: 16, height: 16 });
//   await writeSpriteSource(s, 'src/hero.h', 'hero');   // .h .c .s .asm/.inc .bin
//
// Colour index 0 is transparent, as on the hardware.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { decodePng, encodePng, contactSheet } from './png.mjs';
import { medianCut } from './recording.mjs';

/** Conversion targets: bits per pixel and visible colours per palette. */
export const TARGETS = {
  gba4: { bpp: 4, colors: 15, system: 'gba' },  // 16-colour palette bank
  gba8: { bpp: 8, colors: 255, system: 'gba' }, // 256-colour palette
  gbc: { bpp: 2, colors: 3, system: 'gb' },     // CGB OBJ palette
  gb: { bpp: 2, colors: 3, system: 'gb' },      // DMG: shades via OBP0/OBP1
};

/** GBA sprite sizes: [w, h] -> [shape, size] for OAM. */
export const GBA_OBJ_SIZES = {
  '8x8': [0, 0], '16x16': [0, 1], '32x32': [0, 2], '64x64': [0, 3],
  '16x8': [1, 0], '32x8': [1, 1], '32x16': [1, 2], '64x32': [1, 3],
  '8x16': [2, 0], '8x32': [2, 1], '16x32': [2, 2], '32x64': [2, 3],
};

const to555 = (r, g, b) => (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
export const from555 = (v) => [(v & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, ((v >> 10) & 31) * 255 / 31 | 0];
const DMG_RGB = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];
const shadeOf = (r, g, b) => 3 - Math.min(3, Math.round((0.299 * r + 0.587 * g + 0.114 * b) / 85));

/**
 * Convert a PNG (one sprite, or a sheet of equal frames, left-to-right then
 * top-to-bottom) to tiles + palette.
 * @param {Buffer} png
 * @param {object} opts
 * @param {'gba4'|'gba8'|'gbc'|'gb'} opts.target
 * @param {number} [opts.width]  frame size (default: the whole image)
 * @param {number} [opts.height]
 * @param {string} [opts.transparent]  'alpha' (default when the PNG has
 *   transparency), 'none', or a colour '#rrggbb' to treat as transparent
 * @param {boolean} [opts.quantize]  reduce colours instead of failing when over the limit
 * @returns {{ target: string, width: number, height: number, frames: number, tilesPerFrame: number,
 *   tiles: Buffer, palette: number[], obp?: number, indices: Uint8Array[], warnings: string[], previewPng: Buffer }}
 *   palette: BGR555 values (index 0 = transparent) or, for 'gb', DMG shades.
 */
export function convertSprite(png, { target, width, height, transparent, quantize = false }) {
  const T = TARGETS[target];
  if (!T) throw new Error(`target must be one of ${Object.keys(TARGETS).join(', ')}`);
  const img = decodePng(png);
  const W = width ?? img.width, H = height ?? img.height;
  const warnings = [];
  if (W % 8 || H % 8) throw new Error(`frame size ${W}x${H} must be a multiple of 8`);
  if (img.width % W || img.height % H) throw new Error(`image ${img.width}x${img.height} is not a whole number of ${W}x${H} frames`);
  if (T.system === 'gba' && !GBA_OBJ_SIZES[`${W}x${H}`]) {
    warnings.push(`${W}x${H} is not a GBA sprite size (${Object.keys(GBA_OBJ_SIZES).join(' ')}); it needs several OAM entries`);
  }
  if (T.system === 'gb' && !(W === 8 && (H === 8 || H === 16))) {
    warnings.push(`${W}x${H} is larger than one GB sprite (8x8 or 8x16): ${(W / 8) * (H / 8)} OAM entries per frame (max 40, 10 per line)`);
  }

  // Pixel → colour key (or -1 for transparent).
  const hasAlpha = img.channels === 4 && img.data.some((v, i) => i % 4 === 3 && v < 128);
  const mode = transparent ?? (hasAlpha ? 'alpha' : 'none');
  const keyRgb = /^#[0-9a-f]{6}$/i.test(mode) ? parseInt(mode.slice(1), 16) : null;
  const px = (x, y) => {
    const o = (y * img.width + x) * img.channels;
    const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
    if (img.channels === 4 && img.data[o + 3] < 128 && mode === 'alpha') return -1;
    if (keyRgb !== null && ((r << 16) | (g << 8) | b) === keyRgb) return -1;
    return T.system === 'gba' || target === 'gbc' ? to555(r, g, b) : shadeOf(r, g, b);
  };

  // Collect colours in first-seen order (stable palettes across edits).
  const keys = new Map();
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const k = px(x, y); if (k >= 0 && !keys.has(k)) keys.set(k, keys.size); }
  let map = (k) => keys.get(k);
  let palette = [...keys.keys()];
  if (palette.length > T.colors) {
    if (!quantize || target === 'gb') {
      throw new Error(target === 'gb'
        ? `the art uses ${palette.length} grey shades; GB sprites show 3 (+ transparent)`
        : `${palette.length} colours, but ${target} sprites can show ${T.colors} (+ transparent); reduce them in your editor or pass quantize: true`);
    }
    // Median-cut in RGB, then snap every colour to the nearest of the result.
    const rgb = new Uint8Array(palette.length * 3);
    palette.forEach((k, i) => rgb.set(from555(k), i * 3));
    const reduced = medianCut(rgb, T.colors).map((c) => to555(c >> 16, (c >> 8) & 255, c & 255));
    const near = new Map(palette.map((k) => {
      const [r, g, b] = from555(k);
      let best = 0, bd = Infinity;
      reduced.forEach((q, j) => { const [qr, qg, qb] = from555(q); const d = (r - qr) ** 2 + (g - qg) ** 2 + (b - qb) ** 2; if (d < bd) { bd = d; best = j; } });
      return [k, best];
    }));
    warnings.push(`reduced ${palette.length} colours to ${reduced.length}`);
    palette = reduced;
    map = (k) => near.get(k);
  }

  // Index pixels (0 = transparent) per frame, then pack tiles row-major per frame.
  const cols = img.width / W, rows = img.height / H, frames = cols * rows;
  const tilesPerFrame = (W / 8) * (H / 8);
  const tileBytes = T.bpp * 8;
  const tiles = Buffer.alloc(frames * tilesPerFrame * tileBytes);
  const indices = [];
  for (let f = 0; f < frames; f++) {
    const fx = (f % cols) * W, fy = Math.floor(f / cols) * H;
    const idx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = px(fx + x, fy + y); idx[y * W + x] = k < 0 ? 0 : map(k) + 1; }
    indices.push(idx);
    for (let t = 0; t < tilesPerFrame; t++) {
      const tx = (t % (W / 8)) * 8, ty = Math.floor(t / (W / 8)) * 8;
      const o = (f * tilesPerFrame + t) * tileBytes;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const v = idx[(ty + y) * W + tx + x];
        if (T.bpp === 4) tiles[o + y * 4 + (x >> 1)] |= x & 1 ? v << 4 : v;
        else if (T.bpp === 8) tiles[o + y * 8 + x] = v;
        else { tiles[o + y * 2] |= (v & 1) << (7 - x); tiles[o + y * 2 + 1] |= ((v >> 1) & 1) << (7 - x); }
      }
    }
  }

  // DMG: index i shows shade palette[i-1] through OBP (index 0 transparent).
  let obp;
  if (target === 'gb') obp = palette.reduce((v, shade, i) => v | (shade << ((i + 1) * 2)), 0);
  const total = frames * tilesPerFrame * (T.bpp === 8 ? 2 : 1);
  const budget = T.system === 'gba' ? 1024 : 256;
  if (total > budget) warnings.push(`${total} tiles exceed sprite VRAM (${budget}${T.system === 'gba' ? '; 512 in bitmap modes' : ''})`);

  const out = { target, width: W, height: H, frames, tilesPerFrame, tiles, palette, obp, indices, warnings, previewPng: null };
  out.previewPng = contactSheet(indices.map((i) => framePng(out, i)), { cols: Math.min(frames, 8), scale: 1 });
  return out;
}

/** RGB(A) of converted palette entry i (0 = transparent). */
function rgbOf(conv, i) {
  const v = conv.palette[i - 1];
  return conv.target === 'gb' ? DMG_RGB[v] : from555(v);
}

/** One converted frame as a PNG, exactly as the hardware would colour it
 *  (transparent pixels shown as a dark checkerboard). */
export function framePng(conv, idx) {
  const { width: W, height: H } = conv;
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx[y * W + x], o = (y * W + x) * 3;
    const c = i ? rgbOf(conv, i) : ((x >> 2) + (y >> 2)) & 1 ? [48, 48, 56] : [64, 64, 72];
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
  }
  return encodePng({ width: W, height: H, data });
}

/** Draw a converted frame onto a screenshot at (x, y), as the console would
 *  (transparent pixels let the background through). → PNG */
export function overlayFrame(screenPng, conv, frame, x, y) {
  const s = decodePng(screenPng);
  const data = new Uint8Array(s.width * s.height * 3);
  for (let i = 0, j = 0; i < s.data.length; i += s.channels, j += 3) { data[j] = s.data[i]; data[j + 1] = s.data[i + 1]; data[j + 2] = s.data[i + 2]; }
  const idx = conv.indices[frame];
  for (let py = 0; py < conv.height; py++) for (let px = 0; px < conv.width; px++) {
    const v = idx[py * conv.width + px], X = x + px, Y = y + py;
    if (!v || X < 0 || Y < 0 || X >= s.width || Y >= s.height) continue;
    data.set(rgbOf(conv, v), (Y * s.width + X) * 3);
  }
  return encodePng({ width: s.width, height: s.height, data });
}

// ---- Source output ----

const hexList = (arr, width, perLine) => {
  const lines = [];
  for (let i = 0; i < arr.length; i += perLine) lines.push('  ' + Array.from(arr.slice(i, i + perLine), (v) => '0x' + v.toString(16).padStart(width, '0')).join(', '));
  return lines.join(',\n');
};

/** Write tiles + palette for a toolchain; the format comes from the extension:
 *  .h (header-only C), .c (+ a matching .h), .s (GNU as / devkitARM),
 *  .asm or .inc (RGBDS), .bin (NAME.tiles.bin + NAME.pal.bin next to it).
 *  → list of files written */
export async function writeSpriteSource(conv, file, name) {
  const id = name.replace(/\W/g, '_');
  const ext = path.extname(file).toLowerCase();
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const gba = TARGETS[conv.target].system === 'gba';
  const words = gba ? new Uint32Array(conv.tiles.buffer.slice(conv.tiles.byteOffset, conv.tiles.byteOffset + conv.tiles.length)) : null;
  const pal = conv.target === 'gb' ? [] : [0, ...conv.palette]; // slot 0 (transparent) included
  const info = `${conv.frames} frame(s) of ${conv.width}x${conv.height}, ${conv.tilesPerFrame} tile(s) each, ${conv.target}`;
  const defs = [`#define ${id.toUpperCase()}_FRAMES ${conv.frames}`, `#define ${id.toUpperCase()}_TILES_PER_FRAME ${conv.tilesPerFrame}`];
  if (conv.target === 'gb') defs.push(`#define ${id.toUpperCase()}_OBP 0x${conv.obp.toString(16).padStart(2, '0')} /* OBP0/OBP1 value */`);
  const cTiles = (pre) => gba
    ? `${pre}const unsigned int ${id}_tiles[${words.length}] = {\n${hexList(words, 8, 8)}\n};`
    : `${pre}const unsigned char ${id}_tiles[${conv.tiles.length}] = {\n${hexList(conv.tiles, 2, 16)}\n};`;
  const cPal = (pre) => (pal.length ? `${pre}const unsigned short ${id}_pal[${pal.length}] = {\n${hexList(pal, 4, 8)}\n};` : '');

  if (ext === '.bin') {
    const base = file.replace(/\.bin$/i, '');
    const files = [`${base}.tiles.bin`];
    await writeFile(files[0], conv.tiles);
    if (pal.length) {
      const p = Buffer.alloc(pal.length * 2);
      pal.forEach((v, i) => p.writeUInt16LE(v, i * 2));
      files.push(`${base}.pal.bin`);
      await writeFile(files[1], p);
    }
    return files;
  }
  if (ext === '.h') {
    const guard = `${id.toUpperCase()}_H`;
    await writeFile(file, [`// ${info}`, `#ifndef ${guard}`, `#define ${guard}`, ...defs, cTiles('static '), cPal('static '), `#endif`, ''].filter((l) => l !== '').join('\n') + '\n');
    return [file];
  }
  if (ext === '.c') {
    const h = file.replace(/\.c$/i, '.h'), guard = `${id.toUpperCase()}_H`;
    const ext2 = [gba ? `extern const unsigned int ${id}_tiles[${words.length}];` : `extern const unsigned char ${id}_tiles[${conv.tiles.length}];`];
    if (pal.length) ext2.push(`extern const unsigned short ${id}_pal[${pal.length}];`);
    await writeFile(h, [`// ${info}`, `#ifndef ${guard}`, `#define ${guard}`, ...defs, ...ext2, '#endif', ''].join('\n'));
    await writeFile(file, [`// ${info}`, `#include "${path.basename(h)}"`, cTiles(''), cPal(''), ''].filter((l) => l !== '').join('\n\n') + '\n');
    return [file, h];
  }
  if (ext === '.s') {
    const lines = [`@ ${info}`, '.section .rodata', '.align 2', `.global ${id}_tiles`, `${id}_tiles:`];
    for (let i = 0; i < (words ? words.length : conv.tiles.length); i += 8) {
      lines.push(words ? `  .word ${Array.from(words.slice(i, i + 8), (v) => '0x' + v.toString(16).padStart(8, '0')).join(', ')}`
        : `  .byte ${Array.from(conv.tiles.subarray(i, i + 8), (v) => '0x' + v.toString(16).padStart(2, '0')).join(', ')}`);
    }
    if (pal.length) {
      lines.push('.align 2', `.global ${id}_pal`, `${id}_pal:`);
      for (let i = 0; i < pal.length; i += 8) lines.push(`  .hword ${pal.slice(i, i + 8).map((v) => '0x' + v.toString(16).padStart(4, '0')).join(', ')}`);
    }
    await writeFile(file, lines.join('\n') + '\n');
    return [file];
  }
  if (ext === '.asm' || ext === '.inc') {
    const lines = [`; ${info}`, `SECTION "${id}", ROM0`, `${id}_tiles::`];
    for (let i = 0; i < conv.tiles.length; i += 16) lines.push(`  db ${Array.from(conv.tiles.subarray(i, i + 16), (v) => '$' + v.toString(16).padStart(2, '0')).join(', ')}`);
    lines.push(`${id}_tiles_end::`);
    if (pal.length) {
      lines.push(`${id}_pal::`);
      lines.push(`  dw ${pal.map((v) => '$' + v.toString(16).padStart(4, '0')).join(', ')}`);
    }
    if (conv.target === 'gb') lines.push(`DEF ${id.toUpperCase()}_OBP EQU $${conv.obp.toString(16).padStart(2, '0')}`);
    await writeFile(file, lines.join('\n') + '\n');
    return [file];
  }
  throw new Error(`unknown output "${ext}" (use .h, .c, .s, .asm, .inc or .bin)`);
}

// ---- Reading sprites back out of video memory ----

/** Render one sprite (an entry from gbaSprites/gbSprites) from VRAM as RGBA PNG
 *  pixels → PNG. Affine sprites are drawn without their rotation/scale. */
export function renderSprite(system, regions, s) {
  const W = s.dbl ? s.w / 2 : s.w, H = s.dbl ? s.h / 2 : s.h; // double-size affine: graphics are half the box
  const rgba = new Uint8Array(W * H * 4);
  const put = (x, y, rgb) => { const tx = s.hflip ? W - 1 - x : x, ty = s.vflip ? H - 1 - y : y; const o = (ty * W + tx) * 4; rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = 255; };
  if (system === 'gba') {
    const oneD = !!(regions.io.readUInt16LE(0) & 0x40);
    const pal = regions.pram, vram = regions.vram;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      // Tiles are counted in 32-byte slots; an 8bpp tile takes two. 1D mapping
      // packs a sprite's tiles in sequence, 2D uses a 32-slot-wide grid.
      const tx = x >> 3, ty = y >> 3, k = s.bpp8 ? 2 : 1;
      const tile = s.tile + (oneD ? (ty * (W / 8) + tx) * k : ty * 32 + tx * k);
      const base = 0x10000 + (tile & 0x3ff) * 32;
      let v;
      if (s.bpp8) v = vram[base + (y & 7) * 8 + (x & 7)];
      else { const b = vram[base + (y & 7) * 4 + ((x & 7) >> 1)]; v = x & 1 ? b >> 4 : b & 15; }
      if (!v) continue;
      put(x, y, from555(pal.readUInt16LE(0x200 + (s.bpp8 ? v : s.palette * 16 + v) * 2)));
    }
  } else {
    const cgb = !!regions.isCgbWram, objp = regions.fields?.objp;
    const vram = regions.vram.subarray(cgb && s.bank ? 0x2000 : 0, (cgb && s.bank ? 0x2000 : 0) + 0x1000);
    const obp = regions.io[s.palette ? 0x49 : 0x48];
    for (let y = 0; y < H; y++) for (let x = 0; x < 8; x++) {
      const tile = (s.tile + (y >> 3)) & 0xff, o = tile * 16 + (y & 7) * 2;
      const v = ((vram[o] >> (7 - x)) & 1) | (((vram[o + 1] >> (7 - x)) & 1) << 1);
      if (!v) continue;
      put(x, y, cgb && objp ? from555(objp[s.palette * 8 + v * 2] | (objp[s.palette * 8 + v * 2 + 1] << 8)) : DMG_RGB[(obp >> (v * 2)) & 3]);
    }
  }
  return encodePng({ width: W, height: H, data: rgba, channels: 4 });
}

/** Scanlines where sprites exceed what the hardware draws: GB shows at most 10
 *  sprites per line; GBA has a per-line budget of 1210 cycles (954 with HBlank
 *  interval free), a normal sprite costing its width and an affine one 2*width+10.
 *  → ['line 40: 12 sprites (GB max 10)', ...] (consecutive lines merged) */
export function spriteLimitWarnings(system, sprites, regions) {
  const per = new Map();
  const lines = system === 'gba' ? 160 : 144;
  for (const s of sprites) {
    if (!s.onScreen) continue;
    for (let y = Math.max(0, s.y); y < Math.min(lines, s.y + s.h); y++) {
      const v = per.get(y) || { n: 0, cycles: 0 };
      v.n++; v.cycles += s.affine ? 2 * s.w + 10 : s.w;
      per.set(y, v);
    }
  }
  const budget = system === 'gba' ? (regions.io.readUInt16LE(0) & 0x20 ? 954 : 1210) : 0;
  const bad = [...per].filter(([, v]) => (system === 'gba' ? v.cycles > budget : v.n > 10)).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < bad.length;) {
    let j = i;
    while (j + 1 < bad.length && bad[j + 1][0] === bad[j][0] + 1) j++;
    const worst = bad.slice(i, j + 1).reduce((m, [, v]) => (system === 'gba' ? Math.max(m, v.cycles) : Math.max(m, v.n)), 0);
    const range = i === j ? `line ${bad[i][0]}` : `lines ${bad[i][0]}-${bad[j][0]}`;
    out.push(system === 'gba' ? `${range}: ${worst} sprite cycles (max ${budget}) — some sprites won't be drawn` : `${range}: ${worst} sprites (max 10) — some won't be drawn`);
    i = j + 1;
  }
  return out;
}

// ---- Hot-swap: put a converted sprite into the running game ----

/** Write frame `frame` of a converted sprite into the game's video memory and
 *  sprite table on the current frame: tiles (default: the end of sprite VRAM, so
 *  the game's own graphics are untouched), palette slot, OAM entries (from `oam`),
 *  and switch sprites on. The game keeps running; if it rewrites OAM every frame
 *  it will replace the entry — use overlayFrame() for a preview that can't be
 *  overwritten. → { tile, oamEntries, notes } */
export async function injectSprite(emu, conv, { frame = 0, x = 0, y = 0, tile = undefined, palette = 0, oam = 0, priority = 0 } = {}) {
  const T = TARGETS[conv.target];
  if (T.system !== emu.system) throw new Error(`a ${conv.target} sprite can't go into a ${emu.system === 'gb' ? 'GB/GBC' : 'GBA'} game`);
  const regions = await emu.readRegions();
  const idx = conv.indices[frame];
  if (!idx) throw new Error(`frame ${frame} out of range (0-${conv.frames - 1})`);
  const W = conv.width, H = conv.height, notes = [];
  const writes = [];

  if (T.system === 'gba') {
    const size = GBA_OBJ_SIZES[`${W}x${H}`];
    if (!size) throw new Error(`${W}x${H} isn't a GBA sprite size; use the overlay preview`);
    const dispcnt = regions.io.readUInt16LE(0), oneD = !!(dispcnt & 0x40), bitmap = (dispcnt & 7) >= 3;
    const k = T.bpp === 8 ? 2 : 1, n = (W / 8) * (H / 8) * k;
    const slots = bitmap ? [512, 1024] : [0, 1024];
    tile ??= oneD ? slots[1] - n : (1024 - (H / 8) * 32);
    if (tile < slots[0] || tile + (oneD ? n : (H / 8 - 1) * 32 + (W / 8) * k) > slots[1]) throw new Error(`tile ${tile} doesn't fit sprite VRAM`);
    if (k === 2 && tile % 2) throw new Error('256-colour sprites need an even tile number');
    const bytes = T.bpp * 8;
    for (let t = 0; t < (W / 8) * (H / 8); t++) {
      const tx = t % (W / 8), ty = Math.floor(t / (W / 8));
      const slot = oneD ? tile + t * k : tile + ty * 32 + tx * k;
      writes.push([0x06010000 + slot * 32, conv.tiles.subarray((frame * conv.tilesPerFrame + t) * bytes, (frame * conv.tilesPerFrame + t + 1) * bytes)]);
    }
    const pal = Buffer.alloc((T.bpp === 8 ? 256 : 16) * 2);
    conv.palette.forEach((v, i) => pal.writeUInt16LE(v, (i + 1) * 2));
    writes.push([0x05000200 + (T.bpp === 8 ? 0 : palette * 32), pal]);
    const o = Buffer.alloc(6);
    o.writeUInt16LE((y & 0xff) | (T.bpp === 8 ? 0x2000 : 0) | (size[0] << 14), 0);
    o.writeUInt16LE((x & 0x1ff) | (size[1] << 14), 2);
    o.writeUInt16LE(tile | (priority << 10) | (T.bpp === 8 ? 0 : palette << 12), 4);
    writes.push([0x07000000 + oam * 8, o]);
    const d = Buffer.alloc(2); d.writeUInt16LE(dispcnt | 0x1000); writes.push([0x04000000, d]);
    await emu.patchState((state, mem) => { for (const [a, b] of writes) mem.writeMemory(state, a, b); });
    return { tile, oamEntries: 1, notes };
  }

  // GB/GBC: 8x8 entries, or 8x16 when the game has tall sprites on (LCDC bit 2).
  const lcdc = regions.io[0x40], tall = !!(lcdc & 0x04) || (W === 8 && H === 16);
  const eh = tall ? 16 : 8;
  if (H % eh) throw new Error(`with 8x16 sprites on, the height must be a multiple of 16`);
  const cols = W / 8, rows = H / eh, entries = cols * rows, n = entries * (eh / 8);
  if (oam + entries > 40) throw new Error(`needs ${entries} OAM entries from ${oam}; only 40 exist`);
  tile ??= 256 - n;
  if (tall && tile % 2) throw new Error('8x16 sprites need an even tile number');
  if (tile < 0 || tile + n > 256) throw new Error(`tile ${tile} doesn't fit sprite VRAM`);
  const cgb = !!regions.isCgbWram;
  if (cgb !== (conv.target === 'gbc')) notes.push(`converted as ${conv.target} but the game is ${cgb ? 'GBC' : 'DMG'}; colours may be off`);
  const tileBytes = (tx, ty) => {
    const b = Buffer.alloc(16);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const v = idx[(ty * 8 + r) * W + tx * 8 + c];
      b[r * 2] |= (v & 1) << (7 - c); b[r * 2 + 1] |= ((v >> 1) & 1) << (7 - c);
    }
    return b;
  };
  const oamBytes = Buffer.alloc(entries * 4);
  let t = tile;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const e = r * cols + c;
    for (let h = 0; h < eh / 8; h++) writes.push([0x8000 + (t + h) * 16, tileBytes(c, r * (eh / 8) + h)]);
    oamBytes[e * 4] = (y + r * eh + 16) & 0xff; oamBytes[e * 4 + 1] = (x + c * 8 + 8) & 0xff;
    oamBytes[e * 4 + 2] = t; oamBytes[e * 4 + 3] = (priority ? 0x80 : 0) | (cgb ? palette & 7 : (palette & 1) << 4);
    t += eh / 8;
  }
  writes.push([0xfe00 + oam * 4, oamBytes]);
  writes.push([0xff40, Buffer.from([lcdc | 0x02 | (tall ? 0x04 : 0)])]);
  if (tall && !(lcdc & 0x04)) notes.push('switched the game to 8x16 sprites (LCDC bit 2)');
  if (!cgb && conv.target === 'gb') writes.push([palette & 1 ? 0xff49 : 0xff48, Buffer.from([conv.obp])]);
  await emu.patchState((state, mem) => {
    for (const [a, b] of writes) mem.writeMemory(state, a, b);
    // gambatte renders from its palette fields: CGB colours in objp; on DMG,
    // objp[0]/objp[1] hold OBP0/OBP1 (the register alone isn't enough).
    const objp = mem.parseState(state).fields.objp;
    if (objp && cgb) conv.palette.forEach((v, i) => { objp[palette * 8 + (i + 1) * 2] = v & 255; objp[palette * 8 + (i + 1) * 2 + 1] = v >> 8; });
    if (objp && !cgb && conv.target === 'gb') objp[palette & 1] = conv.obp;
  });
  return { tile, oamEntries: entries, notes };
}
