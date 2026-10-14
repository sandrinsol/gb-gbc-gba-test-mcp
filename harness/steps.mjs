// Step runner shared by runner.mjs (CLI) and the MCP `run_sequence` tool: drive a
// ROM through plain-JSON steps and collect a timeline + screenshots.
//
// Step types (one action key per step):
//   { "wait": 60 }                                  advance N frames
//   { "tap": "A" } / { "tap": ["A","B"], "hold": 4, "release": 4 }
//   { "press": "RIGHT" } / { "release": "RIGHT" }   hold / let go (string or array)
//   { "hold": "RIGHT", "frames": 30 }               hold for N frames, then release
//   { "shot": "title" }                             named screenshot
//   { "record": { "frames": 120, "every": 20, "prefix": "walk" } }
//   { "saveState": "cp" } / { "loadState": "cp" }   named, in-memory
//   { "read": "0x03000010", "as": "u16", "name": "hp" }   record a RAM value
//   (addresses can be symbol names when the ROM has a symbol file: "wPlayerX")
//   { "write": "0x03000010", "value": 1, "as": "u8" }     set-up poke
//   { "assertRam": "0x03000010", "as": "u16", "equals": 3, "name": "hp" }
//   { "assert": "goldens/title.png", "threshold": 0.02, "name": "title",
//     "ignore": [{ "x": 200, "y": 0, "w": 40, "h": 16 }] }
//   { "assert": "goldens/hero.png", "sprite": 0 }    one sprite's graphics only
//   { "waitUntil": { "address": "0xC000", "op": "eq", "value": 3 }, "maxFrames": 600 }
//   { "waitUntil": { "screen": "stable", "frames": 30 } }
//   { "reset": true }                               reset button (battery save kept)
//   { "cheats": ["01AAD0C0"] }                      replace the active cheat codes
//   { "loadStateFile": "states/boss.state" }        a state saved to disk
//   { "importSave": "saves/100pct.sav" }            load a battery save + reset
//   { "video": { "frames": 120, "path": "clips/walk.gif", "every": 1, "scale": 2 } }
//                                                   record the next N frames to a file
//
// runSteps(..., { video: { path, onlyOnFail, seconds } }) records the whole run
// and keeps the last `seconds` — e.g. a clip of what led up to a failure.

import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { assertGolden } from './assert.mjs';
import { saveVideo } from './recording.mjs';
import { parseAddress } from './symbols.mjs';

export { parseAddress };

export const VALUE_TYPES = { u8: [1, 'readUInt8'], u16: [2, 'readUInt16LE'], u32: [4, 'readUInt32LE'], s8: [1, 'readInt8'], s16: [2, 'readInt16LE'], s32: [4, 'readInt32LE'] };

/** Decode `buf` as consecutive little-endian values of type `as`. */
export function decodeValues(buf, as) {
  const [w, fn] = VALUE_TYPES[as];
  const out = [];
  for (let o = 0; o + w <= buf.length; o += w) out.push(buf[fn](o));
  return out;
}

/** Encode an integer as `as` (u8/u16/u32; signed types share the unsigned layout). */
export function encodeValue(value, as) {
  const w = VALUE_TYPES[as][0];
  const b = Buffer.alloc(w);
  if (w === 1) b.writeUInt8(value & 0xff);
  else if (w === 2) b.writeUInt16LE(value & 0xffff);
  else b.writeUInt32LE(value >>> 0);
  return b;
}

const hex = (n) => '0x' + n.toString(16);
const asList = (b) => (Array.isArray(b) ? b : [b]);

/**
 * Run `steps` against an EmuHarness.
 * @param {import('./driver.mjs').EmuHarness} emu
 * @param {Array<Record<string, any>>} steps
 * @param {object} [opts]
 * @param {string} [opts.outDir]   write screenshots here
 * @param {string} [opts.baseDir]  resolve relative paths (goldens, state/save files) against this
 * @param {Map<string, Buffer>} [opts.states]  named states (shared with the caller)
 * @param {(msg: string) => void} [opts.log]
 * @param {(absPath: string) => void} [opts.checkWrite]  throws to refuse writing there
 * @param {(step: Record<string, any>) => void} [opts.onStep]  called after each step
 *   completes (so a caller can record what actually ran, even if a later step throws)
 * @param {{ path: string, onlyOnFail?: boolean, seconds?: number, every?: number, scale?: number }} [opts.video]
 *   record the run (last `seconds`, default 10) to `path`; with onlyOnFail
 *   (default true) the file is only written when a step fails or throws
 * @returns {Promise<{ timeline: any[], shots: Array<{name: string, frame: number, png: Buffer, file?: string}>,
 *   records: Array<{prefix: string, frames: number[], pngs: Buffer[], files: string[]}>, failures: number, video?: string | null }>}
 */
