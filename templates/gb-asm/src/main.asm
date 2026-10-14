; Game Boy starter: text on the background, a 16x16 player moved with the D-pad.
;
; Frame loop: the VBlank interrupt copies the shadow OAM to the screen (OAM DMA);
; the main loop sleeps until then, reads the joypad and updates the player.
; Tiles: player at 0-3 (8x16 sprites), font at 32-127 so a tile number is its
; ASCII code (the harness reads on-screen text with charmap "ascii").

DEF rJOYP EQU $FF00
DEF rIF   EQU $FF0F
DEF rLCDC EQU $FF40
DEF rLY   EQU $FF44
DEF rDMA  EQU $FF46
DEF rBGP  EQU $FF47
DEF rOBP0 EQU $FF48
DEF rIE   EQU $FFFF

DEF TILES  EQU $8000
DEF BG_MAP EQU $9800

SECTION "VBlank interrupt", ROM0[$40]
    jp VBlank

SECTION "Header", ROM0[$100]
    nop
    jp Start
    ds $150 - @, 0          ; header, filled in by rgbfix

SECTION "Main", ROM0
Start:
    di
    ld sp, $E000            ; stack at the top of WRAM

    ; VRAM can only be written freely with the LCD off, and the LCD may only be
    ; turned off during VBlank.
.waitVBlank
    ldh a, [rLY]
    cp 144
    jr c, .waitVBlank
    xor a
    ldh [rLCDC], a

    ld hl, TILES
    ld de, PlayerTiles
    ld bc, PlayerTilesEnd - PlayerTiles
    call MemCopy
    ld hl, TILES + 32 * 16
    ld de, FontTiles
    ld bc, FontTilesEnd - FontTiles
    call MemCopy

    ; Clear the background map to spaces, then print.
    ld hl, BG_MAP
    ld bc, 32 * 32
.clear
    ld a, " "
    ld [hli], a
    dec bc
    ld a, b
    or c
    jr nz, .clear
    ld hl, BG_MAP + 32 * 2 + 2
    ld de, TitleText
    call PrintString
    ld hl, BG_MAP + 32 * 15 + 4
    ld de, HintText
    call PrintString

    ; Shadow OAM: all sprites off-screen (y = 0).
    ld hl, wShadowOAM
    ld bc, 160
.clearOam
    xor a
    ld [hli], a
    dec bc
    ld a, b
    or c
    jr nz, .clearOam

    ; OAM DMA must run from HRAM.
    ld hl, hOAMDMA
    ld de, OAMDMARoutine
    ld bc, OAMDMARoutineEnd - OAMDMARoutine
    call MemCopy

    ld a, 76
    ld [wPlayerX], a
    ld a, 64
    ld [wPlayerY], a
    xor a
    ld [wFrameCounter], a
    ld [wKeys], a

    ld a, %11100100         ; shades 3,2,1,0 for colours 3..0
    ldh [rBGP], a
    ldh [rOBP0], a
    ; LCD on, tiles at $8000, BG map $9800, 8x16 sprites, sprites on, BG on.
    ld a, %10010111
    ldh [rLCDC], a

    ld a, 1                 ; VBlank interrupt only
    ldh [rIE], a
    xor a
    ldh [rIF], a
    ei

MainLoop:
    halt                    ; sleep until the VBlank interrupt has run
    call ReadJoypad
    call MovePlayer
    call UpdateShadowOAM
    ld hl, wFrameCounter
    inc [hl]
    jr MainLoop

; wKeys bits: 7 Down, 6 Up, 5 Left, 4 Right, 3 Start, 2 Select, 1 B, 0 A (1 = held).
ReadJoypad:
    ld a, $20               ; select the D-pad
    ldh [rJOYP], a
    ldh a, [rJOYP]
    ldh a, [rJOYP]          ; read twice to let the lines settle
    cpl
    and $0F
    swap a
    ld b, a
    ld a, $10               ; select the buttons
    ldh [rJOYP], a
    REPT 6
    ldh a, [rJOYP]
    ENDR
    cpl
    and $0F
    or b
    ld [wKeys], a
    ld a, $30               ; deselect both
    ldh [rJOYP], a
    ret

MovePlayer:
    ld a, [wKeys]
    ld b, a
    ld hl, wPlayerX
    bit 4, b
    jr z, .notRight
    ld a, [hl]
    cp 160 - 16
    jr nc, .notRight
    inc [hl]
.notRight
    bit 5, b
    jr z, .notLeft
    ld a, [hl]
    and a
    jr z, .notLeft
    dec [hl]
.notLeft
    ld hl, wPlayerY
    bit 6, b
    jr z, .notUp
    ld a, [hl]
    and a
    jr z, .notUp
    dec [hl]
.notUp
    bit 7, b
    jr z, .notDown
    ld a, [hl]
    cp 144 - 16
    jr nc, .notDown
    inc [hl]
.notDown
    ret

; Two 8x16 sprites side by side. OAM holds y+16 and x+8.
UpdateShadowOAM:
    ld hl, wShadowOAM
    ld a, [wPlayerY]
    add 16
    ld b, a
    ld a, [wPlayerX]
    add 8
    ld c, a
    ld [hl], b
    inc l
    ld [hl], c
    inc l
    ld [hl], 0              ; tiles 0-1
    inc l
    ld [hl], 0
    inc l
    ld [hl], b
    inc l
    ld a, c
    add 8
    ld [hl], a
    inc l
    ld [hl], 2              ; tiles 2-3
    inc l
    ld [hl], 0
    ret

VBlank:
    push af
    ld a, HIGH(wShadowOAM)
    call hOAMDMA
    pop af
    reti

; hl = destination, de = source, bc = length
MemCopy:
    ld a, [de]
    ld [hli], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, MemCopy
    ret

; hl = destination in the BG map, de = zero-terminated string
PrintString:
    ld a, [de]
    and a
    ret z
    ld [hli], a
    inc de
    jr PrintString

OAMDMARoutine:
    ldh [rDMA], a
    ld a, 40                ; wait 160 cycles for the copy
.wait
    dec a
    jr nz, .wait
    ret
OAMDMARoutineEnd:

TitleText: db "HELLO, GAME BOY!", 0
HintText:  db "D-PAD TO MOVE", 0

SECTION "Graphics", ROM0
PlayerTiles: INCBIN "build/player.2bpp"
PlayerTilesEnd:
FontTiles: INCBIN "build/font.2bpp"
FontTilesEnd:

SECTION "Shadow OAM", WRAM0, ALIGN[8]
wShadowOAM: ds 160

SECTION "Variables", WRAM0
wPlayerX: db
wPlayerY: db
wFrameCounter: db
wKeys: db

SECTION "OAM DMA routine", HRAM
hOAMDMA: ds OAMDMARoutineEnd - OAMDMARoutine
