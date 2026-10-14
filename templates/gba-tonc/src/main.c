// GBA starter with libtonc: text on background 0 (tonc's text engine), a 16x16
// player sprite moved with the D-pad, VBlank interrupt + VBlankIntrWait.
//
// player_x, player_y, frame_counter and cpu_usage are globals so tests can read
// them by name (volatile: the game loop writes them to RAM every frame).
#include <tonc.h>
#include "player.h"

volatile int player_x = 112, player_y = 64;
volatile u32 frame_counter;
volatile int cpu_usage;  // % of the last frame spent on game logic

OBJ_ATTR obj_buffer[128];

int main(void) {
    irq_init(NULL);
    irq_enable(II_VBLANK);

    // Text: tonc's default 8x8 font on BG0, tiles in char block 0, map in screen block 31.
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_OBJ | DCNT_OBJ_1D;
    tte_init_se_default(0, BG_CBB(0) | BG_SBB(31));
    tte_write("#{P:28,16}Hello, Game Boy Advance!");
    tte_write("#{P:68,128}D-pad to move");

    // Sprite: tiles at OBJ tile 0, palette bank 0.
    memcpy32(&tile_mem[4][0], playerTiles, playerTilesLen / 4);
    memcpy16(pal_obj_mem, playerPal, playerPalLen / 2);
    oam_init(obj_buffer, 128);
    OBJ_ATTR *player = &obj_buffer[0];
    obj_set_attr(player, ATTR0_SQUARE, ATTR1_SIZE_16, ATTR2_PALBANK(0) | 0);

    while (1) {
        VBlankIntrWait();
        key_poll();
        if (key_is_down(KEY_RIGHT) && player_x < 240 - 16) player_x++;
        if (key_is_down(KEY_LEFT) && player_x > 0) player_x--;
        if (key_is_down(KEY_UP) && player_y > 0) player_y--;
        if (key_is_down(KEY_DOWN) && player_y < 160 - 16) player_y++;
        obj_set_pos(player, player_x, player_y);
        oam_copy(oam_mem, obj_buffer, 1);
        frame_counter++;
        // Lines drawn since VBlank started (line 160) = CPU time used; 228 lines
        // per frame. x * 449 >> 10 ≈ x * 100 / 228 without a division.
        cpu_usage = (((REG_VCOUNT + 228 - 160) % 228) * 449) >> 10;
    }
}
