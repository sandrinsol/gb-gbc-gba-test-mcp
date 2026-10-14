// Read GB/GBC memory out of a gambatte save state (RASTATE container).
//
// Gambatte serializes a labeled stream: a 2-byte version, a 24-bit-sized snapshot,
// then repeating records of `label\0` + 24-bit big-endian size + data. We walk it
// generically and pull out the RAM regions by label, so offsets are correct across
// games and gambatte versions — nothing hardcoded.

// Extract the "MEM " chunk (gambatte's retro_serialize output) from a RASTATE buffer.
function memChunk(state) {
  if (state.toString('latin1', 0, 7) !== 'RASTATE') throw new Error('not a RASTATE save state');
  let off = 8;
  while (off + 8 <= state.length) {
    const tag = state.toString('latin1', off, off + 4);
    const size = state.readUInt32LE(off + 4);
    if (tag === 'MEM ') return state.subarray(off + 8, off + 8 + size);
    off += 8 + size;
    if (tag === 'END ' || size === 0) break;
  }
  throw new Error('no MEM chunk in save state');
}

const be24 = (b, p) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];

/** Parse a gambatte save state into { wram, vram, sram, hram, io } views.
 *  `hram` is the 0x200 block covering GB 0xFE00-0xFFFF (OAM + IO + HRAM). */
export function parseState(state) {
  const mem = memChunk(state);
  let p = 2; // skip version[2]
  p += 3 + be24(mem, p); // skip snapshot (24-bit size + data)
  const fields = {};
  while (p < mem.length) {
    let l = p;
    while (l < mem.length && mem[l] !== 0) l++;
    if (l >= mem.length) break;
    const label = mem.toString('latin1', p, l);
    p = l + 1;
    if (p + 3 > mem.length) break;
    const size = be24(mem, p); p += 3;
    fields[label] = mem.subarray(p, p + size);
    p += size;
  }
  const wram = fields.wram;
  const hram = fields.hram; // 0x200 block for 0xFE00-0xFFFF
  if (!wram || !hram) throw new Error('not a gambatte GB save state (missing wram/hram)');
  return {
    wram, vram: fields.vram, sram: fields.sram, hram,
    // IO page 0xFF00-0xFF7F lives inside the hram block at offset 0x100.
    io: hram.subarray(0x100, 0x180),
    isCgbWram: wram.length > 0x2000,
    fields,
  };
}

// Map a GB bus address to (region buffer, offset), honoring WRAM/echo and CGB banking.
function locate(r, addr) {
  const a = addr & 0xffff;
  if (a < 0x8000) throw new Error(`0x${a.toString(16)} is ROM (not stored in a save state)`);
  if (a < 0xa000) return [r.vram, a - 0x8000];               // 0x8000-0x9FFF VRAM (bank 0)
  if (a < 0xc000) {                                          // 0xA000-0xBFFF cart RAM
    if (!r.sram || r.sram.length === 0) throw new Error('this game has no cart RAM (SRAM)');
    return [r.sram, (a - 0xa000) % r.sram.length];
  }
  if (a < 0xd000) return [r.wram, a - 0xc000];               // 0xC000-0xCFFF WRAM bank 0
  if (a < 0xe000) {                                          // 0xD000-0xDFFF WRAM bank 1..7 (CGB)
    let bank = 1;
    if (r.isCgbWram) { bank = (r.hram[0x170] & 0x07) || 1; } // SVBK @ 0xFF70
    return [r.wram, bank * 0x1000 + (a - 0xd000)];
  }
  if (a < 0xfe00) return [r.wram, a - 0xe000];               // 0xE000-0xFDFF echo of WRAM
  return [r.hram, a - 0xfe00];                               // 0xFE00-0xFFFF OAM/IO/HRAM block
}

/** Read `length` bytes at a GB bus address from a parsed state (or raw state buffer). */
export function readMemory(stateOrParsed, addr, length = 1) {
  const r = Buffer.isBuffer(stateOrParsed) ? parseState(stateOrParsed) : stateOrParsed;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const [buf, off] = locate(r, (addr + i) & 0xffff);
    out[i] = buf[off];
  }
  return out;
}

/** Patch RAM at a GB address inside a save-state buffer (in place) and return it.
 *  The region views alias the state buffer, so writing them patches the state. */
export function writeMemory(state, addr, data) {
  const r = parseState(state);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let i = 0; i < bytes.length; i++) {
    const [buf, off] = locate(r, (addr + i) & 0xffff);
    buf[off] = bytes[i];
  }
  return state;
}

// Offset of a region view inside the save-state buffer it was parsed from.
const offsetIn = (state, view) => view.byteOffset - state.byteOffset;

/** Save-state byte offsets of `length` bytes at a GB bus address. (A 0xD000-0xDFFF
 *  address on CGB resolves to the WRAM bank selected right now.) */
export function stateOffsets(state, addr, length = 1) {
  const r = parseState(state);
  return Array.from({ length }, (_, i) => { const [buf, o] = locate(r, (addr + i) & 0xffff); return offsetIn(state, buf) + o; });
}

/** [start, length] save-state ranges that determine the picture: VRAM, OAM, the
 *  LCD registers (0xFF40-0xFF4B) and, when present, the palette fields. */
export function videoRanges(state) {
  const r = parseState(state);
  const views = [r.vram, r.hram.subarray(0, 0xa0), r.hram.subarray(0x140, 0x14c)];
  for (const k of ['bgp', 'objp', 'dmgpal']) if (r.fields[k]) views.push(r.fields[k]);
  return views.map((v) => [offsetIn(state, v), v.length]);
}

/** The cartridge's battery-backed RAM (the .sav file) as a view into the state, or
 *  null if the cartridge has none. Writing it patches the state. */
export function saveData(state) {
  const r = parseState(state);
  return r.sram && r.sram.length ? r.sram : null;
}

/** SM83 registers from the state. */
export function cpu(state) {
  const f = parseState(state).fields;
  const n = (k) => { const b = f[k]; if (!b) return undefined; let v = 0; for (const x of b) v = v * 256 + x; return v; };
  const F = n('f');
  return {
    pc: n('pc'), sp: n('sp'), a: n('a'), f: F, b: n('b'), c: n('c'), d: n('d'), e: n('e'), h: n('h'), l: n('l'),
    flags: { z: !!(F & 0x80), n: !!(F & 0x40), h: !!(F & 0x20), c: !!(F & 0x10) },
    ime: !!n('ime'), halted: !!n('halt'), romBank: n('rombank'),
  };
}
