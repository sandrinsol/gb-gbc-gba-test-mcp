// Input-script runner: drive a ROM through a list of steps and dump a screenshot
// timeline the AI can read back. Steps are plain JSON so an AI can author them.
//
//   node runner.mjs <script.json> [outDir]
//
// Script shape:
//   {
//     "rom": "../anguna.gba",
//     "steps": [
//       { "wait": 240 },
//       { "shot": "title" },
//       { "tap": "START" },
//       { "hold": "RIGHT", "frames": 90 },
//       { "record": { "frames": 300, "every": 30, "prefix": "walk" } },
//       { "assert": "goldens/title.png", "threshold": 0.02, "name": "title" },
//       { "saveState": "checkpoint" },
//       { "loadState": "checkpoint" },
//       { "read": "0x03000010", "as": "u16", "name": "hp" },
//       { "assertRam": "0x03000010", "as": "u16", "equals": 3 }
//     ]
//   }
//
// `rom` is relative to the working directory, `assert` goldens to the script
// file. Full step list: steps.mjs.
//
// Output: <outDir>/NN-*.png screenshots + <outDir>/timeline.json manifest.
// Exit code is nonzero if any `assert`/`assertRam` step fails.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EmuHarness } from './driver.mjs';
import { runSteps } from './steps.mjs';

const scriptPath = process.argv[2];
if (!scriptPath) {
  console.error('Usage: node runner.mjs <script.json> [outDir]');
  process.exit(1);
}
const absScript = path.resolve(process.cwd(), scriptPath);
const script = JSON.parse(await readFile(absScript, 'utf8'));
const outDir = path.resolve(
  process.cwd(),
  process.argv[3] || path.join('out', path.basename(scriptPath).replace(/\.json$/i, ''))
);

// The ROM path is relative to the working directory; golden paths are relative
// to the script file.
const emu = await EmuHarness.launch(script.rom);
let result;
try {
  result = await runSteps(emu, script.steps, { outDir, baseDir: path.dirname(absScript), log: console.log });
} finally {
  await emu.close();
}
const { timeline, failures } = result;
const rel = (p) => path.relative(process.cwd(), p);
for (const e of timeline) if (e.assert?.golden) { e.assert.golden = rel(e.assert.golden); if (e.assert.diff) e.assert.diff = rel(e.assert.diff); }
const shotCount = timeline.reduce((n, e) => n + (e.file ? 1 : 0) + (e.files?.length ?? 0), 0);

await writeFile(
  path.join(outDir, 'timeline.json'),
  JSON.stringify({ rom: script.rom, outDir: rel(outDir), pass: failures === 0, steps: timeline }, null, 2)
);

console.log(`\nTimeline -> ${rel(path.join(outDir, 'timeline.json'))}  (${shotCount} screenshots, ${failures} failed assert${failures === 1 ? '' : 's'})`);
process.exit(failures ? 1 : 0);
