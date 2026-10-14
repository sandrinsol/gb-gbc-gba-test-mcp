// GBA starter: text on background 0, a 16x16 player sprite moved with the D-pad.
//
// The font is loaded at tiles 32-127 so a tile number is its ASCII code (the
// harness reads on-screen text with charmap "ascii"). player_x, player_y and
// frame_counter are globals so tests can read them by name.
#include <stdint.h>
#include "gfx/font.h"
#include "gfx/player.h"

#define REG_DISPCNT  (*(volatile uint16_t *)0x04000000)
#define REG_DISPSTAT (*(volatile uint16_t *)0x04000004)
#define REG_VCOUNT   (*(volatile uint16_t *)0x04000006)
#define REG_BG0CNT   (*(volatile uint16_t *)0x04000008)
#define REG_KEYINPUT (*(volatile uint16_t *)0x04000130)
#define REG_IE       (*(volatile uint16_t *)0x04000200)
#define REG_IME      (*(volatile uint16_t *)0x04000208)
#define IRQ_VECTOR   (*(void (**)(void))0x03007ffc)

#define BG_PALETTE   ((volatile uint16_t *)0x05000000)
#define OBJ_PALETTE  ((volatile uint16_t *)0x05000200)
#define BG_TILES     ((volatile uint32_t *)0x06000000)  // char block 0
#define BG_MAP       ((volatile uint16_t *)0x0600f800)  // screen block 31
#define OBJ_TILES    ((volatile uint32_t *)0x06010000)
#define OAM          ((volatile uint16_t *)0x07000000)

#define KEY_RIGHT 0x10
#define KEY_LEFT  0x20
#define KEY_UP    0x40
#define KEY_DOWN  0x80

#define RGB15(r, g, b) ((r) | ((g) << 5) | ((b) << 10))

extern void irq_handler(void);

int player_x = 112, player_y = 64;
uint32_t frame_counter;
int cpu_usage;  // % of the last frame spent on game logic (tests read it)

// Sleep until the next VBlank (BIOS VBlankIntrWait); VRAM, OAM and palettes are
// safe to change until the next frame starts drawing.
static void vsync(void) {
    __asm__ volatile("swi 0x05" ::: "r0", "r1", "r2", "r3", "memory");
}

// VRAM only takes 16- and 32-bit writes, so copy words.
static void copy32(volatile uint32_t *dst, const unsigned int *src, int words) {
    while (words--) *dst++ = *src++;
}

static void print(int x, int y, const char *s) {
    while (*s) BG_MAP[y * 32 + x++] = (uint8_t)*s++;
}

int main(void) {
    copy32(BG_TILES + 32 * 8, font_tiles, sizeof font_tiles / 4);
    for (int i = 0; i < 32 * 32; i++) BG_MAP[i] = ' ';
    BG_PALETTE[0] = RGB15(2, 4, 10);   // backdrop
    BG_PALETTE[1] = RGB15(31, 31, 31); // font ink
    print(3, 2, "HELLO, GAME BOY ADVANCE!");
    print(8, 16, "D-PAD TO MOVE");

    copy32(OBJ_TILES, player_tiles, sizeof player_tiles / 4);
    for (int i = 0; i < 4; i++) OBJ_PALETTE[i] = player_pal[i];
    for (int i = 0; i < 128; i++) OAM[i * 4] = 0x0200;  // hide every sprite

    REG_BG0CNT = 31 << 8;  // 4bpp, char block 0, screen block 31
    // Mode 0, BG0 + sprites on, 1D sprite tile mapping.
    REG_DISPCNT = (1 << 8) | (1 << 12) | (1 << 6);

    IRQ_VECTOR = irq_handler;
    REG_DISPSTAT = 1 << 3;  // VBlank interrupt
    REG_IE = 1;
    REG_IME = 1;

    while (1) {
        vsync();
        uint16_t keys = ~REG_KEYINPUT;  // buttons read 0 when pressed
        if ((keys & KEY_RIGHT) && player_x < 240 - 16) player_x++;
        if ((keys & KEY_LEFT) && player_x > 0) player_x--;
        if ((keys & KEY_UP) && player_y > 0) player_y--;
        if ((keys & KEY_DOWN) && player_y < 160 - 16) player_y++;
        OAM[0] = player_y & 0xff;                 // square, 4bpp
        OAM[1] = (player_x & 0x1ff) | (1 << 14);  // 16x16
        OAM[2] = 0;                               // tile 0, palette bank 0
        frame_counter++;
        // Work started at the top of VBlank (line 160): the lines since then are
        // the CPU time used (228 lines = one frame). x * 449 >> 10 ≈ x * 100 / 228
        // without a division.
        cpu_usage = (((REG_VCOUNT + 228 - 160) % 228) * 449) >> 10;
    }
}
