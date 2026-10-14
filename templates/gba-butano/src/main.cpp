// GBA starter with Butano: text, and a 16x16 player sprite moved with the D-pad.
//
// player_x, player_y and frame_counter are globals so tests can read them by
// name (volatile: written to RAM every frame, whatever the optimiser does).
// Butano's coordinates are centred: (0, 0) is the middle of the screen.
#include "bn_core.h"
#include "bn_keypad.h"
#include "bn_bg_palettes.h"
#include "bn_color.h"
#include "bn_sprite_ptr.h"
#include "bn_sprite_text_generator.h"
#include "bn_vector.h"

#include "bn_sprite_items_player.h"
#include "common_variable_8x16_sprite_font.h"

volatile int player_x = 0, player_y = 0;
volatile unsigned frame_counter = 0;

int main()
{
    bn::core::init();
    bn::bg_palettes::set_transparent_color(bn::color(2, 4, 10));

    bn::sprite_text_generator text_generator(common::variable_8x16_sprite_font);
    text_generator.set_center_alignment();
    bn::vector<bn::sprite_ptr, 32> text_sprites;
    text_generator.generate(0, -64, "Hello, Butano!", text_sprites);
    text_generator.generate(0, 64, "D-pad to move", text_sprites);

    bn::sprite_ptr player = bn::sprite_items::player.create_sprite(0, 0);

    while(true)
    {
        if(bn::keypad::right_held() && player_x < 112) { player_x = player_x + 1; }
        if(bn::keypad::left_held() && player_x > -112) { player_x = player_x - 1; }
        if(bn::keypad::up_held() && player_y > -72) { player_y = player_y - 1; }
        if(bn::keypad::down_held() && player_y < 72) { player_y = player_y + 1; }
        player.set_position(player_x, player_y);
        frame_counter = frame_counter + 1;
        bn::core::update();
    }
}
