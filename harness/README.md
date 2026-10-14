# Game Boy Test Harness + MCP Server (GB / GBC / GBA)

Test **GBA / GB / GBC** games with an AI agent — **no third-party emulator**. It
drives the bundled EmulatorJS cores (**mgba** for GBA, **gambatte** for GB/GBC —
the same cores `../index.html` runs for humans) in headless Chromium, selecting the
core automatically from the ROM extension, and exposes it two ways:

- **MCP server** (`mcp-server.mjs`) — any MCP host (Claude Code, Claude Desktop,
  Cursor, …) gets tools to load a ROM, press buttons, **see the screen** (inline
  images), read and write real RAM, **search RAM** for a value, run whole input
  scripts in one call, and assert against golden frames. This is the main way an AI
  drives it.
- **Node library** (`driver.mjs`) — the same capabilities as a scriptable class,
  for CI and custom test scripts.

Everything is **deterministic** (verified bit-identical across runs), **fast**
(long waits fast-forward, still bit-identical), **frame-exact** (the emulator is
paused between calls), **fully offline** (any external request is blocked and
reported), and reads/writes **real RAM** out of save states — no core rebuild needed.

## Setup (once)

**From npm** (no clone needed): point your MCP host at `npx -y gb-gbc-gba-test-mcp`
(`command: "npx"`, `args: ["-y", "gb-gbc-gba-test-mcp"]`). The package bundles the
emulator cores; its install downloads headless Chromium.

**From this repo** (to hack on it):

```bash
cd gb-gbc-gba-test-mcp/harness
npm install          # installs deps + Chromium (postinstall)
npm test             # full suite;  npm run typecheck  checks the JSDoc types
```

> Publishing: the npm package is the **repo root** `package.json` (it ships `data/`
> plus `harness/`); `harness/package.json` is the dev workspace. Keep their
> `version` and `dependencies` in sync — `npm run package-test` checks that, packs
> the tarball, installs it into an empty project and drives a ROM through its bin.
> Then `npm publish` from the repo root.

## Use as an MCP server

It runs over **stdio** (`npm run mcp`), so any MCP host launches it with
`command: "node"` and the absolute path to `mcp-server.mjs` (or `npx`, above).
Requires Node 20+; the first `npm install` downloads headless Chromium.

**Relative paths** in tool calls (ROMs, goldens, state files, screenshot saves)
resolve against, in order: the `GBTEST_ROOT` env var, the host's first workspace
root (MCP *roots*), or the server's working directory. Tool results always echo the
resolved absolute path.

| Env var | Effect |
|---------|--------|
| `GBTEST_ROOT` | Base directory for relative paths. |
| `GBTEST_CHROMIUM` | Use this Chromium/Chrome binary instead of Playwright's download. |
| `UPDATE_GOLDENS=1` | Re-create goldens instead of comparing. |
| `GBTEST_ALLOW_ANY_PATH=1` | Allow writing files outside the workspace root (see below). |

**Writes stay in the workspace.** Files the tools create (screenshot saves, state
files, goldens and diffs, `run_sequence` output, exported scripts and saves) must
resolve inside the workspace root or `harness/out/`; anything else is refused, so a
confused or prompt-injected agent can't overwrite arbitrary files. ROMs and other
inputs can be read from anywhere.

> **Config key differs by host:** VS Code uses `"servers"`; Claude Desktop, Cursor,
> Windsurf, and Antigravity use `"mcpServers"`. The inner server entry is identical.

### VS Code (Copilot agent mode, 1.102+)

Copy [`.vscode/mcp.json.example`](../.vscode/mcp.json.example) to `.vscode/mcp.json`
in your workspace and set the path:

```json
{
  "servers": {
    "gb-gbc-gba-test": {
      "command": "node",
      "args": ["/absolute/path/to/gb-gbc-gba-test-mcp/harness/mcp-server.mjs"]
    }
  }
}
```

Or: Command Palette → **MCP: Add Server → Command (stdio)**, enter `node` and the
path. Then open **Copilot Chat → Agent mode**; the tools and prompts appear.

### Antigravity IDE

Open the MCP settings (Settings → **MCP servers** / “Manage MCP servers”) and add a
stdio server with the same entry, under the `mcpServers` key:

