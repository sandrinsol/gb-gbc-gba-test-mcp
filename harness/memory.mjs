// Read GBA memory out of an mgba save state (RASTATE container, GBASerializedState
// v7). This gives real RAM reads with NO core rebuild: take a save state whenever
// you want to inspect memory, then index it by GBA address.
//
// Read-only, at save-state granularity (which is exactly when you want to assert).
// The struct size is located *structurally* from the extdata directory, so offsets
// are correct regardless of game or save type — nothing is hardcoded per-ROM.

const SZ = { IO: 0x400, PRAM: 0x400, OAM: 0x400, VRAM: 0x18000, IWRAM: 0x8000, EWRAM: 0x40000 };
const TAIL = SZ.IO + SZ.PRAM + SZ.OAM + SZ.VRAM + SZ.IWRAM + SZ.EWRAM; // 0x60C00

// Extract the "MEM " chunk (the raw retro_serialize output) from a RASTATE buffer.
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

// sizeof(GBASerializedState): start of the extdata directory. Found by matching the
// directory of 16-byte headers {i32 tag, i32 size, i64 offset} + zero terminator,
// whose data blobs must be contiguous and fill the chunk exactly.
function findStructSize(mem) {
  const N = mem.length;
  for (let P = TAIL; P <= N - 16; P += 8) {
    let p = P, first = null, ok = true;
    const blobs = [];
    while (p + 16 <= N) {
      const tag = mem.readInt32LE(p);
      const size = mem.readInt32LE(p + 4);
      const offset = Number(mem.readBigInt64LE(p + 8));
      p += 16;
      if (tag === 0 && size === 0 && offset === 0) {
        if (first === null || first !== p) { ok = false; break; }
        let cur = p;
        for (const b of blobs) { if (b.offset !== cur) { ok = false; break; } cur += b.size; }
        if (ok && cur === N) return P;
        ok = false; break;
      }
      if (tag < 1 || tag >= 16 || size < 0 || offset < P || offset > N) { ok = false; break; }
      if (first === null) first = offset;
      blobs.push({ tag, size, offset });
      if (blobs.length > 15) { ok = false; break; }
    }
  }
  // No extdata (e.g. a game with no savedata): the struct fills the whole chunk.
  if (N >= TAIL && ((N - TAIL) % 8) === 0) return N;
  throw new Error('could not locate GBASerializedState in save state');
}

/** Parse a save state into typed views of every GBA RAM region. */
export function parseState(state) {
  const mem = memChunk(state);
  const P = findStructSize(mem);
  const base = P - TAIL; // offsetof(io)
  const io = base;
  const pram = io + SZ.IO;
  const oam = pram + SZ.PRAM;
  const vram = oam + SZ.OAM;
  const iwram = vram + SZ.VRAM;
  const ewram = iwram + SZ.IWRAM; // == P - EWRAM
  const view = (start, len) => mem.subarray(start, start + len);
  return {
    structSize: P,
    io: view(io, SZ.IO), pram: view(pram, SZ.PRAM), oam: view(oam, SZ.OAM),
    vram: view(vram, SZ.VRAM), iwram: view(iwram, SZ.IWRAM), ewram: view(ewram, SZ.EWRAM),
  };
}

// Map a GBA bus address to (region buffer, offset), honoring hardware mirroring.
function locate(regions, addr) {
  const a = addr >>> 0;
  const region = a >>> 24;
  switch (region) {
    case 0x02: return [regions.ewram, (a & 0x3ffff)];
    case 0x03: return [regions.iwram, (a & 0x7fff)];
    case 0x04: { const o = a & 0xffffff; if (o < SZ.IO) return [regions.io, o]; break; }
    case 0x05: return [regions.pram, (a & 0x3ff)];
    case 0x06: { let o = a & 0x1ffff; if (o >= SZ.VRAM) o -= 0x8000; return [regions.vram, o]; }
    case 0x07: return [regions.oam, (a & 0x3ff)];
  }
  throw new Error(`address 0x${a.toString(16)} is not in a readable RAM region`);
}

