// Fast-forward must not change results: the same script run at 1x, in
// fast-forward, and in fast-forward with a forced overshoot recovery must give
// bit-identical frames and RAM at every checkpoint.
//
//   node tests/fastforward.mjs   (exit 0 = pass, 1 = fail)

import { EmuHarness } from '../driver.mjs';
import { compare } from '../assert.mjs';

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

async function scriptedRun({ fast, forceOvershoot = false }) {
  const emu = await EmuHarness.launch('../anguna.gba', { fast });
  const t0 = Date.now();
  const out = { shots: [], ram: [], frames: [] };
  const checkpoint = async () => {
    out.shots.push(await emu.screenshot());
    out.ram.push((await emu.readRegions()).iwram);
    out.frames.push(await emu.frameNum());
  };
  await emu.waitFrames(600);
  await checkpoint();
  for (const b of ['START', 'A', 'START', 'A', 'START']) await emu.tap(b, 6, 20);
  if (forceOvershoot) await emu.page.evaluate(() => { window.Emu._forceOvershoot = true; });
  await emu.setButton('RIGHT', true);
  await emu.waitFrames(400);
  await emu.setButton('RIGHT', false);
  await checkpoint();
  out.ms = Date.now() - t0;
  out.stats = await emu.stats();
  await emu.close();
  return out;
}

const slow = await scriptedRun({ fast: false });
const fast = await scriptedRun({ fast: true });
const recov = await scriptedRun({ fast: true, forceOvershoot: true });

console.log(`timing: 1x ${slow.ms}ms, fast ${fast.ms}ms (${fast.stats.ffWaits} ff waits), recovery run ${recov.ms}ms (${recov.stats.recoveries} recoveries)`);
ok('fast-forward was used', fast.stats.ffWaits > 0);
ok('forced overshoot exercised recovery', recov.stats.recoveries === 1, `${recov.stats.recoveries}`);
for (const [name, run] of /** @type {Array<[string, any]>} */ ([['fast', fast], ['recovery', recov]])) {
  for (let i = 0; i < slow.shots.length; i++) {
    const d = compare(slow.shots[i], run.shots[i]).fraction;
    ok(`${name} frame ${i} identical to 1x`, d === 0, `${(d * 100).toFixed(3)}% differ`);
    const nd = slow.ram[i].reduce((n, v, j) => n + (v !== run.ram[i][j]), 0);
    ok(`${name} RAM ${i} identical to 1x`, nd === 0, `${nd} IWRAM bytes differ`);
    ok(`${name} frame number ${i} matches`, slow.frames[i] === run.frames[i], `${slow.frames[i]} vs ${run.frames[i]}`);
  }
}

process.exit(failed ? 1 : 0);
