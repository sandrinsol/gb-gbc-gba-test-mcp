---
name: gb-ci-tests
description: Set up automated regression tests for a Game Boy / Color / Advance game that run in CI (GitHub Actions) using step scripts and golden images from the gb-gbc-gba-test harness. Use when the user wants their GB/GBC/GBA game tested on every push or pull request, or asks to add CI for a ROM.
---

# CI regression tests for a GB / GBC / GBA game

Tests are step scripts (JSON) replayed by `runner.mjs`. Replays are deterministic, so
golden images and RAM checks are stable across runs and machines.

## 1. Write the scripts

In the user's repo create `tests/gb/<name>.json`:

```json
{ "rom": "build/game.gba",
  "video": { "path": "failures/<name>.gif", "onlyOnFail": true, "seconds": 10 },
  "steps": [
    { "wait": 240 },
    { "tap": "START" },
    { "waitUntil": { "screen": "stable", "frames": 20 } },
    { "assert": "goldens/<name>-title.png" },
    { "assertRam": "0x03001a4c", "as": "u8", "equals": 3 }
  ] }
```

The fastest way to get one is to play the scenario with the MCP tools and
`export_script`, then add `assert` / `assertRam` steps. `rom` is relative to the
working directory; every other path (goldens, the failure clip) to the script.

## 2. Create the goldens

Run each script once locally — missing goldens are created — and look at every
created PNG before committing it. Commit `tests/gb/goldens/`.

## 3. Add the workflow

Copy [workflow.yml](workflow.yml) to `.github/workflows/gb-tests.yml` and adjust:
the build step for the user's toolchain (or a step that downloads the ROM artifact),
and the ROM path. It fetches the harness, runs every script, and uploads screenshots,
diffs and failure clips as an artifact.

## Notes

- Goldens depend on the software renderer; after a Playwright upgrade regenerate them
  with `UPDATE_GOLDENS=1` and review the diff.
- Keep scripts short and focused (one feature each); long scripts fail late.
- Don't commit commercial ROMs; build the ROM in CI or fetch it from a private artifact.
