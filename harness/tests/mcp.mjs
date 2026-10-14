// End-to-end test of the MCP layer: drives the real server through the MCP SDK
// client over an in-memory transport and checks tool schemas and responses.
//
//   node tests/mcp.mjs   (exit 0 = pass, 1 = fail)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../mcp-server.mjs';
import { decodePng, encodePng } from '../png.mjs';
import { makeInteractiveGbRom, makeBatteryGbRom, makeVblankGbRom } from './gb-roms.mjs';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(HARNESS, 'out', 'mcp-test');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const gbRom = path.join(OUT, 'input.gb');
await writeFile(gbRom, makeInteractiveGbRom());
const saveRom = path.join(OUT, 'save.gb');
await writeFile(saveRom, makeBatteryGbRom());
const vblankRom = path.join(OUT, 'vblank.gb');
await writeFile(vblankRom, makeVblankGbRom());

// Relative paths resolve against `root` (here: the repo root).
const { server, close } = createServer({ root: path.resolve(HARNESS, '..') });
const client = new Client({ name: 'test', version: '0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

/** @returns {Promise<any>} */
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const images = (r) => r.content.filter((c) => c.type === 'image').map((c) => decodePng(Buffer.from(c.data, 'base64')));
const frameNow = async () => (await call('status')).structuredContent.frame;
// export_script's text ends with the script as one-line JSON.
const scriptOf = (r) => JSON.parse(textOf(r).slice(textOf(r).indexOf('{')));

try {
  // --- Listing ---
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const ALL = ['load_rom', 'wait_frames', 'press', 'set_button', 'wait_until', 'reset', 'screenshot', 'read_memory',
    'read_cpu', 'read_sprites', 'view_vram', 'status', 'write_memory', 'save_state', 'load_state', 'set_cheats',
    'battery_save', 'run_sequence', 'assert_golden', 'export_script', 'ab_compare', 'ram_search'];
  for (const n of ALL) ok(`tool listed: ${n}`, names.includes(n));
  ok('exactly the documented tools', names.length === ALL.length, `${names.length}`);
  ok('screenshot is annotated read-only', tools.find((t) => t.name === 'screenshot').annotations?.readOnlyHint === true);
  const listJson = JSON.stringify(tools);
  ok('tool list is slim (no output schemas, $schema or ±2^53 bounds)',
    !tools.some((t) => t.outputSchema) && !listJson.includes('$schema') && !listJson.includes('9007199254740991'));
  ok('tool list stays small', listJson.length / 4 < 3000, `~${Math.round(listJson.length / 4)} tokens`);
  const { prompts } = await client.listPrompts();
  ok('prompts listed', ['smoke_test_rom', 'regression_check', 'find_ram_address', 'record_regression_test'].every((p) => prompts.some((x) => x.name === p)));
  const { resources } = await client.listResources();
  ok('resources listed', ['emu://screen', 'emu://status'].every((u) => resources.some((r) => r.uri === u)));

  // --- No ROM yet ---
  const noRom = await call('screenshot');
  ok('tools error cleanly without a ROM', noRom.isError && /load_rom/.test(textOf(noRom)));

  // --- GBA: load (relative path via root), wait, screenshot scaling ---
  let r = await call('load_rom', { rom: 'anguna.gba' });
  ok('load_rom (relative to root)', !r.isError && r.structuredContent.system === 'GBA', textOf(r));
  r = await call('wait_frames', { frames: 300 });
  ok('wait_frames lands exactly', r.structuredContent.frame === 300, `frame ${r.structuredContent.frame}`);
  r = await call('screenshot');
  let [img] = images(r);
  ok('screenshot defaults to 2x (480x320)', img && img.width === 480 && img.height === 320, img && `${img.width}x${img.height}`);
  r = await call('screenshot', { scale: 1, save: 'harness/out/mcp-test/native.png' });
  [img] = images(r);
  ok('screenshot scale=1 is native 240x160', img.width === 240 && img.height === 160);
  ok('screenshot save writes a file', existsSync(path.join(OUT, 'native.png')));

  // --- Concurrency: parallel calls are serialized ---
  const [w, f] = await Promise.all([call('wait_frames', { frames: 30 }), call('status')]);
  ok('parallel calls run in order', w.structuredContent.frame === 330 && f.structuredContent.frame === 330,
    `${w.structuredContent.frame} / ${f.structuredContent.frame}`);

  // --- Memory: hex-string addresses, typed arrays, writes ---
  r = await call('read_memory', { address: '0x03000000', length: 8, as: 'u16' });
  ok('read_memory accepts hex strings and returns all values', !r.isError && r.structuredContent.values.length === 4, textOf(r));
  r = await call('read_memory', { address: 'nonsense' });
  ok('bad address is a clean error', r.isError && /invalid address/.test(textOf(r)));
  r = await call('write_memory', { address: '0x02000100', value: 0xbeef, as: 'u16' });
  ok('write_memory sticks', !r.isError && r.structuredContent.stuck === true, textOf(r));
  r = await call('read_memory', { address: 0x02000100, length: 2, as: 'u16' });
  ok('write visible to read_memory', r.structuredContent.values[0] === 0xbeef);

  // --- States on disk ---
  r = await call('save_state', { id: 'cp', path: 'harness/out/mcp-test/cp.state' });
  ok('save_state to file', !r.isError && existsSync(path.join(OUT, 'cp.state')), textOf(r));
  const shotAtCp = (await call('screenshot', { scale: 1 })).content[1].data;
  await call('press', { buttons: ['START', 'A'], hold: 6, release: 30 });
  await call('save_state', {});
  r = await call('load_state', { path: 'harness/out/mcp-test/cp.state' });
  ok('load_state from file', !r.isError, textOf(r));
  ok('loading a file keeps the named "default" state', (await call('status')).structuredContent.states.includes('default'));
  ok('state restore is pixel-exact', (await call('screenshot', { scale: 1 })).content[1].data === shotAtCp);
  ok('repeated screenshots are identical', (await call('screenshot', { scale: 1 })).content[1].data === shotAtCp);
  await call('write_memory', { address: '0x02000104', value: 7 });
  ok('write_memory leaves the picture unchanged', (await call('screenshot', { scale: 1 })).content[1].data === shotAtCp);

  // --- Golden asserts: create, pass, fail with inline images ---
  r = await call('assert_golden', { golden: 'harness/out/mcp-test/golden.png' });
  ok('assert_golden creates baseline', !r.isError && r.structuredContent.created === true);
  r = await call('assert_golden', { golden: 'harness/out/mcp-test/golden.png' });
  ok('assert_golden passes on same frame', !r.isError && r.structuredContent.pass === true, textOf(r));
  await writeFile(path.join(OUT, 'black.png'), encodePng({ width: 240, height: 160, data: new Uint8Array(240 * 160 * 3) }));
  r = await call('assert_golden', { golden: 'harness/out/mcp-test/black.png', threshold: 0 });
  ok('assert_golden fails on mismatch', r.isError && r.structuredContent.pass === false);
  ok('failure returns current + golden + diff images', images(r).length === 3, `${images(r).length} images`);

  // --- run_sequence ---
  r = await call('run_sequence', {
    steps: [
      { wait: 30 }, { shot: 'a' }, { tap: ['START'] },
      { record: { frames: 40, every: 10, prefix: 'rec' } },
      { read: '0x02000100', as: 'u16', name: 'poked' },
      { assertRam: '0x02000100', as: 'u16', equals: 0xbeef },
      { saveState: 'seq' },
    ],
    outDir: 'harness/out/mcp-test/seq',
  });
  ok('run_sequence passes', !r.isError && r.structuredContent.pass === true, textOf(r).split('\n')[0]);
  ok('run_sequence returns shot + contact sheet', images(r).length === 2, `${images(r).length} images`);
  ok('run_sequence reports read values', /read poked = 48879/.test(textOf(r)), textOf(r));
  ok('run_sequence writes timeline.json', existsSync(path.join(OUT, 'seq', 'timeline.json')));
  r = await call('load_state', { id: 'seq' });
  ok('run_sequence states shared with load_state', !r.isError);
  r = await call('run_sequence', { steps: [{ assertRam: '0x02000100', as: 'u16', equals: 1 }] });
  ok('run_sequence failed assertRam -> isError', r.isError && r.structuredContent.failures === 1);
  r = await call('run_sequence', { steps: [{ bogus: 1 }] });
  ok('run_sequence rejects unknown steps', r.isError && /unknown step/.test(textOf(r)));
  const before = scriptOf(await call('export_script')).steps.length;
  r = await call('run_sequence', { steps: [{ wait: 5 }, { tap: 'A' }, { bogus: 1 }] });
  const afterSteps = scriptOf(await call('export_script')).steps;
  ok('steps before a failing step are still recorded', r.isError && afterSteps.length >= before + 1 && afterSteps.some((s) => s.tap === 'A'), `${before} -> ${afterSteps.length}`);

  // --- Resources ---
  const res = /** @type {any} */ (await client.readResource({ uri: 'emu://status' }));
  ok('emu://status resource', JSON.parse(res.contents[0].text).system === 'GBA');
  const scr = /** @type {any} */ (await client.readResource({ uri: 'emu://screen' }));
  ok('emu://screen resource is a PNG', decodePng(Buffer.from(scr.contents[0].blob, 'base64')).width === 240);

  // --- Golden ignore masks ---
  r = await call('assert_golden', { golden: 'harness/out/mcp-test/black.png', threshold: 0, ignore: [{ x: 0, y: 0, w: 240, h: 160 }] });
  ok('assert_golden ignore mask', !r.isError && r.structuredContent.pass === true, textOf(r));

  // --- Path safety ---
  r = await call('screenshot', { save: '/tmp/gbtest-outside.png' });
  ok('writes outside the workspace are refused', r.isError && /refusing to write/.test(textOf(r)));

  // --- wait_until / CPU / sprites / VRAM / cheats on GBA ---
  r = await call('wait_until', { screen: 'stable', frames: 10, maxFrames: 600 });
  ok('wait_until screen stable', !r.isError && r.structuredContent.met, textOf(r));
  r = await call('read_cpu');
  ok('read_cpu (GBA)', !r.isError && typeof r.structuredContent.pc === 'number' && /pc=[0-9a-f]{8}/.test(textOf(r)), textOf(r).split('\n')[0]);
  r = await call('read_sprites');
  ok('read_sprites returns overlay', !r.isError && images(r).length === 1 && images(r)[0].width === 480, textOf(r).split('\n')[0]);
  r = await call('view_vram', { what: 'tiles', region: 'obj' });
  ok('view_vram GBA obj tiles 256x256 @2x', images(r)[0]?.width === 512 && images(r)[0]?.height === 512);
  r = await call('view_vram', { what: 'palettes' });
  ok('view_vram palettes', !r.isError && images(r).length === 1);
  r = await call('set_cheats', { codes: ['32000100 0042'] });
  await call('wait_frames', { frames: 2 });
  r = await call('read_memory', { address: '0x02000100', length: 1, as: 'u8' });
  ok('GBA CodeBreaker cheat applies', r.structuredContent.values[0] === 0x42, textOf(r));
  await call('set_cheats', { codes: [] });
  r = await call('reset');
  ok('reset restarts the clock at frame 1', /Frame 1\./.test(textOf(r)), textOf(r));

  // --- export_script: record a session, replay it, same final frame ---
  await call('load_rom', { rom: 'anguna.gba' });
  await call('wait_frames', { frames: 200 });
  await call('press', { button: 'START', hold: 6, release: 20 });
  await call('set_button', { button: 'RIGHT', pressed: true });
  await call('wait_until', { screen: 'changed', maxFrames: 300 });
  await call('wait_frames', { frames: 40 });
  await call('set_button', { button: 'RIGHT', pressed: false });
  await call('write_memory', { address: '0x02000200', value: 9 });
  await call('wait_frames', { frames: 20 });
  const endShot = (await call('screenshot', { scale: 1 })).content[1].data;
  const endFrame = await frameNow();
  r = await call('export_script', { path: 'harness/out/mcp-test/session.json' });
  const script = scriptOf(r);
  ok('export_script writes a script', !r.isError && existsSync(path.join(OUT, 'session.json')) && script.steps.length >= 6, `${script.steps.length} steps`);
  await call('load_rom', { rom: 'anguna.gba' });
  r = await call('run_sequence', { steps: script.steps });
  ok('exported script replays', !r.isError, textOf(r).split('\n')[0]);
  ok('replay ends on the same frame', r.structuredContent.frame === endFrame, `${r.structuredContent.frame} vs ${endFrame}`);
  ok('replay ends on the same picture', (await call('screenshot', { scale: 1 })).content[1].data === endShot);

  // --- A state file from a fresh session: picture unknown -> flagged stale ---
  await call('load_rom', { rom: 'anguna.gba' });
  await call('wait_frames', { frames: 10 });
  r = await call('load_state', { path: 'harness/out/mcp-test/cp.state' });
  r = await call('screenshot', { scale: 1 });
  ok('screenshot after external state load is flagged stale', r.structuredContent.stale === true && /wait_frames 1/.test(textOf(r)));
  await call('wait_frames', { frames: 1 });
  r = await call('screenshot', { scale: 1 });
  ok('stale flag clears after a frame', r.structuredContent.stale === false);

  // --- GB: switch ROM (shared browser), RAM search finds the joypad byte ---
  const t0 = Date.now();
  r = await call('load_rom', { rom: gbRom });
  ok('load_rom switches to GB', !r.isError && r.structuredContent.system === 'GB/GBC', `${Date.now() - t0}ms`);
  await call('wait_frames', { frames: 30 });
  r = await call('ram_search', { action: 'start', value: 0x0f, region: 'wram' });
  ok('ram_search start with value narrows immediately', !r.isError && r.structuredContent.count > 0, textOf(r).split('\n')[0]);
  await call('set_button', { button: 'A', pressed: true });
  await call('wait_frames', { frames: 5 });
  r = await call('ram_search', { action: 'filter', op: 'decreased' });
  ok('filter decreased', !r.isError, textOf(r).split('\n')[0]);
  r = await call('ram_search', { action: 'filter', op: 'eq', value: 0x0e });
  ok('RAM search finds 0xC000', r.structuredContent.count === 1 && /\n0xc000 wram =14/.test(textOf(r)), textOf(r));
  r = await call('ram_search', { action: 'list' });
  ok('ram_search list', /0xc000/.test(textOf(r)));
  r = await call('ram_search', { action: 'filter' });
  ok('ram_search filter without op errors', r.isError);
  await call('set_button', { button: 'A', pressed: false });
  await call('wait_frames', { frames: 5 });
  r = await call('ram_search', { action: 'filter', op: 'delta', value: 1 });
  ok('delta filter keeps it', r.structuredContent.count === 1);
  r = await call('status');
  ok('status reports search + system', r.structuredContent.system === 'GB/GBC' && r.structuredContent.ramSearch === 1, textOf(r));
  r = await call('wait_until', { address: '0xC000', op: 'eq', value: 0x0f, maxFrames: 60 });
  ok('wait_until already true returns at once', r.structuredContent.met && r.structuredContent.waited === 0, textOf(r));
  const f0 = await frameNow();
  await call('set_button', { button: 'B', pressed: true });
  r = await call('wait_until', { address: '0xC000', op: 'changed', maxFrames: 60 });
  ok('wait_until stops on the first frame', r.structuredContent.met && r.structuredContent.frame === f0 + 1, textOf(r));
  await call('set_button', { button: 'B', pressed: false });
  r = await call('read_cpu');
  ok('read_cpu (GB) pc in the ROM loop', r.structuredContent.pc >= 0x150 && r.structuredContent.pc < 0x180, textOf(r));
  // Clear OAM (it powers on random, like real hardware), put one sprite in it and
  // turn sprites on: read_sprites must find exactly that one.
  await call('write_memory', { address: '0xFE00', hex: '50500100' + '00'.repeat(156) });
  await call('write_memory', { address: '0xFF40', value: 0x93 });
  r = await call('read_sprites', { overlay: false });
  ok('read_sprites (GB) finds the poked sprite', r.structuredContent.onScreen === 1 && /\n#0 72,64 8x8 t1 p0$/.test(textOf(r)), textOf(r));
  r = await call('view_vram');
  ok('view_vram GB tiles 128x192 @2x', images(r)[0]?.width === 256 && images(r)[0]?.height === 384);
  r = await call('battery_save', { action: 'export', path: 'harness/out/mcp-test/none.sav' });
  ok('battery_save export errors when the game has no battery', r.isError && /no battery save/.test(textOf(r)));

  // --- Battery saves ---
  await call('load_rom', { rom: saveRom });
  await call('wait_frames', { frames: 10 });
  const sav = Buffer.alloc(8192); sav[0] = 0x42;
  await writeFile(path.join(OUT, 'in.sav'), sav);
  r = await call('battery_save', { action: 'import', path: 'harness/out/mcp-test/in.sav' });
  ok('battery_save import resets the game', !r.isError && r.structuredContent.frame === 1, textOf(r));
  r = await call('read_memory', { address: '0xC000', length: 1, as: 'u8' });
  ok('game booted with the imported save', r.structuredContent.values[0] === 0x42, textOf(r));
  r = await call('battery_save', { action: 'export', path: 'harness/out/mcp-test/out.sav' });
  const outSav = await readFile(path.join(OUT, 'out.sav'));
  ok('battery_save export has what the game wrote', !r.isError && outSav.length === 8192 && outSav[1] === 0x43, `A001=${outSav[1]}`);
  r = await call('reset');
  r = await call('read_memory', { address: '0xC000', length: 1, as: 'u8' });
  ok('reset keeps the battery save', r.structuredContent.values[0] === 0x42);

  // --- GB GameShark (applied at VBlank) ---
  await call('load_rom', { rom: vblankRom });
  await call('wait_frames', { frames: 10 });
  await call('set_cheats', { codes: ['01AAD0C0'] });
  await call('wait_frames', { frames: 3 });
  r = await call('read_memory', { address: '0xC0D0', length: 1, as: 'u8' });
  ok('GB GameShark cheat applies', r.structuredContent.values[0] === 0xaa, textOf(r));
  r = await call('status');
  ok('status counts cheats', r.structuredContent.cheats === 1);

  // --- A/B compare ---
  const steps = [{ wait: 20 }, { shot: 'a' }, { read: '0xC000' }];
  r = await call('ab_compare', { romA: gbRom, romB: gbRom, steps });
  ok('ab_compare: same ROM is identical', !r.isError && r.structuredContent.identical === true, textOf(r).split('\n')[0]);
  r = await call('ab_compare', { romA: gbRom, romB: saveRom, steps });
  ok('ab_compare: different ROMs differ', !r.isError && r.structuredContent.identical === false, textOf(r));
  r = await call('status');
  ok('ab_compare leaves the session alone', r.structuredContent.rom === vblankRom);
} finally {
  await client.close();
  await close();
}

// --- GBTEST_TOOLS subsets ---
for (const [spec, expect] of /** @type {Array<[string, number]>} */ ([['core', 11], ['core,ram_search', 12], ['screenshot,status', 2]])) {
  const sub = createServer({ tools: spec });
  const c = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([sub.server.connect(b), c.connect(a)]);
  const n = (await c.listTools()).tools.length;
  ok(`tools="${spec}" exposes ${expect} tools`, n === expect, `${n}`);
  await c.close();
}

process.exit(failed ? 1 : 0);
