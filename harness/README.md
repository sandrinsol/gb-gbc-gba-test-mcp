# GB / GBC / GBA test harness and MCP server

Lets an AI agent (or a script) play and test Game Boy, Game Boy Color and Game Boy
Advance ROMs. It runs the bundled EmulatorJS cores — mgba for GBA, gambatte for
GB/GBC — in headless Chromium. No other emulator is needed and nothing is
downloaded at runtime.

- `mcp-server.mjs` — MCP server for agents (Claude Code, Cursor, VS Code, …).
- `driver.mjs` — the same features as a Node library, for scripts and CI.
- A Claude Code plugin bundling the server with skills for testing, homebrew
  development and CI ([`skills/`](../skills/)).

## Setup

Node 20+.

**Claude Code:** install the plugin (server + skills; dependencies install on first
start):

```
/plugin install gb-gbc-gba-test --marketplace sandrinsol/gb-gbc-gba-test-mcp
```

**Other MCP hosts**, or to work on the harness:

```bash
cd harness
npm install        # dependencies + headless Chromium
```

Add the server to your MCP host:

```json
{
  "mcpServers": {
    "gb-gbc-gba-test": {
      "command": "node",
      "args": ["/absolute/path/to/gb-gbc-gba-test-mcp/harness/mcp-server.mjs"],
      "env": { "GBTEST_ROOT": "/path/to/your/project" }
    }
  }
}
```

- VS Code uses the key `"servers"` instead of `"mcpServers"`; see
  [`.vscode/mcp.json.example`](../.vscode/mcp.json.example).
- Once the package is published to npm, `"command": "npx", "args": ["-y",
  "gb-gbc-gba-test-mcp"]` works without a clone.