```json
{
  "mcpServers": {
    "gb-gbc-gba-test": {
      "command": "node",
      "args": ["/absolute/path/to/gb-gbc-gba-test-mcp/harness/mcp-server.mjs"]
    }
  }
}
```

Then use it from Antigravity's agent/chat. (The exact menu label can vary by
version — look for “MCP”; the server entry above is what matters.)

### Claude Desktop / Cursor / Windsurf / Claude Code

Same `mcpServers` entry as the Antigravity block above, added to that host's MCP
config (e.g. Claude Desktop's `claude_desktop_config.json`, or `claude mcp add` for
Claude Code).

### Tools & prompts

| Tool | What it does |
|------|--------------|
| `load_rom` | Boot a `.gba/.gb/.gbc` (system auto-detected). Reuses the browser, so switching ROMs takes ~2 s. `fast` (default on) fast-forwards long waits. |
| `wait_frames` | Advance N frames (60 ≈ 1 s). |
| `press` | Tap one `button` or a combo `buttons: ["A","B"]` (hold / release frames). |
| `set_button` | Hold/release button(s) without advancing time. |
| `screenshot` | Current frame inline, **upscaled 3× by default** (`scale` 1–4) so it's legible; `save` writes the native PNG. |
| `read_memory` | Read RAM. `address` may be a number or a hex string (`"0x03000010"`, `"$C000"`); typed `as` returns every value in the range. |
| `write_memory` | Poke RAM on the current frame (`value`+`as` or `hex`); reports whether it stuck. |
| `save_state` / `load_state` | Named snapshots; optional `path` saves/loads a file that survives restarts. |
| `assert_golden` | Compare to a golden PNG (created on first run). On failure returns **current, golden and diff images inline**. |
| `run_sequence` | Run a whole script of steps in **one call** (waits, taps, holds, shots, recordings as a contact sheet, RAM reads/writes/asserts, golden asserts) and get the timeline + images back. |
| `wait_until` | Run until a **RAM condition** (`address` + `op` + `value`, or `changed`) or a **screen condition** (`changed`, or `stable` for N frames) holds, stopping on the first frame it does. Replaces wait-read-check loops. |
| `ram_search_start` / `ram_search_filter` / `ram_search_results` | Cheat-search: find where the game keeps a value (eq / changed / increased / decreased / delta …) in a few calls. |
| `read_cpu` | CPU registers (GBA ARM7 / GB SM83) — tell "hung in a loop" from "running". |
| `read_sprites` | Decoded sprite table (position, size, tile, palette, flips) + a screenshot with sprite boxes — find the player/enemies without a RAM search. |
| `view_vram` | Tile graphics or all palettes as an image. |
| `set_cheats` | GameShark / Action Replay / CodeBreaker (GBA), GameShark / Game Genie (GB). |
| `export_save` / `import_save` | Battery saves (`.sav`): check what the game saved, or boot from a save. |
| `export_script` | Everything done since `load_rom` as a replayable step script — exploratory play becomes a regression test. |
| `ab_compare` | Run the same steps on two ROM builds side by side and diff the shots and RAM reads. |
| `frame_number`, `reset`, `status` | Housekeeping. `reset` is the console's reset button: deterministic, keeps the battery save. |

Tools carry MCP annotations (`readOnlyHint` etc.) and structured output schemas.
Calls are serialized, so a host issuing tools in parallel can't interleave them.
**Resources:** `emu://screen` (current frame PNG) and `emu://status` (JSON).

**Console support:** GBA (mgba) and GB/GBC (gambatte) — everything works for all
three: input, screenshots, save states, determinism, golden asserts, RAM
read/write and RAM search. Addresses are interpreted for whichever console is loaded.

**Prompts (guided workflows).** Pick one in your host and it walks the agent through
a multi-step job using the tools:
- `smoke_test_rom` — boot a ROM and judge whether it actually runs (renders vs.
  black/crash/hang) and responds to input.
- `regression_check` — play a scripted sequence (one `run_sequence`) and
  `assert_golden` at checkpoints.
- `find_ram_address` — discover the address of an in-game value (HP, score…) with
  the RAM search tools, then verify it with a write.
- `record_regression_test` — play to a goal, add checks, `export_script`, and prove
  the script replays.

**Cheats on GB/GBC:** GameShark codes (`01VVLLHH` writes `VV` to `0xHHLL`) are
applied when the VBlank interrupt is serviced, like the real device, so they work in
games that use VBlank interrupts (nearly all do).

