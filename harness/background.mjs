// Background art → tiles + tilemap + palettes for GB, GBC and GBA, with
// duplicate (and mirrored) tiles merged, palettes packed per tile, and a preview
// rebuilt from the output so the result can be checked. Also renders Tiled maps
// (.tmx/.tmj/.json) to an image first, so any tile size works.
//
// Fonts and other tile sets that must keep their order: dedupe: false.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync, gunzipSync } from 'node:zlib';
import { decodePng, encodePng } from './png.mjs';

export const BG_TARGETS = {
  gb: { bpp: 2, palettes: 1, colors: 4, maxTiles: 256, flips: false },
  gbc: { bpp: 2, palettes: 8, colors: 4, maxTiles: 512, flips: true },
  gba4: { bpp: 4, palettes: 16, colors: 15, maxTiles: 1024, flips: true },
  gba8: { bpp: 8, palettes: 1, colors: 255, maxTiles: 1024, flips: true },
};
const MAP_LIMIT = { gb: [32, 32], gbc: [32, 32], gba4: [64, 64], gba8: [64, 64] };
const DMG_RGB = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];
const to555 = (r, g, b) => (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
const from555 = (v) => [(v & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, ((v >> 10) & 31) * 255 / 31 | 0];
const shadeOf = (r, g, b) => 3 - Math.min(3, Math.round((0.299 * r + 0.587 * g + 0.114 * b) / 85));

/** Parse "#rrggbb" to a BGR555 value. */
function parseHex(s) {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) throw new Error(`colour must be #rrggbb, got "${s}"`);
  const v = parseInt(m[1], 16);
  return to555(v >> 16, (v >> 8) & 255, v & 255);
}

/**
 * Convert background art (PNG, width and height multiples of 8).
 * @param {Buffer} png
 * @param {{ target: string, dedupe?: boolean, flips?: boolean, transparent?: string }} opts
 *   transparent: GBA only — "alpha" or "#rrggbb" for the backdrop colour (palette
 *   index 0, shared by every palette bank); default: the most common colour.
 */
export function convertBackground(png, { target, dedupe = true, flips, transparent }) {
  const T = BG_TARGETS[target];
  if (!T) throw new Error(`target must be one of ${Object.keys(BG_TARGETS).join(', ')}`);
  const img = decodePng(png);
  if (img.width % 8 || img.height % 8) throw new Error(`image is ${img.width}x${img.height}; both sides must be multiples of 8`);
  const useFlips = (flips ?? T.flips) && T.flips;
  const gba = target.startsWith('gba');
  const cols = img.width / 8, rows = img.height / 8;
  const warnings = [];

  // Pixel colours at hardware precision (BGR555; DMG: shade 0-3). -1 = backdrop.
  const px = new Int32Array(img.width * img.height);
  const counts = new Map();
  for (let i = 0; i < px.length; i++) {
    const o = i * img.channels;
    const [r, g, b] = [img.data[o], img.data[o + 1], img.data[o + 2]];
    const a = img.channels === 4 ? img.data[o + 3] : img.channels === 2 ? img.data[o + 1] : 255;
    const v = target === 'gb' ? shadeOf(r, g, b) : (a < 128 ? -1 : to555(r, g, b));
    px[i] = v;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let backdrop = null;
  if (gba) {
    backdrop = transparent && transparent !== 'alpha' ? parseHex(transparent)
      : counts.has(-1) ? null
        : [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    if (backdrop !== null) for (let i = 0; i < px.length; i++) if (px[i] === backdrop) px[i] = -1;
  } else if (counts.has(-1)) {
    for (let i = 0; i < px.length; i++) if (px[i] === -1) px[i] = target === 'gb' ? 0 : 0x7fff;
  }

  // Tiles, merged when identical (or mirrored).
  const tileAt = (tx, ty) => {
    const t = new Int32Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) t[y * 8 + x] = px[(ty * 8 + y) * img.width + tx * 8 + x];
    return t;
  };
  const flip = (t, h, v) => { const o = new Int32Array(64); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) o[y * 8 + x] = t[(v ? 7 - y : y) * 8 + (h ? 7 - x : x)]; return o; };
  const unique = [], index = new Map(), cells = [];
  let flipped = 0;
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const t = tileAt(tx, ty);
    let hit = null;
    if (dedupe) {
      for (const [h, v] of useFlips ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]]) {
        const k = index.get(flip(t, h, v).join(','));
        if (k !== undefined) { hit = { tile: k, h, v }; break; }
      }
    }
    if (!hit) {
      hit = { tile: unique.length, h: 0, v: 0 };
      unique.push(t);
      if (dedupe) index.set(t.join(','), hit.tile);
    } else if (hit.h || hit.v) flipped++;
    cells.push(hit);
  }

  // Palettes: pack each tile's colours into as few palettes as possible.
  const tileColors = unique.map((t) => [...new Set(t)].filter((c) => c !== -1));
  const palettes = [];   // arrays of colours (without the backdrop)
  const tilePal = new Array(unique.length);
  if (target === 'gb') {
    palettes.push([0, 1, 2, 3]);
    tilePal.fill(0);
  } else {
    const order = tileColors.map((c, i) => i).sort((a, b) => tileColors[b].length - tileColors[a].length);
    for (const i of order) {
      const cs = tileColors[i];
      if (cs.length > T.colors) {
        const pos = cells.findIndex((c) => c.tile === i);
        throw new Error(`tile at ${(pos % cols) * 8},${Math.floor(pos / cols) * 8} uses ${cs.length} colours; ${target} allows ${T.colors} per tile${gba ? ' plus the backdrop' : ''}`);
      }
      let best = -1, bestGrowth = Infinity;
      palettes.forEach((p, k) => {
        const growth = cs.filter((c) => !p.includes(c)).length;
        if (p.length + growth <= T.colors && growth < bestGrowth) { best = k; bestGrowth = growth; }
      });
      if (best < 0) { palettes.push([]); best = palettes.length - 1; }
      for (const c of cs) if (!palettes[best].includes(c)) palettes[best].push(c);
      tilePal[i] = best;
    }
    if (!palettes.length) palettes.push([]);
    if (palettes.length > T.palettes) throw new Error(`needs ${palettes.length} palettes; ${target} has ${T.palettes}. Use fewer colours or share colours between areas.`);
  }

  // Encode tiles with each one's palette.
  const bytesPerTile = T.bpp * 8;
  const tiles = new Uint8Array(unique.length * bytesPerTile);
  unique.forEach((t, i) => {
    const pal = palettes[tilePal[i]];
    const idx = (c) => (c === -1 ? 0 : target === 'gb' ? c : pal.indexOf(c) + (gba ? 1 : 0));
    const o = i * bytesPerTile;
    for (let y = 0; y < 8; y++) {
      if (T.bpp === 2) {
        let lo = 0, hi = 0;
        for (let x = 0; x < 8; x++) { const v = idx(t[y * 8 + x]); lo |= (v & 1) << (7 - x); hi |= ((v >> 1) & 1) << (7 - x); }
        tiles[o + y * 2] = lo; tiles[o + y * 2 + 1] = hi;
      } else if (T.bpp === 4) {
        for (let x = 0; x < 8; x += 2) tiles[o + y * 4 + x / 2] = idx(t[y * 8 + x]) | (idx(t[y * 8 + x + 1]) << 4);
      } else {
        for (let x = 0; x < 8; x++) tiles[o + y * 8 + x] = idx(t[y * 8 + x]);
      }
    }
  });

  // Tilemap (+ GBC attribute map).
  let map, attrs = null;
  if (gba) {
    map = new Uint16Array(cells.length);
    cells.forEach((c, i) => { map[i] = c.tile | (c.h << 10) | (c.v << 11) | (target === 'gba4' ? tilePal[c.tile] << 12 : 0); });
  } else {
    map = new Uint8Array(cells.length);
    cells.forEach((c, i) => { map[i] = c.tile & 0xff; });
    if (target === 'gbc') {
      attrs = new Uint8Array(cells.length);
      cells.forEach((c, i) => { attrs[i] = tilePal[c.tile] | ((c.tile >> 8) << 3) | (c.h << 5) | (c.v << 6); });
    }
  }

  // Palettes as BGR555 (GBA: index 0 of each bank is the backdrop).
  const pal555 = target === 'gb' ? [] : palettes.map((p) => {
    const full = gba ? [backdrop === null || backdrop === -1 ? 0 : backdrop, ...p] : [...p];
    while (full.length < (target === 'gba8' ? 256 : gba ? 16 : 4)) full.push(0);
    return full;
  });

  if (unique.length > T.maxTiles) warnings.push(`${unique.length} unique tiles; ${target} can address ${T.maxTiles}${target === 'gb' ? ' (384 with both tile blocks)' : ''}`);
  const [mw, mh] = MAP_LIMIT[target];
  if (cols > mw || rows > mh) warnings.push(`map is ${cols}x${rows} tiles, larger than the hardware map (${mw}x${mh}): copy it into VRAM in parts as the screen scrolls`);

  const conv = { target, cols, rows, tileCount: unique.length, cells: cells.length, flipped, tiles, map, attrs, palettes: pal555, backdrop, warnings, previewPng: /** @type {Buffer} */ (Buffer.alloc(0)) };
  conv.previewPng = renderBackground(conv);
  return conv;
}

