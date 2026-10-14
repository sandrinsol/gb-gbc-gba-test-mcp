// GBA display state for agents: the I/O registers decoded into words, and each
// background layer and the sprite layer rendered on their own, so "which layer
// is wrong" has an answer without reading register bits.

import { encodePng, decodePng } from './png.mjs';
import { gbaSprites } from './video.mjs';
import { renderSprite } from './sprite.mjs';

const from555 = (v) => [(v & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, ((v >> 10) & 31) * 255 / 31 | 0];
const hex = (n, w = 0) => '0x' + (n >>> 0).toString(16).padStart(w, '0');
const s16 = (v) => (v << 16) >> 16;
const s28 = (v) => (v << 4) >> 4;
const TEXT_SIZES = [[256, 256], [512, 256], [256, 512], [512, 512]];

/** Decode the display and system registers. */
export function decodeIo(io) {
  const r16 = (o) => io.readUInt16LE(o), r32 = (o) => io.readUInt32LE(o);
  const dispcnt = r16(0), mode = dispcnt & 7;
  const bgKind = (n) => {
    if (mode === 0) return 'text';
    if (mode === 1) return n < 2 ? 'text' : n === 2 ? 'affine' : null;
    if (mode === 2) return n >= 2 ? 'affine' : null;
    return n === 2 ? 'bitmap' : null;
  };
  const bgs = [0, 1, 2, 3].map((n) => {
    const cnt = r16(0x08 + n * 2), kind = bgKind(n);
    const bg = {
      n, kind, on: !!(dispcnt & (0x100 << n)) && !!kind, priority: cnt & 3,
      charBase: (cnt >> 2) & 3, screenBase: (cnt >> 8) & 31, bpp8: kind === 'affine' || !!(cnt & 0x80),
      mosaic: !!(cnt & 0x40), wrap: !!(cnt & 0x2000), size: cnt >> 14,
      hofs: r16(0x10 + n * 4) & 0x1ff, vofs: r16(0x12 + n * 4) & 0x1ff,
    };
    if (kind === 'affine') {
      const o = 0x20 + (n - 2) * 0x10;
      Object.assign(bg, { pa: s16(r16(o)), pb: s16(r16(o + 2)), pc: s16(r16(o + 4)), pd: s16(r16(o + 6)), x: s28(r32(o + 8)), y: s28(r32(o + 12)) });
    }
    return bg;
  });
  const targets = (bits) => ['BG0', 'BG1', 'BG2', 'BG3', 'OBJ', 'backdrop'].filter((_, i) => bits & (1 << i));
  const bldcnt = r16(0x50), bldalpha = r16(0x52);
  const win = (n) => ({ on: !!(dispcnt & (0x2000 << n)), x1: r16(0x40 + n * 2) >> 8, x2: r16(0x40 + n * 2) & 0xff, y1: r16(0x44 + n * 2) >> 8, y2: r16(0x44 + n * 2) & 0xff });
  const IRQ = ['vblank', 'hblank', 'vcount', 'timer0', 'timer1', 'timer2', 'timer3', 'serial', 'dma0', 'dma1', 'dma2', 'dma3', 'keypad', 'gamepak'];
  const irqs = (bits) => IRQ.filter((_, i) => bits & (1 << i));
  return {
    mode, forcedBlank: !!(dispcnt & 0x80), page: (dispcnt >> 4) & 1, hblankFree: !!(dispcnt & 0x20),
    obj: { on: !!(dispcnt & 0x1000), oneD: !!(dispcnt & 0x40) },
    bgs,
    windows: { win0: win(0), win1: win(1), objWin: !!(dispcnt & 0x8000) },
    blend: { mode: ['none', 'alpha', 'brighten', 'darken'][(bldcnt >> 6) & 3], first: targets(bldcnt & 0x3f), second: targets((bldcnt >> 8) & 0x3f), eva: bldalpha & 31, evb: (bldalpha >> 8) & 31, evy: r16(0x54) & 31 },
    mosaic: r16(0x4c),
    dispstat: { vblankIrq: !!(r16(4) & 8), hblankIrq: !!(r16(4) & 16), vcountIrq: !!(r16(4) & 32), vcountTarget: r16(4) >> 8 },
    dma: [0, 1, 2, 3].map((n) => {
      const o = 0xb0 + n * 12, ctl = r16(o + 10);
      return { n, on: !!(ctl & 0x8000), src: r32(o), dst: r32(o + 4), count: r16(o + 8), timing: ['now', 'vblank', 'hblank', 'special'][(ctl >> 12) & 3], word: !!(ctl & 0x400), repeat: !!(ctl & 0x200) };
    }),
    timers: [0, 1, 2, 3].map((n) => {
      const ctl = r16(0x102 + n * 4);
      return { n, on: !!(ctl & 0x80), prescaler: [1, 64, 256, 1024][ctl & 3], cascade: !!(ctl & 4), irq: !!(ctl & 0x40), value: r16(0x100 + n * 4) };
    }),
    irq: { ime: !!(r16(0x208) & 1), ie: irqs(r16(0x200)), if: irqs(r16(0x202)) },
    sound: (() => {
      const scl = r16(0x80), sch = r16(0x82), scx = r16(0x84);
      const ds = (shift, volBit) => ({ vol: sch & volBit ? 100 : 50, right: !!(sch & (0x100 << shift)), left: !!(sch & (0x200 << shift)), timer: (sch >> (10 + shift)) & 1 });
      return {
        master: !!(scx & 0x80), psgVolume: [25, 50, 100, 0][sch & 3], psgRight: scl & 7, psgLeft: (scl >> 4) & 7,
        psg: [1, 2, 3, 4].map((c) => ({ n: c, right: !!(scl & (0x80 << c)), left: !!(scl & (0x800 << c)) })),
        a: ds(0, 4), b: ds(4, 8),
      };
    })(),
    waitcnt: r16(0x204),
  };
}

/** The display registers as short lines of text. */
export function formatDisplay(d) {
  const lines = [`mode ${d.mode}${d.forcedBlank ? ' · FORCED BLANK (screen white)' : ''} · sprites ${d.obj.on ? 'on' : 'off'}, ${d.obj.oneD ? '1D' : '2D'} tile mapping${d.mode >= 4 ? ` · page ${d.page}` : ''}`];
  for (const bg of d.bgs) {
    if (!bg.kind) continue;
    const head = `BG${bg.n} ${bg.on ? 'on ' : 'off'} ${bg.kind} prio ${bg.priority}`;
    if (bg.kind === 'bitmap') { lines.push(`${head} · bitmap at ${hex(0x06000000 + (d.mode === 3 ? 0 : d.page * 0xa000))}`); continue; }
    const px = bg.kind === 'affine' ? `${128 << bg.size}x${128 << bg.size}` : TEXT_SIZES[bg.size].join('x');
    let l = `${head} · ${bg.bpp8 ? '8bpp' : '4bpp'} tiles char block ${bg.charBase} (${hex(0x06000000 + bg.charBase * 0x4000)}) · map screen block ${bg.screenBase} (${hex(0x06000000 + bg.screenBase * 0x800)}) ${px}`;
    if (bg.kind === 'text') l += ` · scroll ${bg.hofs},${bg.vofs}`;
    else l += ` · matrix ${bg.pa},${bg.pb},${bg.pc},${bg.pd} (/256) ref ${(bg.x / 256).toFixed(1)},${(bg.y / 256).toFixed(1)}${bg.wrap ? ' wrap' : ''}`;
    if (bg.mosaic) l += ' · mosaic';
    lines.push(l);
  }
  const b = d.blend;
  if (b.mode === 'alpha') lines.push(`blend: alpha ${b.first.join('+') || '-'} over ${b.second.join('+') || '-'} (${b.eva}/16, ${b.evb}/16)`);
  else if (b.mode !== 'none') lines.push(`blend: ${b.mode} ${b.first.join('+') || '-'} by ${b.evy}/16`);
  const w = d.windows;
  const wins = [w.win0.on && `win0 ${w.win0.x1}-${w.win0.x2},${w.win0.y1}-${w.win0.y2}`, w.win1.on && `win1 ${w.win1.x1}-${w.win1.x2},${w.win1.y1}-${w.win1.y2}`, w.objWin && 'obj window'].filter(Boolean);
  if (wins.length) lines.push(`windows: ${wins.join(' · ')}`);
  return lines;
}

const IO_NAMES = {
  0x00: 'DISPCNT', 0x10: 'BG0HOFS', 0x12: 'BG0VOFS', 0x14: 'BG1HOFS', 0x16: 'BG1VOFS', 0x18: 'BG2HOFS', 0x1a: 'BG2VOFS', 0x1c: 'BG3HOFS', 0x1e: 'BG3VOFS',
  0x20: 'BG2PA', 0x22: 'BG2PB', 0x24: 'BG2PC', 0x26: 'BG2PD', 0x28: 'BG2X', 0x2c: 'BG2Y', 0x30: 'BG3PA', 0x32: 'BG3PB', 0x34: 'BG3PC', 0x36: 'BG3PD', 0x38: 'BG3X', 0x3c: 'BG3Y',
  0x40: 'WIN0H', 0x42: 'WIN1H', 0x44: 'WIN0V', 0x46: 'WIN1V', 0x48: 'WININ', 0x4a: 'WINOUT', 0x4c: 'MOSAIC', 0x50: 'BLDCNT', 0x52: 'BLDALPHA', 0x54: 'BLDY', 0xa0: 'FIFO A', 0xa4: 'FIFO B',
};

/** What a DMA channel is doing, in words. */
export function dmaPurpose(x) {
  const d = x.dst >>> 0;
  if (d === 0x040000a0 || d === 0x040000a4) return `feeds DirectSound FIFO ${d === 0x040000a0 ? 'A' : 'B'} (sound samples)`;
  if (x.timing !== 'hblank') return null;
  if (d >= 0x05000000 && d < 0x05000400) return 'per-scanline palette writes (colour gradient / raster effect)';
  if (d >> 24 !== 4) return null;
  const name = IO_NAMES[d & 0x3fe] ?? `I/O ${hex(d)}`;
  const o = d & 0x3ff;
  const kind = o >= 0x10 && o < 0x20 ? 'scroll per line: wave, parallax or split-screen'
    : o >= 0x20 && o < 0x40 ? 'affine per line: mode 7 / perspective floor'
      : o >= 0x40 && o < 0x4c ? 'window shape per line'
        : o >= 0x50 && o < 0x56 ? 'blending per line' : 'a register per line';
  return `per-scanline ${name} (${kind})`;
}

/** Sample rate of a timer clocking DirectSound (prescaler 1: 16.78 MHz / (65536 - reload)). */
const timerRate = (t) => (t.on && !t.cascade && t.value < 65536 ? Math.round(16777216 / t.prescaler / (65536 - t.value)) : 0);

/** The sound registers as short lines of text. */
export function formatSound(d) {
  const s = d.sound;
  if (!s.master) return ['sound: master OFF (SOUNDCNT_X bit 7): silent'];
  const fifo = (n) => d.dma.find((x) => x.on && (x.dst >>> 0) === (n === 'A' ? 0x040000a0 : 0x040000a4));
  const side = (c) => (c.left && c.right ? 'L+R' : c.left ? 'L' : c.right ? 'R' : 'muted');
  const ds = (n, c) => {
    if (!c.left && !c.right) return `DirectSound ${n} off`;
    const t = d.timers[c.timer], dma = fifo(n);
    return `DirectSound ${n} ${c.vol}% ${side(c)} · timer ${c.timer}${t.on ? ` ${timerRate(t)} Hz` : ' STOPPED'}${dma ? ` · fed by DMA${dma.n}` : ' · no DMA feeding it'}`;
  };
  const psg = s.psg.filter((c) => c.left || c.right);
  return [
    `sound: master on · ${ds('A', s.a)} · ${ds('B', s.b)}`,
    `PSG (GB channels) ${s.psgVolume}%: ${psg.length ? psg.map((c) => `ch${c.n} ${side(c)}`).join(', ') : 'none routed'}`,
  ];
}

/** Sound set-up mistakes: [{ key, level, msg }]. */
export function gbaSoundIssues(d) {
  const s = d.sound, out = [];
  for (const [n, c, addr] of [['A', s.a, 0x040000a0], ['B', s.b, 0x040000a4]]) {
    const dma = d.dma.find((x) => x.on && (x.dst >>> 0) === addr);
    if (!dma) continue;
    if (!s.master) out.push({ key: 'soundmaster', level: 'error', msg: `DMA${dma.n} feeds DirectSound FIFO ${n} but the sound master switch is off (SOUNDCNT_X bit 7 = 0): nothing plays` });
    else if (!c.left && !c.right) out.push({ key: `sound${n}route`, level: 'warn', msg: `DirectSound ${n} receives samples (DMA${dma.n}) but isn't routed to the left or right speaker (SOUNDCNT_H)` });
    if (!d.timers[c.timer].on) out.push({ key: `sound${n}timer`, level: 'error', msg: `DirectSound ${n} is clocked by timer ${c.timer}, which is stopped: no samples are played (start TM${c.timer} with the sample-rate reload value)` });
  }
  return out;
}

/** How much VRAM and palette the current frame uses: text lines and figures. */
export function vramBudget(r) {
  const d = decodeIo(r.io), vram = r.vram, pram = r.pram;
  const ranges = [];
  for (const bg of d.bgs.filter((b) => b.on && (b.kind === 'text' || b.kind === 'affine'))) {
    const x = layerRanges(r, bg);
    if (x.maxTile >= 0) ranges.push([x.charStart, x.charEnd]);
    ranges.push([x.mapStart, x.mapEnd]);
  }
  if (d.mode >= 3) ranges.push([0, d.mode === 3 ? 0x12c00 : 0x14000]);
  ranges.sort((a, b) => a[0] - b[0]);
  let bgBytes = 0, end = -1;
  for (const [a, b] of ranges) { if (b <= end) continue; bgBytes += b - Math.max(a, end); end = b; }
  const firstObj = d.mode >= 3 ? 512 : 0;
  let objUsed = 0;
  for (let t = firstObj; t < 1024; t++) {
    const o = 0x10000 + t * 32;
    for (let i = 0; i < 32; i++) if (vram[o + i]) { objUsed++; break; }
  }
  const banks = (base) => { let n = 0; for (let b = 0; b < 16; b++) { for (let c = 1; c < 16; c++) if (pram.readUInt16LE(base + (b * 16 + c) * 2)) { n++; break; } } return n; };
  const objTotal = 1024 - firstObj, bgPal = banks(0), objPal = banks(0x200);
  return {
    objUsed, objTotal, bgPal, objPal, bgBytes,
    lines: [`memory: BG VRAM ${(Math.min(bgBytes, 0x10000) / 1024).toFixed(1)} of 64 KB used by the visible layers · OBJ tiles ${objUsed}/${objTotal} slots hold data · palette banks in use: BG ${bgPal}/16, OBJ ${objPal}/16`],
  };
}

/** Interrupts, DMA, timers and wait states as short lines of text. */
export function formatSystem(d) {
  const lines = [`interrupts: IME ${d.irq.ime ? 'on' : 'OFF'} · enabled ${d.irq.ie.join(', ') || 'none'}${d.irq.if.length ? ` · pending ${d.irq.if.join(', ')}` : ''}${d.dispstat.vblankIrq ? '' : (d.irq.ie.includes('vblank') ? ' · DISPSTAT VBlank IRQ bit OFF (no VBlank interrupts)' : '')}`];
  const dma = d.dma.filter((x) => x.on);
  lines.push(`dma: ${dma.length ? dma.map((x) => { const p = dmaPurpose(x); return `DMA${x.n} ${hex(x.src)}→${hex(x.dst)} ×${x.count} ${x.word ? '32' : '16'}-bit ${x.timing}${x.repeat ? ' repeat' : ''}${p ? `: ${p}` : ''}`; }).join(' · ') : 'idle'}`);
  const tm = d.timers.filter((x) => x.on);
  lines.push(`timers: ${tm.length ? tm.map((x) => `TM${x.n} ${x.cascade ? 'cascade' : `1/${x.prescaler}`}${x.irq ? ' irq' : ''} =${x.value}`).join(' · ') : 'off'}`);
  const wc = d.waitcnt;
  lines.push(`waitcnt ${hex(wc, 4)}: ROM ${[4, 3, 2, 8][(wc >> 2) & 3]}/${(wc >> 4) & 1 ? 1 : 2} wait states, prefetch ${wc & 0x4000 ? 'on' : 'off'}${wc === 0 ? ' (default: slow ROM; 0x4317 is the usual setting)' : ''}`);
  return lines;
}

// ---- Layers ----

const W = 240, H = 160;
/** Checkerboard for transparent pixels. */
const checker = (x, y) => (((x >> 2) + (y >> 2)) & 1 ? 70 : 50);

function blank() {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = checker(x, y), o = (y * W + x) * 3; out[o] = out[o + 1] = out[o + 2] = v; }
  return out;
}
const put = (out, x, y, rgb) => { const o = (y * W + x) * 3; out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; };

