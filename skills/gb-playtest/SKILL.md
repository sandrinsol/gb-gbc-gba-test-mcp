---
name: gb-playtest
description: Playtest a Game Boy / Color / Advance game like a player with a goal — reach a level, beat a boss, try to break a menu — using save states to explore, and write a bug report with replayable steps and a video for every problem found. Use when the user asks to playtest, try out, explore, QA, or find bugs in a GB/GBC/GBA game, or to check a feature works from a player's point of view.
---

# Playtesting a GB / GBC / GBA game

Play towards a goal, keep checkpoints, and turn every problem into something the
developer can replay.

## Set up

1. `load_rom` (or `build` for a project). If there's a `gbtest.json`, its charmap and
   watch list are already active.
2. Learn the screen cheaply: `describe`. If it says the font is unknown, find a word
   on screen in a `screenshot` and pass it as `describe` `learn`. From then on,
   `describe` reads menus and dialogue as text: use it instead of screenshots.
3. Watch what matters for the goal (`watch`: lives, HP, score, position, level).
   Without symbols, find the addresses with `ram_search` first.

## Play

- Save a state at every checkpoint (`save_state` id per place: "level1-start",
  "boss-door"); retry from there instead of from boot.
- Move in `run_sequence` batches: `hold` to walk, `tap` to act, `waitUntil` on the
  screen settling or a RAM value, then one `describe`.
- Explore the edges, not just the happy path: walls and screen edges, pausing at
  odd moments, pressing two buttons at once, going back to a previous screen, dying
  during a transition, menus opened and closed fast, scores and counters at their
  limits (`write_memory` to set them near overflow).
- Run `check` at a few points: it catches crashes, lag and sprite overflow you
  can't see.
- Stuck for 3 attempts on the same obstacle? Report it as a possible difficulty or
  design issue and move on (a cheat or `write_memory` can skip it).

## For every problem

1. Reproduce it from the nearest save state with the fewest steps.
2. `export_script` the steps (or write them), and add the check that fails:
   `assertRam` for a wrong value, `assert` for a wrong picture.
3. `record_video` a short clip of it (.gif; .mp4 if sound matters).
4. Note the frame number, what you expected and what happened.

## Report

```
## Playtest: <goal> — reached / not reached
Played <N> minutes of game time, <M> checkpoints.

### Bugs
1. <title> — <severity: crash / blocker / wrong behaviour / visual / polish>
   Steps: tests/gb/bug-<n>.json (fails at step <k>)   Clip: <path>
   Expected …  Actual …

### Notes
Difficulty, confusing moments, things that felt good.
```

Severity: crash or freeze > blocks progress > wrong behaviour > visual glitch > polish.