/** Rebuild the picture from converted tiles, map and palettes (a round-trip check). */
export function renderBackground(conv) {
  const { target, cols, rows, tiles, map, attrs, palettes } = conv;
  const T = BG_TARGETS[target];
  const W = cols * 8, H = rows * 8, out = new Uint8Array(W * H * 3);
  const bpt = T.bpp * 8;
  for (let i = 0; i < cols * rows; i++) {
    const e = map[i];
    let tile, h, v, pal;
    if (target.startsWith('gba')) { tile = e & 0x3ff; h = (e >> 10) & 1; v = (e >> 11) & 1; pal = target === 'gba4' ? e >> 12 : 0; }
    else { tile = e | (attrs ? ((attrs[i] >> 3) & 1) << 8 : 0); h = attrs ? (attrs[i] >> 5) & 1 : 0; v = attrs ? (attrs[i] >> 6) & 1 : 0; pal = attrs ? attrs[i] & 7 : 0; }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const sx = h ? 7 - x : x, sy = v ? 7 - y : y, o = tile * bpt;
      let c;
      if (T.bpp === 2) c = ((tiles[o + sy * 2] >> (7 - sx)) & 1) | (((tiles[o + sy * 2 + 1] >> (7 - sx)) & 1) << 1);
      else if (T.bpp === 4) c = (tiles[o + sy * 4 + (sx >> 1)] >> ((sx & 1) * 4)) & 15;
      else c = tiles[o + sy * 8 + sx];
      const rgb = target === 'gb' ? DMG_RGB[c] : from555(palettes[pal][c]);
      const p = (((i / cols | 0) * 8 + y) * W + (i % cols) * 8 + x) * 3;
      out[p] = rgb[0]; out[p + 1] = rgb[1]; out[p + 2] = rgb[2];
    }
  }
  return encodePng({ width: W, height: H, data: out });
}

