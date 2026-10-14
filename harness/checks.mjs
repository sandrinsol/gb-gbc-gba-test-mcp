// Hardware-rule checks for homebrew: the ROM header (real hardware refuses a bad
// one even though emulators boot it) and a short run watching for the mistakes
// that show up on a console but are easy to miss in an emulator.
//
// Not checked: VRAM/OAM writes while the screen is drawing (they're silently
// dropped on hardware). That needs per-instruction hooks the bundled cores don't
// expose; golden-image tests catch the resulting glitches.

import { gbaSprites, gbSprites } from './video.mjs';
import { spriteLimitWarnings } from './sprite.mjs';
import { gbaDisplayIssues, gbaSaveType, gbaSoundIssues, vramBudget, decodeIo } from './gba.mjs';

const GB_LOGO = Buffer.from('ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e', 'hex');
// The GBA logo's first bytes: enough to tell "present" from zeros (gbafix writes it).
const GBA_LOGO_HEAD = Buffer.from('24ffae51699aa221', 'hex');

/** @typedef {{ level: 'error' | 'warn' | 'ok', msg: string }} Finding */

/** Problems with a ROM's header. @param {Buffer} rom @param {'gb'|'gba'} system @returns {Finding[]} */
export function romHeaderIssues(rom, system) {
  /** @type {Finding[]} */
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg }), warn = (msg) => out.push({ level: 'warn', msg });
  if (system === 'gba') {
    if (rom.length < 0xc0) { err('ROM is smaller than its header'); return out; }
    if (!rom.subarray(4, 12).equals(GBA_LOGO_HEAD)) err('Nintendo logo missing at 0x04 (run gbafix): real hardware will not boot');
    if (rom[0xb2] !== 0x96) err('fixed byte 0xB2 must be 0x96 (run gbafix)');
    let sum = 0;
    for (let i = 0xa0; i < 0xbd; i++) sum += rom[i];
    const want = (-(sum + 0x19)) & 0xff;
    if (rom[0xbd] !== want) err(`header checksum 0xBD is 0x${rom[0xbd].toString(16)}, should be 0x${want.toString(16)} (run gbafix): real hardware will not boot`);
    if ((rom.readUInt32LE(0) >>> 24) !== 0xea) warn('first instruction is not a branch (b start): the header would be executed');
    if (rom.length > 32 * 1024 * 1024) err('ROM is larger than 32 MB');
    const save = gbaSaveType(rom);
    if (!out.length) out.push({ level: 'ok', msg: `GBA header valid (${(rom.length / 1024).toFixed(0)} KB, save type ${save ?? 'none declared'})` });
    return out;
  }
  if (rom.length < 0x150) { err('ROM is smaller than its header'); return out; }
  if (!rom.subarray(0x104, 0x134).equals(GB_LOGO)) err('Nintendo logo at 0x104 is wrong (run rgbfix -v / makebin): real hardware locks up at boot');
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff;
  if (rom[0x14d] !== x) err(`header checksum 0x14D is 0x${rom[0x14d].toString(16)}, should be 0x${x.toString(16)} (run rgbfix -v): real hardware locks up at boot`);
  const sizeCode = rom[0x148];
  if (sizeCode <= 8) {
    const declared = 32768 << sizeCode;
    if (declared !== rom.length) warn(`header says ${declared / 1024} KB (0x148 = ${sizeCode}) but the file is ${(rom.length / 1024).toFixed(0)} KB (pad it: rgbfix -p 0xFF)`);
  } else err(`ROM size code 0x148 = ${sizeCode} is invalid`);
  const cart = rom[0x147];
  if (cart === 0x00 && rom.length > 32768) err(`cartridge type 0x147 is ROM ONLY but the ROM is ${(rom.length / 1024).toFixed(0)} KB: banks above 32 KB need an MBC (e.g. 0x19 MBC5)`);
  const ramCode = rom[0x149];
  const hasRam = [0x02, 0x03, 0x08, 0x09, 0x0c, 0x0d, 0x10, 0x12, 0x13, 0x1a, 0x1b, 0x1d, 0x1e, 0x22, 0xff].includes(cart);
  if (hasRam && ramCode === 0 && cart !== 0x22) warn('cartridge type has RAM but 0x149 declares none: saves won\'t work');
  if (!hasRam && ramCode !== 0 && cart !== 0x06 && cart !== 0x05) warn('0x149 declares cartridge RAM but the cartridge type has none');
  let g = 0;
  for (let i = 0; i < rom.length; i++) if (i !== 0x14e && i !== 0x14f) g = (g + rom[i]) & 0xffff;
  if (rom.readUInt16BE(0x14e) !== g) warn('global checksum 0x14E is wrong (hardware ignores it; rgbfix -v fixes it)');
  if (!out.some((f) => f.level === 'error')) out.unshift({ level: 'ok', msg: `GB header valid (${rom[0x143] & 0x80 ? (rom[0x143] === 0xc0 ? 'GBC only' : 'GBC+DMG') : 'DMG'}, cart 0x${cart.toString(16)}, ${(rom.length / 1024).toFixed(0)} KB)` });
  return out;
}

