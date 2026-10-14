# Game Boy Advance starter (C)

A small working game to start from: text on screen and a 16x16 player you move
with the D-pad, plus a test that checks both.

| | |
|---|---|
| Build | `make` → `build/hello.gba` (+ symbols) |
| Needs | any `arm-none-eabi-gcc` (devkitARM, or the `gcc-arm-none-eabi` package) and Node.js (or open the folder in the dev container) |
| Test | `tests/gb/smoke.json`, run by the `gb-tests` GitHub workflow or by an AI agent with the gb-gbc-gba-test MCP server |

- `src/main.c`: mode 0 text background, a sprite, VBlank interrupt + `VBlankIntrWait`, input.
- `src/crt0.s`, `gba.ld`: start-up code and memory layout; no other libraries needed.
- `src/gfx/`: the font and player converted from `assets/` (regenerate with the MCP `sprite` tool: `convert` with `width: 8, height: 8, transparent: "#ffffff", out: "src/gfx/font.c"`).
- `tools/gbafix.mjs`: writes the header real hardware checks.

`gbtest.json` tells the test harness how to build and load the game, how to read
on-screen text (`charmap`), which variables to report after each step (`watch`),
and which variable counts frames (`frameCounter`, for lag checks).

The goldens in `tests/gb/goldens/` are created on the first run; delete them when
you change what the screen should look like.
