#!/usr/bin/env node
// Game Boy (GB/GBC/GBA) test harness as an MCP server.
//
// Exposes the emulator to any MCP host (Claude Code, Claude Desktop, Cursor, ...)
// as tools an AI agent can call to test the GB/GBC/GBA games it builds — no
// third-party emulator program. Tools, in groups:
//   play     load_rom, wait_frames, press, set_button, wait_until, reset
//   look     screenshot, read_memory, read_cpu, read_sprites, view_vram, status
//   change   write_memory, save_state, load_state, set_cheats, battery_save
//   test     run_sequence, assert_golden, export_script, ab_compare, record_video
//   find     ram_search
//   make     sprite (convert art, inject into the game, overlay, export), background
//   develop  build (compile + reload), describe (screen as text), watch, check
// Addresses can be symbol names when the ROM has a symbol file (.sym/.noi/.elf/.map).
// A gbtest.json in the workspace sets project defaults (build, rom, charmap, watch).
// The machine is paused between calls, so every read lands on an exact frame.
//
// Token budget: every tool definition is resent with each request, so they are
// kept terse and GBTEST_TOOLS can expose a subset (see toolFilter). Results put
// their data in one place, and images default to 2x.
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
import { saveVideo } from './recording.mjs';
import { convertSprite, writeSpriteSource, injectSprite, overlayFrame, framePng, spriteLimitWarnings } from './sprite.mjs';
import { RamSearch, SEARCH_OPS, SEARCH_TYPES } from './ramsearch.mjs';
import { runSteps, decodeValues, encodeValue, VALUE_TYPES } from './steps.mjs';
import { gbaSprites, gbSprites, drawBoxes, gbaPalettes, gbPalettes, palettesPng, gbaTilesPng, gbTilesPng } from './video.mjs';
import { screenText, learnCharmap, normalizeCharmap } from './screentext.mjs';
import { romHeaderIssues, RunChecker } from './checks.mjs';
import { runCommand, parseDiagnostics, formatDiagnostic, detectBuild, findRom, readProjectConfig } from './build.mjs';
import { convertBackground, writeBackgroundSource, renderTiledMap, BG_TARGETS } from './background.mjs';
import { TEMPLATES, createProject } from './templates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

const BUTTONS = ['A', 'B', 'L', 'R', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
const Button = z.enum(BUTTONS);
const Address = z.union([z.number().int().nonnegative(), z.string()]).describe('number, "0x..." or symbol');
const Scale = z.number().int().min(1).max(4).default(2);

/** Tools in the "core" set: enough to play, look, check and script a game. */
export const CORE_TOOLS = ['load_rom', 'wait_frames', 'press', 'set_button', 'wait_until', 'screenshot',
  'read_memory', 'write_memory', 'run_sequence', 'assert_golden', 'status', 'build', 'describe'];

/** Drop JSON-schema detail that costs tokens on every request but rarely helps
 *  a model: the $schema URL, numeric bounds, "type" next to an enum, a record's
 *  default key/value schemas; and write anyOf of plain types as a type list.
 *  Inputs are still fully validated by the zod schemas on the server, whose
 *  error messages state the limits. */
function slimSchema(node) {
  if (Array.isArray(node)) return node.map(slimSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'minimum' || k === 'maximum' || k === 'exclusiveMinimum' || k === 'exclusiveMaximum') continue;
    if (k === 'type' && node.enum) continue;
    if (k === 'propertyNames' && v?.type === 'string' && Object.keys(v).length === 1) continue;
    if (k === 'additionalProperties' && v && typeof v === 'object' && !Object.keys(v).length) continue;
    if (k === 'anyOf' && v.every((x) => Object.keys(x).length === 1 && typeof x.type === 'string')) { out.type = v.map((x) => x.type); continue; }
    out[k] = slimSchema(v);
  }
  return out;
}

/** Which tools to register, from GBTEST_TOOLS (or the `tools` option): unset or
 *  "all" = every tool; otherwise a comma list of tool names and/or "core". */
export function toolFilter(spec) {
  if (!spec || spec.trim() === 'all') return () => true;
  const want = new Set(spec.split(',').map((x) => x.trim()).filter(Boolean).flatMap((x) => (x === 'core' ? CORE_TOOLS : [x])));
  return (name) => want.has(name);
}

const hex = (n) => '0x' + (n >>> 0).toString(16);
const hexBytes = (buf) => buf.toString('hex').replace(/(..)/g, '$1 ').trim();
const sysName = (s) => (s === 'gb' ? 'GB/GBC' : 'GBA');
const png = (buf) => ({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });

/** Build an MCP server with its own emulator session. Options:
 *  - root: base dir for relative paths (else $GBTEST_ROOT, the client's first
 *    file:// root, or the process cwd)
 *  - fast: default fast-forward setting for load_rom
 *  - tools: which tools to expose (else $GBTEST_TOOLS; see toolFilter)
 *  @param {{ root?: string, fast?: boolean, tools?: string }} [opts] */
