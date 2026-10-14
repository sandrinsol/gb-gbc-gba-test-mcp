---
name: gb-homebrew-dev
description: Build-run-fix loop for Game Boy / Color / Advance homebrew — compile with the project's toolchain (devkitARM/devkitPro, Butano, GBDK-2020, RGBDS), boot the ROM in the emulator, check it works, and fix what's broken; also converting sprite art (PNG) into the game. Use when the user is writing or changing a GB/GBC/GBA game, or wants sprites, tiles or graphics added to one.
---

# Developing GB / GBC / GBA homebrew

## 1. Find the toolchain

Look at the project before building:

| Signs | Toolchain | Build | Output |
|---|---|---|---|
| `Makefile` including `$(DEVKITARM)/gba_rules` or `$(DEVKITPRO)` | devkitARM (libtonc/libgba) | `make` | `<name>.gba` |
| `butano` in the Makefile | Butano (C++) | `make -j` | `<name>.gba` |
| `lcc` in a Makefile or `.bat`, `#include <gb/gb.h>` | GBDK-2020 | `make` or the script | `.gb` / `.gbc` |
| `.asm` files, `rgbasm`/`rgblink`/`rgbfix` | RGBDS | `make` | `.gb` / `.gbc` |

If the tools aren't installed, say which one is needed and where to get it; don't
guess at installs.

## 2. Loop

1. Build. Read compiler errors and fix them first; rebuild until it links.
2. `load_rom` the output, then one `run_sequence` that gets past boot:
   `[{"wait": 120}, {"shot": "boot"}, {"tap": "START"}, {"waitUntil": {"screen": "stable", "frames": 20}}, {"shot": "after-start"}]`.
3. Blank or frozen? `read_cpu` (is `pc` moving?), `read_memory` the IO registers
   (GBA `0x04000000` DISPCNT; GB `0xFF40` LCDC), `view_vram` to see if graphics loaded.
4. Fix, rebuild, and re-run the same sequence; compare with the previous screenshot.
5. When it works, `export_script` the sequence and keep it as a regression test (see the
   `gb-ci-tests` skill).

## 3. Sprites from PNG art

Use the `sprite` tool:

1. `convert` the PNG (a sprite sheet of equal frames: `width`/`height`) for the game's
   target — `gba4` (16 colours), `gba8` (256), `gbc` or `gb` (3 colours + transparent).
   Transparency comes from the PNG's alpha, or `transparent: "#ff00ff"`.
   It reports colour/size/tile-budget problems; fix the art rather than quantizing
   unless the user agrees.
2. Write source for the toolchain with `out`: `.h` / `.c` (devkitARM, GBDK), `.s`
   (GNU as), `.asm` (RGBDS), `.bin` (any). Add it to the build.
3. Preview before wiring it up: `inject` puts a frame into the running game at x,y
   (if the game rewrites its sprite table every frame the tool says so — use `overlay`).
   `animation: "walk.gif"` shows the frames animated.
4. After integrating, `read_sprites` / `assert_golden` with `sprite: N` checks it in game.

## Sharing

`record_video` to `.gif` (or `.mp4` with sound) for the user, a PR or an issue.