/** Colour index of a tile pixel (0 = transparent). */
function tilePixel(vram, charBase, tile, bpp8, x, y) {
  if (bpp8) { const a = charBase + tile * 64 + y * 8 + x; return a < 0x10000 ? vram[a] : 0; }
  const a = charBase + tile * 32 + y * 4 + (x >> 1);
  if (a >= 0x10000) return 0;
  return x & 1 ? vram[a] >> 4 : vram[a] & 15;
}

function renderText(r, bg) {
  const out = blank(), vram = r.vram, pram = r.pram;
  const [mw, mh] = TEXT_SIZES[bg.size];
  const cb = bg.charBase * 0x4000;
  for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
    const px = (sx + bg.hofs) % mw, py = (sy + bg.vofs) % mh;
    const tx = px >> 3, ty = py >> 3;
    const block = bg.screenBase + (tx >= 32 ? 1 : 0) + (ty >= 32 ? (mw === 512 ? 2 : 1) : 0);
    const off = block * 0x800 + ((ty & 31) * 32 + (tx & 31)) * 2;
    if (off + 1 >= vram.length) continue;
    const e = vram.readUInt16LE(off);
    let x = px & 7, y = py & 7;
    if (e & 0x400) x = 7 - x;
    if (e & 0x800) y = 7 - y;
    const c = tilePixel(vram, cb, e & 0x3ff, bg.bpp8, x, y);
    if (c) put(out, sx, sy, from555(pram.readUInt16LE((bg.bpp8 ? c : (e >> 12) * 16 + c) * 2)));
  }
  return out;
}

