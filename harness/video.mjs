// Decode video memory out of parsed save-state regions: the sprite table (OAM),
// tile graphics and palettes, for GBA and GB/GBC. Lets an agent find objects on
// screen (the player, enemies) and inspect graphics without a RAM search.

import { encodePng, decodePng } from './png.mjs';

// ---- Sprites ----

const GBA_SIZES = [ // [shape][size] -> [w, h]
  [[8, 8], [16, 16], [32, 32], [64, 64]],
  [[16, 8], [32, 8], [32, 16], [64, 32]],
  [[8, 16], [8, 32], [16, 32], [32, 64]],
];

/** GBA OAM → 128 sprites: { index, x, y, w, h, tile, palette, priority, hflip,
 *  vflip, affine, mode, bpp8, hidden, onScreen }. x/y are screen pixels (wrapped
 *  to negative when partly off the top/left). */
export function gbaSprites(regions) {
  const oam = regions.oam;
  const objOn = !!(regions.io.readUInt16LE(0) & 0x1000); // DISPCNT.OBJ
  const out = [];
  for (let i = 0; i < 128; i++) {
    const a0 = oam.readUInt16LE(i * 8), a1 = oam.readUInt16LE(i * 8 + 2), a2 = oam.readUInt16LE(i * 8 + 4);
    const affine = !!(a0 & 0x100), shape = (a0 >> 14) & 3, size = (a1 >> 14) & 3;
    const [w, h] = GBA_SIZES[shape]?.[size] ?? [8, 8];
    const dbl = affine && (a0 & 0x200) ? 2 : 1;
    let y = a0 & 0xff, x = a1 & 0x1ff;
    if (y + h * dbl > 256) y -= 256;
    if (x >= 256) x -= 512;
    const hidden = !objOn || (!affine && !!(a0 & 0x200)) || shape === 3;
    const W = w * dbl, H = h * dbl;
    out.push({
      index: i, x, y, w: W, h: H, tile: a2 & 0x3ff, palette: a2 >> 12, priority: (a2 >> 10) & 3,
      hflip: !affine && !!(a1 & 0x1000), vflip: !affine && !!(a1 & 0x2000), affine, dbl: dbl === 2,
      mode: ['normal', 'semi-transparent', 'window', 'prohibited'][(a0 >> 10) & 3], bpp8: !!(a0 & 0x2000),
      hidden, onScreen: !hidden && x < 240 && x + W > 0 && y < 160 && y + H > 0,
    });
  }
  return out;
}

/** GB/GBC OAM → 40 sprites: { index, x, y, w, h, tile, palette, priority, hflip,
 *  vflip, bank, onScreen }. `palette` is OBP0/1 on DMG, 0-7 on CGB. */
export function gbSprites(regions, { cgb = false } = {}) {
  const oam = regions.hram; // 0xFE00 block: OAM is its first 0xA0 bytes
  const lcdc = regions.io[0x40];
  const objOn = !!(lcdc & 0x02), tall = !!(lcdc & 0x04);
  const out = [];
  for (let i = 0; i < 40; i++) {
    const y = oam[i * 4] - 16, x = oam[i * 4 + 1] - 8, tile = oam[i * 4 + 2], f = oam[i * 4 + 3];
    const h = tall ? 16 : 8;
    out.push({
      index: i, x, y, w: 8, h, tile: tall ? tile & 0xfe : tile,
      palette: cgb ? f & 7 : (f >> 4) & 1, priority: f & 0x80 ? 'behind-bg' : 'above-bg',
      hflip: !!(f & 0x20), vflip: !!(f & 0x40), bank: cgb ? (f >> 3) & 1 : 0,
      affine: false, hidden: !objOn, onScreen: objOn && x > -8 && x < 160 && y > -h && y < 144,
    });
  }
  return out;
}

/** Draw 1px rectangle outlines (screen coordinates) onto a PNG scaled by `scale`
 *  (the boxes are scaled too). Colours cycle so neighbouring boxes differ. */
