---
name: gba-dev
description: How to write Game Boy Advance game code that is correct and fast on the real console — project setup (devkitARM, libtonc, libgba, Butano, plain arm-none-eabi-gcc), the frame loop with VBlank interrupts, sprites and backgrounds, affine (rotate/scale) and mode 7 effects, fixed-point maths, DMA, IWRAM/ARM code for speed, saves (SRAM/Flash/EEPROM), sound with Maxmod, compressed graphics, and debugging GBA-specific bugs with the gb-gbc-gba-test tools. Use when writing, optimising or debugging a GBA game in C, C++ or assembly.
---

# GBA game development

Register addresses and bit layouts: the `gb-hardware` skill (`references/gba.md`).
Code recipes: [references/recipes.md](references/recipes.md). For Butano projects
also read the `butano` skill.

## Pick the toolchain

| Want | Use | Starter (`new_project`) |
|---|---|---|
| C++, high level (sprites, text, audio, scenes handled) | Butano | `gba-butano` |
| C, the classic tutorial (Tonc) | devkitARM + libtonc | `gba-tonc` |
| C, no libraries, any ARM GCC | arm-none-eabi-gcc + own crt0 | `gba-c` |

## The frame loop

1. Set up the VBlank interrupt once (libtonc: `irq_init(NULL); irq_enable(II_VBLANK);`).
2. Each frame: `VBlankIntrWait()` → copy the shadow OAM (and any queued VRAM/palette
   updates) → read input → update the game → draw into the shadow OAM.
3. Keep VBlank work short (~1.2 ms of the 16.7 ms frame); do game logic after it.
4. Count frames in a global (`frame_counter`) and name it in `gbtest.json`: `check`
   then reports lag (frames where the loop didn't finish in time).

## Rules that matter on hardware

- 16/32-bit writes only to VRAM, palette RAM and OAM (no `u8*` stores there).
- Hide unused sprites (attr0 = 0x0200); OAM starts zeroed = 128 sprites at 0,0.
- Tiles and maps share VRAM: put maps in screen blocks past the tiles (`check` and
  `view_vram` `layers` show overlaps).
- `volatile` on registers and on anything an interrupt changes.
- No FPU and no divide instruction: use fixed point (`int` with 8 fractional bits,
  or `bn::fixed`) and avoid `/` `%` in hot code (shift, multiply by reciprocal,
  or the BIOS `Div`).
- Thumb code in ROM; hot loops as ARM in IWRAM (32 KB, also holds the stack).
- Small stack: no large local arrays; put big buffers in EWRAM (`EWRAM_BSS`).
- Set WAITCNT (`REG_WAITCNT = 0x4317`) early for faster ROM access.
- Saves: declare the type (devkitARM/Butano libraries add the ID string), write
  SRAM 8 bits at a time at 0x0E000000.

## Debug with the harness

| Symptom | Look with | Usual cause |
|---|---|---|
| White screen | `describe` `io: true` | Forced blank still set, or no BG/OBJ enabled in DISPCNT |
| Black screen | `view_vram` `palettes` | Palette never loaded |
| Garbage tiles | `view_vram` `layers`, `check` | Map overlapping tile data; wrong char block; 4bpp/8bpp mismatch |
| Scrambled sprites | `check` | 2D OBJ mapping with tiles loaded for 1D (DISPCNT bit 6) |
| Sprite missing | `read_sprites`, `view_vram` `layers` | Hidden bit, off-screen Y wrap, zero affine matrix, bitmap mode with tiles < 512 |
| Slowdown | `check` with a frame counter | Logic over a frame: divisions, ROM-heavy loops, too much per-frame copying |
| Freezes | `read_cpu`, `describe` `io: true` | Waiting for an interrupt that's disabled (IME/IE/DISPSTAT bit) |
| Saves lost | `check`, `battery_save` | No save-type string; 16-bit writes to SRAM |

Art: `sprite` and `background` convert PNGs (and Tiled maps) with `compress: "lz77"`
for the BIOS decompressor, and write `.bmp` + `.json` for Butano.