export async function runSteps(emu, steps, opts = {}) {
  const { video, baseDir = process.cwd(), checkWrite = () => {} } = opts;
  if (!video) return runPlain(emu, steps, opts);
  const file = path.resolve(baseDir, video.path);
  checkWrite(file);
  const every = video.every ?? 1;
  await emu.startRecording({ every, maxFrames: Math.ceil((video.seconds ?? 10) * 60 / every) });
  let res, error;
  try { res = await runPlain(emu, steps, opts); } catch (e) { error = e; }
  const caps = await emu.stopRecording();
  const failed = !!error || res.failures > 0;
  let saved = null;
  if (caps.length && (failed || video.onlyOnFail === false)) {
    saved = (await saveVideo(caps, file, { scale: video.scale ?? 2, every, toJpeg: (p, k) => emu.toJpeg(p, k) })).file;
  }
  if (error) { if (saved) error.message += ` (video: ${saved})`; throw error; }
  return { ...res, video: saved };
}

/** runSteps without whole-run recording. @param {any} emu @param {any} steps @param {any} [opts] */
async function runPlain(emu, steps, { outDir, baseDir = process.cwd(), states = new Map(), log = () => {}, checkWrite = () => {}, onStep = () => {} } = {}) {
  if (!Array.isArray(steps)) throw new Error('steps must be an array');
  if (outDir) { checkWrite(outDir); await mkdir(outDir, { recursive: true }); }
  const timeline = [], shots = [], records = [];
  let seq = 0, failures = 0;

  const snap = async (name) => {
    const png = await emu.screenshot();
    const frame = await emu.frameNum();
    const shot = { name, frame, png };
    if (outDir) {
      shot.file = `${String(seq++).padStart(3, '0')}-${name}.png`;
      await writeFile(path.join(outDir, shot.file), png);
    }
    return shot;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const entry = { i, frame: await emu.frameNum() };
    if ('wait' in step) {
      entry.action = `wait ${step.wait}`;
      await emu.waitFrames(step.wait);
    } else if ('tap' in step) {
      entry.action = `tap ${asList(step.tap).join('+')}`;
      await emu.tap(step.tap, step.hold ?? 4, step.release ?? 4);
    } else if ('press' in step) {
      entry.action = `press ${asList(step.press).join('+')}`;
      await emu.setButtons(asList(step.press), true);
    } else if ('release' in step) {
      entry.action = `release ${asList(step.release).join('+')}`;
      await emu.setButtons(asList(step.release), false);
    } else if ('hold' in step) {
      const frames = step.frames ?? 30;
      entry.action = `hold ${asList(step.hold).join('+')} ${frames}f`;
      await emu.setButtons(asList(step.hold), true);
      await emu.waitFrames(frames);
      await emu.setButtons(asList(step.hold), false);
    } else if ('shot' in step) {
      entry.action = `shot ${step.shot}`;
      const s = await snap(step.shot);
      shots.push(s);
      if (s.file) entry.file = s.file;
    } else if ('record' in step) {
      const { frames = 300, every = 30, prefix = 'frame' } = step.record;
      entry.action = `record ${frames}f/${every}`;
      const rec = { prefix, frames: [], pngs: [], files: [] };
      for (let f = 0; f < frames; f += every) {
        await emu.waitFrames(every);
        const s = await snap(`${prefix}-${await emu.frameNum()}`);
        rec.frames.push(s.frame); rec.pngs.push(s.png);
        if (s.file) rec.files.push(s.file);
      }
      records.push(rec);
      entry.frames = rec.frames;
      if (outDir) entry.files = rec.files;
    } else if ('video' in step) {
      const v = step.video;
      if (!v.path || !v.frames) throw new Error(`step ${i}: video needs "frames" and "path"`);
      if (await emu.recording) throw new Error(`step ${i}: a video step can't run while the whole run is being recorded`);
      const file = path.resolve(baseDir, v.path);
      checkWrite(file);
      const caps = await emu.record(v.frames, { every: v.every ?? 1 });
      const r = await saveVideo(caps, file, { scale: v.scale ?? 2, every: v.every ?? 1, audio: v.audio ?? 'auto', toJpeg: (p, k) => emu.toJpeg(p, k) });
      entry.action = `video ${v.frames}f`;
      entry.file = r.file;
      if (r.audio) entry.audio = r.audio;
    } else if ('saveState' in step) {
      entry.action = `saveState ${step.saveState}`;
      states.set(step.saveState, await emu.saveState());
    } else if ('loadState' in step) {
      entry.action = `loadState ${step.loadState}`;
      const st = states.get(step.loadState);
      if (!st) throw new Error(`step ${i}: no saved state named "${step.loadState}"`);
      await emu.loadState(st);
    } else if ('read' in step) {
      const addr = parseAddress(step.read, emu.symbols), as = step.as ?? 'u8';
      if (!VALUE_TYPES[as]) throw new Error(`step ${i}: bad "as" ${as}`);
      const count = step.count ?? 1;
      const vals = decodeValues(await emu.readMemory(addr, VALUE_TYPES[as][0] * count), as);
      entry.action = `read ${step.name ?? (emu.symbols?.get(String(step.read)) ? step.read : hex(addr))}`;
      entry.value = count === 1 ? vals[0] : vals;
    } else if ('write' in step) {
      const addr = parseAddress(step.write, emu.symbols);
      const bytes = step.hex != null ? Buffer.from(String(step.hex).replace(/[^0-9a-f]/gi, ''), 'hex') : encodeValue(step.value, step.as ?? 'u8');
      entry.action = `write ${hex(addr)}`;
      entry.stuck = await emu.writeMemory(addr, bytes);
    } else if ('assertRam' in step) {
      const addr = parseAddress(step.assertRam, emu.symbols), as = step.as ?? 'u8';
      const [val] = decodeValues(await emu.readMemory(addr, VALUE_TYPES[as][0]), as);
      const name = step.name ?? (emu.symbols?.get(String(step.assertRam)) ? step.assertRam : hex(addr));
      const pass = 'equals' in step ? val === step.equals
        : ('min' in step || 'max' in step) ? val >= (step.min ?? -Infinity) && val <= (step.max ?? Infinity)
          : true;
      entry.action = `assertRam ${name}`;
      entry.assert = { value: val, pass, ...('equals' in step ? { equals: step.equals } : {}), ...('min' in step ? { min: step.min } : {}), ...('max' in step ? { max: step.max } : {}) };
      if (!pass) { failures++; log(`  ✗ assertRam ${name}: ${val}`); } else log(`  ✓ assertRam ${name} = ${val}`);
    } else if ('waitUntil' in step) {
      const c = { ...step.waitUntil };
      if (c.address !== undefined) c.address = parseAddress(c.address, emu.symbols);
      const r = await emu.waitFor(c, { maxFrames: step.maxFrames ?? 600, precise: !!step.precise });
      entry.action = `waitUntil ${JSON.stringify(step.waitUntil)}`;
      entry.met = r.met; entry.metFrame = r.frame;
      if (!r.met && step.required !== false) { failures++; log(`  ✗ waitUntil not met within ${step.maxFrames ?? 600} frames`); }
    } else if ('reset' in step) {
      entry.action = 'reset';
      await emu.restart();
    } else if ('cheats' in step) {
      entry.action = `cheats ${step.cheats.length}`;
      await emu.setCheats(step.cheats);
    } else if ('loadStateFile' in step) {
      entry.action = `loadStateFile ${step.loadStateFile}`;
      await emu.loadState(await readFile(path.resolve(baseDir, step.loadStateFile)));
    } else if ('importSave' in step) {
      entry.action = `importSave ${step.importSave}`;
      await emu.writeSaveData(await readFile(path.resolve(baseDir, step.importSave)), { reset: step.reset !== false });
    } else if ('assert' in step) {
      const name = step.name || path.basename(step.assert).replace(/\.png$/i, '');
      entry.action = `assert ${name}`;
      let s;
      if (step.sprite !== undefined) s = { png: await emu.spriteImage(step.sprite) };
      else { s = await snap(name); if (s.file) entry.file = s.file; }
      const golden = path.resolve(baseDir, step.assert);
      checkWrite(golden);
      const res = await assertGolden(s.png, golden, {
        threshold: step.threshold ?? 0.02, tolerance: step.tolerance ?? 16, ignore: step.ignore ?? [],
      });
      entry.assert = {
        golden: res.goldenPath, created: res.created, pass: res.pass,
        fraction: Number((res.fraction ?? 0).toFixed(4)),
        ...(res.diffPath ? { diff: res.diffPath } : {}),
      };
      if (!res.pass) { failures++; log(`  ✗ assert ${name}: ${(res.fraction * 100).toFixed(2)}% differ (> ${(step.threshold ?? 0.02) * 100}%)`); }
      else log(`  ✓ assert ${name}${res.created ? ' (golden created)' : ''}`);
    } else {
      throw new Error(`step ${i}: unknown step ${JSON.stringify(step)}`);
    }
    timeline.push(entry);
    onStep(step);
  }
  return { timeline, shots, records, failures };
}
