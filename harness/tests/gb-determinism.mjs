// Proves, for GB/GBC (gambatte), the two properties a test harness must have:
//   1. Input actually affects the game (button press changes RAM *and* the frame).
//   2. Runs are deterministic (identical scripts -> bit-identical frames).
//
//   node tests/gb-determinism.mjs   (exit 0 = pass, 1 = fail)

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { EmuHarness } from '../driver.mjs';
import { compare } from '../assert.mjs';
import { makeInteractiveGbRom } from './gb-roms.mjs';

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

await mkdir(path.resolve('out'), { recursive: true });
const romPath = path.resolve('out', 'gb-input.gb');
await writeFile(romPath, makeInteractiveGbRom());

// One scripted run: idle snapshot, then hold A, capturing RAM + frames.
async function run() {
  const gba = await EmuHarness.launch(romPath, { timeout: 30000 });
  await gba.waitFrames(60);
  const idleMem = await gba.readU8(0xc000);
  const idleShot = await gba.screenshot();
  await gba.setButton('A', true);
  await gba.waitFrames(30);
  const pressedMem = await gba.readU8(0xc000);
  const pressedShot = await gba.screenshot();
  await gba.setButton('A', false);
  await gba.close();
  return { idleMem, pressedMem, idleShot, pressedShot };
}

const a = await run();
const b = await run();

// 1. Input effect — memory and frame both change when A is held.
ok('GB input changes RAM (0xC000)', a.idleMem === 0x0f && a.pressedMem !== a.idleMem,
  `idle=0x${a.idleMem.toString(16)} pressed=0x${a.pressedMem.toString(16)}`);
const frameDiff = compare(a.idleShot, a.pressedShot).fraction;
ok('GB input changes the frame', frameDiff > 0.5, `${(frameDiff * 100).toFixed(1)}% differ`);

// 2. Determinism — matched checkpoints are bit-identical across runs.
const idleDet = compare(a.idleShot, b.idleShot).fraction;
const pressDet = compare(a.pressedShot, b.pressedShot).fraction;
ok('GB deterministic idle frame', idleDet === 0, `${(idleDet * 100).toFixed(3)}% differ`);
ok('GB deterministic post-input frame', pressDet === 0, `${(pressDet * 100).toFixed(3)}% differ`);
ok('GB deterministic RAM', a.pressedMem === b.pressedMem);

process.exit(failed ? 1 : 0);