const hexList = (arr, digits, perLine, prefix = '0x') => {
  const parts = Array.from(arr, (v) => prefix + v.toString(16).padStart(digits, '0'));
  const lines = [];
  for (let i = 0; i < parts.length; i += perLine) lines.push('  ' + parts.slice(i, i + perLine).join(', '));
  return lines.join(',\n');
};

/** Write a conversion as source for the toolchain: .c (+ .h), .h, .s, .asm/.inc
 *  or .bin (several files). Returns the files written. */
export async function writeBackgroundSource(conv, file, name) {
  const id = name.replace(/\W/g, '_'), ID = id.toUpperCase();
  const ext = path.extname(file).toLowerCase();
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const gba = conv.target.startsWith('gba');
  const pal = conv.palettes.flat();
  const info = `${conv.cols}x${conv.rows} tile map, ${conv.tileCount} tiles, ${conv.palettes.length || 1} palette(s), ${conv.target}`;
  const defs = [`#define ${ID}_WIDTH ${conv.cols}`, `#define ${ID}_HEIGHT ${conv.rows}`, `#define ${ID}_TILE_COUNT ${conv.tileCount}`, `#define ${ID}_PALETTE_COUNT ${conv.palettes.length}`];
  const mapType = gba ? 'unsigned short' : 'unsigned char';
  const arrays = [
    [`const unsigned char ${id}_tiles[${conv.tiles.length}]`, hexList(conv.tiles, 2, 16)],
    [`const ${mapType} ${id}_map[${conv.map.length}]`, hexList(conv.map, gba ? 4 : 2, gba ? 12 : 16)],
    ...(conv.attrs ? [[`const unsigned char ${id}_attrs[${conv.attrs.length}]`, hexList(conv.attrs, 2, 16)]] : []),
    ...(pal.length ? [[`const unsigned short ${id}_pal[${pal.length}]`, hexList(pal, 4, 8)]] : []),
  ];
  if (ext === '.bin') {
    const base = file.replace(/\.bin$/i, '');
    const files = [[`${base}.tiles.bin`, Buffer.from(conv.tiles)], [`${base}.map.bin`, Buffer.from(conv.map.buffer, conv.map.byteOffset, conv.map.byteLength)]];
    if (conv.attrs) files.push([`${base}.attrs.bin`, Buffer.from(conv.attrs)]);
    if (pal.length) { const p = Buffer.alloc(pal.length * 2); pal.forEach((v, i) => p.writeUInt16LE(v, i * 2)); files.push([`${base}.pal.bin`, p]); }
    for (const [f, b] of files) await writeFile(f, b);
    return files.map(([f]) => f);
  }
  if (ext === '.h') {
    const guard = `${ID}_BG_H`;
    const align = gba ? ' __attribute__((aligned(4)))' : '';
    await writeFile(file, [`// ${info}`, `#ifndef ${guard}`, `#define ${guard}`, ...defs, ...arrays.map(([d, body]) => `static ${d}${align} = {\n${body}\n};`), '#endif', ''].join('\n'));
    return [file];
  }
  if (ext === '.c') {
    const h = file.replace(/\.c$/i, '.h'), guard = `${ID}_BG_H`;
    const align = gba ? ' __attribute__((aligned(4)))' : '';
    await writeFile(h, [`// ${info}`, `#ifndef ${guard}`, `#define ${guard}`, ...defs, ...arrays.map(([d]) => `extern ${d};`), '#endif', ''].join('\n'));
    await writeFile(file, [`// ${info}`, `#include "${path.basename(h)}"`, '', ...arrays.map(([d, body]) => `${d}${align} = {\n${body}\n};\n`)].join('\n'));
    return [file, h];
  }
  if (ext === '.s') {
    const block = (label, arr, dir, digits) => {
      const l = ['.align 2', `.global ${label}`, `${label}:`];
      for (let i = 0; i < arr.length; i += 8) l.push(`  ${dir} ${Array.from(arr.slice(i, i + 8), (v) => '0x' + v.toString(16).padStart(digits, '0')).join(', ')}`);
      return l;
    };
    const lines = [`@ ${info}`, '.section .rodata', ...block(`${id}_tiles`, conv.tiles, '.byte', 2), ...block(`${id}_map`, conv.map, gba ? '.hword' : '.byte', gba ? 4 : 2)];
    if (conv.attrs) lines.push(...block(`${id}_attrs`, conv.attrs, '.byte', 2));
    if (pal.length) lines.push(...block(`${id}_pal`, pal, '.hword', 4));
    await writeFile(file, lines.join('\n') + '\n');
    return [file];
  }
  if (ext === '.asm' || ext === '.inc') {
    const block = (label, arr) => {
      const l = [`${label}::`];
      for (let i = 0; i < arr.length; i += 16) l.push(`  db ${Array.from(arr.slice(i, i + 16), (v) => '$' + v.toString(16).padStart(2, '0')).join(', ')}`);
      l.push(`${label}_end::`);
      return l;
    };
    const lines = [`; ${info}`, `DEF ${ID}_WIDTH EQU ${conv.cols}`, `DEF ${ID}_HEIGHT EQU ${conv.rows}`, `DEF ${ID}_TILE_COUNT EQU ${conv.tileCount}`, `SECTION "${id}", ROM0`, ...block(`${id}_tiles`, conv.tiles), ...block(`${id}_map`, conv.map)];
    if (conv.attrs) lines.push(...block(`${id}_attrs`, conv.attrs));
    if (pal.length) lines.push(`${id}_pal::`, ...conv.palettes.map((p) => `  dw ${p.map((v) => '$' + v.toString(16).padStart(4, '0')).join(', ')}`));
    await writeFile(file, lines.join('\n') + '\n');
    return [file];
  }
  throw new Error(`unknown output "${ext}" (use .c, .h, .s, .asm, .inc or .bin)`);
}

