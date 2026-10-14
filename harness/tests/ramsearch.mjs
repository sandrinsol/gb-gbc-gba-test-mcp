// Unit tests for the RAM search engine and address parsing (no emulator needed).
//
//   node tests/ramsearch.mjs   (exit 0 = pass, 1 = fail)

import { RamSearch } from '../ramsearch.mjs';
import { parseAddress } from '../steps.mjs';

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

// Fake GBA regions with a "HP" u16 at IWRAM+0x40 and an 8-bit counter at EWRAM+0x10.
const gba = () => ({ ewram: Buffer.alloc(0x40000), iwram: Buffer.alloc(0x8000) });
let r = gba();
r.iwram.writeUInt16LE(300, 0x40); r.ewram[0x10] = 5;

let s = new RamSearch('gba', r, { type: 'u16' });
ok('u16 candidates are 2-byte aligned', s.count === (0x40000 + 0x8000) / 2, `${s.count}`);
s.filter(r, 'eq', 300);
ok('eq 300 finds HP', s.count === 1 && s.results()[0].address === 0x03000040, JSON.stringify(s.results()));
let r2 = gba(); r2.iwram.writeUInt16LE(290, 0x40);
s.filter(r2, 'delta', -10);
ok('delta -10 keeps HP', s.count === 1 && s.results()[0].value === 290 && s.results()[0].previous === 300);

s = new RamSearch('gba', r, { type: 'u8', region: 'ewram' });
const r3 = gba(); r3.ewram[0x10] = 6; r3.ewram[0x20] = 1;
s.filter(r3, 'increased');
ok('increased finds both changes', s.count === 2);
const r4 = gba(); r4.ewram[0x10] = 6; r4.ewram[0x20] = 9;
s.filter(r4, 'unchanged');
ok('unchanged removes the noisy byte', s.count === 1 && s.results()[0].address === 0x02000010);

s = new RamSearch('gba', r, { type: 's8', region: 'iwram' });
const r5 = gba(); r5.iwram[0x7] = 0xff;
s.filter(r5, 'eq', -1);
ok('signed eq -1', s.count === 1 && s.results()[0].value === -1);
ok('unknown region errors', (() => { try { new RamSearch('gba', r, { region: 'vram' }); return false; } catch { return true; } })());
ok('value op without value errors', (() => { try { s.filter(r5, 'eq'); return false; } catch { return true; } })());

// GB: CGB WRAM banks report bus address + bank; HRAM maps to 0xFF80.
const gbr = () => ({ wram: Buffer.alloc(0x8000), hram: Buffer.alloc(0x200), sram: Buffer.alloc(0), isCgbWram: true });
const g = gbr(); g.wram[0x3005] = 42; g.hram[0x180 + 3] = 42; g.wram[0x0007] = 42;
s = new RamSearch('gb', g, { type: 'u8' });
s.filter(g, 'eq', 42);
const res = s.results();
ok('GB search hits WRAM0, banked WRAM and HRAM', s.count === 3, JSON.stringify(res));
ok('bank 3 hit reported at 0xD005', res.some((x) => x.address === 0xd005 && x.bank === 3));
ok('WRAM0 hit at 0xC007', res.some((x) => x.address === 0xc007 && x.bank === 0));
ok('HRAM hit at 0xFF83', res.some((x) => x.address === 0xff83));

// Address parsing
ok('parse 0x hex', parseAddress('0x03000010') === 0x03000010);
ok('parse $ hex', parseAddress('$C000') === 0xc000);
ok('parse h-suffix hex', parseAddress('FF80h') === 0xff80);
ok('parse bare hex with letters', parseAddress('C000') === 0xc000);
ok('parse decimal string', parseAddress('49152') === 49152);
ok('parse number', parseAddress(0xc000) === 0xc000);
ok('reject junk', (() => { try { parseAddress('xyz'); return false; } catch { return true; } })());

process.exit(failed ? 1 : 0);
