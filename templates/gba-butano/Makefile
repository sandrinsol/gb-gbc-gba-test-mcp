# Game Boy Advance starter — Butano (C++). `make` builds hello.gba plus hello.elf,
# whose symbols the test harness reads so tools accept names like player_x.
# Needs devkitARM and Butano: set BUTANO to the Butano checkout (the folder with
# butano/ and common/ inside), or use the dev container.
BUTANO       ?= /opt/butano
# Butano resolves these folders from the project, so use a relative path.
BN           := $(shell python3 -c "import os, sys; print(os.path.relpath(sys.argv[1]))" "$(BUTANO)")

TARGET       := hello
BUILD        := build
LIBBUTANO    := $(BUTANO)/butano
PYTHON       := python3
SOURCES      := src $(BN)/common/src
INCLUDES     := include $(BN)/common/include
DATA         :=
GRAPHICS     := graphics $(BN)/common/graphics
AUDIO        :=
AUDIOBACKEND := maxmod
AUDIOTOOL    :=
DMGAUDIO     :=
DMGAUDIOBACKEND := default
ROMTITLE     := HELLO
ROMCODE      := SBTP
USERFLAGS    :=
USERCXXFLAGS :=
USERASFLAGS  :=
USERLDFLAGS  :=
USERLIBDIRS  :=
USERLIBS     :=
DEFAULTLIBS  :=
STACKTRACE   :=
USERBUILD    :=
EXTTOOL      :=

ifndef LIBBUTANOABS
	export LIBBUTANOABS := $(realpath $(LIBBUTANO))
endif
ifeq ($(LIBBUTANOABS),)
$(error Butano not found at $(BUTANO): set BUTANO=/path/to/butano)
endif

include $(LIBBUTANOABS)/butano.mak
