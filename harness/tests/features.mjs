// Driver-level guarantees of reset, waitFor, zipped ROMs and launch errors:
//   - restart() is deterministic: after a reset the game replays exactly like a
//     fresh boot (same frames, same RAM).
//   - waitFor() in fast mode (fast-forward + rewind) stops on the same frame as a
//     precise frame-by-frame scan.
//
//   node tests/features.mjs   (exit 0 = pass, 1 = fail)

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { EmuHarness, romSystem } from '../driver.mjs';
import { compare } from '../assert.mjs';
import { makeInteractiveGbRom, makeZip } from './gb-roms.mjs';

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

// --- restart() vs a fresh boot ---
{
  const fresh = await EmuHarness.launch('../anguna.gba', { reuse: true });
  await fresh.waitFrames(400);
  const a = { shot: await fresh.screenshot(), ram: Buffer.from((await fresh.readRegions()).ewram), frame: await fresh.frameNum() };
  await fresh.close();

  const emu = await EmuHarness.launch('../anguna.gba', { reuse: true });
  await emu.waitFrames(250);
  for (const b of ['START', 'A', 'START']) await emu.tap(b, 6, 20); // diverge first
  await emu.restart();
  ok('restart puts the clock at frame 1', (await emu.frameNum()) === 1);
  await emu.waitFrames(400);
  const b = { shot: await emu.screenshot(), ram: Buffer.from((await emu.readRegions()).ewram), frame: await emu.frameNum() };
  ok('after restart: same frame number as a fresh boot', a.frame === b.frame, `${a.frame} vs ${b.frame}`);
  ok('after restart: same picture as a fresh boot', compare(a.shot, b.shot).fraction === 0);
  ok('after restart: same EWRAM as a fresh boot', a.ram.equals(b.ram));
  await emu.close();
}

// --- waitFor: fast (fast-forward + rewind) == precise ---
{
  const run = async (precise) => {
    const emu = await EmuHarness.launch('../anguna.gba', { reuse: true });
    await emu.waitFrames(30);
    const r1 = await emu.waitFor({ screen: 'changed' }, { maxFrames: 2000, precise });
    const r2 = await emu.waitFor({ screen: 'stable', frames: 20 }, { maxFrames: 2000 });
    await emu.tap('START', 6, 20);
    const r3 = await emu.waitFor({ screen: 'changed' }, { maxFrames: 2000, precise });
    const stats = await emu.stats();
    await emu.close();
    return { r1, r2, r3, stats };
  };
  const fast = await run(false), precise = await run(true);
  ok('screen changed: fast == precise', fast.r1.met && fast.r1.frame === precise.r1.frame, `${fast.r1.frame} vs ${precise.r1.frame}`);
  ok('screen stable: deterministic', fast.r2.met && fast.r2.frame === precise.r2.frame, `${fast.r2.frame} vs ${precise.r2.frame}`);
  ok('changed after input: fast == precise', fast.r3.met && fast.r3.frame === precise.r3.frame, `${fast.r3.frame} vs ${precise.r3.frame}`);
}

// --- Reads on one frame share one state transfer ---
{
  const emu = await EmuHarness.launch('../anguna.gba', { reuse: true });
  await emu.waitFrames(60);
  let calls = 0;
  const orig = emu.page.evaluate.bind(emu.page);
  emu.page.evaluate = (...a) => { calls++; return orig(...a); };
  for (let i = 0; i < 10; i++) await emu.readU32(0x03000000 + i * 4);
  ok('10 reads on one frame = 1 state transfer', calls === 1, `${calls} transfers`);
  await emu.waitFrames(1);
  calls = 0;
  await emu.readU8(0x03000000);
  ok('advancing invalidates the cache', calls === 1);
  emu.page.evaluate = orig;
  await emu.close();
}

// --- A zipped GB ROM boots on the GB core (console read from inside the zip) ---
{
  await mkdir(path.resolve('out'), { recursive: true });
  const zipPath = path.resolve('out', 'input-zipped.zip');
  await writeFile(zipPath, makeZip('input.gb', makeInteractiveGbRom()));
  ok('romSystem looks inside .zip', (await romSystem(zipPath)) === 'gb');
  const emu = await EmuHarness.launch(zipPath, { reuse: true });
  await emu.waitFrames(20);
  ok('zipped GB ROM runs as GB', emu.system === 'gb' && (await emu.videoDimensions()).w === 160);
  ok('zipped GB ROM: RAM reads use the GB map', (await emu.readU8(0xc000)) === 0x0f);
  await emu.close();
}

// --- A missing browser gives an actionable error ---
{
  const saved = process.env.GBTEST_CHROMIUM;
  process.env.GBTEST_CHROMIUM = '/nonexistent/chrome';
  let msg = '';
  try { await EmuHarness.launch('../anguna.gba'); } catch (e) { msg = e.message; }
  if (saved === undefined) delete process.env.GBTEST_CHROMIUM; else process.env.GBTEST_CHROMIUM = saved;
  ok('missing Chromium -> how-to-fix error', /playwright install chromium/.test(msg) && /GBTEST_CHROMIUM/.test(msg), msg.slice(0, 120));
}

await EmuHarness.shutdown();
process.exit(failed ? 1 : 0);