// ---- Tiled maps ----

const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : undefined; };

/** Layer data → gids (CSV, base64 with optional zlib/gzip, or a JSON array). */
function decodeData(data, encoding, compression) {
  if (Array.isArray(data)) return data;
  if (encoding === 'csv') return data.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (encoding === 'base64') {
    let b = Buffer.from(data.trim(), 'base64');
    if (compression === 'zlib') b = inflateSync(b);
    else if (compression === 'gzip') b = gunzipSync(b);
    else if (compression) throw new Error(`unsupported Tiled compression "${compression}" (use CSV, base64, zlib or gzip)`);
    return Array.from({ length: b.length / 4 }, (_, i) => b.readUInt32LE(i * 4));
  }
  throw new Error(`unsupported Tiled layer encoding "${encoding}" (use CSV or base64)`);
}

/** A tileset as { firstgid, tw, th, columns, margin, spacing, img }. */
async function loadTileset(ts, dir) {
  let t = ts, base = dir;
  if (ts.source) {
    const f = path.resolve(dir, ts.source);
    base = path.dirname(f);
    const text = await readFile(f, 'utf8');
    if (/\.(tsj|json)$/i.test(f)) t = JSON.parse(text);
    else {
      const head = /<tileset[^>]*>/.exec(text)?.[0] ?? '', im = /<image[^>]*>/.exec(text)?.[0] ?? '';
      t = { tilewidth: +attr(head, 'tilewidth'), tileheight: +attr(head, 'tileheight'), columns: +(attr(head, 'columns') ?? 0), margin: +(attr(head, 'margin') ?? 0), spacing: +(attr(head, 'spacing') ?? 0), image: attr(im, 'source') };
    }
  }
  if (!t.image) throw new Error('tilesets must use one image (image-collection tilesets are not supported)');
  const img = decodePng(await readFile(path.resolve(base, t.image)));
  const tw = t.tilewidth, th = t.tileheight, margin = t.margin ?? 0, spacing = t.spacing ?? 0;
  const columns = t.columns || Math.floor((img.width - 2 * margin + spacing) / (tw + spacing));
  return { firstgid: ts.firstgid, tw, th, columns, margin, spacing, img };
}

