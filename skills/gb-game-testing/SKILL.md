---
name: gb-game-testing
description: Test a Game Boy, Game Boy Color or Game Boy Advance ROM (.gb/.gbc/.gba) with the gb-gbc-gba-test MCP tools — boot it, play it, check the screen and RAM, find addresses, record clips, and turn a session into a regression test. Use when the user asks to test, play, check, debug or verify a GB/GBC/GBA game or ROM.
---

# Testing GB / GBC / GBA games

The `gb-gbc-gba-test` MCP server runs the ROM in a deterministic emulator that is
paused between tool calls: the same inputs always give the same frames and RAM.

## Workflow

1. `load_rom` with the ROM path. If the game must be built first, build it (see the
   `gb-homebrew-dev` skill) and load the output.
2. Drive it with **one `run_sequence` per stretch of play**, not many single calls:
   `[{"wait": 240}, {"tap": "START"}, {"waitUntil": {"screen": "stable", "frames": 20}}, {"shot": "menu"}]`.
   Every tool call resends the conversation, so batching is the biggest saving.
3. Wait for the game, don't guess: `wait_until` (or a `waitUntil` step) on a RAM
   value or on the screen changing / settling, instead of long `wait_frames`.
4. Look only when needed: `screenshot` is 2× by default; prefer one `shot` at the end
   of a sequence over a screenshot after every input.
5. Check what matters:
   - picture: `assert_golden` (first run creates the golden; mask clocks with `ignore`;
     `sprite: N` compares one sprite instead of the whole screen),
   - values: `read_memory`, or `assertRam` steps.
6. Don't know where a value lives? `ram_search` `start` with the value you see, change
   it in game, `filter` (`eq`, `decreased`, `delta`…) until one address is left, then
   confirm with `write_memory`.
7. Turn the session into a test: `export_script` writes every step since `load_rom`;
   add `assert` / `assertRam` steps and replay it with `run_sequence` to prove it passes.

## Useful facts

- Buttons: `A B L R START SELECT UP DOWN LEFT RIGHT`. 60 frames ≈ 1 second.
- Addresses: GBA `0x02000000` EWRAM, `0x03000000` IWRAM; GB `0xC000` WRAM,
  `0xFF80` HRAM, `0xA000` cart RAM. Pass them as hex strings.
- Hung game? `read_cpu` twice a few frames apart: a `pc` that doesn't move means a loop.
- Sprites on screen: `read_sprites` (also flags per-line hardware limits).
- Save states (`save_state` / `load_state`) are the fastest way to retry from a point.
- Battery saves: `battery_save` `import` boots the game from a `.sav`; `export` checks
  what it saved.
- For a person: `record_video` (.gif plays everywhere, .mp4 has sound), or
  `run_sequence` with `video: {path}` to keep a clip only when a check fails.
- `reset` is the console's reset button; the battery save survives.

## Reporting

Say what you ran, what passed and failed (with the frame number), and attach the
relevant screenshot or clip path. Don't paste raw RAM dumps unless asked.
