# Game Boy / Game Boy Color reference

## Memory map

| Range | What |
|---|---|
| 0000-3FFF | ROM bank 0 |
| 4000-7FFF | ROM bank 1-N (selected through the MBC) |
| 8000-97FF | VRAM tile data: 384 tiles × 16 bytes (GBC: 2 banks, VBK FF4F) |
| 9800-9BFF / 9C00-9FFF | Tile maps, 32×32 bytes each (GBC bank 1: attributes) |
| A000-BFFF | Cartridge RAM (enable first: write $0A to 0000-1FFF) |
| C000-CFFF | WRAM bank 0 |
| D000-DFFF | WRAM bank 1 (GBC: 1-7, SVBK FF70) |
| E000-FDFF | Echo of C000-DDFF (don't use) |
| FE00-FE9F | OAM: 40 sprites × 4 bytes |
| FEA0-FEFF | Unusable |
| FF00-FF7F | I/O registers |
| FF80-FFFE | HRAM (usable during OAM DMA) |
| FFFF | IE |

## Tiles and maps

- A tile is 8×8, 2 bits per pixel, 16 bytes: per row, one byte of low bits then one
  byte of high bits; bit 7 is the leftmost pixel.
- LCDC bit 4 = 1: BG/window tile n at 8000+16n (n 0-255). Bit 4 = 0: at 9000+16n
  with n signed (-128..127). Sprites always use 8000+16n.
- GBC map attributes (VRAM bank 1, same address as the tile number): bits 0-2
  palette, bit 3 tile VRAM bank, bit 5 X flip, bit 6 Y flip, bit 7 BG-over-sprites.

## Sprites (OAM, FE00 + 4 × index)

| Byte | Meaning |
|---|---|
| 0 | Y + 16 (0 or ≥ 160 hides it) |
| 1 | X + 8 (0 or ≥ 168 hides it) |
| 2 | Tile (8x16 mode ignores bit 0) |
| 3 | Bit 7 behind BG colours 1-3, bit 6 Y flip, bit 5 X flip, bit 4 DMG palette OBP0/OBP1, bit 3 GBC VRAM bank, bits 0-2 GBC palette |

At most 10 sprites per scanline (the rest are not drawn); colour 0 is transparent.
OAM DMA: write the source's high byte to FF46 (source $XX00 in ROM/WRAM); for the
next 160 µs only HRAM is usable, so run it from HRAM:

```
ldh [$46], a     ; a = HIGH(wShadowOAM)
ld a, 40
.wait: dec a
jr nz, .wait
ret
```

## LCD registers

| Addr | Name | Bits |
|---|---|---|
| FF40 | LCDC | 7 LCD on · 6 window map 9C00 · 5 window on · 4 tiles at 8000 · 3 BG map 9C00 · 2 sprites 8x16 · 1 sprites on · 0 BG on (GBC: BG priority) |
| FF41 | STAT | 0-1 mode (0 HBlank, 1 VBlank, 2 OAM scan, 3 drawing) · 2 LY=LYC · 3-6 interrupt on HBlank/VBlank/OAM/LYC |
| FF42 / FF43 | SCY / SCX | BG scroll |
| FF44 | LY | Current line 0-153; 144-153 = VBlank |
| FF45 | LYC | Line compare |
| FF46 | DMA | OAM DMA source high byte |
| FF47 | BGP | DMG BG palette: 2 bits per colour, bits 1-0 = colour 0; shade 0 white … 3 black |
| FF48 / FF49 | OBP0 / OBP1 | DMG sprite palettes (colour 0 unused: transparent) |
| FF4A / FF4B | WY / WX | Window position (WX is X + 7) |
| FF4D | KEY1 | GBC speed switch (set bit 0, then `stop`) |
| FF4F | VBK | GBC VRAM bank |
| FF51-FF55 | HDMA1-5 | GBC VRAM DMA |
| FF68 / FF69 | BCPS / BCPD | GBC BG palette index (bit 7 auto-increment) / data |
| FF6A / FF6B | OCPS / OCPD | GBC sprite palette index / data |
| FF70 | SVBK | GBC WRAM bank (1-7) |

GBC colours: 15-bit little-endian, bits 0-4 red, 5-9 green, 10-14 blue; 8 BG and 8
sprite palettes of 4 colours.

## Timing

- CPU 4.194304 MHz (1.048576 MHz machine cycles); a frame is 70224 clocks, ~59.73 Hz.
- 154 lines × 456 clocks. Lines 0-143: mode 2 (80 clocks) → mode 3 (172-289) → mode 0.
- VBlank (lines 144-153) is ~1.1 ms: the main window for VRAM updates.
- VRAM is inaccessible in mode 3; OAM in modes 2 and 3 (writes dropped, reads $FF).

## Interrupts

IE = FFFF, IF = FF0F. Bit 0 VBlank → $40, 1 STAT → $48, 2 Timer → $50, 3 Serial →
$58, 4 Joypad → $60. `ei` takes effect after the next instruction; handlers end
with `reti`.

## Joypad (FF00)

Write $20 (bit 4 low) to read the D-pad, $10 (bit 5 low) for buttons; read a few
times to let it settle; low nibble, 0 = pressed. D-pad: bit 0 Right, 1 Left, 2 Up,
3 Down. Buttons: bit 0 A, 1 B, 2 Select, 3 Start. Write $30 afterwards.

## Other registers

FF04 DIV, FF05 TIMA, FF06 TMA, FF07 TAC (timer); FF10-FF26 sound (FF26 NR52 bit 7
enables sound; FF24 NR50 volume, FF25 NR51 panning); FF01/FF02 serial.

## Cartridge header (0100-014F)

| Addr | Field |
|---|---|
| 0100-0103 | Entry: `nop` / `jp $0150` |
| 0104-0133 | Nintendo logo (boot ROM checks it) |
| 0134-0143 | Title; 0143 = $80 GBC-enhanced, $C0 GBC only |
| 0147 | Cartridge type: $00 ROM only, $01-03 MBC1, $0F-13 MBC3, $19-1E MBC5 (+RAM, +battery variants) |
| 0148 | ROM size: 32 KB << n |
| 0149 | RAM size: 0 none, 2 8 KB, 3 32 KB, 4 128 KB, 5 64 KB |
| 014D | Header checksum (boot ROM checks it): x = x - byte - 1 over 0134-014C |
| 014E-014F | Global checksum (not checked) |

`rgbfix -v -p 0xFF` fixes the logo and checksums and pads the ROM.

## MBC banking

- MBC1: ROM bank = write to 2000-3FFF (0 selects 1); RAM bank 4000-5FFF.
- MBC5: ROM bank low 8 bits 2000-2FFF, bit 8 3000-3FFF (bank 0 allowed); RAM bank 4000-5FFF.
- RAM enable: $0A to 0000-1FFF; disable ($00) after writing saves.