**Not included: a CPU debugger** (breakpoints, watchpoints, single-step). The bundled
cores don't expose one; it would need custom builds of mgba/gambatte. `read_cpu`,
`wait_until` on RAM conditions and frame-exact pausing cover the common cases.

### Example: finding HP with RAM search

(Addresses and counts are illustrative.)

```
ram_search_start  { "type": "u8", "value": 10 }        -> 812 candidates
(take a hit in game)
ram_search_filter { "op": "eq", "value": 9 }            -> 3 candidates
(take another hit)
ram_search_filter { "op": "delta", "value": -1 }        -> 1 candidate: 0x03001a4c = 8
write_memory      { "address": "0x03001a4c", "value": 99 }   # verify on screen
```

## Quick check

```bash
node driver.mjs shot ../anguna.gba 300 out/title.png   # boot, run 300 frames, screenshot
node tests/smoke.mjs                                    # boot + render + state round-trip
npm test                                                # full suite (incl. the MCP layer)
```

## Writing a test

```js
import { EmuHarness } from './driver.mjs';

const emu = await EmuHarness.launch('../mygame.gba'); // waits until the game has started
await emu.waitFrames(180);        // let it boot
await emu.tap('START');           // press+release START
await emu.setButton('RIGHT', true);
await emu.waitFrames(60);         // hold RIGHT for 60 frames
await emu.setButton('RIGHT', false);
await emu.screenshot('out/after-move.png');

const save = await emu.saveState();   // Buffer — snapshot the whole machine
// ... do stuff ...
await emu.loadState(save);            // restore exactly

await emu.close();
```

`launch(rom)` accepts any path; the ROM is served to the browser in place (nothing is
copied).

The machine is **paused between calls** and only runs inside `waitFrames` /
`waitUntilFrame` / `tap`, so a screenshot, RAM read or write always lands on exactly
the frame `frameNum()` reports, no matter how long your script takes in between.

## API

| Method | Description |
|--------|-------------|
| `EmuHarness.launch(rom, {headless=true, timeout=60000, fast=true, reuse=false})` | Boot a ROM, resolve once the game has started. `fast`: fast-forward long waits (bit-identical). `reuse`: share one browser + server between harnesses (`close()` then only closes the page). |
| `EmuHarness.shutdown()` | Close the shared browser used by `reuse: true` harnesses. |
| `waitFrames(n)` | Advance **n emulated frames** on a boot-anchored absolute clock (see Determinism). |
| `waitUntilFrame(abs)` | Advance to an absolute emulated frame number. |
| `frameNum()` | Current emulated frame number (absolute, from boot). |
| `setButton(name, pressed)` | Hold/release a button. Names: `A B L R START SELECT UP DOWN LEFT RIGHT`. |
| `setButtons(names, pressed)` / `heldButtons()` | Several buttons at once / which are held. |
| `tap(name \| names[], hold=4, release=4)` | Press (one button or a combo), hold `hold` frames, release, settle `release` frames. |
| `screenshot(outPath?)` | PNG of the current frame → `Buffer` (and written to `outPath` if given). `lastScreenshotStale` is `true` if the picture is unknown (see below). |
| `saveState()` / `loadState(buf)` | Capture / restore a full save state (`Buffer`). |
| `readMemory(addr, len)` | Read `len` bytes at a bus address (GBA or GB/GBC) → `Buffer`. |
| `readU8/readU16/readU32(addr)` | Read a little-endian integer at a bus address. |
| `readRegions()` | Typed RAM views (GBA: `ewram/iwram/vram/pram/oam/io`; GB: `wram/vram/sram/hram/io`). |
| `writeMemory(addr, buf)` | Poke RAM on the current frame via save state; returns whether it stuck (see below). |
| `writeU8/writeU16/writeU32(addr, v)` | Write a little-endian integer at a bus address. |
| `hasMemoryAccess()` | `true` only if the core exports *live* RAM (not required for reads). |
| `videoDimensions()` | `{ w, h }` — `240x160` (GBA) or `160x144` (GB/GBC). |
| `stats()` | Fast-forward counters `{ ffWaits, recoveries, restoreRetries }`. |
| `waitFor(cond, {maxFrames=600, precise=false})` | Run until `{address, as, op, value}` or `{screen: 'changed' \| 'stable', frames}` holds; stops on the first matching frame → `{ met, frame }`. |
| `readCpu()` | CPU registers on the current frame. |
| `readSaveData()` / `writeSaveData(buf, {reset=true})` | Battery save (`.sav`) out / in (in = then reset, so the game boots with it). |
| `setCheats(codes)` | Replace the active cheat codes. |
| `restart()` | Reset button: battery save and cheats kept, clock back to frame 1, deterministic. |
| `close()` | Shut down the browser and static server. |

