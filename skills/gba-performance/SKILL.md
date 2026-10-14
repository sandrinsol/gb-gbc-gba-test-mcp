---
name: gba-performance
description: Make a Game Boy Advance game run at full speed — measure CPU load per frame, find what is slow, and fix it (ARM code in IWRAM, Thumb in ROM, wait states, DMA and CpuFastSet, avoiding division and floats, fixed point, sprite and per-line budgets, VBlank work). Use when a GBA game slows down, lags, drops frames, or the user asks to optimise it.
---

# GBA performance

A frame is 280,896 CPU cycles (16.78 MHz / 59.73 Hz): 197,120 while the screen is
drawn (lines 0-159) and 83,776 in VBlank (lines 160-227).

## 1. Measure first

- Keep a `cpu_usage` global (% of a frame) and name it in `gbtest.json`
  (`"cpuUsage": "cpu_usage"`):
  - C: right before waiting for VBlank, `cpu_usage = (((REG_VCOUNT + 228 - 160) % 228) * 449) >> 10;`
    (lines since VBlank began × 100 / 228, no division).
  - Butano: `cpu_usage = (bn::core::last_cpu_usage() * 100).right_shift_integer();`
- `check` (with `frames` covering the slow part) reports min/average/max CPU and lag.
  `watch` on `cpu_usage` (via `describe`) shows it after every step, so you can see
  which action costs what.
- Narrow it down: time sections by reading `REG_VCOUNT` before and after into
  globals (`t_ai`, `t_collision`), then `read_memory` them. One scanline ≈ 1,232 cycles.

## 2. Usual fixes, biggest first

| Cost | Fix |
|---|---|
| Division / modulo by a variable (library call, hundreds of cycles) | Reciprocal table (`data` `table: "reciprocal"`), shifts, or BIOS `Div` outside loops |
| `float` / `double` (software emulated, very slow) | Fixed point (`int` with 8-12 fraction bits, `bn::fixed`) |
| Hot loop running from ROM in Thumb | ARM in IWRAM: `__attribute__((section(".iwram"), target("arm"), long_call))`, or a `*.iwram.c` file in devkitARM |
| ROM wait states left at the default | `REG_WAITCNT = 0x4317` at start-up (3/1 wait states + prefetch) |
| Copying with byte/halfword loops | `memcpy32` / `CpuFastSet` (32-bit, 8 words at a time) or DMA3 |
| Per-object work every frame | Do it every 2nd/4th frame or only when something changed; early-out on off-screen objects |
| O(n²) collision | Grid / tile lookups; sort by x and only compare neighbours |
| Recomputing sin/cos/sqrt | Lookup tables (`data` `table: "sin"`) |
| Big structs passed by value, many small function calls | Pass pointers; `static inline` small helpers |
| Big VRAM/OAM updates during drawing | Shadow copies, copied once in VBlank |

## 3. Hardware budgets (not CPU, same symptoms)

- Sprites per line: about 1,210 cycles of sprite drawing per line (954 with the
  HBlank-free bit): a 64-pixel-wide sprite costs 64, an affine one 2×width+10.
  Too many → sprites vanish on that line. `check` and `read_sprites` report it.
- VBlank is ~4.99 ms: OAM copies, palette changes and queued VRAM writes must fit.
- DMA stops the CPU while it runs; HBlank DMA runs on every line (keep it short).

## 4. Verify

Re-run `check` over the same steps (`run_sequence` from a save state) and compare
the CPU figures; keep the slow scenario as a test with an `assertRam` on
`cpu_usage` (`"max": 90`) so it can't regress.
