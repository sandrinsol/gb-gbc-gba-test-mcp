// Debug symbols from homebrew toolchains, so tools take names ("wPlayerX",
// "player_hp+2") instead of addresses and can say which function the CPU is in.
//
// Formats: RGBDS / no$gmb .sym ("BB:AAAA name"), GBDK/SDCC .noi ("DEF _name 0x..."),
// ELF files (devkitARM, Butano, any arm-none-eabi build), GNU ld .map, nm output,
// and RGBDS .map. findSymbols() looks next to a ROM for a file with the same name.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** @typedef {{ name: string, addr: number, bank?: number, size?: number, code?: boolean }} Sym */

export class Symbols {
  /** @param {Sym[]} list @param {string} [file] */
  constructor(list, file) {
    this.file = file;
    /** @type {Map<string, Sym>} */
    this.byName = new Map();
    for (const s of list) if (!this.byName.has(s.name)) this.byName.set(s.name, s);
    // At equal addresses the last one wins in nameOf: put real variables and
    // functions (sized, no leading underscores) after linker markers like __bss_start.
    const rank = (s) => (s.size ? 2 : 0) + (/^__|^\.|_(start|end)__?$/i.test(s.name) ? 0 : 1);
    this.sorted = [...this.byName.values()].sort((a, b) => a.addr - b.addr || rank(a) - rank(b));
  }

  get count() { return this.byName.size; }

  /** Look a name up as given, then with C's leading underscore (SDCC/GBDK). */
  get(name) {
    return this.byName.get(name) ?? this.byName.get('_' + name) ?? (name.startsWith('_') ? this.byName.get(name.slice(1)) : undefined);
  }

  /** "name", "name+4" or "name-0x10" → address, or undefined if not a known name. */
  resolve(expr) {
    const m = /^\s*([A-Za-z_.$@][\w.$@]*)\s*(?:([+-])\s*(0x[0-9a-f]+|\$[0-9a-f]+|\d+))?\s*$/i.exec(expr);
    if (!m) return undefined;
    const s = this.get(m[1]);
    if (!s) return undefined;
    let off = 0;
    if (m[3]) off = /^(0x|\$)/i.test(m[3]) ? parseInt(m[3].replace(/^(0x|\$)/i, ''), 16) : parseInt(m[3], 10);
    return s.addr + (m[2] === '-' ? -off : off);
  }

  /** The symbol an address falls in, as "name" or "name+off" (null if none is
   *  close). `bank`: the switchable ROM bank, to pick among GB banked symbols.
   *  @param {number} addr @param {{ bank?: number, maxOffset?: number }} [opts] */
  nameOf(addr, { bank, maxOffset = 0x1000 } = {}) {
    let best = null;
    for (const s of this.sorted) {
      if (s.addr > addr) break;
      if (bank !== undefined && s.bank !== undefined && s.addr >= 0x4000 && s.addr < 0x8000 && s.bank !== bank) continue;
      if (s.size && addr >= s.addr + s.size) continue;
      if (!best || s.addr >= best.addr) best = s;
    }
    if (!best || addr - best.addr > maxOffset) return null;
    const off = addr - best.addr;
    return off ? `${best.name}+${off}` : best.name;
  }
}

