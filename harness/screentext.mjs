// Read on-screen text from the background tile maps: the visible part of each
// layer as tile numbers, turned into characters with a charmap (which tile is
// which letter). Text is far cheaper for an agent than a screenshot.
//
// A charmap is "ascii" (tile number = character code), or { first, chars }: the
// tile holding chars[0], with the rest following in order. chars defaults to
// printable ASCII (space to ~). learnCharmap() finds `first` from a string that
// is visible on screen, for games whose font is in ASCII order at some offset.

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

/** @typedef {{ first: number, chars: string }} Charmap */

/** Normalise "ascii" / { first, chars } / { offset } to { first, chars }. @returns {Charmap} */
export function normalizeCharmap(cm) {
  if (!cm || cm === 'ascii') return { first: 32, chars: ASCII };
  if (typeof cm === 'object' && Number.isInteger(cm.first)) return { first: cm.first, chars: typeof cm.chars === 'string' && cm.chars.length ? cm.chars : ASCII };
  throw new Error('charmap must be "ascii" or { "first": <tile of the first char>, "chars": "<chars in tile order>" }');
}

/** Visible tile numbers per background layer, top layer first:
 *  [{ name, rows: number[][] }]. GB: the background with the window drawn over
 *  it (20x18). GBA: each text-mode layer that is switched on (30x20). */
export function visibleTiles(system, regions) {
  return system === 'gba' ? gbaLayers(regions) : [gbLayer(regions)];
}

function gbLayer(r) {
  const io = r.io, vram = r.vram;
  const lcdc = io[0x40], scy = io[0x42], scx = io[0x43], wy = io[0x4a], wx = io[0x4b];
  const map = (hi) => (hi ? 0x1c00 : 0x1800);
  const bg = map(lcdc & 0x08), win = map(lcdc & 0x40);
  const rows = [];
  for (let ty = 0; ty < 18; ty++) {
    const row = [];
    for (let tx = 0; tx < 20; tx++) {
      const my = ((scy + ty * 8) >> 3) & 31, mx = ((scx + tx * 8) >> 3) & 31;
      row.push(vram[bg + my * 32 + mx]);
    }
    rows.push(row);
  }
  if (lcdc & 0x20 && wy < 144 && wx < 167) {
    const y0 = Math.ceil(wy / 8), x0 = Math.ceil(Math.max(0, wx - 7) / 8);
    for (let ty = y0; ty < 18; ty++) for (let tx = x0; tx < 20; tx++) rows[ty][tx] = vram[win + (ty - y0) * 32 + (tx - x0)];
  }
  return { name: (lcdc & 0x20) ? 'bg+window' : 'bg', rows };
}

function gbaLayers(r) {
  const io = r.io, vram = r.vram;
  const dispcnt = io.readUInt16LE(0), mode = dispcnt & 7;
  const text = mode === 0 ? [0, 1, 2, 3] : mode === 1 ? [0, 1] : [];
  const layers = [];
  for (const n of text) {
    if (!(dispcnt & (0x100 << n))) continue;
    const cnt = io.readUInt16LE(0x08 + n * 2);
    const sbb = (cnt >> 8) & 31, size = cnt >> 14;
    const wide = size & 1, tall = size & 2;
    const hofs = io.readUInt16LE(0x10 + n * 4) & 0x1ff, vofs = io.readUInt16LE(0x12 + n * 4) & 0x1ff;
    const W = wide ? 64 : 32, H = tall ? 64 : 32;
    const rows = [];
    for (let ty = 0; ty < 20; ty++) {
      const row = [];
      for (let tx = 0; tx < 30; tx++) {
        const mx = ((hofs + tx * 8) >> 3) % W, my = ((vofs + ty * 8) >> 3) % H;
        const block = sbb + (mx >= 32 ? 1 : 0) + (my >= 32 ? (wide ? 2 : 1) : 0);
        const off = block * 0x800 + ((my & 31) * 32 + (mx & 31)) * 2;
        row.push(off + 1 < vram.length ? vram.readUInt16LE(off) & 0x3ff : 0);
      }
      rows.push(row);
    }
    layers.push({ name: `bg${n}`, priority: cnt & 3, rows });
  }
  return layers.sort((a, b) => a.priority - b.priority).map(({ name, rows }) => ({ name, rows }));
}

/** Tile rows → text lines (unknown tiles become spaces; blank lines and common
 *  indentation dropped). @param {number[][]} rows @param {Charmap} cm */
export function tilesToText(rows, cm) {
  const lines = rows.map((row) => row.map((t) => {
    const i = t - cm.first;
    return i >= 0 && i < cm.chars.length ? cm.chars[i] : ' ';
  }).join('').trimEnd()).filter((l) => l.trim());
  const indent = Math.min(...lines.map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(indent));
}

/** Text of every layer that has any: [{ name, lines }]. */
export function screenText(system, regions, charmap) {
  const cm = normalizeCharmap(charmap);
  return visibleTiles(system, regions).map((l) => ({ name: l.name, lines: tilesToText(l.rows, cm) })).filter((l) => l.lines.length);
}

/** Find the charmap from a string that is on screen: the tile offset at which
 *  `text` appears (letters in ASCII order). Returns { first, chars } or null. */
export function learnCharmap(system, regions, text) {
  const want = [...text].map((c) => c.charCodeAt(0));
  const keyIdx = want.map((c, i) => (c === 32 ? -1 : i)).filter((i) => i >= 0);
  if (!keyIdx.length) return null;
  const found = new Map(); // offset -> hits
  for (const layer of visibleTiles(system, regions)) {
    for (const row of layer.rows) {
      for (let x = 0; x + want.length <= row.length; x++) {
        const d = row[x + keyIdx[0]] - want[keyIdx[0]];
        if (keyIdx.every((i) => row[x + i] - want[i] === d)) found.set(d, (found.get(d) ?? 0) + 1);
      }
    }
  }
  if (!found.size) return null;
  const d = [...found.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { first: 32 + d, chars: ASCII };
}
