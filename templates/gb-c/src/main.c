// Game Boy starter: text on the background, a 16x16 player moved with the D-pad.
//
// The font is loaded at tiles 32-127 so a tile number is its ASCII code (the
// harness reads on-screen text with charmap "ascii"). player_x, player_y and
// frame_counter are globals so tests can read them by name.
#include <gb/gb.h>
#include <gb/metasprites.h>
#include <stdint.h>
#include <string.h>
#include "font.h"
#include "player.h"

uint8_t player_x = 72, player_y = 64;
uint8_t frame_counter;

static void print(uint8_t x, uint8_t y, const char *s) {
    set_bkg_tiles(x, y, strlen(s), 1, (const uint8_t *)s);
}

void main(void) {
    DISPLAY_OFF;
    set_bkg_data(32, font_TILE_COUNT, font_tiles);
    fill_bkg_rect(0, 0, 32, 32, ' ');
    print(2, 2, "HELLO FROM GBDK!");
    print(4, 15, "D-PAD TO MOVE");
    // png2asset gave the font's ink colour index 1: show colour 1 as black.
    BGP_REG = DMG_PALETTE(DMG_WHITE, DMG_BLACK, DMG_DARK_GRAY, DMG_LITE_GRAY);
    OBP0_REG = DMG_PALETTE(DMG_WHITE, DMG_LITE_GRAY, DMG_DARK_GRAY, DMG_BLACK);

    SPRITES_8x16;
    set_sprite_data(0, player_TILE_COUNT, player_tiles);
    SHOW_BKG;
    SHOW_SPRITES;
    DISPLAY_ON;

    while (1) {
        uint8_t keys = joypad();
        if ((keys & J_RIGHT) && player_x < 160 - 16) player_x++;
        if ((keys & J_LEFT) && player_x > 0) player_x--;
        if ((keys & J_UP) && player_y > 0) player_y--;
        if ((keys & J_DOWN) && player_y < 144 - 16) player_y++;
        // Hardware sprite coordinates are offset by (8, 16); the metasprite's
        // pivot is its centre.
        move_metasprite_ex(player_metasprites[0], 0, 0, 0, player_x + 8 + 8, player_y + 16 + 8);
        frame_counter++;
        vsync();
    }
}
