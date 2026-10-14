# Game Boy Emulator + AI Test Harness (GB / GBC / GBA, fully offline)

A dead-simple browser-based Game Boy Advance emulator. Everything it needs is
bundled in the `data/` folder — **no internet connection required**, ever.

Two ways to use it:

- **Play in a browser** — see below.
- **Let an AI test your GBA/GB/GBC games** — the [`harness/`](harness/) folder is an
  **MCP server** (+ Node library) that drives this same emulator headlessly: load a
  ROM, press buttons, capture screenshots the agent can *see*, read, write and search
  real RAM, wait for game conditions, inspect sprites/tiles/CPU, use cheats and battery
  saves, record a session as a replayable test, and assert against golden frames. No
  third-party emulator. See
  [harness/README.md](harness/README.md).

**Quick start:** add an MCP server with `command: "npx"`, `args: ["-y",
"gb-gbc-gba-test-mcp"]` to your host (once the package is published to npm), or
run it from this repo as below.

**Use it in your editor** — VS Code (Copilot agent mode), Antigravity, Cursor,
Windsurf, Claude Desktop/Code, or any MCP host. Setup for each is in
[harness/README.md → Use as an MCP server](harness/README.md#use-as-an-mcp-server);
a ready-to-edit VS Code config is at [`.vscode/mcp.json.example`](.vscode/mcp.json.example).

**License:** GPL-3.0-or-later (this repo bundles EmulatorJS, which is GPL-3.0). See
`LICENSE` and `NOTICE.md`. Only the freeware `anguna.gba` is included — don't commit
commercial ROMs.

## Run it

Because browsers block the emulator core from loading over `file://`, it runs on
a tiny local web server.

**Easiest:** double-click **`start.command`**. It serves the folder on
`http://localhost:8000` (or the next free port) and opens your browser.

**Or from a terminal:**

```bash
cd gb-gbc-gba-test-mcp
python3 -m http.server 8000
# then open http://localhost:8000 in your browser
```

Then click **Load ROM** and pick a `.gba`, `.gb`, or `.gbc` file.

A free homebrew game, **`anguna.gba`**, is included so you can try it right away.
Delete it if you don't want it — you can load any `.gba` ROM.

## Default controls

| Action | Key |
|--------|-----|
| D-Pad  | Arrow keys |
| A / B  | X / Z |
| L / R  | A / S |
| Start  | Enter |
| Select | Shift |

The control bar at the bottom of the screen has pause, save/load states,
fullscreen, volume, and a settings menu (including gamepad remapping).

## Put it online (Netlify)

The whole folder is a static site — no build step. A `netlify.toml` is included.

**Drag-and-drop (easiest):**
1. Go to <https://app.netlify.com/drop>.
2. Drag the **`gb-gbc-gba-test-mcp`** folder onto the page.
3. Netlify gives you a live URL. Done.

**Netlify CLI:**
```bash
cd gb-gbc-gba-test-mcp
npx netlify-cli deploy --prod
```

**From Git:** push this folder to a repo and connect it in Netlify. Leave the
build command empty and set the publish directory to the folder root (`.`).

Once deployed it works over plain HTTPS with no server config — it's all static
files. (You no longer need `start.command`; that's only for running locally.)

## How it works

The heavy lifting (ARM7TDMI CPU, graphics, audio) is done by the open-source
[EmulatorJS](https://emulatorjs.org) `mgba` core. All of its files live locally:

```
index.html            the page (~60 lines)
netlify.toml          static-hosting config for Netlify
start.command         one-click local server launcher (local use only)
anguna.gba            sample freeware homebrew game
data/
  loader.js           EmulatorJS bootstrap
  emulator.min.js     EmulatorJS engine
  emulator.min.css    styling
  version.json
  cores/
    mgba-wasm.data           GBA core (WebGL2)
    mgba-legacy-wasm.data     GBA core (fallback)
    gambatte-wasm.data        GB/GBC core (WebGL2)
    cores.json, reports/      per-core build reports (tell EmulatorJS to use the bundled WebGL2 builds)
  compression/        7z/zip/rar workers for unpacking the core
```

Your ROM never leaves your machine — everything runs in your browser, and the
page makes **zero external network requests** (verified). It has been patched so
even the EmulatorJS update-check reads the bundled `data/version.json` instead of
the internet.

## Notes

- You must supply your own commercial ROMs; only the freeware `anguna.gba` is
  included.
- Save files and save states are stored in your browser's local storage.