function renderAffine(r, bg) {
  const out = blank(), vram = r.vram, pram = r.pram;
  const size = 128 << bg.size, tiles = size >> 3;
  const cb = bg.charBase * 0x4000, sb = bg.screenBase * 0x800;
  for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
    let px = (bg.x + bg.pa * sx + bg.pb * sy) >> 8, py = (bg.y + bg.pc * sx + bg.pd * sy) >> 8;
    if (bg.wrap) { px = ((px % size) + size) % size; py = ((py % size) + size) % size; } else if (px < 0 || py < 0 || px >= size || py >= size) continue;
    const t = vram[sb + (py >> 3) * tiles + (px >> 3)];
    const c = tilePixel(vram, cb, t, true, px & 7, py & 7);
    if (c) put(out, sx, sy, from555(pram.readUInt16LE(c * 2)));
  }
  return out;
}

function renderBitmap(r, d) {
  const out = blank(), vram = r.vram, pram = r.pram;
  if (d.mode === 3) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(out, x, y, from555(vram.readUInt16LE((y * W + x) * 2)));
  else if (d.mode === 4) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = vram[d.page * 0xa000 + y * W + x]; if (c) put(out, x, y, from555(pram.readUInt16LE(c * 2))); }
  else for (let y = 0; y < 128; y++) for (let x = 0; x < 160; x++) put(out, x, y, from555(vram.readUInt16LE(d.page * 0xa000 + (y * 160 + x) * 2)));
  return out;
}