## Screenshot timelines (AI-friendly)

Author a test as plain JSON steps and dump a screenshot timeline the AI reads back:

```bash
node runner.mjs tests/anguna.script.json          # -> out/anguna.script/*.png + timeline.json
```

Step types: `wait` (frames), `tap`/`press`/`release`/`hold` (a button or an array of
buttons), `shot` (named screenshot), `record` (`{frames, every, prefix}` — periodic
screenshots), `saveState`/`loadState` (named, in-memory), `loadStateFile`,
`read` / `write` / `assertRam` (RAM by address, e.g. `{"assertRam": "0x03000010",
"as": "u16", "equals": 3}` or `min`/`max`), `waitUntil` (`{"waitUntil": {"screen":
"stable", "frames": 30}}` or a RAM condition), `reset`, `cheats`, `importSave`, and
`assert` (golden compare, with optional `ignore` rectangles). The same steps drive
the MCP `run_sequence` tool and `ab_compare`, and are what `export_script` writes
(`steps.mjs`). Example:

```json
{ "rom": "../mygame.gba", "steps": [
  { "wait": 240 },
  { "shot": "title" },
  { "tap": "START" },
  { "hold": "RIGHT", "frames": 90 },
  { "record": { "frames": 300, "every": 30, "prefix": "walk" } },
  { "assert": "goldens/title.png", "threshold": 0.02 }
]}
```

`timeline.json` lists every step with its emulated frame number and screenshot file, so
an AI can walk the run and inspect each PNG.

## Golden-frame diffing

`assert.mjs` (zero-dependency PNG decode/encode) compares a screenshot to a stored
golden and writes a red-highlighted `*.diff.png` on mismatch.

```js
import { compare, assertGolden } from './assert.mjs';
const res = await assertGolden(await emu.screenshot(), 'goldens/title.png', { threshold: 0.02 });
// res.pass, res.fraction, res.diffPath
```

- First run (or `UPDATE_GOLDENS=1 node runner.mjs ...`) **creates/refreshes** goldens.
- `threshold` is the max fraction of differing pixels (default 2%); `tolerance` is the
  per-channel value delta that counts as "different" (default 16, absorbs codec noise).
- `ignore: [{x, y, w, h}]` masks rectangles that legitimately change (clocks, timers);
  they show dark blue in the diff image.
- In `runner.mjs` scripts, `rom` is relative to the working directory and `assert`
  paths to the **script file's** directory.

## How it works

