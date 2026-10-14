---
name: gb-hardware
description: Hardware reference for writing or reviewing Game Boy, Game Boy Color and Game Boy Advance code — memory maps, I/O registers and their bits, VRAM/OAM access timing, sprites, palettes, interrupts, input, ROM headers, and the classic mistakes that work in an emulator but fail on a console. Use whenever writing, debugging or reviewing GB/GBC/GBA game code (C, assembly, devkitARM, GBDK, RGBDS, Butano), so register addresses and rules come from here instead of memory.
---

# GB / GBC / GBA hardware

Look addresses and bit meanings up instead of recalling them:

- Game Boy / Color: [references/gb.md](references/gb.md)
- Game Boy Advance: [references/gba.md](references/gba.md)

The full specs are Pan Docs (gbdev.io/pandocs) and GBATEK (problemkaputt.de/gbatek.htm).

## Rules that break real hardware but often not emulators

**Game Boy / Color**
1. Write VRAM only during VBlank or HBlank, or with the LCD off. During mode 3
   (drawing) writes are dropped. A big copy (tiles, a whole map) is done with the LCD
   off, or split over several VBlanks.
2. Turn the LCD off (LCDC bit 7) only during VBlank (LY ≥ 144).
3. Update sprites with OAM DMA from a routine in HRAM, from a shadow OAM aligned to
   $XX00, during VBlank. Don't write OAM directly while the screen is on.
4. Initialise every variable: RAM holds random values at power-on, while
   emulators start it with zeros or a fixed pattern, so the bug hides.
5. Set up the stack (`ld sp, …`) before the first `call`, and keep it in WRAM/HRAM.
6. `halt` needs the interrupt it waits for enabled in IE; with IME=0 and an
   interrupt pending, the byte after `halt` runs twice (the halt bug).
7. ROM header: logo and header checksum must be right (`rgbfix -v`), the cartridge
   type must have an MBC if the ROM is over 32 KB, and RAM size must match the type.
8. GBC: palettes are set through BCPS/BCPD and OCPS/OCPD (index + data, with
   auto-increment), only outside mode 3. Colours are 15-bit BGR.

**Game Boy Advance**
1. VRAM, palette RAM and OAM take 16- and 32-bit writes only: an 8-bit write to BG
   VRAM or palette RAM writes the byte twice; to OBJ VRAM or OAM it is ignored.
   (`u8` pointers into VRAM are a classic bug.)
2. Hide unused sprites (attr0 bit 9 with bit 8 clear). Zeroed OAM shows 128 8x8
   sprites at 0,0.
3. Update OAM in VBlank from a shadow copy. Wait for VBlank with `VBlankIntrWait`
   (needs an IRQ handler at 0x03007FFC that acknowledges IF and sets 0x03007FF8),
   not a busy loop on VCOUNT, which burns battery.
4. Bitmap modes 3-5 use the lower half of OBJ VRAM: sprites must use tiles 512+.
5. Hardware registers and anything an interrupt changes must be `volatile`.
6. No hardware divide: `/` and `%` call slow library code; use shifts, or the BIOS
   `Div` (swi 0x06) outside hot loops.
7. Put hot code in IWRAM (ARM), the rest in ROM (Thumb); EWRAM is slower (16-bit, wait
   states). The default IWRAM stack is small: no big local arrays.
8. ROM header: logo and complement checksum (`gbafix`), or the console won't boot.

## Checking with the harness

`check` reports header problems, crashes, bad stack pointers, sprite-per-line
overflow, bitmap-mode sprite tiles and lag frames. VRAM writes during drawing can't
be detected: golden-image tests (`assert_golden`) catch the glitches they cause.
