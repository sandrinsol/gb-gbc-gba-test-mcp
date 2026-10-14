---
name: gb-homebrew-dev
description: Build-run-fix loop for Game Boy / Color / Advance homebrew — start from a working template, compile with the project's toolchain (RGBDS, GBDK-2020, devkitARM/arm-none-eabi-gcc, Butano), read errors, run and check the game, and add art (sprites, backgrounds, fonts, Tiled maps). Use when the user is writing or changing a GB/GBC/GBA game, starting a new one, or wants graphics added to one.
---

# Developing GB / GBC / GBA homebrew

Read the `gb-hardware` skill before writing hardware code: register addresses and
VRAM/OAM rules come from there, not from memory.

## Start

- New game: `new_project` with `gb-asm` (RGBDS), `gb-c` (GBDK-2020), `gba-c`
  (arm-none-eabi-gcc), `gba-tonc` (devkitARM + libtonc) or `gba-butano` (Butano,
  C++). It builds, runs and has a passing test from the start, plus `gbtest.json`,
  a CI workflow and a dev container with the toolchain. GBA projects: also read
  the `gba-dev` skill (and `butano` for Butano).
- Existing game: find the toolchain, and add a `gbtest.json` (below).

| Signs | Toolchain | Build | Symbols |
|---|---|---|---|
| `.asm`, `rgbasm`/`rgblink` | RGBDS | `make` | `rgblink -n game.sym` |
| `#include <gb/gb.h>`, `lcc` | GBDK-2020 | `make` | `lcc -Wl-j` → `.noi` |
| `$(DEVKITARM)`, `gba_rules`, libtonc | devkitARM | `make` | the `.elf` |
| `butano` in the Makefile | Butano | `make -j` | the `.elf` |

Missing tools: the template's `.devcontainer/` has all of them; otherwise say which
is needed rather than guessing at installs.

`gbtest.json` in the project root:

```json
{ "build": "make", "rom": "build/game.gb", "charmap": "ascii",
  "watch": ["player_x", "player_y", "lives"], "frameCounter": "frame_count" }
```

## Loop

1. `build`: compiler errors come back as `file:line: error: …`; fix them and build
   again. On success it loads the ROM with its symbols and reports header problems.
   `replay: true` replays what you did since the last load, so you land where you were.
2. Look with `describe` (text, sprites, watched variables: cheap) and use `screenshot`
   when the picture itself matters.
3. Use names everywhere: `read_memory {"address": "player_x"}`, `assertRam:
   "lives"`, `wait_until` on a variable. `read_cpu` names the function the CPU is in.
4. `check` after each feature: crashes, stack, sprite limits, lag frames.
5. Keep what you verified as a test in `tests/gb/*.json` (see `gb-ci-tests`), and for
   bigger changes hand the result to the `gb-tester` agent to try to break it.

Blank or frozen screen: `check` first; then `describe` with `io: true` (display and
interrupt registers in words), `read_cpu` (where is it?), and on GBA `view_vram`
`layers` (each background and the sprites on their own).

## Art

- Sprites: `sprite` `convert` (sheet of `width`×`height` frames) to `out` source
  (.c/.h/.s/.asm/.bin, or `.bmp` + `.json` for Butano), preview with
  `inject`/`overlay`, `animation: "x.gif"`. GBA: `compress: "lz77"` for the BIOS
  decompressor.
- Backgrounds and maps: `background` with `png`, or `tiled` (a Tiled .tmx/.tmj map).
  Duplicate and mirrored tiles are merged, palettes packed; the preview image is
  rebuilt from the output, so if it looks right the data is right.
- Fonts: `background` with `dedupe: false` keeps tiles in order; put the first
  character at tile 32 and `charmap: "ascii"` reads the game's text.
- Colour limits are the hardware's: GB 4 shades, GBC 4 colours per tile and 8
  palettes, GBA 4bpp 15 colours per tile and 16 palettes. Fix the art rather than
  quantizing unless the user agrees.

## Sharing

`record_video` to `.gif` (or `.mp4` with sound) for the user, a PR or an issue.
