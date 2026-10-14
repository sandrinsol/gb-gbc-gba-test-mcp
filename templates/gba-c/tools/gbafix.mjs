#!/usr/bin/env node
// Fix up a GBA ROM header in place (like devkitPro's gbafix): Nintendo logo,
// title, fixed byte and complement checksum. Real hardware won't boot a ROM
// without them.   node tools/gbafix.mjs game.gba [TITLE]
import { readFileSync, writeFileSync } from 'node:fs';

const LOGO = Buffer.from('JP+uUWmaoiE9hIIKhOQJrREki5jAgX8ho1K+GZMJziAQRkpK+Ccx7FjH6DOC486/hfTflM5LCcGUVorAE3Kn/J+ETXOjypphWJejJ/wDmHYjHcdhAwSuVr84hABApw79/1L+A2+VMPGX+8CFYNaAJaljvgMBTjji+aI0/7s+A0R4AJDLiBE6lGXAfGOH8Dyv1iXkizgKrHIh1PgH', 'base64');
const [file, title = ''] = process.argv.slice(2);
if (!file) { console.error('usage: node gbafix.mjs <rom.gba> [TITLE]'); process.exit(1); }
const rom = readFileSync(file);
LOGO.copy(rom, 0x04);
rom.fill(0, 0xa0, 0xac);
rom.write(title.toUpperCase().slice(0, 12), 0xa0, 'latin1');
rom[0xb2] = 0x96;
let sum = 0;
for (let i = 0xa0; i < 0xbd; i++) sum += rom[i];
rom[0xbd] = (-(sum + 0x19)) & 0xff;
writeFileSync(file, rom);
