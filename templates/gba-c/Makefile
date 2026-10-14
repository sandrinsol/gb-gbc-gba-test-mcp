# Game Boy Advance starter — any arm-none-eabi GCC (devkitARM or a distro
# package). `make` builds build/hello.gba plus build/hello.elf, whose symbols
# the test harness reads so tools accept names like player_x.
CC      := arm-none-eabi-gcc
OBJCOPY := arm-none-eabi-objcopy
NAME    := hello
BUILD   := build
SRC     := $(wildcard src/*.c src/gfx/*.c) src/crt0.s

CFLAGS  := -mcpu=arm7tdmi -mthumb -mthumb-interwork -O2 -g -Wall -Wextra \
           -ffreestanding -fno-strict-aliasing
LDFLAGS := -nostartfiles -nostdlib -T gba.ld -Wl,-Map,$(BUILD)/$(NAME).map -Wl,--gc-sections

all: $(BUILD)/$(NAME).gba

$(BUILD)/$(NAME).elf: $(SRC) gba.ld | $(BUILD)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(SRC) -lgcc

$(BUILD)/$(NAME).gba: $(BUILD)/$(NAME).elf
	$(OBJCOPY) -O binary $< $@
	node tools/gbafix.mjs $@ HELLO

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
