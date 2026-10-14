@ Start-up code: ROM header, stacks, copy .data to IWRAM, clear .bss, call main.
    .section .crt0, "ax"
    .global _start
    .arm
_start:
    b       start
    .fill   156, 1, 0           @ Nintendo logo   } filled in by tools/gbafix.mjs
    .fill   12, 1, 0            @ title           }
    .ascii  "HELO"              @ game code
    .ascii  "01"                @ maker code
    .byte   0x96, 0, 0          @ fixed value, unit code, device type
    .fill   7, 1, 0
    .byte   0, 0                @ version, complement checksum (gbafix)
    .fill   2, 1, 0

start:
    mov     r0, #0x12           @ IRQ mode stack
    msr     cpsr_c, r0
    ldr     sp, =0x03007fa0
    mov     r0, #0x1f           @ system mode stack
    msr     cpsr_c, r0
    ldr     sp, =0x03007f00

    ldr     r0, =__data_lma     @ initialised variables: ROM -> IWRAM
    ldr     r1, =__data_start
    ldr     r2, =__data_end
1:  cmp     r1, r2
    ldrlo   r3, [r0], #4
    strlo   r3, [r1], #4
    blo     1b

    ldr     r1, =__bss_start    @ zero-initialised variables
    ldr     r2, =__bss_end
    mov     r3, #0
2:  cmp     r1, r2
    strlo   r3, [r1], #4
    blo     2b

    ldr     r0, =main
    mov     lr, pc
    bx      r0
    b       .

@ Interrupt handler (the BIOS calls it in ARM mode): acknowledge what fired and
@ tell the BIOS, so VBlankIntrWait returns.
    .global irq_handler
irq_handler:
    mov     r0, #0x04000000
    add     r0, r0, #0x200
    ldr     r1, [r0]            @ IE | IF << 16
    and     r1, r1, r1, lsr #16
    strh    r1, [r0, #2]        @ acknowledge in IF
    ldr     r2, =0x03007ff8
    ldrh    r3, [r2]
    orr     r3, r3, r1
    strh    r3, [r2]            @ and in the BIOS flags
    bx      lr
    .ltorg
