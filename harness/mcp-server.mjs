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
import { assertGolden, compare } from './assert.mjs';
import { scalePng, contactSheet } from './png.mjs';
import { RamSearch, SEARCH_OPS, SEARCH_TYPES } from './ramsearch.mjs';
import { runSteps, parseAddress, decodeValues, encodeValue, VALUE_TYPES } from './steps.mjs';
import { gbaSprites, gbSprites, drawBoxes, gbaPalettes, gbPalettes, palettesPng, gbaTilesPng, gbTilesPng } from './video.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
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
 *  - fast: default fast-forward setting for load_rom
 *  @param {{ root?: string, fast?: boolean }} [opts] */
export function createServer({ root = undefined, fast = true } = {}) {
  // ---- Session (one ROM at a time) ----
  let emu = null;
  let romName = null, romPath = null;
  const states = new Map(); // id -> Buffer (save states)
  let search = null;        // active RamSearch
  let rec = [];             // steps done since load_rom (export_script)
  const record = (step) => { rec.push(step); };

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

  // Files are only written inside the workspace root (or harness/out), so a
  // confused or prompt-injected agent can't overwrite arbitrary files.
  // GBTEST_ALLOW_ANY_PATH=1 lifts this.
  const inside = (abs, dir) => { const rel = path.relative(dir, abs); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  async function writeGuard() {
    const roots = [await baseDir(), OUT_DIR];
    return (abs) => {
      if (process.env.GBTEST_ALLOW_ANY_PATH === '1' || roots.some((d) => inside(abs, d))) return;
      throw new Error(`refusing to write outside the workspace (${roots.join(', ')}): ${abs}. Set GBTEST_ALLOW_ANY_PATH=1 to allow.`);
    };
  }
  const writePath = async (p) => { const abs = await resolvePath(p); (await writeGuard())(abs); return abs; };

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
    states.clear(); search = null; rec = [];
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
    record({ wait: frames });
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
    record({ tap: list.length === 1 ? list[0] : list, hold: args.hold, release: args.release });
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
    record(args.pressed ? { press: list } : { release: list });
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
    record({ shot: `f${frame}` });
    if (save) {
      saved = await writePath(save);
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
    record({ write: hex(addr), hex: bytes.toString('hex') });
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
    record({ saveState: id });
    let file;
    if (p) {
      file = await writePath(p);
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
    record(p ? { loadStateFile: await resolvePath(p) } : { loadState: id });
    const frame = await emu.frameNum();
    return result(`Restored state ${p ? `from ${p}` : `"${id}"`}. Frame ${frame}.`, { frame });
  });

  tool('assert_golden', {
    title: 'Assert golden frame',
    description: 'Compare the current frame to a stored golden PNG (created on first call). Fails if more than `threshold` of pixels differ. `ignore` masks rectangles that legitimately change (clocks, timers). On failure, returns the current frame, the golden and a red-highlighted diff inline.',
    inputSchema: {
      golden: z.string().describe('Path to the golden PNG (created if missing)'),
      threshold: z.number().min(0).max(1).default(0.02).describe('Max fraction of differing pixels'),
      tolerance: z.number().int().min(0).max(255).default(16).describe('Per-channel delta that counts as different'),
      ignore: z.array(z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() })).default([])
        .describe('Rectangles (native pixels) to leave out, e.g. a clock: [{"x":200,"y":0,"w":40,"h":16}]'),
      scale: Scale.default(2),
    },
    outputSchema: { pass: z.boolean(), created: z.boolean(), fraction: z.number(), golden: z.string(), diff: z.string().optional() },
    annotations: ACT,
  }, async ({ golden, threshold, tolerance, ignore, scale }) => {
    const shot = await emu.screenshot();
    const goldenPath = await writePath(golden);
    const res = await assertGolden(shot, goldenPath, { threshold, tolerance, ignore });
    record({ assert: goldenPath, threshold, tolerance, ...(ignore.length ? { ignore } : {}) });
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
{"wait":60} | {"tap":"A"} or {"tap":["A","B"],"hold":4,"release":4} | {"press":"RIGHT"} / {"release":"RIGHT"} | {"hold":"RIGHT","frames":30} | {"waitUntil":{"address":"0xC000","op":"eq","value":3},"maxFrames":600} or {"waitUntil":{"screen":"stable","frames":30}} | {"shot":"name"} | {"record":{"frames":120,"every":20,"prefix":"walk"}} (returned as one contact-sheet image) | {"saveState":"cp"} / {"loadState":"cp"} / {"loadStateFile":"x.state"} | {"read":"0x03000010","as":"u16","name":"hp"} | {"write":"0x03000010","value":1,"as":"u8"} | {"assertRam":"0x03000010","as":"u16","equals":3} (or "min"/"max") | {"assert":"goldens/x.png","threshold":0.02,"ignore":[{"x":0,"y":0,"w":40,"h":8}]} | {"reset":true} | {"cheats":["..."]} | {"importSave":"x.sav"}.
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
    const out = outDir ? await writePath(outDir) : undefined;
    const bd = await baseDir();
    const res = await runSteps(emu, steps, { outDir: out, baseDir: bd, states, checkWrite: await writeGuard() });
    // Record with absolute paths so an exported script replays from anywhere.
    for (const st of steps) {
      const c = { ...st };
      for (const k of ['assert', 'loadStateFile', 'importSave']) if (typeof c[k] === 'string') c[k] = path.resolve(bd, c[k]);
      record(c);
    }
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

  // ---- Waiting on conditions ----
  tool('wait_until', {
    title: 'Wait until',
    description: `Run the game until a condition holds, stopping on the FIRST frame where it does (or after maxFrames). Replaces "wait, read, check" loops. Give either a RAM condition (address + op + value, e.g. wait until HP at 0x03001a4c == 0, or op "changed") or a screen condition: screen "changed" (the picture's video memory differs from now — e.g. a menu opened) or "stable" (unchanged for \`frames\` frames — e.g. a screen transition finished). Fast-forwards while checking, then pins down the exact frame; precise=true checks every frame at 1x (catches conditions that are true for only a few frames).`,
    inputSchema: {
      address: Address.optional(),
      as: z.enum(Object.keys(VALUE_TYPES)).default('u8'),
      op: z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'changed']).default('eq'),
      value: z.number().int().optional(),
      screen: z.enum(['changed', 'stable']).optional(),
      frames: z.number().int().positive().default(30).describe('For screen "stable": how many unchanged frames'),
      maxFrames: z.number().int().positive().max(216000).default(600),
      precise: z.boolean().default(false),
      screenshot: z.boolean().default(false).describe('Return a screenshot of the frame it stopped on'),
      scale: Scale,
    },
    outputSchema: { met: z.boolean(), frame: z.number(), waited: z.number() },
    annotations: ACT,
  }, async ({ address, as, op, value, screen, frames, maxFrames, precise, screenshot, scale }) => {
    let cond;
    if (screen) cond = { screen, frames };
    else if (address !== undefined) cond = { address: parseAddress(address), as, op, value };
    else return errText('give `address` (+ op/value) or `screen`');
    const before = await emu.waitTarget(), f0 = await emu.frameNum();
    const r = await emu.waitFor(cond, { maxFrames, precise });
    record({ wait: r.frame - before });
    const what = screen ? `screen ${screen}${screen === 'stable' ? ` for ${frames} frames` : ''}` : `${hex(cond.address)} ${as} ${op}${op === 'changed' ? '' : ` ${value}`}`;
    const text = r.met ? `Met (${what}) at frame ${r.frame}, after ${r.frame - f0} frames.` : `NOT met (${what}) within ${maxFrames} frames; stopped at frame ${r.frame}.`;
    const extra = screenshot ? [png(scalePng(await emu.screenshot(), scale))] : [];
    return result(text, { met: r.met, frame: r.frame, waited: r.frame - f0 }, extra);
  });

  // ---- CPU / video inspection ----
  tool('read_cpu', {
    title: 'Read CPU registers',
    description: 'CPU registers on the current frame. GBA (ARM7): r0-r12, sp, lr, pc (+ the executing address after prefetch), cpsr mode/Thumb/flags. GB (SM83): pc, sp, a/f/b/c/d/e/h/l, flags, ime, halted. Handy to tell "hung in a loop" (pc stays put across waits) from "running".',
    inputSchema: {},
    outputSchema: { cpu: z.record(z.string(), z.any()) },
    annotations: RO,
  }, async () => {
    const c = await emu.readCpu();
    const h4 = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0'), h2 = (n) => '0x' + n.toString(16).padStart(4, '0'), h1 = (n) => n.toString(16).padStart(2, '0');
    const text = emu.system === 'gba'
      ? `pc=${h4(c.pc)} (executing ${h4(c.executing)}) ${c.thumb ? 'Thumb' : 'ARM'} mode=${c.mode} sp=${h4(c.sp)} lr=${h4(c.lr)} cpsr=${h4(c.cpsr)} [${['n', 'z', 'c', 'v'].filter((k) => c.flags[k]).join('').toUpperCase() || '-'}]${c.irqDisabled ? ' IRQs off' : ''}\n` +
        c.r.map((v, i) => `r${i}=${h4(v)}`).join(' ')
      : `pc=${h2(c.pc)} sp=${h2(c.sp)} af=${h1(c.a)}${h1(c.f)} bc=${h1(c.b)}${h1(c.c)} de=${h1(c.d)}${h1(c.e)} hl=${h1(c.h)}${h1(c.l)} flags=[${['z', 'n', 'h', 'c'].filter((k) => c.flags[k]).join('').toUpperCase() || '-'}] ime=${c.ime ? 1 : 0}${c.halted ? ' HALTED' : ''}`;
    return result(`Frame ${await emu.frameNum()}: ${text}`, { cpu: c });
  });

  tool('read_sprites', {
    title: 'Read sprites (OAM)',
    description: 'Decode the sprite table: position, size, tile, palette, flips and priority of every hardware sprite, and (by default) a screenshot with the on-screen sprites outlined (box colours cycle; the list is in the same order). Use it to find the player/enemies on screen without a RAM search.',
    inputSchema: {
      all: z.boolean().default(false).describe('List all OAM entries, not just the ones on screen'),
      overlay: z.boolean().default(true).describe('Return a screenshot with sprite boxes drawn'),
      scale: Scale,
    },
    outputSchema: { sprites: z.array(z.record(z.string(), z.any())) },
    annotations: RO,
  }, async ({ all, overlay, scale }) => {
    const r = await emu.readRegions();
    const list = emu.system === 'gba' ? gbaSprites(r) : gbSprites(r, { cgb: !!r.isCgbWram });
    const shown = all ? list : list.filter((s) => s.onScreen);
    const visible = list.filter((s) => s.onScreen);
    const lines = shown.map((s) => `#${s.index} x=${s.x} y=${s.y} ${s.w}x${s.h} tile=${s.tile} pal=${s.palette}${s.hflip ? ' hflip' : ''}${s.vflip ? ' vflip' : ''}${s.affine ? ' affine' : ''}${s.onScreen ? '' : ' (off-screen/hidden)'}`);
    const extra = overlay ? [png(drawBoxes(await emu.screenshot(), visible, scale))] : [];
    return result(`${visible.length} sprite(s) on screen (of ${list.length} OAM entries) at frame ${await emu.frameNum()}.${lines.length ? '\n' + lines.join('\n') : ''}`, { sprites: shown }, extra);
  });

  tool('view_vram', {
    title: 'View tiles / palettes',
    description: 'Render video memory as an image: what="tiles" shows the tile graphics (GBA: region "bg" char blocks or "obj" sprite tiles, 4bpp with palette bank `palette`, or bpp8; GB: the 384 tiles of VRAM bank `bank` with BG palette `palette`), what="palettes" shows every palette as colour swatches (BG rows first, then OBJ).',
    inputSchema: {
      what: z.enum(['tiles', 'palettes']).default('tiles'),
      region: z.enum(['bg', 'obj']).default('bg').describe('GBA tiles: background or sprite tiles'),
      palette: z.number().int().min(0).max(15).default(0),
      bpp8: z.boolean().default(false).describe('GBA: decode as 256-colour tiles'),
      bank: z.number().int().min(0).max(1).default(0).describe('GBC: VRAM bank'),
      scale: z.number().int().min(1).max(4).default(2),
    },
    annotations: RO,
  }, async ({ what, region, palette, bpp8, bank, scale }) => {
    const r = await emu.readRegions();
    const cgb = !!r.isCgbWram;
    let img, desc;
    if (what === 'palettes') {
      img = palettesPng(emu.system === 'gba' ? gbaPalettes(r) : gbPalettes(r, { cgb }));
      desc = emu.system === 'gba' ? 'GBA palettes: 16 BG rows then 16 OBJ rows of 16 colours' : (cgb ? 'CGB palettes: 8 BG then 8 OBJ' : 'DMG palettes: BGP, OBP0, OBP1');
    } else if (emu.system === 'gba') {
      img = gbaTilesPng(r, { region, palette, bpp8 });
      desc = `GBA ${region} tiles (${bpp8 ? '8bpp' : `4bpp, palette ${palette}`}), 32 per row, tile 0 top-left`;
    } else {
      if (bank === 1 && r.vram.length < 0x4000) return errText('VRAM bank 1 only exists on GBC');
      img = gbTilesPng(r, { bank, palette, cgb });
      desc = `GB tiles 0x8000-0x97FF bank ${bank}, 16 per row (tile 0 = 0x8000)`;
    }
    return result(`${desc}, frame ${await emu.frameNum()}.`, undefined, [png(scalePng(img, scale))]);
  });

  // ---- Cheats ----
  tool('set_cheats', {
    title: 'Set cheat codes',
    description: 'Replace the active cheat codes (an empty list clears them). GBA: GameShark, Action Replay or CodeBreaker codes (e.g. CodeBreaker 8-bit write "3AAAAAAA 00VV"). GB/GBC: GameShark "01VVLLHH" (writes VV to 0xHHLL; applied at VBlank like the real device) or Game Genie. Cheats apply every frame from the next one, and survive reset.',
    inputSchema: { codes: z.array(z.string()).describe('Cheat codes, one per entry') },
    outputSchema: { cheats: z.array(z.string()) },
    annotations: ACT,
  }, async ({ codes }) => {
    await emu.setCheats(codes);
    record({ cheats: codes });
    return result(codes.length ? `${codes.length} cheat(s) active: ${codes.join(', ')}` : 'Cheats cleared.', { cheats: codes });
  });

  // ---- Battery saves ----
  tool('export_save', {
    title: 'Export battery save',
    description: "Write the cartridge's battery save (the .sav: SRAM/flash/EEPROM) on the current frame to a file, so a test can check what the game saved or keep it as a fixture.",
    inputSchema: { path: z.string().describe('Where to write the .sav') },
    outputSchema: { path: z.string(), bytes: z.number() },
    annotations: ACT,
  }, async ({ path: p }) => {
    const data = await emu.readSaveData();
    if (!data) return errText('This game has no battery save.');
    const file = await writePath(p);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    return result(`Wrote ${data.length}-byte save to ${file}.`, { path: file, bytes: data.length });
  });

  tool('import_save', {
    title: 'Import battery save',
    description: 'Load a .sav file into the cartridge and reset, so the game boots with that save (e.g. start a test from a 100% save). reset=false patches it in without resetting.',
    inputSchema: { path: z.string(), reset: z.boolean().default(true) },
    outputSchema: { bytes: z.number(), frame: z.number() },
    annotations: { ...ACT, destructiveHint: true },
  }, async ({ path: p, reset }) => {
    const file = await resolvePath(p);
    const data = await readFile(file);
    await emu.writeSaveData(data, { reset });
    record({ importSave: file, reset });
    const frame = await emu.frameNum();
    return result(`Imported ${data.length}-byte save from ${file}${reset ? '; game reset' : ''}. Frame ${frame}.`, { bytes: data.length, frame });
  });

  // ---- Recording ----
  tool('export_script', {
    title: 'Export session as a test script',
    description: 'Turn everything done since load_rom (inputs, waits, wait_until results, states, RAM writes, cheats, saves, golden asserts, run_sequence steps) into a replayable step script — the same format run_sequence and runner.mjs take. Exploratory play becomes a regression test: add {"assert": ...} / {"assertRam": ...} steps where it matters. Replays are frame-exact.',
    inputSchema: {
      path: z.string().optional().describe('Also write the script (JSON) here'),
      includeShots: z.boolean().default(false).describe('Keep a {"shot"} step for every screenshot you took'),
    },
    outputSchema: { rom: z.string(), steps: z.array(z.record(z.string(), z.any())) },
    annotations: RO,
  }, async ({ path: p, includeShots }) => {
    const steps = rec.filter((s) => includeShots || !s.shot).map((s) => ({ ...s }));
    // Merge consecutive waits.
    const merged = [];
    for (const s of steps) {
      const last = merged[merged.length - 1];
      if (last && 'wait' in s && 'wait' in last && Object.keys(s).length === 1 && Object.keys(last).length === 1) last.wait += s.wait;
      else merged.push(s);
    }
    const script = { rom: romPath, steps: merged.filter((s) => !('wait' in s) || s.wait > 0) };
    let file;
    if (p) {
      file = await writePath(p);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(script, null, 2) + '\n');
    }
    return result(`${script.steps.length} steps${file ? ` written to ${file}` : ''}. Replay: load_rom + run_sequence(steps), or \`node runner.mjs <file>\`.\n${JSON.stringify(script, null, 1)}`, script);
  });

  // ---- A/B comparison ----
  tool('ab_compare', {
    title: 'Compare two ROM builds',
    description: 'Run the same steps on two ROMs (e.g. the last good build and the new one) side by side in separate emulators and report, per screenshot step and RAM read, whether they differ — with A | B | diff images for the shots that do. Uses the run_sequence step format; put {"shot": "name"} / {"read": ...} steps where you want comparisons. Does not touch the currently loaded ROM.',
    inputSchema: {
      romA: z.string(), romB: z.string(),
      steps: z.array(z.record(z.string(), z.any())).min(1),
      tolerance: z.number().int().min(0).max(255).default(16),
      scale: z.number().int().min(1).max(3).default(2),
      maxImages: z.number().int().min(0).max(10).default(4),
    },
    outputSchema: {
      identical: z.boolean(),
      shots: z.array(z.object({ name: z.string(), frame: z.number(), fraction: z.number() })),
      reads: z.array(z.object({ step: z.number(), a: z.any(), b: z.any(), same: z.boolean() })),
    },
    annotations: RO,
  }, async ({ romA, romB, steps, tolerance, scale, maxImages }) => {
    const [pa, pb] = [await resolvePath(romA), await resolvePath(romB)];
    const base = await baseDir();
    const runOne = async (rom) => {
      const h = await EmuHarness.launch(rom, { reuse: true });
      try { return { system: h.system, ...(await runSteps(h, steps, { baseDir: base, checkWrite: await writeGuard() })) }; } finally { await h.close(); }
    };
    const [A, B] = await Promise.all([runOne(pa), runOne(pb)]);
    if (A.system !== B.system) return errText(`ROMs are for different consoles (${A.system} vs ${B.system}).`);
    const shots = [], images = [];
    A.shots.forEach((sa, i) => {
      const sb = B.shots[i];
      if (!sb) return;
      const c = compare(sa.png, sb.png, { tolerance });
      shots.push({ name: sa.name, frame: sa.frame, fraction: c.fraction });
      if (c.fraction > 0 && images.length / 2 < maxImages) {
        const tiles = [sa.png, sb.png, ...(c.diffPng ? [c.diffPng] : [])];
        images.push({ type: 'text', text: `"${sa.name}" @ frame ${sa.frame}: A | B | diff (${(c.fraction * 100).toFixed(2)}% differ)` },
          png(contactSheet(tiles, { cols: tiles.length, scale })));
      }
    });
    const reads = [];
    A.timeline.forEach((ea, i) => {
      if (!('value' in ea)) return;
      const eb = B.timeline[i];
      reads.push({ step: i, a: ea.value, b: eb?.value, same: JSON.stringify(ea.value) === JSON.stringify(eb?.value) });
    });
    const identical = shots.every((s) => s.fraction === 0) && reads.every((r) => r.same);
    const lines = [
      ...shots.map((s) => `shot "${s.name}" f${s.frame}: ${s.fraction === 0 ? 'identical' : `${(s.fraction * 100).toFixed(2)}% differ`}`),
      ...reads.map((r) => `step #${r.step} read: A=${JSON.stringify(r.a)} B=${JSON.stringify(r.b)}${r.same ? '' : '  <-- differs'}`),
    ];
    return result(`${identical ? 'IDENTICAL' : 'DIFFERENT'}: ${path.basename(pa)} vs ${path.basename(pb)}${A.failures + B.failures ? ` (failed asserts: A ${A.failures}, B ${B.failures})` : ''}\n${lines.join('\n') || '(no shot/read steps to compare)'}`,
      { identical, shots, reads }, images);
  }, { needsRom: false });

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
    description: 'Reset the game like the console\'s reset button: the battery save and cheats are kept, the frame clock restarts at 1. Deterministic. Saved states are kept.',
    inputSchema: {},
    annotations: { ...ACT, destructiveHint: true },
  }, async () => {
    await emu.restart();
    record({ reset: true });
    return result(`Game reset. Frame ${await emu.frameNum()}.`);
  });

  const statusData = async () => (emu
    ? { loaded: true, rom: romPath, system: sysName(emu.system), frame: await emu.frameNum(), states: [...states.keys()], held: await emu.heldButtons(), ramSearch: search ? search.count : null, cheats: emu.cheats, recordedSteps: rec.length }
    : { loaded: false, states: [] });

  tool('status', {
    title: 'Status',
    description: 'Report the loaded ROM, current frame, held buttons, saved states and any active RAM search.',
    inputSchema: {},
    outputSchema: {
      loaded: z.boolean(), rom: z.string().optional(), system: z.string().optional(), frame: z.number().optional(),
      states: z.array(z.string()), held: z.array(z.string()).optional(), ramSearch: z.number().nullable().optional(),
      cheats: z.array(z.string()).optional(), recordedSteps: z.number().optional(),
    },
    annotations: RO,
  }, async () => {
    const s = await statusData();
    if (!s.loaded) return result('No ROM loaded.', s);
    return result(`ROM: ${romName} (${s.system}), frame ${s.frame}, held: ${s.held.join(', ') || 'none'}, ${s.states.length} saved state(s)${s.states.length ? ` [${s.states.join(', ')}]` : ''}${search ? `, RAM search: ${search.count} candidates` : ''}${s.cheats.length ? `, ${s.cheats.length} cheat(s)` : ''}, ${s.recordedSteps} recorded step(s).`, s);
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
  /** @param {string} t */
  const userMsg = (t) => ({ messages: [{ role: /** @type {const} */ ('user'), content: { type: /** @type {const} */ ('text'), text: t } }] });

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

  server.registerPrompt('record_regression_test', {
    title: 'Record a regression test',
    description: 'Play to a point of interest, then turn the session into a replayable test script with checks.',
    argsSchema: { rom: z.string().describe('Path to the ROM'), goal: z.string().describe('What to reach and check, e.g. "beat the first enemy and check the score goes up"'), path: z.string().optional().describe('Where to save the script (default tests/<name>.json)') },
  }, ({ rom, goal, path: p }) => userMsg(
`Record a regression test for "${rom}": ${goal}

1. load_rom with rom="${rom}" (this starts a fresh recording).
2. Play towards the goal with press / set_button / wait_frames. Prefer wait_until
   over guessing wait lengths (e.g. wait_until screen "stable" after a transition,
   or a RAM condition). Use screenshot to see where you are.
3. At each point that matters, add a check: assert_golden for the picture (mask
   clocks/timers with \`ignore\`), or note a RAM address/value for an assertRam step
   (use ram_search_* to find addresses if needed).
4. export_script${p ? ` with path="${p}"` : ''} — then add {"assertRam": ...} steps to the
   exported steps where you noted values.
5. Prove it replays: load_rom again and run_sequence with the exported steps; it
   must pass.

Report the script path, what it checks, and the replay result.`));

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
