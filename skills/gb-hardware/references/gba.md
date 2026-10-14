# Game Boy Advance reference

## Memory map

| Range | Size | What |
|---|---|---|
| 00000000 | 16 KB | BIOS (not readable from game code) |
| 02000000 | 256 KB | EWRAM: 16-bit bus, 2 wait states (slow) |
| 03000000 | 32 KB | IWRAM: 32-bit, no wait states (hot ARM code, stacks) |
| 04000000 | | I/O registers |
| 05000000 | 1 KB | Palette RAM: BG 05000000, OBJ 05000200 (256 colours each) |
| 06000000 | 96 KB | VRAM |
| 07000000 | 1 KB | OAM |
| 08000000 | ≤ 32 MB | Game Pak ROM (also mirrored at 0A000000, 0C000000) |
| 0E000000 | 64 KB | SRAM / Flash (8-bit access only) |

IWRAM top is used by the BIOS: 03007FFC IRQ handler pointer, 03007FF8 BIOS IRQ flags
(IntrWait), default stacks: IRQ 03007FA0, supervisor 03007FE0, user/system 03007F00.

## Display registers

| Addr | Name | Bits |
|---|---|---|
| 04000000 | DISPCNT | 0-2 mode · 4 page (modes 4/5) · 5 OAM access in HBlank · 6 OBJ 1D mapping · 7 forced blank · 8-11 BG0-3 on · 12 OBJ on · 13-15 windows |
| 04000004 | DISPSTAT | 0 VBlank · 1 HBlank · 2 VCount match · 3 VBlank IRQ · 4 HBlank IRQ · 5 VCount IRQ · 8-15 VCount target |
| 04000006 | VCOUNT | Line 0-227; 160-227 = VBlank |
| 04000008 + 2n | BGnCNT | 0-1 priority · 2-3 char block (×16 KB) · 6 mosaic · 7 256 colours · 8-12 screen block (×2 KB) · 13 affine wrap · 14-15 size |
| 04000010 + 4n | BGnHOFS | X scroll (9 bits, write-only) |
| 04000012 + 4n | BGnVOFS | Y scroll (9 bits, write-only) |
| 04000050 | BLDCNT | Blending; 04000052 BLDALPHA, 04000054 BLDY |

Modes: 0 = four text BGs; 1 = BG0-1 text + BG2 affine; 2 = BG2-3 affine; 3 = 240×160
15-bit bitmap at 06000000; 4 = 240×160 8-bit paletted, pages at 06000000/0600A000;
5 = 160×128 15-bit, two pages. In modes 3-5 sprites can only use OBJ tiles 512-1023.

Text BG sizes (bits 14-15): 0 256×256, 1 512×256, 2 256×512, 3 512×512.

## Tiles and maps

- 4bpp tile: 32 bytes, 4 per row, low nibble = left pixel. 8bpp: 64 bytes.
- Char block n at 06000000 + n×4000; screen block n at 06000000 + n×800. They
  overlap: keep maps in blocks your tiles don't use (e.g. tiles in char block 0, map
  in screen block 31).
- Text map entry (16-bit): bits 0-9 tile, 10 X flip, 11 Y flip, 12-15 palette (4bpp).
- OBJ tiles at 06010000-06017FFF; tile numbers count 32-byte units (an 8bpp tile
  takes two numbers). 1D mapping (DISPCNT bit 6): a sprite's tiles follow each other;
  2D: rows are 32 tiles apart.

## Sprites (OAM, 07000000 + 8 × index)

| Attr | Bits |
|---|---|
| attr0 | 0-7 Y · 8 affine · 9 double size (affine) / hide (not affine) · 10-11 mode (0 normal, 1 blend, 2 window) · 12 mosaic · 13 256 colours · 14-15 shape |
| attr1 | 0-8 X · 9-13 affine matrix (affine) · 12 X flip, 13 Y flip (not affine) · 14-15 size |
| attr2 | 0-9 tile · 10-11 priority · 12-15 palette (4bpp) |

Sizes by shape (square / wide / tall) and size 0-3: 8×8 16×16 32×32 64×64 /
16×8 32×8 32×16 64×32 / 8×16 8×32 16×32 32×64. Affine matrices live in the 4th
halfword of each group of four entries (pa, pb, pc, pd).

Hide unused sprites with attr0 = 0x0200. Too many (or too wide) sprites on one line
run out of drawing time and the last ones drop out.

## Palettes

15-bit BGR: bits 0-4 red, 5-9 green, 10-14 blue. Colour 0 of every palette is
transparent; BG palette entry 0 is the backdrop colour.

## Access rules

- VRAM, palette RAM, OAM: 16/32-bit writes only. 8-bit writes to BG VRAM and palette
  RAM store the byte in both halves; to OBJ VRAM and OAM they are ignored.
- OAM is accessible in VBlank (and HBlank with DISPCNT bit 5); update it in VBlank.

## Input

KEYINPUT 04000130: bit 0 A, 1 B, 2 Select, 3 Start, 4 Right, 5 Left, 6 Up, 7 Down,
8 R, 9 L; 0 = pressed. KEYCNT 04000132 for the keypad interrupt.

## Interrupts

IE 04000200, IF 04000202 (write 1 to acknowledge), IME 04000208. Bits: 0 VBlank, 1
HBlank, 2 VCount, 3-6 Timer 0-3, 7 Serial, 8-11 DMA 0-3, 12 Keypad, 13 Game Pak.
The source must also be enabled in its own register (DISPSTAT bit 3 for VBlank).
The BIOS calls the handler at [03007FFC] in ARM mode; it must acknowledge IF, and
for IntrWait/VBlankIntrWait also OR the bits into 03007FF8.

## BIOS calls (`swi n` in Thumb, `swi n << 16` in ARM)

0x02 Halt · 0x04 IntrWait · 0x05 VBlankIntrWait · 0x06 Div (r0/r1 → r0 quotient, r1
remainder) · 0x08 Sqrt · 0x0B CpuSet · 0x0C CpuFastSet · 0x11/0x12 LZ77 decompress to
WRAM/VRAM · 0x01 RegisterRamReset.

## DMA and timers

DMA3 (general purpose): 040000D4 source, 040000D8 destination, 040000DC count (low
16 bits) + control (high 16: bit 15 enable, bit 10 32-bit, bits 12-13 start: 0 now, 1
VBlank, 2 HBlank, 3 special; bit 14 IRQ). Timers: 04000100 + 4n (reload/count),
04000102 + 4n (control: bits 0-1 prescaler 1/64/256/1024, 2 cascade, 6 IRQ, 7 on).

## Speed

- ROM is a 16-bit bus: compile game code as Thumb (`-mthumb`); put hot loops in IWRAM
  as ARM (`__attribute__((section(".iwram"), target("arm")))` or `IWRAM_CODE`).
- WAITCNT 04000204 = 0x4317 is the usual faster ROM setting.
- No divide instruction; avoid `/` and `%` in hot paths.

## Cartridge header (first 0xC0 bytes)

| Offset | Field |
|---|---|
| 0x00 | ARM branch to the start code |
| 0x04-0x9F | Nintendo logo (checked by the BIOS) |
| 0xA0 | Title (12 bytes) |
| 0xAC | Game code (4) · 0xB0 maker code (2) |
| 0xB2 | Fixed 0x96 |
| 0xBD | Complement: -(sum of 0xA0-0xBC) - 0x19 |

`gbafix` writes the logo and checksum. Save type: emulators detect SRAM/Flash/EEPROM
from a string in the ROM (`SRAM_V`, `FLASH1M_V`, `EEPROM_V`); devkitARM's save
libraries add it.
