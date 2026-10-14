# GBA recipes

Plain C with libtonc names where they exist; register addresses are in the
`gb-hardware` skill.

## VBlank interrupt and frame wait (no library)

```c
extern void irq_handler(void);          // ARM code: acknowledge IF, OR bits into 0x03007FF8
*(void (**)(void))0x03007FFC = irq_handler;
REG_DISPSTAT = 1 << 3;                  // VBlank IRQ from the display
REG_IE = 1;                             // VBlank
REG_IME = 1;
// each frame:
__asm__ volatile("swi 0x05" ::: "r0", "r1", "r2", "r3", "memory");   // VBlankIntrWait
```
The `gba-c` starter's `crt0.s` has a working handler.

## Shadow OAM

```c
OBJ_ATTR obj_buffer[128];
oam_init(obj_buffer, 128);              // hides all
obj_set_attr(&obj_buffer[0], ATTR0_SQUARE, ATTR1_SIZE_16, ATTR2_PALBANK(0) | tile);
obj_set_pos(&obj_buffer[0], x, y);
// in VBlank:
oam_copy(oam_mem, obj_buffer, count);
```

## DMA copies

```c
dma3_cpy(dst, src, bytes);              // libtonc: DMA3, size in bytes
// raw: REG_DMA3SAD = src; REG_DMA3DAD = dst; REG_DMA3CNT = words | DMA_32 | DMA_ENABLE;
```
DMA halts the CPU while it runs; for big copies prefer VBlank or use `memcpy32`
(`CpuFastSet`) which is nearly as fast.

## Fixed point

```c
typedef int FIXED;                      // 24.8
#define FIX_SHIFT 8
#define int2fx(n)   ((n) << FIX_SHIFT)
#define fx2int(f)   ((f) >> FIX_SHIFT)
#define fxmul(a, b) (((a) * (b)) >> FIX_SHIFT)
// velocity 1.5 px/frame: vx = 0x180; x += vx; screen x = fx2int(x)
```
Sine/cosine: a 512-entry lookup table (libtonc `lu_sin(angle)` returns .12 fixed),
or generate one with the `data` tool (`kind: "table"`, `table: "sin"`, `bits: 12`).
Division by a variable: multiply by a reciprocal table (`table: "reciprocal"`) and
shift right by its fractional bits.

## Affine sprite (rotate / scale)

```c
OBJ_AFFINE *aff = (OBJ_AFFINE *)obj_buffer;            // matrices overlay OAM
obj_aff_rotscale(&aff[0], scale_x, scale_y, angle);    // .8 scales, angle 0-0xFFFF
obj_set_attr(&obj_buffer[0], ATTR0_SQUARE | ATTR0_AFF | ATTR0_AFF_DBL, ATTR1_SIZE_32 | ATTR1_AFF_ID(0), tile);
```
`ATTR0_AFF_DBL` doubles the bounding box so rotated corners aren't clipped (the
sprite's x,y then refer to the doubled box). Matrix all zero = invisible.

## Affine background and mode 7

Mode 1 or 2; BG2/BG3 are affine (8bpp tiles, 1-byte map entries, square maps
128-1024 px). Set `REG_BG2PA..PD` (.8 fixed) and `REG_BG2X/Y` (.8 fixed, 28 bits).
Mode 7 (perspective floor): change PA/PC and BG2X/Y per scanline from an HBlank
interrupt or HBlank DMA into the registers.

## Code in IWRAM

```c
__attribute__((section(".iwram"), target("arm"), long_call, noinline))
void hot_loop(void) { ... }
```
(libtonc's `IWRAM_CODE` is the section + `long_call` part; the code must also be
ARM: `target("arm")`, or compile the file with `-marm`. In devkitARM projects a
file named `name.iwram.c` gets both automatically.)
Use it for the few functions that run every frame over many items; IWRAM is 32 KB
shared with variables and the stack.

## Saves

- SRAM (32 KB at 0x0E000000): 8-bit reads and writes only; read back through a
  `volatile u8*`. Add the ID string `"SRAM_V113"` somewhere in the ROM (a const
  array) so emulators and flash carts pick SRAM.
- Flash and EEPROM need command sequences: use a library (Butano `bn::sram`,
  devkitPro's `gba-save` code) rather than writing them by hand.

## Sound effects with DirectSound (no library)

Convert with the `data` tool (`kind: "sound"`, `out: "src/gfx/jump.c"`): signed
8-bit samples plus `JUMP_TIMER_RELOAD` and `JUMP_LENGTH`. Then:
```c
REG_SOUNDCNT_X = 0x0080;                 // master on (first)
REG_SOUNDCNT_H = 0x0B04;                 // DirectSound A 100%, left+right, timer 0, reset FIFO A
REG_DMA1SAD = (u32)jump;                 // samples
REG_DMA1DAD = (u32)&REG_FIFO_A;          // 0x040000A0
REG_DMA1CNT = 0xB6400000;                // enable | FIFO timing | 32-bit | repeat | dest fixed
REG_TM0D    = JUMP_TIMER_RELOAD;         // sample rate
REG_TM0CNT  = TM_ENABLE;                 // prescaler 1
// stop after JUMP_LENGTH samples (≈ JUMP_LENGTH / rate * 59.73 frames): REG_DMA1CNT = 0; REG_TM0CNT = 0;
```
18157 Hz (reload 64612) gives exactly 304 samples per frame, which makes
VBlank-timed double buffering easy. `describe` with `io: true` shows whether this is
set up (rate, which DMA feeds the FIFO) and `check` flags a stopped timer or the
master switch left off.

## Sound with Maxmod (devkitARM)

Put `.it .mod .s3m .xm` music and `.wav` effects (the `data` tool writes clean 8-bit
WAVs at the rate you pick) in an audio folder; `mmutil`
builds `soundbank.bin` + `soundbank.h`. Then:
```c
mmInitDefault((mm_addr)soundbank_bin, 8);   // 8 channels
mmStart(MOD_SONG, MM_PLAY_LOOP);
mmEffect(SFX_JUMP);
// every frame, right after VBlankIntrWait():
mmVBlank(); mmFrame();
```
Maxmod's VBlank call must run every frame or sound stutters.

## Compressed graphics

The `sprite` / `background` tools with `compress: "lz77"` write data the BIOS
decompresses straight into VRAM:
```c
LZ77UnCompVram(font_tiles, &tile_mem[0][32]);   // libtonc; or swi 0x12 with r0=src, r1=dst
```
Source must be 4-byte aligned (the generated arrays are).