/** Collects per-frame observations and turns them into findings. */
export class RunChecker {
  /** @param {'gb'|'gba'} system @param {{ frameCounter?: number | null, counterWidth?: number, cpuUsage?: number | null }} [opts] */
  constructor(system, { frameCounter = null, counterWidth = 1, cpuUsage = null } = {}) {
    this.cpuUsage = cpuUsage; this.cpu = [];
    this.objPeak = 0; this.objTotal = 1024; this.objPalPeak = 0; this.anySound = false;
    this.system = system;
    this.frameCounter = frameCounter; this.counterWidth = counterWidth;
    this.frames = 0; this.lag = 0; this.lastCounter = null;
    this.spriteFrames = 0; this.spriteWorst = '';
    this.bitmapObjLow = 0; this.lcdOff = 0; this.forcedBlank = 0;
    this.badPc = null; this.badSp = null; this.haltNoIrq = 0; this.rst38 = 0;
    /** @type {Map<string, { level: 'error' | 'warn', msg: string, frames: number }>} */
    this.display = new Map(); // GBA display mistakes, by kind
  }

  /** @param {any} regions @param {any} cpu @param {Buffer | null} counterBytes
   *  @param {number | null} [cpuPercent] the game's own CPU-usage variable, in % of a frame */
  observe(regions, cpu, counterBytes, cpuPercent = null) {
    if (cpuPercent !== null) this.cpu.push(cpuPercent);
    this.frames++;
    const gba = this.system === 'gba';
    const sprites = gba ? gbaSprites(regions) : gbSprites(regions, { cgb: !!regions.isCgbWram });
    const lim = spriteLimitWarnings(this.system, sprites, regions);
    if (lim.length) { this.spriteFrames++; if (!this.spriteWorst) this.spriteWorst = lim.join('; '); }

    if (counterBytes) {
      const v = this.counterWidth === 1 ? counterBytes[0] : this.counterWidth === 2 ? counterBytes.readUInt16LE(0) : counterBytes.readUInt32LE(0);
      if (this.lastCounter !== null && v === this.lastCounter) this.lag++;
      this.lastCounter = v;
    }

    const pc = gba ? cpu.executing ?? cpu.pc : cpu.pc;
    if (gba) {
      const dispcnt = regions.io.readUInt16LE(0);
      if ((dispcnt & 7) >= 3 && dispcnt & 0x1000 && sprites.some((s) => s.onScreen && s.tile < 512)) this.bitmapObjLow++;
      if (dispcnt & 0x80) this.forcedBlank++;
      const io = decodeIo(regions.io);
      if (io.sound.master && (io.sound.a.left || io.sound.a.right || io.sound.b.left || io.sound.b.right || io.sound.psg.some((c) => c.left || c.right))) this.anySound = true;
      if (this.frames % 10 === 1) {
        const b = vramBudget(regions);
        this.objPeak = Math.max(this.objPeak, b.objUsed); this.objTotal = b.objTotal; this.objPalPeak = Math.max(this.objPalPeak, b.objPal);
      }
      for (const f of [...gbaDisplayIssues(regions), ...gbaSoundIssues(io)]) {
        const seen = this.display.get(f.key);
        if (seen) seen.frames++; else this.display.set(f.key, { level: f.level, msg: f.msg, frames: 1 });
      }
      const inRange = (a) => (a < 0x4000) || (a >= 0x02000000 && a < 0x02040000) || (a >= 0x03000000 && a < 0x03008000) || (a >= 0x08000000 && a < 0x0e000000);
      if (!inRange(pc) && this.badPc === null) this.badPc = pc;
      const sp = cpu.sp >>> 0;
      if (!((sp >= 0x02000000 && sp <= 0x02040000) || (sp >= 0x03000000 && sp <= 0x03008000)) && this.badSp === null) this.badSp = sp;
    } else {
      const lcdc = regions.io[0x40];
      if (!(lcdc & 0x80)) this.lcdOff++;
      if (cpu.halted && !cpu.ime && !(regions.hram?.[0x1ff] ?? 1)) this.haltNoIrq++;
      if (pc === 0x38 || pc === 0x39) this.rst38++;
      if (((pc >= 0x8000 && pc < 0xa000) || (pc >= 0xfe00 && pc < 0xff80)) && this.badPc === null) this.badPc = pc;
      if ((cpu.sp < 0xa000 || (cpu.sp > 0xe000 && cpu.sp < 0xff80)) && this.badSp === null) this.badSp = cpu.sp;
    }
  }