export function drawBoxes(pngBuf, boxes, scale = 1) {
  const img = decodePng(pngBuf);
  const W = img.width * scale, H = img.height * scale;
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = (((y / scale) | 0) * img.width + ((x / scale) | 0)) * img.channels, o = (y * W + x) * 3;
    out[o] = img.data[si]; out[o + 1] = img.data[si + 1]; out[o + 2] = img.data[si + 2];
  }
  const COLORS = [[255, 0, 255], [0, 255, 255], [255, 255, 0], [0, 255, 0], [255, 128, 0], [255, 0, 0]];
  boxes.forEach((b, n) => {
    const [r, g, bl] = COLORS[n % COLORS.length];
    const x0 = b.x * scale, y0 = b.y * scale, x1 = (b.x + b.w) * scale - 1, y1 = (b.y + b.h) * scale - 1;
    const put = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) { const o = (y * W + x) * 3; out[o] = r; out[o + 1] = g; out[o + 2] = bl; } };
    for (let x = x0; x <= x1; x++) { put(x, y0); put(x, y1); }
    for (let y = y0; y <= y1; y++) { put(x0, y); put(x1, y); }
  });
  return encodePng({ width: W, height: H, data: out });
}

// ---- Palettes ----

const bgr555 = (v) => [(v & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, ((v >> 10) & 31) * 255 / 31 | 0];
const DMG_SHADES = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];

/** GBA palette RAM → { bg: [[r,g,b] x256], obj: [[r,g,b] x256] }. */
export function gbaPalettes(regions) {
  const p = regions.pram;
  const read = (base) => Array.from({ length: 256 }, (_, i) => bgr555(p.readUInt16LE(base + i * 2)));
  return { bg: read(0), obj: read(0x200) };
}

/** GB palettes → { bg: [[[r,g,b] x4] x n], obj: [...] }. DMG: BGP / OBP0 / OBP1
 *  mapped to grey shades; CGB: the 8 BG and 8 OBJ colour palettes. */
export function gbPalettes(regions, { cgb = false } = {}) {
  const f = regions.fields || {};
  if (cgb && f.bgp && f.objp) {
    const read = (b) => Array.from({ length: 8 }, (_, p) => Array.from({ length: 4 }, (_, c) => bgr555(b[p * 8 + c * 2] | (b[p * 8 + c * 2 + 1] << 8))));
    return { bg: read(f.bgp), obj: read(f.objp) };
  }
  const dmg = (reg) => Array.from({ length: 4 }, (_, c) => DMG_SHADES[(reg >> (c * 2)) & 3]);
  return { bg: [dmg(regions.io[0x47])], obj: [dmg(regions.io[0x48]), dmg(regions.io[0x49])] };
}

/** Render palettes as a grid of `cell`-px swatches, one palette (or 16 colours on
 *  GBA) per row: BG rows first, then OBJ rows. */
