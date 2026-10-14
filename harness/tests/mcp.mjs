// End-to-end test of the MCP layer: drives the real server through the MCP SDK
// client over an in-memory transport and checks tool schemas and responses.
//
//   node tests/mcp.mjs   (exit 0 = pass, 1 = fail)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../mcp-server.mjs';
import { decodePng, encodePng } from '../png.mjs';
import { makeInteractiveGbRom } from './gb-roms.mjs';

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

// Relative paths resolve against `root` (here: the repo root).
const { server, close } = createServer({ root: path.resolve(HARNESS, '..') });
const client = new Client({ name: 'test', version: '0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const images = (r) => r.content.filter((c) => c.type === 'image').map((c) => decodePng(Buffer.from(c.data, 'base64')));

try {
  // --- Listing ---
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['load_rom', 'wait_frames', 'press', 'set_button', 'screenshot', 'read_memory', 'write_memory',
    'save_state', 'load_state', 'assert_golden', 'run_sequence', 'ram_search_start', 'ram_search_filter',
    'ram_search_results', 'frame_number', 'reset', 'status']) ok(`tool listed: ${n}`, names.includes(n));
  ok('screenshot is annotated read-only', tools.find((t) => t.name === 'screenshot').annotations?.readOnlyHint === true);
  ok('read_memory has an output schema', !!tools.find((t) => t.name === 'read_memory').outputSchema);
  const { prompts } = await client.listPrompts();
  ok('prompts listed', ['smoke_test_rom', 'regression_check', 'find_ram_address'].every((p) => prompts.some((x) => x.name === p)));
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
  ok('screenshot defaults to 3x (720x480)', img && img.width === 720 && img.height === 480, img && `${img.width}x${img.height}`);
  r = await call('screenshot', { scale: 1, save: 'harness/out/mcp-test/native.png' });
  [img] = images(r);
  ok('screenshot scale=1 is native 240x160', img.width === 240 && img.height === 160);
  ok('screenshot save writes a file', existsSync(path.join(OUT, 'native.png')));

  // --- Concurrency: parallel calls are serialized ---
  const [w, f] = await Promise.all([call('wait_frames', { frames: 30 }), call('frame_number')]);
  ok('parallel calls run in order', w.structuredContent.frame === 330 && f.structuredContent.frame === 330,
    `${w.structuredContent.frame} / ${f.structuredContent.frame}`);

  // --- Memory: hex-string addresses, typed arrays, writes ---
  r = await call('read_memory', { address: '0x03000000', length: 8, as: 'u16' });
  ok('read_memory accepts hex strings and returns all values', !r.isError && r.structuredContent.values.length === 4, textOf(r));
  r = await call('read_memory', { address: 'nonsense' });
  ok('bad address is a clean error', r.isError && /invalid address/.test(textOf(r)));
  r = await call('write_memory', { address: '0x02000100', value: 0xbeef, as: 'u16' });
  ok('write_memory sticks', !r.isError && r.structuredContent.stuck === true && r.structuredContent.readBack === 'ef be', textOf(r));
  r = await call('read_memory', { address: 0x02000100, length: 2, as: 'u16' });
  ok('write visible to read_memory', r.structuredContent.values[0] === 0xbeef);

  // --- States on disk ---
  r = await call('save_state', { id: 'cp', path: 'harness/out/mcp-test/cp.state' });
  ok('save_state to file', !r.isError && existsSync(path.join(OUT, 'cp.state')), textOf(r));
  const shotAtCp = (await call('screenshot', { scale: 1 })).content[1].data;
  await call('press', { buttons: ['START', 'A'], hold: 6, release: 30 });
  r = await call('load_state', { path: 'harness/out/mcp-test/cp.state' });
  ok('load_state from file', !r.isError, textOf(r));
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
  ok('run_sequence records read values', r.structuredContent.timeline.find((e) => e.action === 'read poked')?.value === 0xbeef);
  ok('run_sequence writes timeline.json', existsSync(path.join(OUT, 'seq', 'timeline.json')));
  r = await call('load_state', { id: 'seq' });
  ok('run_sequence states shared with load_state', !r.isError);
  r = await call('run_sequence', { steps: [{ assertRam: '0x02000100', as: 'u16', equals: 1 }] });
  ok('run_sequence failed assertRam -> isError', r.isError && r.structuredContent.failures === 1);
  r = await call('run_sequence', { steps: [{ bogus: 1 }] });
  ok('run_sequence rejects unknown steps', r.isError && /unknown step/.test(textOf(r)));

  // --- Resources ---
  const res = await client.readResource({ uri: 'emu://status' });
  ok('emu://status resource', JSON.parse(res.contents[0].text).system === 'GBA');
  const scr = await client.readResource({ uri: 'emu://screen' });
  ok('emu://screen resource is a PNG', decodePng(Buffer.from(scr.contents[0].blob, 'base64')).width === 240);

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
  r = await call('ram_search_start', { value: 0x0f, region: 'wram' });
  ok('ram_search_start with value narrows immediately', !r.isError && r.structuredContent.count > 0, textOf(r).split('\n')[0]);
  await call('set_button', { button: 'A', pressed: true });
  await call('wait_frames', { frames: 5 });
  r = await call('ram_search_filter', { op: 'decreased' });
  ok('filter decreased', !r.isError, textOf(r).split('\n')[0]);
  r = await call('ram_search_filter', { op: 'eq', value: 0x0e });
  const hits = r.structuredContent.results.map((x) => x.address);
  ok('RAM search finds 0xC000', r.structuredContent.count === 1 && hits[0] === 0xc000, textOf(r));
  await call('set_button', { button: 'A', pressed: false });
  await call('wait_frames', { frames: 5 });
  r = await call('ram_search_filter', { op: 'delta', value: 1 });
  ok('delta filter keeps it', r.structuredContent.count === 1);
  r = await call('status');
  ok('status reports search + system', r.structuredContent.system === 'GB/GBC' && r.structuredContent.ramSearch === 1, textOf(r));
  r = await call('reset');
  ok('reset', !r.isError, textOf(r));
} finally {
  await client.close();
  await close();
}

process.exit(failed ? 1 : 0);
