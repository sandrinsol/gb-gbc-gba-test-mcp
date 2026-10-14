// Tiny hand-assembled GB test ROMs shared by the tests.

import { crc32 } from '../png.mjs';

// Interactive 32KB DMG ROM: each loop, read the action buttons, store the nibble at
// WRAM 0xC000, and set the background palette to 0xFF while any button is held (0xE4
// otherwise). So holding A changes both memory (0xC000) and the screen (white->black).
export function makeInteractiveGbRom() {
  const rom = Buffer.alloc(0x8000, 0);
  rom[0x100] = 0x00; rom[0x101] = 0xc3; rom[0x102] = 0x50; rom[0x103] = 0x01; // nop; jp 0x150
  Buffer.from('INPUTTEST').copy(rom, 0x134);
  let x = 0; for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff; rom[0x14d] = x;
  const code = [
    0x3e, 0x91, 0xe0, 0x40,             // 0x150 ld a,0x91; ldh (40),a   (LCDC on)
    0x3e, 0x10, 0xe0, 0x00,             // 0x154 ld a,0x10; ldh (00),a   (select action buttons)
    0xf0, 0x00, 0xf0, 0x00,             // 0x158 ldh a,(00); ldh a,(00)  (read P1, settle)
    0xe6, 0x0f,                         // 0x15c and 0x0F
    0xea, 0x00, 0xc0,                   // 0x15e ld (C000),a
    0xfe, 0x0f,                         // 0x161 cp 0x0F  (0x0F = nothing pressed)
    0x28, 0x04,                         // 0x163 jr z,+4 -> 0x169
    0x3e, 0xff,                         // 0x165 ld a,0xFF (pressed)
    0x18, 0x02,                         // 0x167 jr +2 -> 0x16B
    0x3e, 0xe4,                         // 0x169 ld a,0xE4 (idle)
    0xe0, 0x47,                         // 0x16b ldh (47),a  (BGP)
    0xc3, 0x54, 0x01,                   // 0x16d jp 0x154  (loop)
  ];
  for (let i = 0; i < code.length; i++) rom[0x150 + i] = code[i];
  return rom;
}

// Battery-backed 32KB ROM (MBC1+RAM+BATTERY, 8KB cart RAM). At boot it copies the
// saved byte at 0xA000 into WRAM 0xC000 and writes that value + 1 to 0xA001, then
// idles. So importing a save and power-cycling is observable in RAM, and the game
// "writing a save" is observable in the exported save.
export function makeBatteryGbRom() {
  const rom = Buffer.alloc(0x8000, 0);
  rom[0x100] = 0x00; rom[0x101] = 0xc3; rom[0x102] = 0x50; rom[0x103] = 0x01; // nop; jp 0x150
  Buffer.from('SAVETEST').copy(rom, 0x134);
  rom[0x147] = 0x03; // MBC1+RAM+BATTERY
  rom[0x149] = 0x02; // 8KB RAM
  let x = 0; for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff; rom[0x14d] = x;
  const code = [
    0x3e, 0x91, 0xe0, 0x40,       // 0x150 ld a,0x91; ldh (40),a   (LCDC on)
    0x3e, 0x0a, 0xea, 0x00, 0x00, // 0x154 ld a,0x0A; ld (0000),a  (enable cart RAM)
    0xfa, 0x00, 0xa0,             // 0x159 ld a,(A000)
    0xea, 0x00, 0xc0,             // 0x15c ld (C000),a
    0x3c,                         // 0x15f inc a
    0xea, 0x01, 0xa0,             // 0x160 ld (A001),a
    0x18, 0xfe,                   // 0x163 jr -2 (idle)
  ];
  for (let i = 0; i < code.length; i++) rom[0x150 + i] = code[i];
  return rom;
}

// 32KB ROM that turns on the LCD, enables the VBlank interrupt and HALTs between
// frames (handler at 0x40 is just RETI). Cheat devices (GameShark) apply their
// codes when VBlank is serviced, so this is the ROM to test cheats against.
export function makeVblankGbRom() {
  const rom = Buffer.alloc(0x8000, 0);
  rom[0x40] = 0xd9; // VBlank vector: reti
  rom[0x100] = 0x00; rom[0x101] = 0xc3; rom[0x102] = 0x50; rom[0x103] = 0x01; // nop; jp 0x150
  Buffer.from('VBLANK').copy(rom, 0x134);
  let x = 0; for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff; rom[0x14d] = x;
  const code = [
    0x3e, 0x91, 0xe0, 0x40, // 0x150 ld a,0x91; ldh (40),a  (LCDC on)
    0x3e, 0x01, 0xe0, 0xff, // 0x154 ld a,0x01; ldh (ff),a  (IE = VBlank)
    0xfb,                   // 0x158 ei
    0x76, 0x00,             // 0x159 halt; nop
    0x18, 0xfc,             // 0x15b jr -4 -> 0x159
  ];
  for (let i = 0; i < code.length; i++) rom[0x150 + i] = code[i];
  return rom;
}

/** Minimal store-only .zip (no compression) holding one file — enough to test
 *  zipped-ROM loading without a zip dependency. */
export function makeZip(name, data) {
  const crc = crc32(data), n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}
