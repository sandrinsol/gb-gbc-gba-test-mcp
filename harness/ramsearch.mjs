// RAM value search ("cheat search") over save-state RAM regions.
//
// Finds where the game stores a value (HP, score, coins…) without the agent
// hex-dumping RAM: snapshot every candidate address, then narrow the set with
// comparisons against a known value or against the previous snapshot.
//
//   const s = new RamSearch('gba', await emu.readRegions(), { type: 'u8' });
//   // ...lose 1 HP in game...
//   s.filter(await emu.readRegions(), 'decreased');
//   s.filter(await emu.readRegions(), 'eq', 9);
//   s.results(10); // -> [{ address, value, previous, region }]

const TYPES = {
  u8: [1, false], u16: [2, false], u32: [4, false],
  s8: [1, true], s16: [2, true], s32: [4, true],
};
export const SEARCH_TYPES = Object.keys(TYPES);
export const SEARCH_OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'changed', 'unchanged', 'increased', 'decreased', 'delta'];
const NEEDS_VALUE = new Set(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'delta']);

/** The searchable RAM areas of a parsed state, with how each offset maps to a bus
 *  address. GBA: EWRAM + IWRAM. GB/GBC: WRAM (every CGB bank), HRAM, cart SRAM. */
export function searchAreas(system, regions) {
  if (system === 'gba') {
    return [
      { name: 'ewram', buf: regions.ewram, addr: (o) => 0x02000000 + o },
      { name: 'iwram', buf: regions.iwram, addr: (o) => 0x03000000 + o },
    ];
  }
  const areas = [{
    // CGB banks 1-7 all appear at 0xD000; report which bank a hit lives in.
    name: 'wram', buf: regions.wram,
    addr: (o) => (o < 0x1000 ? 0xc000 + o : 0xd000 + (o & 0xfff)),
    bank: regions.isCgbWram ? (o) => (o < 0x1000 ? 0 : o >> 12) : null,
  }, {
    name: 'hram', buf: regions.hram.subarray(0x180, 0x1ff), addr: (o) => 0xff80 + o,
  }];
  if (regions.sram && regions.sram.length) {
    areas.push({
      name: 'sram', buf: regions.sram, addr: (o) => 0xa000 + (o & 0x1fff),
      bank: regions.sram.length > 0x2000 ? (o) => o >> 13 : null,
    });
  }
  return areas;
}

function reader(width, signed) {
  if (width === 1) return signed ? (b, o) => b.readInt8(o) : (b, o) => b[o];
  if (width === 2) return signed ? (b, o) => b.readInt16LE(o) : (b, o) => b.readUInt16LE(o);
  return signed ? (b, o) => b.readInt32LE(o) : (b, o) => b.readUInt32LE(o);
}

export class RamSearch {
  /** @param {string} system 'gba' | 'gb'
   *  @param {any} regions parsed RAM regions (EmuHarness#readRegions)
   *  @param {object} [opts]
   *  @param {string} [opts.type]  u8|u16|u32|s8|s16|s32 (little-endian)
   *  @param {string} [opts.region] restrict to one area name (e.g. 'iwram', 'wram') */
  constructor(system, regions, { type = 'u8', region = undefined } = {}) {
    if (!TYPES[type]) throw new Error(`type must be one of ${SEARCH_TYPES.join(', ')}`);
    /** @type {number} */ this.width = TYPES[type][0];
    /** @type {boolean} */ this.signed = TYPES[type][1];
    this.type = type; this.system = system;
    this.read = reader(this.width, this.signed);
    let areas = searchAreas(system, regions);
    if (region) {
      areas = areas.filter((a) => a.name === region.toLowerCase());
      if (!areas.length) throw new Error(`unknown region "${region}" (have: ${searchAreas(system, regions).map((a) => a.name).join(', ')})`);
    }
    this.areas = areas.map((a) => ({ ...a, buf: undefined }));
    // GBA code keeps multi-byte values aligned; GB (8-bit CPU) doesn't.
    const step = system === 'gba' ? this.width : 1;
    this.cands = areas.map((a) => {
      const n = Math.max(0, Math.floor((a.buf.length - this.width) / step) + 1);
      const offs = new Int32Array(n);
      for (let i = 0; i < n; i++) offs[i] = i * step;
      return offs;
    });
    this.prev = null;
    this.cur = areas.map((a) => Buffer.from(a.buf)); // own copies
    this.filters = 0;
  }

  get count() { return this.cands.reduce((n, c) => n + c.length, 0); }

  _norm(v) {
    const bits = this.width * 8;
    if (this.signed) return Number(BigInt.asIntN(bits, BigInt(v)));
    return Number(BigInt.asUintN(bits, BigInt(v)));
  }

  /** Narrow the candidates. Value ops (eq ne gt lt gte lte) compare the current
   *  value to `value`; changed/unchanged/increased/decreased compare to the value
   *  at the previous snapshot; delta keeps current - previous == value. */
  filter(regions, op, value) {
    if (!SEARCH_OPS.includes(op)) throw new Error(`op must be one of ${SEARCH_OPS.join(', ')}`);
    if (NEEDS_VALUE.has(op) && (value === undefined || value === null)) throw new Error(`op "${op}" needs a value`);
    const v = op === 'delta' ? value : (NEEDS_VALUE.has(op) ? this._norm(value) : 0);
    const byName = Object.fromEntries(searchAreas(this.system, regions).map((a) => [a.name, a.buf]));
    const next = this.areas.map((a) => Buffer.from(byName[a.name]));
    const test = {
      eq: (c) => c === v, ne: (c) => c !== v, gt: (c) => c > v, lt: (c) => c < v,
      gte: (c) => c >= v, lte: (c) => c <= v,
      changed: (c, p) => c !== p, unchanged: (c, p) => c === p,
      increased: (c, p) => c > p, decreased: (c, p) => c < p, delta: (c, p) => c - p === v,
    }[op];
    this.cands = this.cands.map((offs, ai) => {
      const nb = next[ai], ob = this.cur[ai];
      const keep = new Int32Array(offs.length);
      let k = 0;
      for (let i = 0; i < offs.length; i++) {
        const o = offs[i];
        if (test(this.read(nb, o), this.read(ob, o))) keep[k++] = o;
      }
      return keep.slice(0, k);
    });
    this.prev = this.cur;
    this.cur = next;
    this.filters++;
    return this.count;
  }

  /** The first `limit` candidates: { address, region, bank?, value, previous? }. */
  results(limit = 20) {
    const out = [];
    for (let ai = 0; ai < this.areas.length && out.length < limit; ai++) {
      const a = this.areas[ai];
      for (const o of this.cands[ai]) {
        if (out.length >= limit) break;
        const r = { address: a.addr(o), region: a.name, value: this.read(this.cur[ai], o) };
        if (a.bank) r.bank = a.bank(o);
        if (this.prev) r.previous = this.read(this.prev[ai], o);
        out.push(r);
      }
    }
    return out;
  }
}