function renderObjects(r) {
  const out = blank(), oam = r.oam;
  // Every sprite that isn't switched off (drawn even when the OBJ layer is off).
  const sprites = gbaSprites(r).filter((s) => {
    const a0 = oam.readUInt16LE(s.index * 8);
    return !(!(a0 & 0x100) && (a0 & 0x200)) && (a0 >> 14) !== 3;
  });
  // Lower OAM index draws on top: paint from the last one to the first.
  for (const s of [...sprites].reverse()) {
    const w = s.dbl ? s.w / 2 : s.w, h = s.dbl ? s.h / 2 : s.h;
    const tex = decodePng(renderSprite('gba', r, { ...s, w, h, dbl: false, hflip: s.affine ? false : s.hflip, vflip: s.affine ? false : s.vflip }));
    let pa = 256, pb = 0, pc = 0, pd = 256;
    if (s.affine) {
      const k = (oam.readUInt16LE(s.index * 8 + 2) >> 9) & 31;
      [pa, pb, pc, pd] = [0, 1, 2, 3].map((i) => s16(oam.readUInt16LE((k * 4 + i) * 8 + 6)));
    }
    for (let by = 0; by < s.h; by++) for (let bx = 0; bx < s.w; bx++) {
      const sx = s.x + bx, sy = s.y + by;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      let u = bx, v = by;
      if (s.affine) {
        const cx = bx - s.w / 2, cy = by - s.h / 2;
        u = ((pa * cx + pb * cy) >> 8) + w / 2; v = ((pc * cx + pd * cy) >> 8) + h / 2;
        if (u < 0 || v < 0 || u >= w || v >= h) continue;
      }
      const o = (v * w + u) * 4;
      if (tex.data[o + 3]) put(out, sx, sy, [tex.data[o], tex.data[o + 1], tex.data[o + 2]]);
    }
  }
  return out;
}

