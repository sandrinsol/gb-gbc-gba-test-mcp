# Game Boy Advance starter (Butano, C++)

A small working game to start from: text and a 16x16 player you move with the
D-pad, plus a test that checks both.

| | |
|---|---|
| Build | `make -j4` → `hello.gba` (+ `hello.elf` with symbols) |
| Needs | devkitARM and [Butano](https://github.com/GValiente/butano); set `BUTANO` to the Butano folder (default `/opt/butano`), or open the folder in the dev container |
| Test | `tests/gb/smoke.json`, run by the `gb-tests` GitHub workflow or by an AI agent with the gb-gbc-gba-test MCP server |

- `src/main.cpp`: `bn::core`, a sprite text generator, a sprite moved with `bn::keypad`.
- `graphics/player.bmp` + `.json`: made from `assets/player.png` with the MCP
  `sprite` tool (`convert`, `out: "graphics/player.bmp"`). Backgrounds: the
  `background` tool with `out: "graphics/<name>.bmp"`.
- Butano coordinates are centred: (0, 0) is the middle of the screen.
- Butano's docs: <https://gvaliente.github.io/butano/>.

Text is drawn with sprites, so `describe` lists it as sprites rather than reading
it; use a screenshot to read it. `gbtest.json` sets the build, the variables to
report after each step (`watch`), the frame counter (for lag checks) and the CPU load
variable (`cpuUsage`).

The goldens in `tests/gb/goldens/` are created on the first run; delete them when
you change what the screen should look like.
