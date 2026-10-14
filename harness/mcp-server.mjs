#!/usr/bin/env node
// Game Boy (GB/GBC/GBA) test harness as an MCP server.
//
// Exposes the emulator to any MCP host (Claude Code, Claude Desktop, Cursor, ...)
// as tools an AI agent can call to test the GB/GBC/GBA games it builds — no
// third-party emulator program. screenshot returns the frame as an inline image so
// the agent literally sees the game; read_memory reads real RAM out of a save state;
// ram_search finds where a value lives; run_sequence plays a whole script per call.
//
// Run: node mcp-server.mjs   (stdio transport)
// Library/tests: import { createServer } from './mcp-server.mjs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EmuHarness } from './driver.mjs';
import { assertGolden } from './assert.mjs';
import { scalePng, contactSheet } from './png.mjs';
import { RamSearch, SEARCH_OPS, SEARCH_TYPES } from './ramsearch.mjs';
import { runSteps, parseAddress, decodeValues, encodeValue, VALUE_TYPES } from './steps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

const BUTTONS = ['A', 'B', 'L', 'R', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
const Button = z.enum(BUTTONS);
const Address = z.union([z.number().int().nonnegative(), z.string()])
  .describe('Bus address: a number, or a hex string like "0x03000010" / "$C000" (JSON has no hex literals)');
const Scale = z.number().int().min(1).max(4).default(3)
  .describe('Integer upscale (nearest-neighbour). 3 = 720x480 for GBA, 480x432 for GB');

const hex = (n) => '0x' + (n >>> 0).toString(16);
const hexBytes = (buf) => buf.toString('hex').replace(/(..)/g, '$1 ').trim();
const sysName = (s) => (s === 'gb' ? 'GB/GBC' : 'GBA');
const png = (buf) => ({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });

/** Build an MCP server with its own emulator session. Options:
 *  - root: base dir for relative paths (else $GBTEST_ROOT, the client's first
 *    file:// root, or the process cwd)
 *  - fast: default fast-forward setting for load_rom */
export function createServer({ root, fast = true } = {}) {
  // ---- Session (one ROM at a time) ----
  let emu = null;
  let romName = null, romPath = null;
  const states = new Map(); // id -> Buffer (save states)
  let search = null;        // active RamSearch

  const server = new McpServer({ name: 'gb-gbc-gba-test-mcp', version: VERSION });

  // Tool calls touch one shared emulator, and hosts may issue calls in parallel;
  // run them strictly one at a time.
  let queue = Promise.resolve();
  const serial = (fn) => (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };

  // ---- Path resolution ----
  let rootsDir; // undefined = not fetched yet, null = none
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => { rootsDir = undefined; });
  async function baseDir() {
    if (root) return path.resolve(root);
    if (process.env.GBTEST_ROOT) return path.resolve(process.env.GBTEST_ROOT);
    if (rootsDir === undefined) {
      rootsDir = null;
      try {
        if (server.server.getClientCapabilities()?.roots) {
          const { roots } = await server.server.listRoots();
          const r = roots.find((x) => x.uri.startsWith('file://'));
          if (r) rootsDir = fileURLToPath(r.uri);
        }
      } catch { /* client didn't answer; fall back to cwd */ }
    }
    return rootsDir || process.cwd();
  }
  const resolvePath = async (p) => (path.isAbsolute(p) ? p : path.resolve(await baseDir(), p));

  // ---- Helpers ----
  function requireRom() {
    if (!emu) throw new Error('No ROM loaded. Call load_rom first.');
  }
  const result = (text, structured, extra = []) => ({
    content: [{ type: 'text', text }, ...extra],
    ...(structured ? { structuredContent: structured } : {}),
  });
  const errText = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

  /** Register a tool whose handler runs serialized and turns throws into tool errors. */
  function tool(name, config, handler, { needsRom = true } = {}) {
    server.registerTool(name, config, serial(async (args, extra) => {
      try {
        if (needsRom) requireRom();
        return await handler(args ?? {}, extra);
      } catch (e) {
        return errText(`${name} failed: ${e.message}`);
      }
    }));
  }

  const RO = { readOnlyHint: true, openWorldHint: false };
  const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const FrameOut = { frame: z.number().int() };

  // ---- Tools ----
  tool('load_rom', {
    title: 'Load ROM',
    description: 'Boot a GBA/GB/GBC ROM (.gba/.gb/.gbc/.zip) in the headless emulator, replacing any current ROM (saved states and RAM searches are cleared). The system is auto-detected from the extension. Relative paths resolve against the workspace root. The emulator is paused between calls and only runs inside waits, so every read is frame-exact.',
    inputSchema: {
      rom: z.string().describe('Path to the ROM file'),
      fast: z.boolean().default(fast).describe('Fast-forward long waits (results are bit-identical to real-time)'),
    },
    outputSchema: { rom: z.string(), system: z.string(), width: z.number(), height: z.number(), frame: z.number() },
    annotations: ACT,
  }, async ({ rom, fast: ff }) => {
    if (emu) { await emu.close().catch(() => {}); emu = null; }
    states.clear(); search = null;
    const abs = await resolvePath(rom);
    emu = await EmuHarness.launch(abs, { reuse: true, fast: ff });
    romName = path.basename(abs); romPath = abs;
    const dims = await emu.videoDimensions();
    const frame = await emu.frameNum();
    return result(`Loaded ${romName} (${abs}) as ${sysName(emu.system)}. Video ${dims.w}x${dims.h}. Paused at frame ${frame}.`,
      { rom: abs, system: sysName(emu.system), width: dims.w, height: dims.h, frame });
  }, { needsRom: false });

  tool('wait_frames', {
    title: 'Wait frames',
    description: 'Advance the emulator by N emulated frames (deterministic; ~60 frames = 1 second). Held buttons stay held.',
    inputSchema: { frames: z.number().int().positive().describe('Number of emulated frames to advance') },
    outputSchema: FrameOut,
    annotations: ACT,
  }, async ({ frames }) => {
    await emu.waitFrames(frames);
    const frame = await emu.frameNum();
    return result(`Advanced to frame ${frame}.`, { frame });
  });

  const buttonsOf = ({ button, buttons }) => {
    const list = [...(buttons ?? []), ...(button ? [button] : [])];
    if (!list.length) throw new Error('give `button` or `buttons`');
    return [...new Set(list)];
  };

  tool('press', {
    title: 'Press button(s)',
    description: 'Press one button or a combo together (e.g. buttons=["A","B"]): hold for `hold` frames, then release and settle for `release` frames.',
    inputSchema: {
      button: Button.optional(),
      buttons: z.array(Button).optional().describe('Several buttons pressed at the same time'),
      hold: z.number().int().positive().default(4),
      release: z.number().int().nonnegative().default(4),
    },
    outputSchema: FrameOut,
    annotations: ACT,
  }, async (args) => {
    const list = buttonsOf(args);
    await emu.tap(list, args.hold, args.release);
    const frame = await emu.frameNum();
    return result(`Pressed ${list.join('+')} (hold ${args.hold}f). Now at frame ${frame}.`, { frame });
  });

  tool('set_button', {
    title: 'Hold / release button(s)',
    description: 'Hold or release one or more buttons without advancing time (for long holds, combos, precise timing). Follow with wait_frames.',
    inputSchema: { button: Button.optional(), buttons: z.array(Button).optional(), pressed: z.boolean() },
    outputSchema: { held: z.array(z.string()) },
    annotations: ACT,
  }, async (args) => {
    const list = buttonsOf(args);
    await emu.setButtons(list, args.pressed);
    const held = await emu.heldButtons();
    return result(`${list.join('+')} ${args.pressed ? 'held' : 'released'}. Held now: ${held.join(', ') || 'none'}.`, { held });
  });

  tool('screenshot', {
    title: 'Screenshot',
    description: 'Capture the current frame as a PNG (returned inline so you can see it). Upscaled 3x by default so small console frames are legible. Optionally also save the native-resolution PNG.',
    inputSchema: {
      scale: Scale,
      save: z.string().optional().describe('Also write the native-resolution PNG to this path'),
    },
    outputSchema: { frame: z.number(), width: z.number(), height: z.number(), stale: z.boolean(), saved: z.string().optional() },
    annotations: RO,
  }, async ({ scale, save }) => {
    const buf = await emu.screenshot();
    const stale = emu.lastScreenshotStale;
    const d = await emu.videoDimensions();
    const frame = await emu.frameNum();
    let saved;
    if (save) {
      saved = await resolvePath(save);
      await mkdir(path.dirname(saved), { recursive: true });
      await writeFile(saved, buf);
    }
    const warn = stale ? ' NOTE: this state was loaded from a file made outside this session, so its picture is unknown — this is the last frame rendered before the load; wait_frames 1 to see the real screen.' : '';
    return result(`Frame ${frame} of ${romName} (${d.w}x${d.h}, shown at ${scale}x)${saved ? `; saved ${saved}` : ''}.${warn}`,
      { frame, width: d.w, height: d.h, stale, ...(saved ? { saved } : {}) }, [png(scalePng(buf, scale))]);
  });

  tool('read_memory', {
    title: 'Read RAM',
    description: 'Read RAM at a bus address on the current frame. GBA: 0x02000000 (EWRAM), 0x03000000 (IWRAM), 0x04000000 (IO). GB/GBC: 0xC000 (WRAM), 0xFF80 (HRAM), 0xFE00 (OAM), 0xFF00 (IO), 0xA000 (cart RAM). With a typed `as`, returns every value in the range (length bytes / width).',
    inputSchema: {
      address: Address,
      length: z.number().int().positive().max(4096).default(4).describe('Bytes to read'),
      as: z.enum(['hex', ...Object.keys(VALUE_TYPES)]).default('hex').describe('Interpretation (little-endian)'),
    },
    outputSchema: { address: z.number(), hex: z.string(), values: z.array(z.number()).optional() },
    annotations: RO,
  }, async ({ address, length, as }) => {
    const addr = parseAddress(address);
    if (as !== 'hex') length = Math.max(length - (length % VALUE_TYPES[as][0]), VALUE_TYPES[as][0]);
    const buf = await emu.readMemory(addr, length);
    const h = hexBytes(buf);
    if (as === 'hex') return result(`@${hex(addr)} [${length}B]: ${h}`, { address: addr, hex: h });
    const values = decodeValues(buf, as);
    const shown = values.length === 1 ? `${values[0]} (${hex(values[0])})` : `[${values.join(', ')}]`;
    return result(`@${hex(addr)} ${as}=${shown} raw: ${h}`, { address: addr, hex: h, values });
  });

  tool('write_memory', {
    title: 'Write RAM',
    description: 'Write RAM at a bus address on the current frame to SET UP state (e.g. HP=1) without playing to it. Give `value`+`as`, or raw `hex` bytes. The game may overwrite values it recomputes every frame; the result says whether the value is in RAM after the write.',
    inputSchema: {
      address: Address,
      value: z.number().int().optional().describe('Integer value to write (used with `as`)'),
      as: z.enum(['u8', 'u16', 'u32']).default('u8').describe('Width (little-endian) for `value`'),
      hex: z.string().optional().describe('Alternative: raw bytes as hex, e.g. "deadbeef" (overrides value)'),
    },
    outputSchema: { address: z.number(), written: z.string(), readBack: z.string(), stuck: z.boolean() },
    annotations: ACT,
  }, async ({ address, value, as, hex: hx }) => {
    const addr = parseAddress(address);
    let bytes;
    if (hx != null) {
      const clean = hx.replace(/[^0-9a-fA-F]/g, '');
      if (clean.length === 0 || clean.length % 2) return errText('hex must be an even number of hex digits');
      bytes = Buffer.from(clean, 'hex');
    } else if (value != null) {
      bytes = encodeValue(value, as);
    } else {
      return errText('provide `value` (with `as`) or `hex`');
    }
    const stuck = await emu.writeMemory(addr, bytes);
    const back = await emu.readMemory(addr, bytes.length);
    const text = `Wrote ${bytes.length}B @${hex(addr)}; read back: ${hexBytes(back)}` +
      (stuck ? '' : ' — WARNING: the value did not stick (not RAM-backed, or the game overwrote it).');
    return result(text, { address: addr, written: hexBytes(bytes), readBack: hexBytes(back), stuck });
  });

  tool('save_state', {
    title: 'Save state',
    description: 'Snapshot the full machine under a name you can restore later. With `path`, also write it to disk so it survives load_rom / server restarts (reload with load_state path=...).',
    inputSchema: {
      id: z.string().default('default'),
      path: z.string().optional().describe('Also save the state to this file'),
    },
    outputSchema: { id: z.string(), bytes: z.number(), frame: z.number(), path: z.string().optional() },
    annotations: ACT,
  }, async ({ id, path: p }) => {
    const st = await emu.saveState();
    states.set(id, st);
    let file;
    if (p) {
      file = await resolvePath(p);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, st);
    }
    const frame = await emu.frameNum();
    return result(`Saved state "${id}" (${st.length} bytes) at frame ${frame}${file ? ` -> ${file}` : ''}.`,
      { id, bytes: st.length, frame, ...(file ? { path: file } : {}) });
  });

  tool('load_state', {
    title: 'Load state',
    description: 'Restore a saved state by name, or from a file written by save_state (`path`). The state must come from the same ROM/console.',
    inputSchema: {
      id: z.string().default('default'),
      path: z.string().optional().describe('Load from this file instead of a named in-memory state'),
    },
    outputSchema: FrameOut,
    annotations: ACT,
  }, async ({ id, path: p }) => {
    let st;
    if (p) {
      st = await readFile(await resolvePath(p));
      states.set(id, st);
    } else {
      st = states.get(id);
      if (!st) return errText(`No saved state "${id}". Saved: ${[...states.keys()].join(', ') || 'none'}.`);
    }
    await emu.loadState(st);
    const frame = await emu.frameNum();
    return result(`Restored state ${p ? `from ${p}` : `"${id}"`}. Frame ${frame}.`, { frame });
  });

  tool('assert_golden', {
    title: 'Assert golden frame',
    description: 'Compare the current frame to a stored golden PNG (created on first call). Fails if more than `threshold` of pixels differ. On failure, returns the current frame, the golden and a red-highlighted diff inline.',
    inputSchema: {
      golden: z.string().describe('Path to the golden PNG (created if missing)'),
      threshold: z.number().min(0).max(1).default(0.02).describe('Max fraction of differing pixels'),
      tolerance: z.number().int().min(0).max(255).default(16).describe('Per-channel delta that counts as different'),
      scale: Scale.default(2),
    },
    outputSchema: { pass: z.boolean(), created: z.boolean(), fraction: z.number(), golden: z.string(), diff: z.string().optional() },
    annotations: ACT,
  }, async ({ golden, threshold, tolerance, scale }) => {
    const shot = await emu.screenshot();
    const res = await assertGolden(shot, await resolvePath(golden), { threshold, tolerance });
    const out = { pass: res.pass, created: !!res.created, fraction: res.fraction ?? 0, golden: res.goldenPath, ...(res.diffPath ? { diff: res.diffPath } : {}) };
    if (res.created) return result(`Golden created at ${res.goldenPath} (baseline saved). Check it looks right:`, out, [png(scalePng(shot, scale))]);
    const pct = (res.fraction * 100).toFixed(2);
    if (res.pass) return result(`PASS: ${pct}% pixels differ (<= ${threshold * 100}%).`, out);
    const why = res.mismatchDimensions ? 'frame size differs from the golden' : `${pct}% pixels differ (> ${threshold * 100}%)`;
    const images = [{ type: 'text', text: 'Current frame:' }, png(scalePng(shot, scale)),
      { type: 'text', text: 'Golden:' }, png(scalePng(await readFile(res.goldenPath), scale))];
    if (res.diffPng) images.push({ type: 'text', text: 'Diff (red = different):' }, png(scalePng(res.diffPng, scale)));
    return { ...result(`FAIL: ${why}.${res.diffPath ? ` Diff image: ${res.diffPath}` : ''}`, out, images), isError: true };
  });

  tool('run_sequence', {
    title: 'Run input sequence',
    description: `Run a whole script of steps in ONE call (instead of many press/wait/screenshot calls) and get back a timeline plus the screenshots it took. Steps (one action key each):
{"wait":60} | {"tap":"A"} or {"tap":["A","B"],"hold":4,"release":4} | {"press":"RIGHT"} / {"release":"RIGHT"} | {"hold":"RIGHT","frames":30} | {"shot":"name"} | {"record":{"frames":120,"every":20,"prefix":"walk"}} (returned as one contact-sheet image) | {"saveState":"cp"} / {"loadState":"cp"} | {"read":"0x03000010","as":"u16","name":"hp"} | {"write":"0x03000010","value":1,"as":"u8"} | {"assertRam":"0x03000010","as":"u16","equals":3} (or "min"/"max") | {"assert":"goldens/x.png","threshold":0.02}.
States saved here are shared with save_state/load_state.`,
    inputSchema: {
      steps: z.array(z.record(z.string(), z.any())).min(1).describe('Steps to run in order'),
      scale: Scale.default(2),
      outDir: z.string().optional().describe('Also write every screenshot + timeline.json here'),
      maxImages: z.number().int().min(0).max(20).default(8).describe('Max images returned inline (the rest are listed only)'),
    },
    outputSchema: { pass: z.boolean(), failures: z.number(), frame: z.number(), timeline: z.array(z.record(z.string(), z.any())) },
    annotations: ACT,
  }, async ({ steps, scale, outDir, maxImages }) => {
    const out = outDir ? await resolvePath(outDir) : undefined;
    const res = await runSteps(emu, steps, { outDir: out, baseDir: await baseDir(), states });
    const frame = await emu.frameNum();
    if (out) await writeFile(path.join(out, 'timeline.json'), JSON.stringify({ rom: romPath, pass: res.failures === 0, steps: res.timeline }, null, 2));

    const images = [];
    const pushImg = (label, buf) => {
      if (images.length / 2 >= maxImages) return false;
      images.push({ type: 'text', text: label }, png(buf));
      return true;
    };
    let dropped = 0;
    for (const s of res.shots) if (!pushImg(`shot "${s.name}" @ frame ${s.frame}:`, scalePng(s.png, scale))) dropped++;
    for (const r of res.records) {
      // Keep sheets <= ~1600px wide (larger images get downscaled by vision models).
      const cols = Math.min(r.pngs.length, 4), fw = emu.system === 'gb' ? 160 : 240;
      const sheetScale = Math.max(1, Math.min(scale, Math.floor(1600 / (cols * fw))));
      const sheet = contactSheet(r.pngs, { cols, scale: sheetScale });
      if (!pushImg(`record "${r.prefix}": ${r.pngs.length} frames (${r.frames.join(', ')}), left-to-right, top-to-bottom:`, sheet)) dropped++;
    }
    const lines = res.timeline.map((e) => {
      let l = `#${e.i} f${e.frame} ${e.action}`;
      if ('value' in e) l += ` = ${JSON.stringify(e.value)}`;
      if ('stuck' in e && !e.stuck) l += ' (did not stick)';
      if (e.assert) l += e.assert.pass ? ' ✓' : ` ✗ ${JSON.stringify(e.assert)}`;
      return l;
    });
    const summary = `${res.failures ? `FAIL (${res.failures} failed assert${res.failures === 1 ? '' : 's'})` : 'OK'} — ran ${steps.length} steps, now at frame ${frame}.` +
      (dropped ? ` ${dropped} image(s) not shown (maxImages=${maxImages}${out ? `; all saved in ${out}` : ''}).` : '') +
      `\n${lines.join('\n')}`;
    const r = result(summary, { pass: res.failures === 0, failures: res.failures, frame, timeline: res.timeline }, images);
    return res.failures ? { ...r, isError: true } : r;
  });

  // ---- RAM search ----
  const SearchOut = {
    count: z.number(),
    results: z.array(z.object({ address: z.number(), region: z.string(), value: z.number(), previous: z.number().optional(), bank: z.number().optional() })),
  };
  const formatSearch = (limit) => {
    const rows = search.results(limit);
    const lines = rows.map((r) => `  ${hex(r.address)}${r.bank !== undefined ? ` (bank ${r.bank})` : ''} [${r.region}] = ${r.value}${r.previous !== undefined ? ` (was ${r.previous})` : ''}`);
    const more = search.count > rows.length ? `\n  … ${search.count - rows.length} more` : '';
    return { text: `${search.count} candidate${search.count === 1 ? '' : 's'} (${search.type}).${rows.length ? `\n${lines.join('\n')}${more}` : ''}`, data: { count: search.count, results: rows } };
  };

  tool('ram_search_start', {
    title: 'Start RAM search',
    description: `Start a value search ("cheat search") to find where the game stores something (HP, score, coins, x-position…). Snapshots every candidate address on the current frame. Then change the value in game and narrow with ram_search_filter until one address is left. If you already know the current value, pass it as \`value\` to filter immediately. Searches GBA EWRAM+IWRAM, or GB WRAM (all CGB banks)+HRAM+cart RAM.`,
    inputSchema: {
      type: z.enum(SEARCH_TYPES).default('u8').describe('Value width/signedness (little-endian)'),
      region: z.string().optional().describe('Limit to one region: GBA "ewram"/"iwram"; GB "wram"/"hram"/"sram"'),
      value: z.number().int().optional().describe('Known current value: keep only addresses equal to it'),
      limit: z.number().int().min(0).max(100).default(20),
    },
    outputSchema: SearchOut,
    annotations: RO,
  }, async ({ type, region, value, limit }) => {
    search = new RamSearch(emu.system, await emu.readRegions(), { type, region });
    if (value !== undefined) search.filter(await emu.readRegions(), 'eq', value);
    const { text, data } = formatSearch(search.count <= limit ? limit : 0);
    return result(`RAM search started at frame ${await emu.frameNum()}: ${text}${value === undefined ? '\nNow change the value in game, then call ram_search_filter.' : ''}`, data);
  });

  tool('ram_search_filter', {
    title: 'Filter RAM search',
    description: `Narrow the active RAM search using the current frame. Ops: eq/ne/gt/lt/gte/lte compare to \`value\`; changed/unchanged/increased/decreased compare to the previous snapshot; delta keeps addresses whose value changed by exactly \`value\` (e.g. -1 after losing 1 HP). Repeat (changing the value in game between calls) until 1-3 candidates remain, then verify with write_memory.`,
    inputSchema: {
      op: z.enum(SEARCH_OPS),
      value: z.number().int().optional(),
      limit: z.number().int().min(0).max(100).default(20).describe('Candidates to list'),
    },
    outputSchema: SearchOut,
    annotations: RO,
  }, async ({ op, value, limit }) => {
    if (!search) return errText('No active RAM search. Call ram_search_start first.');
    const before = search.count;
    search.filter(await emu.readRegions(), op, value);
    const { text, data } = formatSearch(limit);
    return result(`${op}${value !== undefined ? ` ${value}` : ''}: ${before} -> ${text}`, data);
  });

  tool('ram_search_results', {
    title: 'List RAM search candidates',
    description: 'List the current candidates of the active RAM search with their latest values (without filtering).',
    inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
    outputSchema: SearchOut,
    annotations: RO,
  }, async ({ limit }) => {
    if (!search) return errText('No active RAM search. Call ram_search_start first.');
    const { text, data } = formatSearch(limit);
    return result(text, data);
  });

  // ---- Misc ----
  tool('frame_number', {
    title: 'Frame number',
    description: 'Get the current emulated frame number.',
    inputSchema: {},
    outputSchema: FrameOut,
    annotations: RO,
  }, async () => { const frame = await emu.frameNum(); return result(String(frame), { frame }); });

  tool('reset', {
    title: 'Reset game',
    description: 'Reset the current game (soft restart). Saved states are kept.',
    inputSchema: {},
    annotations: { ...ACT, destructiveHint: true },
  }, async () => {
    await emu.restart();
    await emu.waitFrames(1);
    return result(`Game reset. Frame ${await emu.frameNum()}.`);
  });

  const statusData = async () => (emu
    ? { loaded: true, rom: romPath, system: sysName(emu.system), frame: await emu.frameNum(), states: [...states.keys()], held: await emu.heldButtons(), ramSearch: search ? search.count : null }
    : { loaded: false, states: [] });

  tool('status', {
    title: 'Status',
    description: 'Report the loaded ROM, current frame, held buttons, saved states and any active RAM search.',
    inputSchema: {},
    outputSchema: {
      loaded: z.boolean(), rom: z.string().optional(), system: z.string().optional(), frame: z.number().optional(),
      states: z.array(z.string()), held: z.array(z.string()).optional(), ramSearch: z.number().nullable().optional(),
    },
    annotations: RO,
  }, async () => {
    const s = await statusData();
    if (!s.loaded) return result('No ROM loaded.', s);
    return result(`ROM: ${romName} (${s.system}), frame ${s.frame}, held: ${s.held.join(', ') || 'none'}, ${s.states.length} saved state(s)${s.states.length ? ` [${s.states.join(', ')}]` : ''}${search ? `, RAM search: ${search.count} candidates` : ''}.`, s);
  }, { needsRom: false });

  // ---- Resources ----
  server.registerResource('screen', 'emu://screen', {
    title: 'Current screen', description: 'The current frame as a native-resolution PNG.', mimeType: 'image/png',
  }, serial(async (uri) => {
    requireRom();
    return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: (await emu.screenshot()).toString('base64') }] };
  }));
  server.registerResource('status', 'emu://status', {
    title: 'Emulator status', description: 'Loaded ROM, frame, held buttons and saved states as JSON.', mimeType: 'application/json',
  }, serial(async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await statusData()) }] })));

  // ---- Prompts: reusable workflows that orchestrate the tools above ----
  const userMsg = (t) => ({ messages: [{ role: 'user', content: { type: 'text', text: t } }] });

  server.registerPrompt('smoke_test_rom', {
    title: 'Smoke-test a ROM',
    description: 'Boot a ROM and check it actually runs (renders, does not crash or hang).',
    argsSchema: { rom: z.string().describe('Path to the .gba/.gb/.gbc ROM'), frames: z.string().optional().describe('Frames to run before judging (default 300)') },
  }, ({ rom, frames }) => userMsg(
`Smoke-test the ROM at "${rom}" and tell me if it runs.

1. Call load_rom with rom="${rom}". If it errors, report the error and stop.
2. Call run_sequence with steps [{"wait": ${frames || 300}}, {"shot": "boot"}, {"wait": 60}, {"shot": "later"}].
3. Look at both images. Does it show real game content, or is it black/blank/garbled?
   Do the two frames differ (animation/attract mode), or is it frozen? A static title
   screen can be fine — press START (press tool) and screenshot to check it responds.

Report PASS (it boots, renders and responds) or FAIL (with what you saw).`));

  server.registerPrompt('regression_check', {
    title: 'Visual regression check',
    description: 'Play a scripted sequence and compare frames to saved golden images.',
    argsSchema: { rom: z.string().describe('Path to the ROM'), steps: z.string().describe('Plain-language sequence of inputs and where to check, e.g. "press START, wait 120, then check the title screen"') },
  }, ({ rom, steps }) => userMsg(
`Run a visual regression check on "${rom}".

Sequence to perform: ${steps}

1. load_rom with rom="${rom}".
2. Translate the sequence into ONE run_sequence call: wait/tap/hold steps, plus an
   {"assert": "goldens/<checkpoint>.png", "name": "<checkpoint>"} step at each
   checkpoint. Advance time only with wait steps (never real-time sleeps) so the run
   is deterministic. The FIRST run creates the baselines; later runs compare.
3. Report each checkpoint PASS/FAIL with the percent differing. On FAIL, call
   assert_golden at that point (replay with load_state/run_sequence if needed) to see
   the current/golden/diff images, and describe what changed.

If this is the first run, say that you created the baselines and ask me to confirm they look correct.`));

  server.registerPrompt('find_ram_address', {
    title: 'Find a RAM address',
    description: 'Discover the RAM address of an in-game value (HP, score, coins…) by value search, then verify it.',
    argsSchema: { rom: z.string().describe('Path to the ROM'), variable: z.string().describe('What to find, e.g. "player HP" or "coin count"'), region: z.string().optional().describe('Optional region hint: GBA "iwram"/"ewram", GB "wram"') },
  }, ({ rom, variable, region }) => userMsg(
`Find the RAM address of "${variable}" in "${rom}" using the RAM search tools.

1. load_rom, then play (press / run_sequence) to a point where "${variable}" is in play.
   save_state id="start" so you can retry.
2. ram_search_start${region ? ` with region="${region}"` : ''}. If you can read the value on screen, pass it as
   \`value\` (try type "u8" first; "u16" for values above 255).
3. Change the value in game (take damage, collect a coin…), then ram_search_filter:
   with "eq" + the new value if you can see it, otherwise "decreased"/"increased",
   or "delta" with the exact change. Also filter "unchanged" after doing something
   that does NOT affect the value, to discard noise.
4. Repeat step 3 until 1–3 candidates remain (usually 2–4 rounds).
5. VERIFY: write_memory a distinctive value to the candidate, wait_frames a few, and
   screenshot — the game should reflect it. If not, try the next candidate.

Report the confirmed address, type, and how you verified it.`));

  return {
    server,
    /** Close the emulator (and the shared browser). */
    async close() {
      try { await emu?.close(); } catch {}
      emu = null;
      await EmuHarness.shutdown();
    },
  };
}

// ---- Entry point (stdio) ----
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const { server, close } = createServer();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await close(); process.exit(0); });
  process.stdin.on('close', async () => { await close(); process.exit(0); });
  await server.connect(new StdioServerTransport());
  console.error(`gb-gbc-gba-test-mcp ${VERSION} ready (stdio).`);
}