/** Each layer on its own: [{ name, on, png }] for BG0-3 (those the mode has) and
 *  OBJ, with transparent pixels shown as a grey checkerboard. Disabled layers
 *  are rendered too, so content loaded into them is visible. */
export function renderLayers(regions) {
  const d = decodeIo(regions.io);
  const layers = [];
  for (const bg of d.bgs) {
    if (!bg.kind) continue;
    const data = bg.kind === 'text' ? renderText(regions, bg) : bg.kind === 'affine' ? renderAffine(regions, bg) : renderBitmap(regions, d);
    layers.push({ name: `BG${bg.n}`, on: bg.on, png: encodePng({ width: W, height: H, data }) });
  }
  layers.push({ name: 'OBJ', on: d.obj.on, png: encodePng({ width: W, height: H, data: renderObjects(regions) }) });
  return layers;
}

// ---- Mistakes visible in the display state ----

/** The VRAM a text/affine layer's visible tiles occupy and where its map lives. */
function layerRanges(r, bg) {
  const vram = r.vram;
  let maxTile = -1, mapStart = bg.screenBase * 0x800, mapLen;
  if (bg.kind === 'text') {
    const [mw, mh] = TEXT_SIZES[bg.size];
    mapLen = (mw / 256) * (mh / 256) * 0x800;
    for (let ty = 0; ty < 21; ty++) for (let tx = 0; tx < 31; tx++) {
      const px = (bg.hofs + tx * 8) % mw, py = (bg.vofs + ty * 8) % mh;
      const cx = px >> 3, cy = py >> 3;
      const block = bg.screenBase + (cx >= 32 ? 1 : 0) + (cy >= 32 ? (mw === 512 ? 2 : 1) : 0);
      const off = block * 0x800 + ((cy & 31) * 32 + (cx & 31)) * 2;
      if (off + 1 < vram.length) maxTile = Math.max(maxTile, vram.readUInt16LE(off) & 0x3ff);
    }
  } else {
    const tiles = (128 << bg.size) >> 3;
    mapLen = tiles * tiles;
    for (let i = 0; i < mapLen; i++) maxTile = Math.max(maxTile, vram[mapStart + i] ?? 0);
  }
  const tileBytes = bg.bpp8 ? 64 : 32;
  return { charStart: bg.charBase * 0x4000, charEnd: bg.charBase * 0x4000 + (maxTile + 1) * tileBytes, maxTile, mapStart, mapEnd: mapStart + mapLen };
}

