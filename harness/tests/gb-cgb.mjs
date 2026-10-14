// Exercises the CGB-only WRAM banking path (SVBK) in the GB memory parser.
//
// A Game Boy Color ROM writes a distinct sentinel (0xB0+bank) into 0xD000 of every
// WRAM bank, then selects SVBK=2. The parser must (a) see 32 KB WRAM, (b) return the
// SVBK-selected bank at 0xD000, and (c) hold distinct data in other banks.
//
//   node tests/gb-cgb.mjs   (exit 0 = pass, 1 = fail)

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { EmuHarness } from '../driver.mjs';
import { makeCgbRom } from './gb-roms.mjs';

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};


await mkdir(path.resolve('out'), { recursive: true });
const romPath = path.resolve('out', 'cgbbank.gbc');
await writeFile(romPath, makeCgbRom());

const gba = await EmuHarness.launch(romPath, { timeout: 30000 });
try {
  await gba.waitFrames(30);

  const r = await gba.readRegions();
  ok('CGB mode: 32KB WRAM', r.wram && r.wram.length === 0x8000, `${r.wram?.length} bytes`);

  const svbk = await gba.readU8(0xff70);
  ok('SVBK selected bank 2', (svbk & 7) === 2, `0x${svbk.toString(16)}`);

  // 0xD000 must return the SVBK-selected bank (2), whose sentinel is 0xB2.
  const banked = await gba.readU8(0xd000);
  ok('0xD000 returns SVBK bank 2 sentinel (0xB2)', banked === 0xb2, `0x${banked.toString(16)}`);

  // 0xC000 is the fixed bank 0 (sentinel 0xB0).
  const fixed = await gba.readU8(0xc000);
  ok('0xC000 is fixed bank 0 (0xB0)', fixed === 0xb0, `0x${fixed.toString(16)}`);

  // Other banks hold distinct data in the raw region (proves selection matters).
  ok('bank 3 slot holds 0xB3', r.wram[3 * 0x1000] === 0xb3, `0x${r.wram[3 * 0x1000].toString(16)}`);
  ok('bank 7 slot holds 0xB7', r.wram[7 * 0x1000] === 0xb7, `0x${r.wram[7 * 0x1000].toString(16)}`);
} finally {
  await gba.close();
}
process.exit(failed ? 1 : 0);
