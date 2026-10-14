---
name: gba-real-hardware
description: What changes when a Game Boy Advance game moves from emulators to a real console or flash cart — uninitialised RAM, open-bus reads, BIOS and header checks, save types, timing, audio, and how to test on hardware (flash carts, mGBA's debugger, no$gba). Use when a GBA game works in an emulator but not on hardware, before a release, or when the user asks about testing on a real GBA.
---

# Real GBA hardware

The bundled emulator (mGBA core) is accurate, but it starts in a clean state and
forgives things a console doesn't. Before calling a game done:

## Checklist

1. **Header**: logo and complement checksum (`gbafix`; `check` / `build` report it).
   A bad header = the console won't boot it.
2. **Save type**: one ID string (`SRAM_V`, `FLASH1M_V`, `EEPROM_V`…) matching how the
   game saves; flash carts and emulators choose the save chip from it. `check`
   shows the declared type and warns when save data appears without one.
3. **Initialise everything**: RAM, VRAM, OAM and palettes hold garbage at power-on
   (emulators often zero them). Clear OAM (hide all sprites), set every palette you
   use, zero your globals' memory if you don't rely on the C runtime.
4. **No reads from unmapped memory**: on hardware they return "open bus" values (the
   last thing the bus saw), not 0. A null or stray pointer read can behave
   differently on every run.
5. **8-bit access rules**: VRAM/OAM/palette no 8-bit writes; SRAM only 8-bit
   reads/writes. Emulators can be lenient about these.
6. **Timing**: keep VRAM/OAM changes in VBlank; don't rely on exact cycle counts of
   loops (ROM wait states and the prefetch buffer change them; set WAITCNT yourself).
7. **Interrupts**: acknowledge IF in the handler (write 1s), and set the BIOS flag
   (0x03007FF8) for `VBlankIntrWait`. A missing acknowledge can hang only on hardware.
8. **Sound**: DirectSound needs the master enable (SOUNDCNT_X) set first; leave
   SOUNDBIAS at its default unless you know why; test with headphones (L/R routing).
9. **Stack**: IWRAM is 32 KB with the stack at the top; deep recursion or big locals
   overwrite your variables silently.
10. **Size**: up to 32 MB ROM; pad nothing (unlike the GB, no size field to match).

## Testing on hardware

- **Flash carts** (EZ-Flash, Everdrive GBA, cheap repro carts): copy the `.gba`; set
  the save type in the cart's menu if it doesn't detect it.
- **Multiboot** (no cart, via link cable) needs a multiboot build (≤ 256 KB in EWRAM).
- **mGBA desktop**: Tools → Debugger / GDB server for breakpoints and watchpoints
  (`arm-none-eabi-gdb hello.elf`, `target remote :2345`); the memory and sprite
  viewers complement this harness's `view_vram` and `read_sprites`.
- **no$gba (debug version)**: cycle counts per instruction and warnings about bad
  memory accesses.
- Keep the harness tests (`tests/gb/*.json`) running in CI; use hardware for what an
  emulator can't tell you: timing feel, audio quality, screen ghosting.
