# Game Boy starter (RGBDS assembly)

A small working game to start from: text on screen and a 16x16 player you move
with the D-pad, plus a test that checks both.

| | |
|---|---|
| Build | `make` → `build/hello.gb` (+ symbols) |
| Needs | [RGBDS](https://rgbds.gbdev.io) 0.9+ (or open the folder in the dev container) |
| Test | `tests/gb/smoke.json`, run by the `gb-tests` GitHub workflow or by an AI agent with the gb-gbc-gba-test MCP server |

- `src/main.asm`: start-up, VBlank interrupt with OAM DMA, joypad, player movement.
- `assets/`: `font.png` (ASCII 32-127; tile number = character code) and `player.png`, converted by `rgbgfx` at build time.

`gbtest.json` tells the test harness how to build and load the game, how to read
on-screen text (`charmap`), which variables to report after each step (`watch`),
and which variable counts frames (`frameCounter`, for lag checks).

The goldens in `tests/gb/goldens/` are created on the first run; delete them when
you change what the screen should look like.