/** Read `length` bytes at a GBA address from a parsed state (or raw state buffer). */
export function readMemory(stateOrParsed, addr, length = 1) {
  const regions = Buffer.isBuffer(stateOrParsed) ? parseState(stateOrParsed) : stateOrParsed;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const [buf, off] = locate(regions, (addr + i) >>> 0);
    out[i] = buf[off];
  }
  return out;
}

/** Patch RAM at a GBA address inside a save-state buffer (in place) and return it.
 *  The region views alias the state buffer, so writing them patches the state. */
export function writeMemory(state, addr, data) {
  const regions = parseState(state);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let i = 0; i < bytes.length; i++) {
    const [buf, off] = locate(regions, (addr + i) >>> 0);
    buf[off] = bytes[i];
  }
  return state;
}

export const readU8 = (s, a) => readMemory(s, a, 1).readUInt8(0);
export const readU16 = (s, a) => readMemory(s, a, 2).readUInt16LE(0);
export const readU32 = (s, a) => readMemory(s, a, 4).readUInt32LE(0);
export const readS8 = (s, a) => readMemory(s, a, 1).readInt8(0);
export const readS16 = (s, a) => readMemory(s, a, 2).readInt16LE(0);
export const readS32 = (s, a) => readMemory(s, a, 4).readInt32LE(0);

// Offset of a region view inside the save-state buffer it was parsed from.
const offsetIn = (state, view) => view.byteOffset - state.byteOffset;

/** Save-state byte offsets of `length` bytes at a GBA bus address (for watching
 *  them frame by frame without re-parsing). */
export function stateOffsets(state, addr, length = 1) {
  const r = parseState(state);
  return Array.from({ length }, (_, i) => { const [buf, o] = locate(r, (addr + i) >>> 0); return offsetIn(state, buf) + o; });
}

/** [start, length] save-state ranges holding everything that determines the
 *  picture: VRAM, palettes, OAM and the display registers. */
export function videoRanges(state) {
  const r = parseState(state);
  return [r.vram, r.pram, r.oam, r.io.subarray(0, 0x60)].map((v) => [offsetIn(state, v), v.length]);
}

/** The cartridge's battery save (SRAM/flash/EEPROM image, i.e. the .sav file) as a
 *  view into the state, or null if the game has none. Writing it patches the state. */
export function saveData(state) {
  const mem = memChunk(state);
  const P = findStructSize(mem);
  for (let p = P; p + 16 <= mem.length; p += 16) {
    const tag = mem.readInt32LE(p), size = mem.readInt32LE(p + 4), o = Number(mem.readBigInt64LE(p + 8));
    if (tag === 0) break;
    if (tag === 2 /* EXTDATA_SAVEDATA */) return mem.subarray(o, o + size);
  }
  return null;
}

const MODES = { 0x10: 'usr', 0x11: 'fiq', 0x12: 'irq', 0x13: 'svc', 0x17: 'abt', 0x1b: 'und', 0x1f: 'sys' };

/** ARM7 registers from the state (GBASerializedState.cpu). `pc` is r15 as the CPU
 *  holds it, which runs ahead of the executing instruction by the prefetch (8 bytes
 *  in ARM state, 4 in Thumb); `executing` subtracts that. */
export function cpu(state) {
  const mem = memChunk(state);
  const r = Array.from({ length: 16 }, (_, i) => mem.readUInt32LE(0x20 + i * 4));
  const cpsr = mem.readUInt32LE(0x60);
  const thumb = !!(cpsr & 0x20);
  return {
    r: r.slice(0, 13), sp: r[13], lr: r[14], pc: r[15], executing: (r[15] - (thumb ? 4 : 8)) >>> 0,
    cpsr, mode: MODES[cpsr & 0x1f] ?? 'unknown', thumb,
    flags: { n: !!(cpsr >>> 31), z: !!(cpsr & 1 << 30), c: !!(cpsr & 1 << 29), v: !!(cpsr & 1 << 28) },
    irqDisabled: !!(cpsr & 0x80),
  };
}