/** Render a Tiled map's visible tile layers to an RGBA PNG. */
export async function renderTiledMap(file) {
  const text = await readFile(file, 'utf8');
  const dir = path.dirname(file);
  let map;
  if (/^\s*\{/.test(text)) {
    const j = JSON.parse(text);
    map = { width: j.width, height: j.height, tw: j.tilewidth, th: j.tileheight, tilesets: j.tilesets,
      layers: (j.layers ?? []).filter((l) => l.type === 'tilelayer' && l.visible !== false).map((l) => decodeData(l.data, l.encoding ?? 'csv', l.compression)) };
  } else {
    const head = /<map[^>]*>/.exec(text)?.[0];
    if (!head) throw new Error(`${file} is not a Tiled map`);
    const tilesets = [...text.matchAll(/<tileset([^>]*?)(\/>|>([\s\S]*?)<\/tileset>)/g)].map((m) => {
      const tag = m[1];
      if (attr(tag, 'source')) return { firstgid: +attr(tag, 'firstgid'), source: attr(tag, 'source') };
      const im = /<image[^>]*>/.exec(m[3] ?? '')?.[0] ?? '';
      return { firstgid: +attr(tag, 'firstgid'), tilewidth: +attr(tag, 'tilewidth'), tileheight: +attr(tag, 'tileheight'), columns: +(attr(tag, 'columns') ?? 0), margin: +(attr(tag, 'margin') ?? 0), spacing: +(attr(tag, 'spacing') ?? 0), image: attr(im, 'source') };
    });
    const layers = [...text.matchAll(/<layer([^>]*)>\s*<data([^>]*)>([\s\S]*?)<\/data>/g)]
      .filter((m) => attr(m[1], 'visible') !== '0')
      .map((m) => {
        if (/<tile\b/.test(m[3])) return [...m[3].matchAll(/<tile(?:\s+gid="(\d+)")?\s*\/>/g)].map((t) => +(t[1] ?? 0));
        return decodeData(m[3], attr(m[2], 'encoding') ?? 'xml', attr(m[2], 'compression'));
      });
    map = { width: +attr(head, 'width'), height: +attr(head, 'height'), tw: +attr(head, 'tilewidth'), th: +attr(head, 'tileheight'), tilesets, layers };
  }
  if (attr((/<map[^>]*>/.exec(text)?.[0] ?? ''), 'infinite') === '1') throw new Error('infinite Tiled maps are not supported; set a fixed map size');
  const sets = (await Promise.all(map.tilesets.map((t) => loadTileset(t, dir)))).sort((a, b) => b.firstgid - a.firstgid);
  const W = map.width * map.tw, H = map.height * map.th;
  const out = new Uint8Array(W * H * 4);
  for (const gids of map.layers) {
    gids.forEach((raw, i) => {
      const gid = raw & 0x1fffffff;
      if (!gid) return;
      const fh = !!(raw & 0x80000000), fv = !!(raw & 0x40000000), fd = !!(raw & 0x20000000);
      const ts = sets.find((s) => s.firstgid <= gid);
      if (!ts) return;
      const id = gid - ts.firstgid;
      const sx = ts.margin + (id % ts.columns) * (ts.tw + ts.spacing), sy = ts.margin + Math.floor(id / ts.columns) * (ts.th + ts.spacing);
      const dx = (i % map.width) * map.tw, dy = Math.floor(i / map.width) * map.th;
      for (let y = 0; y < map.th; y++) for (let x = 0; x < map.tw; x++) {
        let u = x, v = y;
        if (fd) [u, v] = [v, u];
        if (fh) u = map.tw - 1 - u;
        if (fv) v = map.th - 1 - v;
        const so = ((sy + v) * ts.img.width + sx + u) * ts.img.channels;
        const a = ts.img.channels === 4 ? ts.img.data[so + 3] : 255;
        if (a < 128) continue;
        const o = ((dy + y) * W + dx + x) * 4;
        out[o] = ts.img.data[so]; out[o + 1] = ts.img.data[so + 1]; out[o + 2] = ts.img.data[so + 2]; out[o + 3] = 255;
      }
    });
  }
  return encodePng({ width: W, height: H, data: out, channels: 4 });
}