/** Parse symbol file contents (format detected from the content). */
export function parseSymbols(buf, file = '') {
  if (buf.length > 4 && buf.readUInt32BE(0) === 0x7f454c46) return parseElf(buf);
  const text = buf.toString('utf8');
  /** @type {Sym[]} */
  const out = [];
  const lines = text.split(/\r?\n/);
  const isRgbdsMap = /^(SUMMARY:|ROM0 bank|ROMX bank|WRAM0 bank|HRAM bank)/m.test(text);
  let bank;
  for (const line of lines) {
    let m;
    if ((m = /^\s*([0-9a-f]{1,4}):([0-9a-f]{4})\s+([^\s;]+)/i.exec(line))) {
      // RGBDS / no$gmb .sym
      out.push({ name: m[3], addr: parseInt(m[2], 16), bank: parseInt(m[1], 16) });
    } else if ((m = /^DEF\s+(\S+)\s+0x([0-9a-f]+)/i.exec(line))) {
      // SDCC .noi: banked addresses carry the bank in bits 16+
      const name = m[1];
      // skip section starts/lengths, bank numbers and GBDK's hardware register names
      if (/^[ls]__|^\.|^___bank_|^b_|^_r[A-Z0-9]+$/.test(name)) continue;
      const v = parseInt(m[2], 16);
      out.push({ name, addr: v & 0xffff, ...(v > 0xffff ? { bank: v >>> 16 } : {}) });
    } else if (isRgbdsMap) {
      if ((m = /bank #(\d+)/i.exec(line))) bank = parseInt(m[1], 10);
      else if ((m = /^\s+\$([0-9a-f]{4}) = (\S+)/i.exec(line))) out.push({ name: m[2], addr: parseInt(m[1], 16), bank });
    } else if ((m = /^\s+0x([0-9a-f]{8,16})\s+([A-Za-z_.$][\w.$]*)\s*$/i.exec(line))) {
      // GNU ld .map: "                0x03000000                player_x"
      out.push({ name: m[2], addr: parseInt(m[1], 16) >>> 0 });
    } else if ((m = /^([0-9a-f]{8})\s+[a-z]\s+([A-Za-z_.$][\w.$]*)$/i.exec(line))) {
      // nm output
      out.push({ name: m[2], addr: parseInt(m[1], 16) >>> 0 });
    } else if ((m = /^\s+([0-9A-F]{8})\s+(_\w+)\s/.exec(line))) {
      // SDCC .map
      const v = parseInt(m[1], 16);
      out.push({ name: m[2], addr: v & 0xffff, ...(v > 0xffff ? { bank: v >>> 16 } : {}) });
    }
  }
  if (!out.length) throw new Error(`no symbols found in ${file || 'file'} (expected .sym, .noi, .elf or .map)`);
  return new Symbols(out, file);
}

/** 32-bit little-endian ELF: the .symtab's functions and objects. */
function parseElf(buf) {
  if (buf[4] !== 1 || buf[5] !== 1) throw new Error('only 32-bit little-endian ELF files are supported');
  const shoff = buf.readUInt32LE(0x20), shentsize = buf.readUInt16LE(0x2e), shnum = buf.readUInt16LE(0x30);
  const sec = (i) => {
    const o = shoff + i * shentsize;
    return { type: buf.readUInt32LE(o + 4), offset: buf.readUInt32LE(o + 16), size: buf.readUInt32LE(o + 20), link: buf.readUInt32LE(o + 24), entsize: buf.readUInt32LE(o + 36) };
  };
  /** @type {Sym[]} */
  const out = [];
  for (let i = 0; i < shnum; i++) {
    const s = sec(i);
    if (s.type !== 2) continue; // SHT_SYMTAB
    const strtab = sec(s.link);
    for (let o = s.offset; o + 16 <= s.offset + s.size; o += s.entsize || 16) {
      const nameOff = buf.readUInt32LE(o), value = buf.readUInt32LE(o + 4), size = buf.readUInt32LE(o + 8);
      const type = buf[o + 12] & 0xf, shndx = buf.readUInt16LE(o + 14);
      if (!nameOff || shndx === 0 || shndx >= 0xff00 || (type !== 1 && type !== 2 && type !== 0)) continue;
      const end = buf.indexOf(0, strtab.offset + nameOff);
      const name = buf.toString('utf8', strtab.offset + nameOff, end);
      if (!name || name.startsWith('$') || name.startsWith('.')) continue; // ARM mapping symbols
      out.push({ name, addr: type === 2 ? value & ~1 : value, ...(size ? { size } : {}), ...(type === 2 ? { code: true } : {}) });
    }
  }
  if (!out.length) throw new Error('the ELF file has no symbol table (built with -s?)');
  return new Symbols(out);
}

/** Parse a bus address given as a number, a string ("0x03000010", "$C000",
 *  "C000h", decimal digits) or, with `symbols`, a name ("wPlayerX", "hp+1").
 *  JSON has no hex literals, so agents send strings.
 *  @param {number | string} a @param {Symbols | null} [symbols] */
export function parseAddress(a, symbols) {
  if (typeof a === 'number') {
    if (!Number.isInteger(a) || a < 0) throw new Error(`invalid address ${a}`);
    return a;
  }
  const s = String(a).trim();
  let m;
  if ((m = /^(?:0x|\$)([0-9a-f]+)$/i.exec(s))) return parseInt(m[1], 16);
  const named = symbols?.resolve(s);
  if (named !== undefined) return named;
  if ((m = /^([0-9a-f]+)h$/i.exec(s))) return parseInt(m[1], 16);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^[0-9a-f]+$/i.test(s)) return parseInt(s, 16); // bare hex with a-f digits
  throw new Error(symbols
    ? `"${a}" is not an address or a symbol in ${path.basename(symbols.file ?? 'the symbol file')}`
    : `invalid address "${a}" (use e.g. "0x03000010"; names need a symbol file)`);
}

/** Load a symbol file. */
export async function loadSymbols(file) {
  const s = parseSymbols(await readFile(file), file);
  s.file = file;
  return s;
}

/** A symbol file next to `rom` with the same base name, or null. */
export async function findSymbols(rom) {
  const base = rom.replace(/\.(gba|gbc|gb|zip)$/i, '');
  for (const ext of ['.sym', '.noi', '.elf', '.map']) {
    const f = base + ext;
    try { if ((await stat(f)).isFile()) return f; } catch { /* next */ }
  }
  // devkitARM/Butano keep the .elf in the project dir, named after it.
  const dir = path.dirname(rom);
  try { const f = path.join(dir, path.basename(dir) + '.elf'); if ((await stat(f)).isFile()) return f; } catch { /* none */ }
  return null;
}