`page.html` configures EmulatorJS headlessly and installs a `window.Emu` bridge
over `EJS_emulator.gameManager` (the core's control object). `driver.mjs` serves
the repo root folder over a throwaway localhost server, launches headless
Chromium with SwiftShader (software WebGL2, so no GPU needed), navigates to the
page, and marshals every call through `page.evaluate`.

## Determinism (verified)

The emulator is deterministic: an identical script produces **bit-identical
frames** across separate runs. `tests/determinism.mjs` enforces this (0.000%
diff at matched checkpoints) and that input actually changes the frame.

The one requirement is to step time on the **absolute clock**: `waitFrames(n)`
accumulates targets anchored at boot (frame 0), so boot jitter can't shift which
emulated frame you land on. Always advance with `waitFrames`/`waitUntilFrame`;
wall-clock time between calls doesn't matter because the machine is paused.

**Fast-forward.** The core can't be single-stepped, so a wait longer than 120 frames
runs at 8× and drops to 1× 60 frames before the target, landing exactly on it. If a
stall ever made fast-forward jump past the target, the wait is rewound from an
in-page snapshot and redone at 1×. `tests/fastforward.mjs` checks that frames, RAM
and frame numbers are identical to a pure 1× run (about 3× faster on the suite's
scripts). Disable with `launch(rom, { fast: false })` / `load_rom { fast: false }`.

**Screens and save states.** A save state doesn't contain the rendered picture.
The harness remembers the picture of every state it hands out, so loading one
restores its screen exactly. Loading a state file made in another session has no
known picture: the screenshot is then flagged stale (`lastScreenshotStale`, or a
note in the MCP result) until you advance one frame. Goldens are also tied to this
software (SwiftShader) renderer; regenerate them with `UPDATE_GOLDENS=1` after a
Chromium/Playwright upgrade.

**Resets.** `restart()` / `reset` presses the console's reset button: the core
applies it before running its next frame, so the harness stops exactly one frame
later and puts the clock at frame 1 (and the wait clock at 0, as after boot). Work
RAM, battery save and cheats survive, like on hardware. `tests/features.mjs` checks
that a reset game replays bit-identically to a freshly booted one.

**Waiting on conditions.** `waitFor` / `wait_until` reads the watched bytes (or a
hash of video memory) out of the machine state every frame it sees. In fast mode it
fast-forwards; when the condition first shows up it rewinds to the last frame where
it didn't hold and replays at 1×, so it still stops on the first matching frame
(`tests/features.mjs` checks it against a precise frame-by-frame scan). A condition
that becomes true and false again within one fast-forward step (a few frames) can
be missed — `precise: true` checks every frame. `stable` always runs at 1×.

## Reading RAM (GBA and GB/GBC)

Assert on actual game variables (HP, score, position, flags, RNG…) by address:

```js
// GBA
const hp  = await emu.readU16(0x03000010);        // IWRAM
const buf = await emu.readMemory(0x02000000, 64); // 64 bytes of EWRAM
const r   = await emu.readRegions();              // { ewram, iwram, vram, pram, oam, io }

// GB/GBC (addresses interpreted for the loaded console)
const w   = await emu.readU8(0xC000);             // WRAM
const io  = await emu.readU8(0xFF40);             // LCDC
const rg  = await emu.readRegions();              // { wram, vram, sram, hram, io }
```

Or via the MCP `read_memory` tool (`address`, `length`, `as: hex|u8|u16|u32|s8|s16|s32`).

**Don't know the address?** `ramsearch.mjs` (MCP: `ram_search_*`) does a classic value
search over GBA EWRAM+IWRAM or GB WRAM (every CGB bank)+HRAM+cart RAM:

```js
import { RamSearch } from './ramsearch.mjs';
const s = new RamSearch(emu.system, await emu.readRegions(), { type: 'u8' });
s.filter(await emu.readRegions(), 'eq', 10);   // HP is 10 now
// ...take a hit...
s.filter(await emu.readRegions(), 'delta', -1);
s.results(); // [{ address: 0x03001a4c, region: 'iwram', value: 9, previous: 10 }]
```

**How it works (no core rebuild).** RAM is read out of the save state.
- **GBA** — the mgba save state's `MEM ` chunk is a raw `GBASerializedState` (v7); the
  struct size is found *structurally* from the trailing extdata directory (verified
  `0x61000`), giving `iwram`/`wram`(EWRAM)/`vram`/`pram`/`oam`/`io`. Honors mirroring.
- **GB/GBC** — the gambatte save state is a labeled stream; we walk it and pull the
  `wram`/`vram`/`sram`/`hram` fields by label. Handles WRAM echo and CGB WRAM banking
  (SVBK). The 0xFE00–0xFFFF block covers OAM, IO, and HRAM.

Both compute offsets per state, so nothing is hardcoded per ROM or save type.

## Writing RAM

Set up a scenario without playing to it — e.g. start a test at low HP:

```js
await emu.writeU8(0x03000010, 1);                 // GBA IWRAM
await emu.writeMemory(0xC000, Buffer.from([1,2])); // GB WRAM
```

Or the MCP `write_memory` tool (`address` + `value`/`as`, or raw `hex`).

**How it works & its limits.** It patches the RAM inside a save state of the paused
machine and reloads it on the same frame, then confirms the value took by reading
back (the MCP tool warns if it didn't). The next frame runs game code as usual, so a
value the game recomputes every frame is overwritten again on the next frame; values
the game only changes through gameplay (HP, inventory, position) stick.
Frame-accurate live poke would need a core built with the libretro memory exports;
`readSystemRam()`/`hasMemoryAccess()` auto-detect such a core if you ever drop one in,
but it isn't required for reads or set-up writes.
