# Game Boy (DMG) starter — RGBDS. `make` builds build/hello.gb plus build/hello.sym,
# which the test harness reads so tools accept names like wPlayerX.
NAME  := hello
BUILD := build

all: $(BUILD)/$(NAME).gb

$(BUILD)/$(NAME).gb: $(BUILD)/main.o
	rgblink -n $(BUILD)/$(NAME).sym -m $(BUILD)/$(NAME).map -o $@ $^
	rgbfix -v -p 0xFF -t HELLO $@

$(BUILD)/main.o: src/main.asm $(BUILD)/font.2bpp $(BUILD)/player.2bpp | $(BUILD)
	rgbasm -Wall -o $@ $<

# Colour 0 (white) is the background / transparent colour.
$(BUILD)/font.2bpp: assets/font.png | $(BUILD)
	rgbgfx -c '#ffffff,#aaaaaa,#555555,#000000' -o $@ $<

# -Z: column order (top-left, bottom-left, top-right, bottom-right) for 8x16 sprites.
$(BUILD)/player.2bpp: assets/player.png | $(BUILD)
	rgbgfx -Z -c '#ffffff,#aaaaaa,#555555,#000000' -o $@ $<

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