const allZero = (buf, from, to) => { for (let i = from; i < to; i += 2) if (buf.readUInt16LE(i)) return false; return true; };

/** GBA display mistakes in the current frame: [{ key, level, msg }]. */
export function gbaDisplayIssues(r) {
  const d = decodeIo(r.io), out = [];
  const add = (key, level, msg) => out.push({ key, level, msg });
  const v = (a) => hex(0x06000000 + a);
  const tiled = d.bgs.filter((bg) => bg.on && (bg.kind === 'text' || bg.kind === 'affine'));
  const ranges = new Map(tiled.map((bg) => [bg.n, layerRanges(r, bg)]));
  for (const a of tiled) for (const b of tiled) {
    const ra = ranges.get(a.n), rb = ranges.get(b.n);
    if (ra.maxTile < 0 || !(ra.charStart < rb.mapEnd && rb.mapStart < ra.charEnd)) continue;
    const free = Math.ceil(ra.charEnd / 0x800);
    add(`overlap${a.n}${b.n}`, 'error', `BG${a.n}'s tiles (char block ${a.charBase}, tiles 0-${ra.maxTile}: ${v(ra.charStart)}-${v(ra.charEnd - 1)}) overlap BG${b.n}'s map (screen block ${b.screenBase}: ${v(rb.mapStart)}-${v(rb.mapEnd - 1)}): the map overwrites tile graphics. Put the map in a screen block past the tiles${free <= 31 ? ` (${free}+)` : ''} or the tiles in another char block`);
  }
  const sprites = gbaSprites(r).filter((s) => s.onScreen);
  if (d.obj.on && !d.obj.oneD && sprites.some((s) => s.w > 8 || s.h > 8)) {
    add('obj2d', 'warn', 'sprites use 2D tile mapping (DISPCNT bit 6 clear) but some are bigger than 8x8: if their tiles were loaded one after another (grit, Butano, the sprite tool), set bit 6 for 1D mapping or they show scrambled');
  }
  const pram = r.pram;
  // Only sprites that have graphics loaded (blank tiles draw nothing anyway).
  const hasPixels = (s) => {
    const start = 0x10000 + (s.tile & 0x3ff) * 32, len = (s.w / 8) * (s.h / 8) * (s.bpp8 ? 64 : 32);
    for (let i = start; i < Math.min(start + len, 0x18000); i++) if (r.vram[i]) return true;
    return false;
  };
  for (const s of sprites.filter(hasPixels)) {
    const black = s.bpp8 ? allZero(pram, 0x202, 0x400) : allZero(pram, 0x200 + s.palette * 32 + 2, 0x200 + s.palette * 32 + 32);
    if (black) { add(`objpal${s.bpp8 ? 'x' : s.palette}`, 'warn', `sprite #${s.index} uses ${s.bpp8 ? 'the 256-colour OBJ palette' : `OBJ palette bank ${s.palette}`}, which is all black: load its palette (0x05000200${s.bpp8 ? '' : ` + ${s.palette * 32}`})`); }
  }
  for (const bg of tiled) {
    const black = bg.bpp8 ? allZero(pram, 2, 0x200) : allZero(pram, 0, 0x200);
    if (black) add(`bgpal${bg.n}`, 'warn', `BG${bg.n} is on but the BG palette (0x05000000) is all black`);
  }
  const oam = r.oam;
  for (const s of sprites.filter((x) => x.affine)) {
    const k = (oam.readUInt16LE(s.index * 8 + 2) >> 9) & 31;
    const m = [0, 1, 2, 3].map((i) => oam.readUInt16LE((k * 4 + i) * 8 + 6));
    if (m.every((x) => x === 0)) add(`aff${k}`, 'error', `affine sprite #${s.index} uses matrix ${k}, which is all zero: it draws as one stretched pixel or nothing. Set pa=pd=0x100 for no rotation/scale`);
  }
  for (const bg of tiled.filter((x) => x.kind === 'affine')) {
    if (!bg.pa && !bg.pb && !bg.pc && !bg.pd) add(`bgaff${bg.n}`, 'error', `BG${bg.n} is affine with an all-zero matrix (BG${bg.n}PA-PD): it shows one repeated pixel. Set PA=PD=0x100`);
  }
  return out;
}

/** The save type a GBA ROM declares with its library ID string, or null. */
export function gbaSaveType(rom) {
  const s = rom.toString('latin1');
  for (const [id, name] of [['EEPROM_V', 'EEPROM'], ['SRAM_F_V', 'SRAM (FRAM)'], ['SRAM_V', 'SRAM'], ['FLASH1M_V', 'Flash 128 KB'], ['FLASH512_V', 'Flash 64 KB'], ['FLASH_V', 'Flash 64 KB']]) {
    if (s.includes(id)) return name;
  }
  return null;
}