  /** @returns {Finding[]} */
  findings() {
    /** @type {Finding[]} */
    const out = [];
    const n = this.frames;
    const hex = (v) => '0x' + (v >>> 0).toString(16);
    if (this.badPc !== null) out.push({ level: 'error', msg: `CPU executing at ${hex(this.badPc)}, outside code memory: crashed (bad jump, stack overwrite or return address)` });
    if (this.rst38 >= 2) out.push({ level: 'error', msg: 'CPU looping through rst $38: it is executing 0xFF bytes (a jump into empty ROM or a corrupted stack)' });
    if (this.haltNoIrq === n && n > 1) out.push({ level: 'error', msg: 'CPU halted with interrupts disabled (di + halt): frozen forever' });
    if (this.badSp !== null) out.push({ level: 'error', msg: `stack pointer at ${hex(this.badSp)}, outside RAM: the stack was never set up or has overflowed` });
    if (this.lcdOff === n && n > 1) out.push({ level: 'warn', msg: 'the LCD was off the whole time (LCDC bit 7): the screen stays blank' });
    if (this.forcedBlank === n && n > 1) out.push({ level: 'warn', msg: 'forced blank (DISPCNT bit 7) the whole time: the screen stays white' });
    if (this.bitmapObjLow) out.push({ level: 'error', msg: 'bitmap mode (3-5) with sprites using tiles below 512: those tiles are covered by the bitmap and show garbage; use tiles 512+' });
    for (const f of this.display.values()) out.push({ level: f.level, msg: f.frames < n ? `${f.msg} (${f.frames}/${n} frames)` : f.msg });
    if (this.system === 'gba') {
      if (this.objPeak >= this.objTotal * 0.9) out.push({ level: 'warn', msg: `sprite tile memory nearly full (${this.objPeak}/${this.objTotal} slots hold data): new sprites will fail to load (Butano asserts "no more sprite tiles")` });
      if (this.objPalPeak >= 16) out.push({ level: 'warn', msg: 'all 16 sprite palette banks are in use: the next sprite with new colours has no palette' });
      if (!this.anySound) out.push({ level: 'ok', msg: 'no sound set up during the run (silent)' });
    }
    if (this.cpu.length) {
      const max = Math.max(...this.cpu), min = Math.min(...this.cpu), avg = Math.round(this.cpu.reduce((a, b) => a + b, 0) / this.cpu.length);
      const msg = `CPU ${min}-${max}% of a frame (average ${avg}%)`;
      if (max >= 100) out.push({ level: 'warn', msg: `${msg}: at ${max}% the game misses frames there (slowdown)` });
      else if (max >= 90) out.push({ level: 'warn', msg: `${msg}: close to the limit, any more work will cause slowdown` });
      else out.push({ level: 'ok', msg });
    }
    if (this.spriteFrames) out.push({ level: 'warn', msg: `sprite limits exceeded in ${this.spriteFrames}/${n} frames (sprites drop out or flicker): ${this.spriteWorst}` });
    if (this.frameCounter !== null && n > 2) {
      if (this.lag) out.push({ level: 'warn', msg: `${this.lag} of ${n - 1} frames lagged (the frame counter didn't advance): the game loop took longer than a frame` });
      else out.push({ level: 'ok', msg: `no lag frames in ${n} frames` });
    }
    return out;
  }
}
