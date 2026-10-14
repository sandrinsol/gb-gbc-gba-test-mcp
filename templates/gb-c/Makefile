# Game Boy (DMG) starter — GBDK-2020. `make` builds build/hello.gb plus
# build/hello.noi (symbols), which the test harness reads so tools accept names
# like player_x.
GBDK  ?= /opt/gbdk
LCC   := $(GBDK)/bin/lcc
P2A   := $(GBDK)/bin/png2asset
NAME  := hello
BUILD := build

all: $(BUILD)/$(NAME).gb

$(BUILD)/$(NAME).gb: src/main.c $(BUILD)/font.c $(BUILD)/player.c | $(BUILD)
	$(LCC) -I$(BUILD) -Wl-j -Wm-yn"HELLO" -o $@ src/main.c $(BUILD)/font.c $(BUILD)/player.c

# The font keeps every tile in sheet order (space first) so tile = ASCII - 32.
$(BUILD)/font.c: assets/font.png | $(BUILD)
	$(P2A) $< -c $@ -map -keep_duplicate_tiles -noflip

$(BUILD)/player.c: assets/player.png | $(BUILD)
	$(P2A) $< -c $@ -sw 16 -sh 16 -spr8x16

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