export function palettesPng(pal, { cell = 12 } = {}) {
  const rows = [];
  const chunk = (cols, n) => { for (let i = 0; i < cols.length; i += n) rows.push(cols.slice(i, i + n)); };
  if (Array.isArray(pal.bg[0][0])) { pal.bg.forEach((p) => rows.push(p)); pal.obj.forEach((p) => rows.push(p)); }
  else { chunk(pal.bg, 16); chunk(pal.obj, 16); }
  const cols = Math.max(...rows.map((r) => r.length));
  const W = cols * cell, H = rows.length * cell;
  const out = new Uint8Array(W * H * 3).fill(40);
  rows.forEach((row, ry) => row.forEach(([r, g, b], cx) => {
    for (let y = 1; y < cell; y++) for (let x = 1; x < cell; x++) {
      const o = ((ry * cell + y) * W + cx * cell + x) * 3; out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }));
  return encodePng({ width: W, height: H, data: out });
}

// ---- Tiles ----

function tileSheet(count, cols, decodePixel, colors) {
  const rows = Math.ceil(count / cols), W = cols * 8, H = rows * 8;
  const out = new Uint8Array(W * H * 3);
  for (let t = 0; t < count; t++) {
    const ox = (t % cols) * 8, oy = Math.floor(t / cols) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const [r, g, b] = colors[decodePixel(t, x, y)] ?? [0, 0, 0];
      const o = ((oy + y) * W + ox + x) * 3; out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  return encodePng({ width: W, height: H, data: out });
}

/** GBA tile graphics. region 'bg' = char blocks 0-3 (0x06000000-0x0600FFFF),
 *  'obj' = sprite tiles (0x06010000-0x06017FFF). 4bpp tiles use 16-colour palette
 *  bank `palette`; bpp8 uses the full 256-colour palette. 32 tiles per row. */
export function gbaTilesPng(regions, { region = 'bg', palette = 0, bpp8 = false } = {}) {
  const base = region === 'obj' ? 0x10000 : 0, size = region === 'obj' ? 0x8000 : 0x10000;
  const vram = regions.vram;
  const pal = gbaPalettes(regions)[region === 'obj' ? 'obj' : 'bg'];
  if (bpp8) {
    return tileSheet(size / 64, 32, (t, x, y) => vram[base + t * 64 + y * 8 + x], pal);
  }
  const colors = pal.slice(palette * 16, palette * 16 + 16);
  return tileSheet(size / 32, 32, (t, x, y) => {
    const b = vram[base + t * 32 + y * 4 + (x >> 1)];
    return x & 1 ? b >> 4 : b & 15;
  }, colors);
}

/** GB tile graphics: the 384 tiles at 0x8000-0x97FF of VRAM bank `bank`, 16 per
 *  row, coloured with BG palette `palette` (DMG: BGP shades). */
export function gbTilesPng(regions, { bank = 0, palette = 0, cgb = false } = {}) {
  const vram = regions.vram.subarray(bank * 0x2000, bank * 0x2000 + 0x1800);
  const colors = gbPalettes(regions, { cgb }).bg[palette] ?? DMG_SHADES;
  return tileSheet(384, 16, (t, x, y) => {
    const lo = vram[t * 16 + y * 2], hi = vram[t * 16 + y * 2 + 1], bit = 7 - x;
    return ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
  }, colors);
}

/** GB/GBC display and interrupt registers as short lines of text. */
export function gbIoLines(regions, cpu) {
  const io = regions.io, lcdc = io[0x40], stat = io[0x41];
  const map = (b) => (b ? '0x9C00' : '0x9800');
  const pal = (v) => [0, 1, 2, 3].map((c) => (v >> (c * 2)) & 3).join('');
  const IRQ = ['vblank', 'stat', 'timer', 'serial', 'joypad'];
  const irqs = (bits) => IRQ.filter((_, i) => bits & (1 << i)).join(', ') || 'none';
  const lines = [
    `LCDC 0x${lcdc.toString(16)}: LCD ${lcdc & 0x80 ? 'on' : 'OFF'} · BG ${lcdc & 1 ? 'on' : 'off'} map ${map(lcdc & 8)} tiles ${lcdc & 0x10 ? '0x8000' : '0x8800 (signed)'} · window ${lcdc & 0x20 ? `on map ${map(lcdc & 0x40)} at ${io[0x4b] - 7},${io[0x4a]}` : 'off'} · sprites ${lcdc & 2 ? 'on' : 'off'} ${lcdc & 4 ? '8x16' : '8x8'}`,
    `scroll ${io[0x43]},${io[0x42]} · LY ${io[0x44]} LYC ${io[0x45]} · STAT mode ${stat & 3}${stat & 0x78 ? ` irq on ${['HBlank', 'VBlank', 'OAM', 'LYC'].filter((_, i) => stat & (8 << i)).join('+')}` : ''}`,
    `palettes (colour 0-3 → shade): BGP ${pal(io[0x47])} OBP0 ${pal(io[0x48])} OBP1 ${pal(io[0x49])}`,
    `interrupts: IME ${cpu.ime ? 'on' : 'OFF'} · enabled ${irqs(regions.hram?.[0x1ff] ?? 0)} · pending ${irqs(io[0x0f])}${cpu.halted ? ' · CPU halted' : ''}`,
  ];
  const nr52 = io[0x26], nr51 = io[0x25], nr50 = io[0x24];
  const routed = [1, 2, 3, 4].filter((c) => nr51 & (0x11 << (c - 1)));
  lines.push(nr52 & 0x80 ? `sound: on · volume L ${(nr50 >> 4) & 7}/7 R ${nr50 & 7}/7 · routed: ${routed.length ? routed.map((c) => `ch${c}`).join(', ') : 'none'}` : 'sound: OFF (NR52 bit 7): silent');
  if (regions.isCgbWram) lines.push(`GBC: ${io[0x4d] & 0x80 ? 'double' : 'normal'} speed · VRAM bank ${io[0x4f] & 1} · WRAM bank ${io[0x70] & 7 || 1}`);
  return lines;
}
