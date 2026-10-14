# Game Boy emulator + AI test harness

Play Game Boy, Game Boy Color and Game Boy Advance ROMs in the browser, or let an AI
agent test them through an MCP server. Everything runs offline from the bundled
`data/` folder (EmulatorJS with the mgba and gambatte cores).

- **Play:** see below.
- **Test with an AI agent:** see [harness/README.md](harness/README.md). In Claude
  Code: `/plugin install gb-gbc-gba-test --marketplace sandrinsol/gb-gbc-gba-test-mcp`.

## Play

Browsers won't load the emulator from `file://`, so serve the folder:

```bash
python3 -m http.server 8000    # or double-click start.command on macOS
```

Open <http://localhost:8000>, click **Load ROM** and pick a `.gba`, `.gb` or `.gbc`
file. The included `anguna.gba` is a free homebrew game to try.

| Action | Key |
|--------|-----|
| D-pad | Arrow keys |
| A / B | X / Z |
| L / R | A / S |
| Start / Select | Enter / Shift |

The bar at the bottom has pause, save states, fullscreen, volume and settings
(including gamepads). Saves are kept in the browser's local storage.

To host it, deploy the folder as a static site (no build step); `netlify.toml` is
included for Netlify.

## License

GPL-3.0-or-later, as it bundles EmulatorJS (GPL-3.0). See `LICENSE` and `NOTICE.md`.
Only the freeware `anguna.gba` is included; don't commit commercial ROMs.