| Variable | Effect |
|----------|--------|
| `GBTEST_ROOT` | Base for relative paths. Default: the host's workspace root, else the working directory. |
| `GBTEST_TOOLS` | Expose only some tools: `core`, or a comma list such as `core,ram_search`. |
| `GBTEST_CHROMIUM` | Use this Chrome/Chromium binary instead of Playwright's. |
| `GBTEST_FFMPEG` | ffmpeg for `.webm`/`.mp4` video (default: one on PATH, else Playwright's). |
| `GBTEST_ALLOW_ANY_PATH=1` | Allow writing files outside the workspace (refused by default). |
| `UPDATE_GOLDENS=1` | Re-create golden images instead of comparing. |

## Tools

| Tool | Does |
|------|------|
| `load_rom` | Boot a `.gba`, `.gb`, `.gbc`, or a `.zip` containing one. |
| `wait_frames` | Advance N frames (60 = 1 s). |
| `press` | Tap a button or a combo (`buttons: ["A","B"]`). |
| `set_button` | Hold or release buttons. |
| `wait_until` | Run until a RAM condition or a screen change holds; stops on the first such frame. |
| `reset` | Reset button. Keeps the battery save and cheats. |
| `screenshot` | Current frame as an image (2× by default). |
| `read_memory` | Read RAM; addresses as numbers or hex strings (`"0x03000010"`). |
| `read_cpu` | CPU registers. |
| `read_sprites` | On-screen sprites, a screenshot with them outlined, and per-line limit warnings. |
| `view_vram` | Tiles or palettes as an image. |
| `status` | ROM, frame, held buttons, saved states, cheats. |
| `write_memory` | Write RAM on the current frame. |
| `save_state` / `load_state` | Named snapshots, optionally to/from a file. |
| `set_cheats` | GameShark, Action Replay, CodeBreaker (GBA); GameShark, Game Genie (GB). |
| `battery_save` | Export or import the `.sav`. |
| `run_sequence` | Run a list of steps in one call (see [Steps](#steps)). |
| `assert_golden` | Compare the frame (or one sprite, `sprite: N`) to a golden PNG; on failure returns current, golden and diff images. |
| `record_video` | Play N frames into `.gif`, animated `.png`, `.webm`, `.mp4` (with sound) or `.wav`. |
| `export_script` | Everything done since `load_rom` as replayable steps. |
| `ab_compare` | Run the same steps on two ROMs and report differences. |
| `ram_search` | Find where a value (HP, score…) is stored: `start`, then `filter` until one address is left. |
| `sprite` | Sprite art: `convert` a PNG to tiles + palette (source for your toolchain), `inject` it into the running game, `overlay` it on the screen, `export` a sprite from VRAM. |

Prompts: `smoke_test_rom`, `regression_check`, `find_ram_address`,
`record_regression_test`. Resources: `emu://screen`, `emu://status`.

**Token use.** Tool definitions are sent with every request: ~2,700 tokens for all
tools, ~1,400 with `GBTEST_TOOLS=core` (`load_rom wait_frames press set_button
wait_until screenshot read_memory write_memory run_sequence assert_golden status`).
A 2× GBA screenshot is ~205 tokens. Prefer one `run_sequence` over many single calls,
and `wait_until` over wait-and-check loops.

## Steps

`run_sequence`, `ab_compare`, `export_script` and `runner.mjs` share one step format.
Each step has one action key:

| Step | Example |
|------|---------|
| wait | `{"wait": 60}` |
| tap (press + release) | `{"tap": "A"}`, `{"tap": ["A","B"], "hold": 4, "release": 4}` |
| hold / release | `{"press": "RIGHT"}`, `{"release": "RIGHT"}`, `{"hold": "RIGHT", "frames": 30}` |
| wait for a condition | `{"waitUntil": {"address": "0xC000", "op": "eq", "value": 3}, "maxFrames": 600}`, `{"waitUntil": {"screen": "stable", "frames": 30}}` |
| screenshot | `{"shot": "title"}`, `{"record": {"frames": 120, "every": 20, "prefix": "walk"}}` |
| state | `{"saveState": "cp"}`, `{"loadState": "cp"}`, `{"loadStateFile": "boss.state"}` |
| RAM | `{"read": "0x03000010", "as": "u16"}`, `{"write": "0x03000010", "value": 1}`, `{"assertRam": "0x03000010", "as": "u16", "equals": 3}` (or `min`/`max`) |
| golden image | `{"assert": "goldens/title.png", "threshold": 0.02, "ignore": [{"x": 200, "y": 0, "w": 40, "h": 16}]}`, `{"assert": "goldens/hero.png", "sprite": 0}` |
| video | `{"video": {"frames": 120, "path": "clips/walk.gif"}}` |
| other | `{"reset": true}`, `{"cheats": ["..."]}`, `{"importSave": "100pct.sav"}` |

From the command line:

```bash
node runner.mjs tests/anguna.script.json   # screenshots + timeline.json in out/anguna.script/
```

In a script file, `rom` is relative to the working directory and other paths to the
script. A top-level `"video": {"path": "failures/x.gif", "onlyOnFail": true,
"seconds": 10}` records the run and keeps the clip when a check fails (as does
`run_sequence`'s `video` option). The exit code is non-zero if an assert fails.

## Library

```js
import { EmuHarness } from './driver.mjs';

const emu = await EmuHarness.launch('mygame.gba');
await emu.waitFrames(180);
await emu.tap('START');
const hp = await emu.readU16(0x03000010);
await emu.screenshot('out/title.png');
await emu.close();
```

| Method | Description |
|--------|-------------|
| `EmuHarness.launch(rom, {fast=true, reuse=false, timeout=60000})` | Boot a ROM. `reuse` shares one browser between harnesses; call `EmuHarness.shutdown()` at the end. |
| `waitFrames(n)`, `waitUntilFrame(f)`, `frameNum()` | Advance and read the frame clock. |
| `waitFor(cond, {maxFrames, precise})` | Run until `{address, as, op, value}` or `{screen: 'changed'\|'stable', frames}` holds → `{met, frame}`. |
| `setButton(b, down)`, `setButtons(bs, down)`, `tap(b \| bs, hold, release)` | Input. Buttons: `A B L R START SELECT UP DOWN LEFT RIGHT`. |
| `screenshot(path?)` | PNG `Buffer`. |
| `readMemory(addr, len)`, `readU8/U16/U32(addr)`, `readRegions()` | RAM. |
| `writeMemory(addr, buf)`, `writeU8/U16/U32(addr, v)` | Write RAM; returns whether it stuck. |
| `saveState()`, `loadState(buf)` | Full machine snapshots. |
| `readCpu()`, `readSaveData()`, `writeSaveData(buf)`, `setCheats(codes)`, `restart()` | CPU, battery save, cheats, reset. |
| `record(n, {every})`, `startRecording()`, `stopRecording()` | Frame-exact captures `[{frame, png}]` with `.audio` (PCM); save with `saveVideo()` from `recording.mjs`. |
| `sprites()`, `spriteImage(i)` | Decoded sprite table; one sprite's graphics as PNG. |
| `videoDimensions()`, `close()` | |

Golden comparison (`assert.mjs`), RAM search (`ramsearch.mjs`), video encoding
(`recording.mjs`) and sprite conversion (`sprite.mjs`: `convertSprite`,
`writeSpriteSource`, `injectSprite`) can also be used on their own.

## Behaviour

- **Deterministic.** The same steps give bit-identical frames and RAM on every run.
  Advance time only with waits; the machine is paused between calls, so real time
  between them doesn't matter and every read lands on the exact frame.
- **Fast-forward.** Waits longer than 120 frames run at 8× and finish at 1×, with
  identical results. Turn it off with `fast: false`.
- **`wait_until`** stops on the first frame where the condition holds. A condition
  that is true for only a few frames can be skipped while fast-forwarding; use
  `precise: true` to check every frame.
- **Reset** is the console's reset button: work RAM, battery save and cheats survive,
  and the frame count restarts at 1.
- **Writes to RAM** apply on the current frame. A value the game recomputes every
  frame is overwritten on the next one; `write_memory` says when that happens.
- **Save states** don't store the picture. Loading a state file from another session
  gives a stale screenshot (flagged) until you advance one frame.
- **GB GameShark codes** apply when the game services VBlank, as on the real device.
- **Colours** are the ones the game sets: GBC colour correction is off in the harness
  (the play page keeps it).
- **Video** is captured frame by frame (identical to screenshots of those frames), at
  real-time speed. **Audio** stays in step with the frames but is not bit-exact
  across runs (a screenshot, state load, RAM write or fast-forward recovery runs one
  frame of the old timeline into the audio resampler). It goes into `.mp4`/`.webm`
  when a full ffmpeg is installed (Playwright's has no audio encoders).
- **Injected sprites** stay only if the game doesn't rewrite that sprite-table entry
  each frame; the tool says when it did. `overlay` previews without touching the game.
- **Golden images** depend on the software renderer; regenerate them with
  `UPDATE_GOLDENS=1` after a Chromium or Playwright upgrade.
- **Files** are only written inside the workspace or `harness/out/`.
- **No debugger.** Breakpoints and single-stepping would need custom builds of the
  cores.

## How it works

`page.html` loads EmulatorJS in a headless page and exposes a small control bridge.
`driver.mjs` serves the repo over localhost, starts Chromium with software WebGL,
and calls the bridge. RAM, CPU registers, sprites and battery saves are read from
(and written into) emulator save states: `memory.mjs` parses mgba's state,
`gb-memory.mjs` gambatte's.

## Development

```bash
npm test               # full suite
npm run typecheck      # JSDoc types
npm run package-test   # pack, install into an empty project, drive a ROM
```

The npm package is the repo-root `package.json`; keep its `version` and
`dependencies` in sync with this folder's (`package-test` checks). Publish with
`npm publish` from the repo root.
