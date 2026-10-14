# Game Boy Advance starter — devkitARM + libtonc. `make` builds hello.gba plus
# hello.elf, whose symbols the test harness reads so tools accept names like
# player_x. Needs DEVKITPRO/DEVKITARM set (the devkitPro installer and the
# devkitpro/devkitarm Docker image do this).
ifeq ($(strip $(DEVKITARM)),)
$(error Set DEVKITARM (install devkitPro, or use the dev container))
endif
include $(DEVKITARM)/gba_rules

NAME    := hello
BUILD   := build
LIBTONC := $(DEVKITPRO)/libtonc
ARCH    := -mthumb -mthumb-interwork
CFLAGS  := -g -Wall -O2 -mcpu=arm7tdmi -mtune=arm7tdmi $(ARCH) -I$(LIBTONC)/include -I$(BUILD)
LDFLAGS := -g $(ARCH) -specs=gba.specs -Wl,-Map,$(BUILD)/$(NAME).map
LIBS    := -L$(LIBTONC)/lib -ltonc

OBJS := $(BUILD)/main.o $(BUILD)/player.o

all: $(NAME).gba

$(NAME).gba: $(NAME).elf
	$(OBJCOPY) -O binary $< $@
	gbafix $@ -tHELLO

$(NAME).elf: $(OBJS)
	$(CC) $(LDFLAGS) $^ $(LIBS) -o $@

$(BUILD)/main.o: src/main.c $(BUILD)/player.h | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

# grit: 4bpp tiles + a 16-colour palette, magenta transparent → playerTiles, playerPal.
$(BUILD)/player.s $(BUILD)/player.h: assets/player.png | $(BUILD)
	grit $< -gB4 -gt -gTFF00FF -pn16 -fts -o$(BUILD)/player

$(BUILD)/player.o: $(BUILD)/player.s
	$(CC) -x assembler-with-cpp $(ARCH) -c $< -o $@

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD) $(NAME).elf $(NAME).gba

.PHONY: all clean
