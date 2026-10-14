// Tiny hand-assembled GB test ROMs shared by the tests.

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
