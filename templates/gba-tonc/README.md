# Game Boy Advance starter (devkitARM + libtonc, C)

A small working game to start from: text on screen and a 16x16 player you move
with the D-pad, plus a test that checks both.

| | |
|---|---|
| Build | `make` → `hello.gba` (+ `hello.elf` with symbols) |
| Needs | [devkitPro](https://devkitpro.org/wiki/Getting_Started) with devkitARM and libtonc (or open the folder in the dev container) |
| Test | `tests/gb/smoke.json`, run by the `gb-tests` GitHub workflow or by an AI agent with the gb-gbc-gba-test MCP server |

- `src/main.c`: tonc's text engine on BG0, an OAM shadow copied in VBlank, `VBlankIntrWait`, input with `key_poll`.
- `assets/player.png`: converted by grit at build time (4bpp, magenta transparent).
- Tonc's tutorial explains every part: <https://gbadev.net/tonc/>.

`gbtest.json` tells the test harness how to build and load the game, how to read
on-screen text (`charmap`: tonc's font starts with the space at tile 0), which
variables to report after each step (`watch`) and which one counts frames
(`frameCounter`, for lag checks).

The goldens in `tests/gb/goldens/` are created on the first run; delete them when
you change what the screen should look like.