export function createServer({ root = undefined, fast = true, tools = undefined } = {}) {
  // ---- Session (one ROM at a time) ----
  let emu = null;
  let romName = null, romPath = null;
  const states = new Map(); // id -> Buffer (save states)
  let search = null;        // active RamSearch
  let rec = [];             // steps done since load_rom (export_script)
  const record = (step) => { rec.push(step); };
  let cfg = {};             // gbtest.json of the workspace
  let lastFast = fast;      // load_rom's fast setting, reused by build
  let watches = null;       // [{ label, expr, as }] (null = from gbtest.json)
  let charmap = null;       // describe's charmap (null = from gbtest.json)
  let lastDescribe = null;  // screenshot at the last describe

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
  /** "0xc0a0" or "0xc0a0 (wPlayerX)". */
  const label = (addr) => { const n = emu?.symbols?.nameOf(addr, { maxOffset: 32 }); return n ? `${hex(addr)} (${n})` : hex(addr); };

  /** @param {string} abs @param {{ fast?: boolean, symbols?: string }} [opts] */
  async function loadRom(abs, { fast: ff = lastFast, symbols = undefined } = {}) {
    if (emu) { await emu.close().catch(() => {}); emu = null; }
    states.clear(); search = null; rec = []; lastDescribe = null;
    const bd = await baseDir();
    cfg = await readProjectConfig(bd);
    const sym = symbols ?? (cfg.symbols ? path.resolve(bd, cfg.symbols) : true);
    emu = await EmuHarness.launch(abs, { reuse: true, fast: ff, symbols: sym });
    lastFast = ff;
    romName = path.basename(abs); romPath = abs;
    return emu;
  }
  const symbolInfo = () => (emu.symbols ? `, ${emu.symbols.count} symbols from ${path.basename(emu.symbols.file)}` : emu.symbolsError ? `; symbols not loaded: ${emu.symbolsError}` : '');

  /** Watched variables: "name", "name:u16", "0xC000:s8". */
  const parseWatch = (w) => { const m = /^(.*?)(?::(u8|u16|u32|s8|s16|s32))?$/.exec(String(w).trim()); return { label: m[1], expr: m[1], as: m[2] ?? 'u8' }; };
  const activeWatches = () => watches ?? (Array.isArray(cfg.watch) ? cfg.watch.map(parseWatch) : []);
  async function watchValues() {
    const out = [];
    for (const w of activeWatches()) {
      try { out.push(`${w.label}=${decodeValues(await emu.readMemory(emu.addr(w.expr), VALUE_TYPES[w.as][0]), w.as)[0]}`); } catch { out.push(`${w.label}=?`); }
    }
    return out;
  }
  /** A "watch: a=1 b=2" line to append to results that advance time ('' if none). */
  const watchLine = async () => { const v = emu ? await watchValues() : []; return v.length ? `\nwatch: ${v.join(' ')}` : ''; };
  // Results carry their data ONCE: lists and dumps go in the text (what the model
  // reads); structuredContent holds only small scalar fields for programmatic use.
  const result = (text, structured, extra = []) => ({
    content: [{ type: 'text', text }, ...extra],
    ...(structured ? { structuredContent: structured } : {}),
  });
  const errText = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

  // Which tools to expose (each one's definition is resent with every request).
  const enabled = toolFilter(tools ?? process.env.GBTEST_TOOLS);

  /** Register a tool whose handler runs serialized and turns throws into tool errors. */
  function tool(name, config, handler, { needsRom = true } = {}) {
    if (!enabled(name)) return;
    server.registerTool(name, config, serial(async (args, extra) => {
      try {
        if (needsRom) requireRom();
        return await handler(args ?? {}, extra);
      } catch (e) {
        return errText(`${name} failed: ${e.message}`);
      }
    }));
  }

  const RO = { readOnlyHint: true };
  const buttonsOf = ({ button, buttons }) => {
    const list = [...(buttons ?? []), ...(button ? [button] : [])];
    if (!list.length) throw new Error('give `button` or `buttons`');
    return [...new Set(list)];
  };
  const Rect = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });

  // ---- Play ----
  tool('load_rom', {
    description: 'Boot a .gba/.gb/.gbc (or .zip) ROM, fresh. A symbol file beside it (.sym/.noi/.elf/.map) lets addresses be names. Paused between calls: reads are frame-exact.',
    inputSchema: {
      rom: z.string().optional().describe('default: gbtest.json rom'),
      fast: z.boolean().default(fast).describe('fast-forward long waits (same results)'),
      symbols: z.string().optional().describe('symbol file if not beside the ROM'),
    },
  }, async ({ rom, fast: ff, symbols }) => {
    const bd = await baseDir();
    const want = rom ?? (await readProjectConfig(bd)).rom;
    if (!want) return errText('give `rom` (or set "rom" in gbtest.json)');
    const abs = await resolvePath(want);
    await loadRom(abs, { fast: ff, symbols: symbols ? await resolvePath(symbols) : undefined });
    const dims = await emu.videoDimensions();
    const frame = await emu.frameNum();
    return result(`Loaded ${abs} as ${sysName(emu.system)} ${dims.w}x${dims.h}, frame ${frame}${symbolInfo()}.`,
      { system: sysName(emu.system), frame });
  }, { needsRom: false });

  tool('wait_frames', {
    description: 'Advance N frames (60 = 1 s). Held buttons stay held.',
    inputSchema: { frames: z.number().int().positive() },
  }, async ({ frames }) => {
    await emu.waitFrames(frames);
    record({ wait: frames });
    const frame = await emu.frameNum();
    return result(`Frame ${frame}.${await watchLine()}`, { frame });
  });

  tool('press', {
    description: 'Tap one button or a combo: hold `hold` frames, release, wait `release` frames.',
    inputSchema: {
      button: Button.optional(),
      buttons: z.array(Button).optional(),
      hold: z.number().int().positive().default(4),
      release: z.number().int().nonnegative().default(4),
    },
  }, async (args) => {
    const list = buttonsOf(args);
    await emu.tap(list, args.hold, args.release);
    record({ tap: list.length === 1 ? list[0] : list, hold: args.hold, release: args.release });
    const frame = await emu.frameNum();
    return result(`Pressed ${list.join('+')}. Frame ${frame}.${await watchLine()}`, { frame });
  });

  tool('set_button', {
    description: 'Hold or release button(s) without advancing time.',
    inputSchema: { button: Button.optional(), buttons: z.array(Button).optional(), pressed: z.boolean() },
  }, async (args) => {
    const list = buttonsOf(args);
    await emu.setButtons(list, args.pressed);
    record(args.pressed ? { press: list } : { release: list });
    const held = await emu.heldButtons();
    return result(`Held: ${held.join(', ') || 'none'}.`);
  });

  tool('wait_until', {
    description: 'Run until address op value, or screen changed / stable for `frames`, holds; stops on that first frame. Use instead of wait/read loops.',
    inputSchema: {
      address: Address.optional(),
      as: z.enum(Object.keys(VALUE_TYPES)).default('u8'),
      op: z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'changed']).default('eq'),
      value: z.number().int().optional(),
      screen: z.enum(['changed', 'stable']).optional(),
      frames: z.number().int().positive().default(30),
      maxFrames: z.number().int().positive().max(216000).default(600),
      precise: z.boolean().default(false),
      screenshot: z.boolean().default(false),
      scale: Scale,
    },
  }, async ({ address, as, op, value, screen, frames, maxFrames, precise, screenshot, scale }) => {
    let cond;
    if (screen) cond = { screen, frames };
    else if (address !== undefined) cond = { address: emu.addr(address), as, op, value };
    else return errText('give `address` (+ op/value) or `screen`');
    const before = await emu.waitTarget(), f0 = await emu.frameNum();
    const r = await emu.waitFor(cond, { maxFrames, precise });
    record({ wait: r.frame - before });
    const text = (r.met ? `Met at frame ${r.frame} (+${r.frame - f0}).` : `Not met within ${maxFrames} frames; frame ${r.frame}.`) + await watchLine();
    const extra = screenshot ? [png(scalePng(await emu.screenshot(), scale))] : [];
    return result(text, { met: r.met, frame: r.frame, waited: r.frame - f0 }, extra);
  });

  tool('reset', {
    description: 'Reset button: battery save and cheats kept, frame restarts at 1.',
    inputSchema: {},
  }, async () => {
    await emu.restart();
    record({ reset: true });
    return result(`Reset. Frame ${await emu.frameNum()}.${await watchLine()}`);
  });

  // ---- Look ----
  tool('screenshot', {
    description: 'Current frame as an image. `save` also writes the native PNG.',
    inputSchema: { scale: Scale, save: z.string().optional() },
    annotations: RO,
  }, async ({ scale, save }) => {
    const buf = await emu.screenshot();
    const stale = emu.lastScreenshotStale;
    const frame = await emu.frameNum();
    let saved;
    if (save) {
      saved = await writePath(save);
      await mkdir(path.dirname(saved), { recursive: true });
      await writeFile(saved, buf);
    }
    record({ shot: `f${frame}` });
    const warn = stale ? ' STALE: state from another session; wait_frames 1 for the real picture.' : '';
    return result(`Frame ${frame}${saved ? `, saved ${saved}` : ''}.${warn}`, { frame, stale }, [png(scalePng(buf, scale))]);
  });

  tool('read_memory', {
    description: 'Read RAM. GBA: 0x02000000 EWRAM, 0x03000000 IWRAM, 0x04000000 IO. GB: 0xC000 WRAM, 0xFF80 HRAM, 0xFE00 OAM, 0xFF00 IO, 0xA000 cart RAM.',
    inputSchema: {
      address: Address,
      length: z.number().int().positive().max(4096).optional().describe('bytes (default 4, or 1 value with as)'),
      as: z.enum(['hex', ...Object.keys(VALUE_TYPES)]).default('hex'),
    },
    annotations: RO,
  }, async ({ address, length, as }) => {
    const addr = emu.addr(address);
    if (as === 'hex') return result(`${label(addr)}: ${hexBytes(await emu.readMemory(addr, length ?? 4))}`);
    const w = VALUE_TYPES[as][0];
    length ??= w;
    const values = decodeValues(await emu.readMemory(addr, Math.max(length - (length % w), w)), as);
    return result(`${label(addr)} ${as}: ${values.length === 1 ? `${values[0]} (${hex(values[0])})` : values.join(', ')}`, { values });
  });

  tool('read_cpu', {
    description: 'CPU registers (pc named from symbols). A pc that stays put across waits means a hang.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const c = await emu.readCpu();
    const h4 = (n) => (n >>> 0).toString(16).padStart(8, '0'), h2 = (n) => n.toString(16).padStart(4, '0'), h1 = (n) => n.toString(16).padStart(2, '0');
    const fl = (keys) => keys.filter((k) => c.flags[k]).join('').toUpperCase() || '-';
    const text = emu.system === 'gba'
      ? `pc=${h4(c.pc)} exec=${h4(c.executing)} ${c.thumb ? 'thumb' : 'arm'} ${c.mode} sp=${h4(c.sp)} lr=${h4(c.lr)} cpsr=${h4(c.cpsr)} ${fl(['n', 'z', 'c', 'v'])}${c.irqDisabled ? ' irq-off' : ''}\n` +
        c.r.map((v, i) => `r${i}=${h4(v)}`).join(' ')
      : `pc=${h2(c.pc)} sp=${h2(c.sp)} af=${h1(c.a)}${h1(c.f)} bc=${h1(c.b)}${h1(c.c)} de=${h1(c.d)}${h1(c.e)} hl=${h1(c.h)}${h1(c.l)} ${fl(['z', 'n', 'h', 'c'])} ime=${c.ime ? 1 : 0}${c.halted ? ' halted' : ''}`;
    const at = emu.symbols?.nameOf(emu.system === 'gba' ? c.executing ?? c.pc : c.pc, { bank: c.romBank });
    return result(`Frame ${await emu.frameNum()}: ${text}${at ? `\nin ${at}` : ''}`, { pc: c.pc });
  });

  tool('read_sprites', {
    description: 'On-screen sprites as "#index x,y wxh tile palette [flags]" plus a screenshot with them outlined (same order).',
    inputSchema: {
      all: z.boolean().default(false).describe('include off-screen/hidden'),
      overlay: z.boolean().default(true),
      scale: Scale,
    },
    annotations: RO,
  }, async ({ all, overlay, scale }) => {
    const r = await emu.readRegions();
    const list = emu.system === 'gba' ? gbaSprites(r) : gbSprites(r, { cgb: !!r.isCgbWram });
    const visible = list.filter((s) => s.onScreen);
    const shown = all ? list : visible;
    // flags: h/v = flipped, a = affine, x = off-screen or hidden
    const line = (s) => {
      const f = `${s.hflip ? 'h' : ''}${s.vflip ? 'v' : ''}${s.affine ? 'a' : ''}${s.onScreen ? '' : 'x'}`;
      return `#${s.index} ${s.x},${s.y} ${s.w}x${s.h} t${s.tile} p${s.palette}${f ? ' ' + f : ''}`;
    };
    const extra = overlay ? [png(drawBoxes(await emu.screenshot(), visible, scale))] : [];
    const warn = spriteLimitWarnings(emu.system, list, r);
    return result(`${visible.length}/${list.length} on screen, frame ${await emu.frameNum()}.${warn.length ? '\nLIMIT: ' + warn.join('; ') : ''}${shown.length ? '\n' + shown.map(line).join('\n') : ''}`,
      { onScreen: visible.length }, extra);
  });

  tool('view_vram', {
    description: 'Image of tile graphics (GBA: region bg/obj, palette bank, bpp8; GB: bank, BG palette) or of all palettes.',
    inputSchema: {
      what: z.enum(['tiles', 'palettes']).default('tiles'),
      region: z.enum(['bg', 'obj']).default('bg'),
      palette: z.number().int().min(0).max(15).default(0),
      bpp8: z.boolean().default(false),
      bank: z.number().int().min(0).max(1).default(0),
      scale: Scale,
    },
    annotations: RO,
  }, async ({ what, region, palette, bpp8, bank, scale }) => {
    const r = await emu.readRegions();
    const cgb = !!r.isCgbWram;
    let img, desc;
    if (what === 'palettes') {
      img = palettesPng(emu.system === 'gba' ? gbaPalettes(r) : gbPalettes(r, { cgb }));
      desc = emu.system === 'gba' ? '16 BG then 16 OBJ rows of 16 colours' : (cgb ? '8 BG then 8 OBJ palettes' : 'BGP, OBP0, OBP1');
    } else if (emu.system === 'gba') {
      img = gbaTilesPng(r, { region, palette, bpp8 });
      desc = `${region} tiles ${bpp8 ? '8bpp' : `4bpp pal ${palette}`}, 32/row`;
    } else {
      if (bank === 1 && r.vram.length < 0x4000) return errText('VRAM bank 1 only exists on GBC');
      img = gbTilesPng(r, { bank, palette, cgb });
      desc = `tiles 0x8000-0x97FF bank ${bank}, 16/row`;
    }
    return result(`${desc}, frame ${await emu.frameNum()}.`, undefined, [png(scalePng(img, scale))]);
  });

  // ---- Change ----
  tool('write_memory', {
    description: 'Write RAM on the current frame (value+as, or hex bytes). Says if it did not stick.',
    inputSchema: {
      address: Address,
      value: z.number().int().optional(),
      as: z.enum(['u8', 'u16', 'u32']).default('u8'),
      hex: z.string().optional().describe('raw bytes, e.g. "deadbeef"'),
    },
  }, async ({ address, value, as, hex: hx }) => {
    const addr = emu.addr(address);
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
    if (stuck) return result(`Wrote ${bytes.length}B at ${label(addr)}.`, { stuck });
    return result(`Wrote ${bytes.length}B at ${label(addr)} but it did not stick (not RAM, or overwritten); now: ${hexBytes(await emu.readMemory(addr, bytes.length))}.`, { stuck });
  });

  tool('save_state', {
    description: 'Snapshot under `id`; `path` also writes a file.',
    inputSchema: { id: z.string().default('default'), path: z.string().optional() },
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
    return result(`Saved "${id}" at frame ${await emu.frameNum()}${file ? ` to ${file}` : ''}.`);
  });

  tool('load_state', {
    description: 'Restore state `id`, or a state file (`path`).',
    inputSchema: { id: z.string().default('default'), path: z.string().optional() },
  }, async ({ id, path: p }) => {
    let st;
    if (p) {
      st = await readFile(await resolvePath(p));
    } else {
      st = states.get(id);
      if (!st) return errText(`No state "${id}". Saved: ${[...states.keys()].join(', ') || 'none'}.`);
    }
    await emu.loadState(st);
    record(p ? { loadStateFile: await resolvePath(p) } : { loadState: id });
    const frame = await emu.frameNum();
    return result(`Restored. Frame ${frame}.${await watchLine()}`, { frame });
  });

  tool('set_cheats', {
    description: 'Replace cheat codes ([] clears). GBA: GameShark/Action Replay/CodeBreaker. GB: GameShark 01VVLLHH (applied at VBlank) or Game Genie.',
    inputSchema: { codes: z.array(z.string()) },
  }, async ({ codes }) => {
    await emu.setCheats(codes);
    record({ cheats: codes });
    return result(codes.length ? `${codes.length} cheat(s) active.` : 'Cheats cleared.');
  });

  tool('battery_save', {
    description: 'Battery save (.sav): export to `path`, or import from it and reset so the game boots with it.',
    inputSchema: { action: z.enum(['export', 'import']), path: z.string(), reset: z.boolean().default(true) },
  }, async ({ action, path: p, reset }) => {
    if (action === 'export') {
      const data = await emu.readSaveData();
      if (!data) return errText('This game has no battery save.');
      const file = await writePath(p);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data);
      return result(`Exported ${data.length}B to ${file}.`, { bytes: data.length });
    }
    const file = await resolvePath(p);
    const data = await readFile(file);
    await emu.writeSaveData(data, { reset });
    record({ importSave: file, reset });
    const frame = await emu.frameNum();
    return result(`Imported ${data.length}B${reset ? '; reset' : ''}. Frame ${frame}.`, { bytes: data.length, frame });
  });

  // ---- Test ----
  tool('run_sequence', {
    description: 'Run many steps in one call. Steps, one key each: wait:N | tap:btn or [btns] (hold,release) | press/release:btn | hold:btn,frames | waitUntil:{address,op,value} or {screen:changed|stable} (maxFrames) | shot:name | record:{frames,every} | saveState/loadState:id | loadStateFile:path | read:addr (as) | write:addr,value|hex | assertRam:addr,equals|min|max | assert:png (threshold,ignore,sprite) | video:{frames,path} | reset:true | cheats:[..] | importSave:path',
    inputSchema: {
      steps: z.array(z.record(z.string(), z.any())).min(1),
      scale: Scale,
      outDir: z.string().optional().describe('also save shots + timeline.json'),
      maxImages: z.number().int().min(0).max(20).default(8),
      video: z.object({ path: z.string(), onlyOnFail: z.boolean().default(true), seconds: z.number().positive().default(10) }).optional()
        .describe('record the run; kept on failure'),
    },
  }, async ({ steps, scale, outDir, maxImages, video }) => {
    const out = outDir ? await writePath(outDir) : undefined;
    const bd = await baseDir();
    // Record each step as it completes (with absolute paths, so an exported script
    // replays from anywhere) — if a later step throws, what already ran is kept.
    const onStep = (st) => {
      const c = { ...st };
      for (const k of ['assert', 'loadStateFile', 'importSave']) if (typeof c[k] === 'string') c[k] = path.resolve(bd, c[k]);
      record(c);
    };
    const res = await runSteps(emu, steps, { outDir: out, baseDir: bd, states, checkWrite: await writeGuard(), onStep, video });
    const frame = await emu.frameNum();
    if (out) await writeFile(path.join(out, 'timeline.json'), JSON.stringify({ rom: romPath, pass: res.failures === 0, steps: res.timeline }, null, 2));

    const images = [];
    const pushImg = (label, buf) => {
      if (images.length / 2 >= maxImages) return false;
      images.push({ type: 'text', text: label }, png(buf));
      return true;
    };
    let dropped = 0;
    for (const s of res.shots) if (!pushImg(`${s.name} f${s.frame}:`, scalePng(s.png, scale))) dropped++;
    for (const r of res.records) {
      // Keep sheets <= ~1600px wide (larger images get downscaled by vision models).
      const cols = Math.min(r.pngs.length, 4), fw = emu.system === 'gb' ? 160 : 240;
      const sheetScale = Math.max(1, Math.min(scale, Math.floor(1600 / (cols * fw))));
      if (!pushImg(`${r.prefix}: frames ${r.frames.join(',')} (left-right, top-bottom):`, contactSheet(r.pngs, { cols, scale: sheetScale }))) dropped++;
    }
    // Only steps with something to say get a line (waits/taps are in the frame count).
    const lines = res.timeline.filter((e) => 'value' in e || 'met' in e || e.assert || ('stuck' in e && !e.stuck)).map((e) => {
      let l = `#${e.i} f${e.frame} ${e.action}`;
      if ('value' in e) l += ` = ${JSON.stringify(e.value)}`;
      if ('met' in e) l += e.met ? ` met f${e.metFrame}` : ' NOT met';
      if ('stuck' in e && !e.stuck) l += ' (did not stick)';
      if (e.assert) l += e.assert.pass ? ' ok' : ` FAIL ${JSON.stringify(e.assert)}`;
      return l;
    });
    const summary = `${res.failures ? `FAIL (${res.failures})` : 'OK'}: ${steps.length} steps, frame ${frame}.` +
      (dropped ? ` ${dropped} image(s) not shown${out ? `; saved in ${out}` : ''}.` : '') +
      (res.video ? ` Video: ${res.video}.` : '') +
      (lines.length ? `\n${lines.join('\n')}` : '') + await watchLine();
    const r = result(summary, { pass: res.failures === 0, failures: res.failures, frame }, images);
    return res.failures ? { ...r, isError: true } : r;
  });

  tool('record_video', {
    description: 'Play `frames` frames into a video: .gif .png(animated) .webm .mp4 (with sound if ffmpeg allows) .wav.',
    inputSchema: {
      frames: z.number().int().positive().max(36000),
      path: z.string(),
      every: z.number().int().positive().default(1).describe('keep every Nth frame'),
      scale: z.number().int().min(1).max(4).default(2),
      audio: z.enum(['auto', 'on', 'off']).default('auto'),
    },
  }, async ({ frames, path: p, every, scale, audio }) => {
    const file = await writePath(p);
    const caps = await emu.record(frames, { every });
    const r = await saveVideo(caps, file, { scale, every, audio, toJpeg: (pngs, k) => emu.toJpeg(pngs, k) });
    record({ video: { frames, path: file, every, scale, audio } });
    const frame = await emu.frameNum();
    return result(`Saved ${caps.length} frames to ${file}${r.audio === 'muxed' ? ' with sound' : r.audio ? `; sound in ${r.audio}` : ''}. Frame ${frame}.`, { frame });
  });

  tool('assert_golden', {
    description: 'Compare the frame to a golden PNG (created if missing). `ignore` masks rects (clocks). On failure returns current/golden/diff images.',
    inputSchema: {
      golden: z.string(),
      threshold: z.number().min(0).max(1).default(0.02).describe('max fraction of differing pixels'),
      tolerance: z.number().int().min(0).max(255).default(16),
      ignore: z.array(Rect).default([]),
      sprite: z.number().int().min(0).optional().describe('compare this sprite\'s graphics instead of the screen'),
      scale: Scale,
    },
  }, async ({ golden, threshold, tolerance, ignore, sprite, scale }) => {
    const shot = sprite !== undefined ? await emu.spriteImage(sprite) : await emu.screenshot();
    const goldenPath = await writePath(golden);
    const res = await assertGolden(shot, goldenPath, { threshold, tolerance, ignore });
    record({ assert: goldenPath, threshold, tolerance, ...(ignore.length ? { ignore } : {}), ...(sprite !== undefined ? { sprite } : {}) });
    const out = { pass: res.pass, created: !!res.created, fraction: res.fraction ?? 0 };
    if (res.created) return result(`Golden created: ${res.goldenPath}. Check it:`, out, [png(scalePng(shot, scale))]);
    const pct = (res.fraction * 100).toFixed(2);
    if (res.pass) return result(`PASS (${pct}% differ).`, out);
    const why = res.mismatchDimensions ? 'frame size differs from the golden' : `${pct}% differ`;
    const images = [{ type: 'text', text: 'current:' }, png(scalePng(shot, scale)),
      { type: 'text', text: 'golden:' }, png(scalePng(await readFile(res.goldenPath), scale))];
    if (res.diffPng) images.push({ type: 'text', text: 'diff (red):' }, png(scalePng(res.diffPng, scale)));
    return { ...result(`FAIL: ${why}.${res.diffPath ? ` Diff: ${res.diffPath}` : ''}`, out, images), isError: true };
  });

  tool('export_script', {
    description: 'Everything done since load_rom as replayable run_sequence steps; add asserts for a regression test.',
    inputSchema: {
      path: z.string().optional(),
      includeShots: z.boolean().default(false).describe('keep a step per screenshot'),
    },
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
    return result(`${file ? `Wrote ${file}. ` : ''}${JSON.stringify(script)}`, { steps: script.steps.length });
  });

  tool('ab_compare', {
    description: 'Run the same steps on two ROMs; reports which shot/read steps differ, with A|B|diff images.',
    inputSchema: {
      romA: z.string(), romB: z.string(),
      steps: z.array(z.record(z.string(), z.any())).min(1),
      tolerance: z.number().int().min(0).max(255).default(16),
      scale: z.number().int().min(1).max(3).default(2),
      maxImages: z.number().int().min(0).max(10).default(4),
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
    const lines = [], images = [];
    let identical = true;
    A.shots.forEach((sa, i) => {
      const sb = B.shots[i];
      if (!sb) return;
      const c = compare(sa.png, sb.png, { tolerance });
      if (c.fraction === 0) { lines.push(`${sa.name} f${sa.frame}: same`); return; }
      identical = false;
      lines.push(`${sa.name} f${sa.frame}: ${(c.fraction * 100).toFixed(2)}% differ`);
      if (images.length / 2 < maxImages) {
        const tiles = [sa.png, sb.png, ...(c.diffPng ? [c.diffPng] : [])];
        images.push({ type: 'text', text: `${sa.name} A|B|diff:` }, png(contactSheet(tiles, { cols: tiles.length, scale })));
      }
    });
    A.timeline.forEach((ea, i) => {
      if (!('value' in ea)) return;
      const vb = B.timeline[i]?.value;
      const same = JSON.stringify(ea.value) === JSON.stringify(vb);
      if (!same) identical = false;
      lines.push(`#${i} read: A=${JSON.stringify(ea.value)} B=${JSON.stringify(vb)}${same ? '' : ' DIFFERS'}`);
    });
    const fails = A.failures + B.failures ? ` (failed asserts: A ${A.failures}, B ${B.failures})` : '';
    return result(`${identical ? 'IDENTICAL' : 'DIFFERENT'}${fails}\n${lines.join('\n') || '(no shot/read steps)'}`, { identical }, images);
  }, { needsRom: false });

  // ---- Find ----
  tool('ram_search', {
    description: 'Find where a value (HP, score) lives: start (optional known value), change it in game, filter (op vs value, or changed/unchanged/increased/decreased/delta vs last) until one is left; list shows candidates.',
    inputSchema: {
      action: z.enum(['start', 'filter', 'list']),
      type: z.enum(SEARCH_TYPES).default('u8'),
      region: z.string().optional().describe('GBA ewram/iwram; GB wram/hram/sram'),
      op: z.enum(SEARCH_OPS).optional(),
      value: z.number().int().optional(),
      limit: z.number().int().min(0).max(200).default(10).describe('candidates to list'),
    },
    annotations: RO,
  }, async ({ action, type, region, op, value, limit }) => {
    let head;
    if (action === 'start') {
      search = new RamSearch(emu.system, await emu.readRegions(), { type, region });
      if (value !== undefined) search.filter(await emu.readRegions(), 'eq', value);
      head = 'Started';
    } else {
      if (!search) return errText('No RAM search; use action "start" first.');
      if (action === 'filter') {
        if (!op) return errText('filter needs `op`');
        const before = search.count;
        search.filter(await emu.readRegions(), op, value);
        head = `${op}${value !== undefined ? ` ${value}` : ''}: ${before} ->`;
      } else head = 'Candidates:';
    }
    const rows = search.results(limit);
    const lines = rows.map((r) => `${label(r.address)}${r.bank !== undefined ? `/b${r.bank}` : ''} ${r.region} =${r.value}${r.previous !== undefined ? ` (was ${r.previous})` : ''}`);
    const more = search.count > rows.length ? `\n…${search.count - rows.length} more` : '';
    return result(`${head} ${search.count} (${search.type}).${lines.length ? `\n${lines.join('\n')}${more}` : ''}`, { count: search.count });
  });

  // ---- Make: sprites ----
  tool('sprite', {
    description: 'Sprite art. convert: PNG (sheet of width x height frames) to tiles+palette; out=.h/.c/.s/.asm/.bin, animation=.gif. inject: frame into the game at x,y (oam). overlay: draw on screen only. export: sprite index from VRAM.',
    inputSchema: {
      action: z.enum(['convert', 'inject', 'overlay', 'export']),
      png: z.string().optional(),
      target: z.enum(['gba4', 'gba8', 'gbc', 'gb']).optional(),
      width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
      transparent: z.string().optional().describe('alpha|none|#rrggbb'),
      quantize: z.boolean().default(false),
      out: z.string().optional(), name: z.string().optional(),
      animation: z.string().optional(), fps: z.number().positive().default(10),
      frame: z.number().int().min(0).default(0), x: z.number().int().default(0), y: z.number().int().default(0),
      tile: z.number().int().min(0).optional(), palette: z.number().int().min(0).default(0), oam: z.number().int().min(0).default(0),
      index: z.number().int().min(0).optional(), path: z.string().optional(),
      scale: Scale,
    },
  }, async (a) => {
    if (a.action === 'export') {
      requireRom();
      if (a.index === undefined) return errText('export needs `index`');
      const img = await emu.spriteImage(a.index);
      let file;
      if (a.path) { file = await writePath(a.path); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, img); }
      return result(`Sprite ${a.index}${file ? ` saved to ${file}` : ''}.`, undefined, [png(scalePng(img, a.scale))]);
    }
    if (!a.png) return errText(`${a.action} needs \`png\``);
    const target = a.target ?? (emu ? (emu.system === 'gba' ? 'gba4' : ((await emu.readRegions()).isCgbWram ? 'gbc' : 'gb')) : null);
    if (!target) return errText('give `target` (no ROM loaded)');
    const conv = convertSprite(await readFile(await resolvePath(a.png)), { target, width: a.width, height: a.height, transparent: a.transparent, quantize: a.quantize });
    const info = `${conv.frames} frame(s) ${conv.width}x${conv.height}, ${conv.palette.length} colour(s), ${conv.tilesPerFrame} tile(s)/frame, ${target}.${conv.warnings.length ? ' WARN: ' + conv.warnings.join('; ') : ''}`;
    if (a.action === 'convert') {
      const files = [];
      if (a.out) files.push(...(await writeSpriteSource(conv, await writePath(a.out), a.name ?? path.basename(a.png).replace(/\.[^.]+$/, ''))));
      if (a.animation) {
        const caps = conv.indices.map((idx, i) => ({ frame: Math.round(i * 60 / a.fps), png: framePng(conv, idx) }));
        caps.push({ ...caps[caps.length - 1], frame: Math.round(conv.frames * 60 / a.fps) });
        files.push((await saveVideo(caps, await writePath(a.animation), { scale: a.scale, audio: 'off' })).file);
      }
      return result(`${info}${files.length ? ` Wrote ${files.join(', ')}.` : ''}`, { frames: conv.frames }, [png(scalePng(conv.previewPng, a.scale))]);
    }
    requireRom();
    if (a.action === 'overlay') {
      return result(info, undefined, [png(scalePng(overlayFrame(await emu.screenshot(), conv, a.frame, a.x, a.y), a.scale))]);
    }
    const r = await injectSprite(emu, conv, { frame: a.frame, x: a.x, y: a.y, tile: a.tile, palette: a.palette, oam: a.oam });
    await emu.waitFrames(1); // let the core draw it
    record({ wait: 1 });
    const now = (await emu.sprites())[a.oam];
    const kept = now && now.x === a.x && now.y === a.y && now.tile === r.tile;
    const head = kept
      ? `Injected at ${a.x},${a.y}: tiles from ${r.tile}, ${r.oamEntries} OAM entr${r.oamEntries === 1 ? 'y' : 'ies'} from ${a.oam}.`
      : `Injected, but the game rewrote OAM entry ${a.oam} on the next frame (it copies its own sprite table each frame) — use action "overlay" to preview instead.`;
    return result(`${head} ${info}${r.notes.length ? ' ' + r.notes.join('; ') : ''}`, { tile: r.tile, kept }, [png(scalePng(await emu.screenshot(), a.scale))]);
  }, { needsRom: false });

  // ---- Make: backgrounds ----
  tool('background', {
    description: 'PNG or Tiled .tmx/.tmj map → deduped tiles + tilemap + palettes; out=.c/.h/.s/.asm/.bin; returns a preview rebuilt from them. Fonts: dedupe false.',
    inputSchema: {
      png: z.string().optional(), tiled: z.string().optional(),
      target: z.enum(Object.keys(BG_TARGETS)).optional().describe('default: the loaded ROM\'s'),
      dedupe: z.boolean().default(true),
      flips: z.boolean().optional(),
      transparent: z.string().optional().describe('GBA backdrop: alpha|#rrggbb'),
      out: z.string().optional(),
      scale: Scale,
    },
  }, async (a) => {
    if (!a.png === !a.tiled) return errText('give `png` or `tiled`');
    const target = a.target ?? (emu ? (emu.system === 'gba' ? 'gba4' : ((await emu.readRegions()).isCgbWram ? 'gbc' : 'gb')) : null);
    if (!target) return errText('give `target` (no ROM loaded)');
    const src = await resolvePath(a.png ?? a.tiled);
    const img = a.tiled ? await renderTiledMap(src) : await readFile(src);
    const conv = convertBackground(img, { target, dedupe: a.dedupe, flips: a.flips, transparent: a.transparent });
    const files = a.out ? await writeBackgroundSource(conv, await writePath(a.out), path.basename(a.out).replace(/\.[^.]+$/, '')) : [];
    const sc = Math.max(1, Math.min(a.scale, Math.floor(1600 / (conv.cols * 8))));
    const text = `${conv.cols}x${conv.rows} map, ${conv.tileCount} unique tiles of ${conv.cells}${conv.flipped ? ` (${conv.flipped} reused mirrored)` : ''}, ${conv.palettes.length || 1} palette(s), ${target}.` +
      (conv.warnings.length ? ` WARN: ${conv.warnings.join('; ')}.` : '') + (files.length ? ` Wrote ${files.join(', ')}.` : '');
    return result(text, { tiles: conv.tileCount, palettes: conv.palettes.length }, [png(scalePng(conv.previewPng, sc))]);
  }, { needsRom: false });

  // ---- Develop ----
  tool('build', {
    description: 'Build (gbtest.json build, else make): errors as file:line, then load the ROM + symbols and check its header. replay: redo the steps since the last load.',
    inputSchema: {
      command: z.string().optional(),
      rom: z.string().optional().describe('default: gbtest.json rom, else the newest'),
      load: z.boolean().default(true),
      replay: z.boolean().default(false),
    },
  }, async ({ command, rom, load, replay }) => {
    const bd = await baseDir();
    cfg = await readProjectConfig(bd);
    const cmd = command ?? cfg.build ?? await detectBuild(bd);
    if (!cmd) return errText(`no build command: pass \`command\` or add {"build": "..."} to ${path.join(bd, 'gbtest.json')}`);
    const r = await runCommand(cmd, bd);
    const diags = parseDiagnostics(r.output);
    const errors = diags.filter((d) => d.level === 'error'), warns = diags.filter((d) => d.level === 'warning');
    const secs = (r.ms / 1000).toFixed(1);
    const count = `${errors.length} error(s), ${warns.length} warning(s)`;
    if (r.code !== 0 || r.timedOut) {
      const shown = (errors.length ? errors : diags).slice(0, 25).map(formatDiagnostic);
      const tail = shown.length ? '' : `\n${r.output.trim().split(/\r?\n/).slice(-25).join('\n')}`;
      return errText(`Build FAILED (${r.timedOut ? 'timed out' : `exit ${r.code}`}, ${secs}s): ${count}.\n${shown.join('\n')}${tail}`);
    }
    let text = `Built with \`${cmd}\` in ${secs}s${warns.length ? `, ${warns.length} warning(s):\n${warns.slice(0, 10).map(formatDiagnostic).join('\n')}` : '.'}`;
    if (!load) return result(text, { built: true });
    const want = rom ?? cfg.rom;
    const abs = want ? await resolvePath(want) : await findRom(bd);
    if (!abs) return result(`${text}\nNo ROM found to load; pass \`rom\`.`, { built: true });
    const steps = replay ? rec.filter((st) => !('shot' in st) && !('assert' in st) && !('video' in st) && !('record' in st)) : null;
    await loadRom(abs);
    text += `\nLoaded ${path.relative(bd, abs) || abs} (${sysName(emu.system)}${symbolInfo()}).`;
    if (!/\.zip$/i.test(abs)) {
      const issues = romHeaderIssues(await readFile(abs), emu.system).filter((f) => f.level !== 'ok');
      if (issues.length) text += `\nROM header: ${issues.map((f) => `${f.level.toUpperCase()} ${f.msg}`).join('; ')}`;
    }
    if (steps?.length) {
      const res = await runSteps(emu, steps, { baseDir: bd, states, checkWrite: await writeGuard(), onStep: record });
      text += `\nReplayed ${steps.length} steps${res.failures ? ` (${res.failures} check(s) failed)` : ''}.`;
    }
    return result(`${text}\nFrame ${await emu.frameNum()}.${await watchLine()}`, { built: true, frame: await emu.frameNum() });
  }, { needsRom: false });

  tool('new_project', {
    description: 'New game from a working template: text, a moving player, a passing test, gbtest.json, CI, dev container.',
    inputSchema: { template: z.enum(Object.keys(TEMPLATES)), path: z.string() },
  }, async ({ template, path: p }) => {
    const dest = await writePath(p);
    const files = await createProject(template, dest);
    return result(`Created ${dest} (${files.length} files): ${files.join(', ')}. Set the workspace to it (or GBTEST_ROOT), then build.`);
  }, { needsRom: false });

  tool('watch', {
    description: 'Variables reported after each step that advances time: "name", "name:u16", "0xC000:s8". Replaces the list.',
    inputSchema: { vars: z.array(z.string()) },
  }, async ({ vars }) => {
    watches = vars.map(parseWatch);
    const v = await watchValues();
    return result(v.length ? `watch: ${v.join(' ')}` : 'Watch list cleared.');
  });

  tool('describe', {
    description: 'Screen as text, far cheaper than a screenshot: on-screen text, sprites, watch values, % changed since last time.',
    inputSchema: {
      charmap: z.any().optional().describe('"ascii" or {first: tile of chars[0], chars}'),
      learn: z.string().optional().describe('text you can see; infers the charmap'),
      image: z.boolean().default(false),
      scale: Scale,
    },
    annotations: RO,
  }, async (a) => {
    const r = await emu.readRegions();
    const cpu = await emu.readCpu();
    const lines = [];
    const pc = emu.system === 'gba' ? cpu.executing ?? cpu.pc : cpu.pc;
    const at = emu.symbols?.nameOf(pc, { bank: cpu.romBank });
    lines.push(`Frame ${await emu.frameNum()}, ${emu.system === 'gba' ? 'GBA' : r.isCgbWram ? 'GBC' : 'GB'}, pc ${hex(pc)}${at ? ` (${at})` : ''}.`);
    const wv = await watchValues();
    if (wv.length) lines.push(`watch: ${wv.join(' ')}`);
    if (a.charmap) charmap = normalizeCharmap(a.charmap);
    if (a.learn) {
      const cm = learnCharmap(emu.system, r, a.learn);
      if (cm) { charmap = cm; lines.push(`charmap learned: first tile ${cm.first} (ASCII order).`); }
      else lines.push(`"${a.learn}" not found on screen in ASCII tile order; give charmap {first, chars} instead.`);
    }
    const cm = charmap ?? (cfg.charmap ? normalizeCharmap(cfg.charmap) : null);
    if (cm) {
      const layers = screenText(emu.system, r, cm);
      if (!layers.length) lines.push('text: none');
      for (const l of layers) lines.push(`text (${l.name}):`, ...l.lines.map((t) => `  ${t}`));
    } else lines.push('text: unknown font; pass charmap ("ascii" or {first, chars}) or learn: "<text you can see>".');
    const list = (emu.system === 'gba' ? gbaSprites(r) : gbSprites(r, { cgb: !!r.isCgbWram })).filter((s) => s.onScreen);
    const sp = list.slice(0, 16).map((s) => `#${s.index} ${s.x},${s.y} ${s.w}x${s.h} t${s.tile}`);
    lines.push(`sprites: ${list.length ? sp.join(' · ') + (list.length > 16 ? ` · +${list.length - 16} more` : '') : 'none'}`);
    const shot = await emu.screenshot();
    if (lastDescribe) {
      const c = compare(lastDescribe, shot, { tolerance: 0 });
      lines.push(`screen: ${c.fraction === 0 ? 'unchanged' : `${(c.fraction * 100).toFixed(1)}% changed`} since the last describe`);
    }
    lastDescribe = shot;
    return result(lines.join('\n'), undefined, a.image ? [png(scalePng(shot, a.scale))] : []);
  });

  tool('check', {
    description: 'Hardware rules: ROM header, then `frames` frames watching for crashes, bad stack, sprite overflow, bitmap-mode sprite tiles, blank screen, lag. State restored after.',
    inputSchema: {
      frames: z.number().int().min(1).max(3600).default(120),
      frameCounter: Address.optional().describe('per-frame counter (default gbtest.json or *frame_count*)'),
    },
    annotations: RO,
  }, async ({ frames, frameCounter }) => {
    const found = [];
    if (!/\.zip$/i.test(romPath)) found.push(...romHeaderIssues(await readFile(romPath), emu.system));
    let counter = frameCounter ?? cfg.frameCounter ?? null, width = emu.system === 'gba' ? 4 : 1;
    if (counter === null && emu.symbols) {
      const s = [...emu.symbols.byName.values()].find((x) => /^_?(w|g_|s_)?frame_?(count|counter|cnt|num)s?$/i.test(x.name));
      if (s) counter = s.name;
    }
    let counterAddr = null, counterNote = '';
    if (counter !== null) {
      try {
        counterAddr = emu.addr(counter);
        const sym = typeof counter === 'string' ? emu.symbols?.get(counter) : null;
        if (sym?.size) width = Math.min(sym.size, 4) === 3 ? 2 : Math.min(sym.size, 4);
      } catch (e) { counterNote = ` (frame counter: ${e.message})`; }
    }
    const checker = new RunChecker(emu.system, { frameCounter: counterAddr, counterWidth: width });
    const saved = await emu.saveState(), f0 = await emu.frameNum();
    try {
      for (let i = 0; i < frames; i++) {
        await emu.waitFrames(1);
        checker.observe(await emu.readRegions(), await emu.readCpu(), counterAddr !== null ? await emu.readMemory(counterAddr, width) : null);
      }
    } finally { await emu.loadState(saved, { frame: f0 }); }
    found.push(...checker.findings());
    const errs = found.filter((f) => f.level === 'error').length, warns = found.filter((f) => f.level === 'warn').length;
    const head = `${errs ? `${errs} error(s)` : 'No errors'}, ${warns} warning(s) over ${frames} frames${counterAddr === null ? counterNote || ' (no frame counter: lag not checked)' : ` (frame counter ${label(counterAddr)})`}; state restored.`;
    return result([head, ...found.map((f) => `${f.level === 'ok' ? 'ok' : f.level.toUpperCase()}: ${f.msg}`)].join('\n'), { errors: errs, warnings: warns });
  });

  // ---- Status ----
  const statusData = async () => (emu
    ? { loaded: true, rom: romPath, system: sysName(emu.system), frame: await emu.frameNum(), held: await emu.heldButtons(), states: [...states.keys()], cheats: emu.cheats.length, ramSearch: search ? search.count : null, recordedSteps: rec.length, symbols: emu.symbols ? `${emu.symbols.file} (${emu.symbols.count})` : null, watch: activeWatches().map((w) => w.label) }
    : { loaded: false });

  tool('status', {
    description: 'Loaded ROM, frame, held buttons, saved states, cheats, RAM search.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const s = await statusData();
    return result(JSON.stringify(s), s);
  }, { needsRom: false });

  // Serve a slimmed tool list (definitions are resent with every request). The SDK
  // keeps its handlers in a private map; if that ever changes, the full list is served.
  const handlers = /** @type {any} */ (server.server)._requestHandlers;
  const listTools = handlers?.get?.('tools/list');
  if (listTools) {
    handlers.set('tools/list', async (...args) => {
      const res = await listTools(...args);
      return { ...res, tools: res.tools.map(({ execution, ...t }) => ({ ...t, inputSchema: slimSchema(t.inputSchema) })) };
    });
  }

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
2. ram_search action="start"${region ? ` region="${region}"` : ''}. If you can read the value on screen, pass it as
   \`value\` (try type "u8" first; "u16" for values above 255).
3. Change the value in game (take damage, collect a coin…), then ram_search
   action="filter": op "eq" + the new value if you can see it, otherwise
   "decreased"/"increased", or "delta" with the exact change. Also filter
   "unchanged" after doing something that does NOT affect the value.
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
2. Play towards the goal with run_sequence / press / set_button. Prefer wait_until
   over guessing wait lengths (e.g. wait_until screen "stable" after a transition,
   or a RAM condition). Use screenshot to see where you are.
3. At each point that matters, add a check: assert_golden for the picture (mask
   clocks/timers with \`ignore\`), or note a RAM address/value for an assertRam step
   (use ram_search to find addresses if needed).
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
/** Serve over stdio until stdin closes. */
export async function main() {
  const { server, close } = createServer();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await close(); process.exit(0); });
  process.stdin.on('close', async () => { await close(); process.exit(0); });
  await server.connect(new StdioServerTransport());
  console.error(`gb-gbc-gba-test-mcp ${VERSION} ready (stdio).`);
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain && process.argv[2] === 'new') {
  // node mcp-server.mjs new <template> <dir>
  const [, , , template, dir] = process.argv;
  if (!template || !dir) {
    console.error(`usage: node mcp-server.mjs new <template> <dir>\ntemplates: ${Object.entries(TEMPLATES).map(([k, v]) => `\n  ${k.padEnd(7)} ${v}`).join('')}`);
    process.exit(1);
  }
  const files = await createProject(template, path.resolve(dir));
  console.log(`Created ${dir} (${files.length} files). cd ${dir} && make`);
} else if (isMain) await main();
