---
name: butano
description: Writing Game Boy Advance games with Butano, the C++ engine — project layout and Makefile, graphics as BMP + JSON (sprites, regular/affine backgrounds), sprite_ptr/bg_ptr lifetimes, bn::fixed, containers without the heap, keypad, text, actions and animations, cameras, audio, SRAM saves, and Butano's common errors. Use when a project includes butano.mak or bn_*.h headers, or the user wants to make a GBA game in C++.
---

# Butano

Docs: <https://gvaliente.github.io/butano/> (and the `examples/` folder of the
Butano checkout, one small program per feature). New project: `new_project`
`gba-butano`. General GBA rules: the `gba-dev` skill.

## Project

- `Makefile` sets `LIBBUTANO`, `SOURCES`, `INCLUDES`, `GRAPHICS`, `AUDIO`, then
  includes `butano.mak`. Folder paths are relative to the project.
- Build: `make -j4` → `<TARGET>.gba` and `<TARGET>.elf` (symbols for the harness).
- `graphics/` holds `name.bmp` + `name.json`; Butano generates
  `bn_sprite_items_name.h` / `bn_regular_bg_items_name.h` from them.
- `audio/`: `.it .mod .s3m .xm` music → `bn::music_items::name`; `.wav` →
  `bn::sound_items::name`.

## Graphics JSON

```json
{ "type": "sprite", "height": 16 }                    // frames stacked vertically
{ "type": "regular_bg", "bpp_mode": "bpp_4" }         // 256/512 px sides
{ "type": "affine_bg" }                               // 8bpp, square
{ "type": "sprite", "height": 32, "compression": "lz77" }
```
BMPs must be indexed (16 or 256 colours), colour 0 transparent, sides multiples
of 8. The harness `sprite` / `background` tools write them: `out: "graphics/x.bmp"`.

## Core patterns

```cpp
#include "bn_core.h"
#include "bn_keypad.h"
#include "bn_sprite_ptr.h"
#include "bn_sprite_items_hero.h"

int main() {
    bn::core::init();
    bn::sprite_ptr hero = bn::sprite_items::hero.create_sprite(0, 0);  // centred coords
    while(true) {
        if(bn::keypad::left_held()) { hero.set_x(hero.x() - 1); }
        if(bn::keypad::a_pressed()) { /* jump */ }
        bn::core::update();                    // once per frame, always
    }
}
```

- `sprite_ptr`, `regular_bg_ptr`, etc. are handles: the object exists while a handle
  does. A sprite created in a block and not stored disappears at the end of it.
- Coordinates are centred (0,0 = screen middle) and `bn::fixed` (fixed point).
  Use `bn::fixed`, never `float`/`double`.
- No heap in practice: use `bn::vector<T, N>`, `bn::deque`, `bn::optional`,
  `bn::string<N>`; fixed capacity, assert on overflow.
- Text: `bn::sprite_text_generator gen(common::variable_8x16_sprite_font);`
  `gen.generate(x, y, "text", vector_of_sprites);` (fonts come from Butano's
  `common/` folder, added in the Makefile).
- Animation: `bn::create_sprite_animate_action_forever(sprite, frames_wait,
  bn::sprite_items::hero.tiles_item(), 0, 1, 2, 1)`; call `action.update()` each frame.
- Movement over time: `bn::sprite_move_to_action`, `..._rotate_..`, `..._scale_..`.
- Camera: `bn::camera_ptr camera = bn::camera_ptr::create(0, 0);
  sprite.set_camera(camera); bg.set_camera(camera);` then move the camera.
- Random: `bn::random` (seed it from a frame counter or input timing).
- Saves: `bn::sram::write(data)` / `bn::sram::read(data)` with a trivially
  copyable struct; keep a version field to detect empty SRAM.
- Audio: `bn::music_items::theme.play(volume)`, `bn::sound_items::jump.play()`.

## Testing with the harness

- Put state the tests need in globals (`volatile int lives;`) so `watch`,
  `assertRam` and `read_memory` find them by name in the `.elf`.
- Butano text is sprites: `describe` lists them but can't read them; take a
  screenshot, or keep the text you need to check in a global too.
- `check` with a `frameCounter` global shows lag; `view_vram` `layers` shows each
  background and the sprite layer.

## Common errors

| Message / symptom | Cause |
|---|---|
| `Python not found` / tool errors at build | `PYTHON := python3` in the Makefile |
| Assert: no more sprite tiles / palettes / sprites | Too many unique graphics alive: share items, release handles you don't need |
| Assert in `bn::vector::push_back` | Capacity N reached: raise N |
| `Invalid width`/`height` from the graphics tool | BMP sides not multiples of 8 (backgrounds: 256/512) |
| `Invalid bits per pixel` | BMP isn't indexed 4/8 bpp: re-export, or use the `sprite`/`background` tool |
| Sprite vanishes | Its `sprite_ptr` went out of scope |
| Everything slow | Work outside `bn::core::update` that scales with object count; per-frame allocations |
