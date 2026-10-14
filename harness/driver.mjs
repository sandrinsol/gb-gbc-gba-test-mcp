// Game Boy (GB/GBC/GBA) test harness driver.
//
// Boots the bundled EmulatorJS cores (mgba for GBA, gambatte for GB/GBC) in
// headless Chromium and exposes a scripting-style API (buttons, frame stepping,
// screenshots, save states, RAM) so AI/CI can test ROMs with no third-party emulator.
//
// Usage as a library:
//   import { EmuHarness } from './driver.mjs';
//   const emu = await EmuHarness.launch('../anguna.gba');
//   await emu.waitFrames(300);
//   await emu.tap('START');
//   await emu.screenshot('out/title.png');
//   await emu.close();
//
// Usage as a CLI (quick smoke shot):
//   node driver.mjs shot <rom> [frames=300] [out.png=out/shot.png]

import http from 'node:http';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as gbaMem from './memory.mjs';
import * as gbMem from './gb-memory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // the repo root (served to the browser)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.gba': 'application/octet-stream',
  '.png': 'image/png', '.map': 'application/json',
};

const SYSTEM_BY_EXT = { gb: 'gb', gbc: 'gb', gba: 'gba' };

/** Which core a ROM needs: by extension, and for a .zip by the first ROM file
 *  inside it (read from the archive's local file headers). 'gb' covers GB + GBC. */
export async function romSystem(absRom) {
  const ext = path.extname(absRom).slice(1).toLowerCase();
  if (SYSTEM_BY_EXT[ext]) return SYSTEM_BY_EXT[ext];
  if (ext === 'zip') {
    const zip = await readFile(absRom);
    for (let p = 0; p + 30 <= zip.length && zip.readUInt32LE(p) === 0x04034b50;) {
      const nameLen = zip.readUInt16LE(p + 26), extraLen = zip.readUInt16LE(p + 28), size = zip.readUInt32LE(p + 18);
      const name = zip.toString('utf8', p + 30, p + 30 + nameLen);
      const sys = SYSTEM_BY_EXT[path.extname(name).slice(1).toLowerCase()];
      if (sys) return sys;
      if (zip.readUInt16LE(p + 6) & 0x08) break; // sizes live in a trailing descriptor; stop
      p += 30 + nameLen + extraLen + size;
    }
  }
  return 'gba';
}

// Serves the repo root, plus each loaded ROM in place at /__rom/<token>/<name>
// (no copying, so ROMs can live anywhere and the install dir can be read-only).
function startServer(rootDir, roms) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath;
      const m = /^\/__rom\/([^/]+)\//.exec(urlPath);
      if (m) {
        filePath = roms.get(m[1]);
        if (!filePath) { res.writeHead(404).end(); return; }
      } else {
        filePath = path.join(rootDir, path.normalize(urlPath));
        if (!filePath.startsWith(rootDir)) { res.writeHead(403).end(); return; }
      }
      const info = await stat(filePath);
      if (info.isDirectory()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: /** @type {import('node:net').AddressInfo} */ (server.address()).port }));
  });
}

// Browser + static server, launched once and shared by every `reuse: true` harness
// (the MCP server uses this so load_rom doesn't cold-start Chromium each time).
let sharedHost = null;

async function startHost({ headless = true } = {}) {
  const { chromium } = await import('playwright');
  const roms = new Map(); // token -> absolute ROM path
  const { server, port } = await startServer(ROOT, roms);
  let browser;
  try {
    browser = await chromium.launch({
      headless,
      // Optional: use a preinstalled Chromium instead of Playwright's download.
      executablePath: process.env.GBTEST_CHROMIUM || undefined,
      args: [
        '--use-gl=angle', '--use-angle=swiftshader',
        '--ignore-gpu-blocklist', '--enable-webgl',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio', '--hide-scrollbars',
      ],
    });
  } catch (e) {
    await new Promise((r) => server.close(r));
    if (/executable doesn't exist|ENOENT/i.test(e.message)) {
      throw new Error('Chromium is not installed. Run `npx playwright install chromium` (in the folder with this package), '
        + 'or set GBTEST_CHROMIUM to an existing Chrome/Chromium binary.'
        + (process.env.GBTEST_CHROMIUM ? ` (GBTEST_CHROMIUM=${process.env.GBTEST_CHROMIUM} was not found.)` : ''));
    }
    throw e;
  }
  return {
    browser, server, port, roms,
    async close() { await browser.close().catch(() => {}); await new Promise((r) => server.close(r)); },
  };
}

export class EmuHarness {
  constructor({ host, shared, context, page, romToken, system, blocked }) {
    this._state = null;      // cached raw state of the current frame (see _rawState)
    this.cheats = [];
    this.host = host; this._shared = shared;
    this.browser = host.browser; this.server = host.server;
    this.context = context; this.page = page;
    this._romToken = romToken; // this harness's entry in host.roms
    this.system = system;    // 'gba' (mgba) or 'gb' (gambatte, covers GB + GBC)
    this.blockedRequests = blocked; // external URLs the page tried to fetch (blocked: offline)
  }

  /** Boot a ROM. Options:
   *  - fast (default true): fast-forward long waits (results stay bit-identical).
   *  - reuse (default false): share one browser + server across harnesses; close()
   *    then only closes this page. Call EmuHarness.shutdown() when done. */
  static async launch(romPath, { headless = true, timeout = 60000, fast = true, reuse = false } = {}) {
    const absRom = path.resolve(process.cwd(), romPath);
    await stat(absRom).catch(() => { throw new Error(`ROM not found: ${absRom}`); });

    let host;
    if (reuse) {
      if (!sharedHost || !sharedHost.browser.isConnected()) sharedHost = await startHost({ headless });
      host = sharedHost;
    } else {
      host = await startHost({ headless });
    }
    const romToken = randomUUID();
    host.roms.set(romToken, absRom);
    const romUrlPath = `/__rom/${romToken}/${encodeURIComponent(path.basename(absRom))}`;
    const context = await host.browser.newContext({
      viewport: { width: 720, height: 480 }, deviceScaleFactor: 1, reducedMotion: 'reduce',
    });
    // Offline guard: everything is bundled, so any non-local request is a bug
    // (e.g. EmulatorJS falling back to its CDN for a missing core). Block + record it.
    const blocked = [];
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      blocked.push(u.href);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => { errors.push(e.message); });

    const cleanup = async () => {
      await context.close().catch(() => {});
      host.roms.delete(romToken);
      if (!reuse) await host.close();
    };
    const sys = await romSystem(absRom);
    const url = `http://127.0.0.1:${host.port}/harness/page.html?rom=${encodeURIComponent(romUrlPath)}&system=${sys}${fast ? '' : '&fast=0'}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.EJS_emulator && window.EJS_emulator.gameManager, { timeout });
      // Bound the wait for the 'start' event so a ROM that never boots fails fast.
      await page.evaluate((ms) => Promise.race([
        window.Emu.ready(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('game did not start (ROM may be unsupported by this core)')), ms)),
      ]), timeout);
    } catch (e) {
      await cleanup();
      const extra = [
        errors.length ? `page errors: ${errors.join('; ')}` : '',
        blocked.length ? `blocked external requests (missing bundled file?): ${blocked.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(`Emulator failed to start${extra ? ` (${extra})` : ''}: ${e.message}`);
    }

    // Hold the machine still between calls (it only runs inside waits).
    // Hold the machine still between calls (it only runs inside waits).
    const system = await page.evaluate(() => { window.Emu.pause(); return window.Emu.system; });
    return new EmuHarness({ host, shared: reuse, context, page, romToken, system, blocked });
  }

  /** Close the shared browser + server used by `reuse: true` harnesses. */
  static async shutdown() {
    const h = sharedHost; sharedHost = null;
    if (h) await h.close();
  }

  frameNum() { return this.page.evaluate(() => window.Emu.frameNum()); }
  videoDimensions() { return this.page.evaluate(() => window.Emu.videoDimensions()); }
  // Anything that runs or replaces the machine drops the cached state.
  waitFrames(n) { this._state = null; return this.page.evaluate((n) => window.Emu.waitFrames(n), n); }
  waitUntilFrame(abs) { this._state = null; return this.page.evaluate((a) => window.Emu.waitUntilFrame(a), abs); }
  setButton(name, pressed) { return this.page.evaluate(([n, p]) => window.Emu.setButton(n, p), [name, pressed]); }
  /** Hold/release several buttons at once (e.g. ['A', 'B']). */
  setButtons(names, pressed) { return this.page.evaluate(([n, p]) => window.Emu.setButtons(n, p), [names, pressed]); }
  heldButtons() { return this.page.evaluate(() => window.Emu.heldButtons()); }
  /** Press, hold `hold` frames, release, settle `release` frames. `name` may be an array (combo). */
  tap(name, hold = 4, release = 4) { this._state = null; return this.page.evaluate(([n, h, r]) => window.Emu.tap(n, h, r), [name, hold, release]); }
  /** The deterministic wait clock's current target (waitFrames(n) moves it by n). */
  waitTarget() { return this.page.evaluate(() => window.Emu._target); }
  /** Fast-forward counters: { ffWaits, recoveries, restoreRetries }. */
  stats() { return this.page.evaluate(() => window.Emu.stats); }

  /** Reset the game, like the console's reset button: cartridge RAM (the battery
   *  save) is kept, the clock restarts at frame 1 and waitFrames() counts from 0
   *  again. Deterministic: the same script gives the same result. */
  async restart() {
    this._state = null;
    await this.page.evaluate(() => window.Emu.reset());
  }

  /** PNG of the current frame → Buffer (and written to `outPath` if given).
   *  `this.lastScreenshotStale` is true when the picture for this exact state is
   *  unknown (right after loading a save state this session didn't create) — the
   *  image is then the last frame rendered; advance a frame for the true picture. */
  async screenshot(outPath) {
    const { png, stale } = await this.page.evaluate(() => window.Emu.screenshot());
    this.lastScreenshotStale = stale;
    const buf = Buffer.from(png, 'base64');
    if (outPath) {
      const abs = path.resolve(process.cwd(), outPath);
      await mkdir(path.dirname(abs), { recursive: true }); // out/ is gitignored; ensure it exists
      await writeFile(abs, buf);
    }
    return buf;
  }

  async saveState() {
    const b64 = await this.page.evaluate(() => window.Emu.saveState());
    return Buffer.from(b64, 'base64');
  }
  /** Raw state of the current frame, cached until the machine runs or changes, so
   *  many reads on one frame cost one transfer. Treat as read-only. */
  async _rawState() {
    if (!this._state) this._state = Buffer.from(await this.page.evaluate(() => window.Emu.rawState()), 'base64');
    return this._state;
  }
  async loadState(buf) {
    this._state = null;
    const b64 = Buffer.from(buf).toString('base64');
    await this.page.evaluate((b) => window.Emu.loadState(b), b64);
  }

  /** Whether the loaded core exposes live RAM exports (bundled mgba core does not;
   *  memory reads instead go through save-state parsing, which always works). */
  hasMemoryAccess() { return this.page.evaluate(() => window.Emu.hasMemoryAccess()); }
  async readSystemRam() {
    const r = await this.page.evaluate(() => window.Emu.readSystemRam());
    return r ? Buffer.from(r.base64, 'base64') : null;
  }

  get _mem() { return this.system === 'gb' ? gbMem : gbaMem; }

  /** Parse the current state into typed RAM regions (views; don't modify).
   *  GBA: { ewram, iwram, vram, pram, oam, io }. GB/GBC: { wram, vram, sram, hram, io }. */
  async readRegions() { return this._mem.parseState(await this._rawState()); }

  /** Read `length` bytes at a bus address. GBA e.g. 0x03000000 (IWRAM); GB/GBC e.g.
   *  0xC000 (WRAM), 0xFF80 (HRAM). Reflects the current frame. Addresses are
   *  interpreted for whichever console the loaded ROM is. */
  async readMemory(addr, length = 1) { return this._mem.readMemory(await this._rawState(), addr, length); }
  async readU8(addr) { return (await this.readMemory(addr, 1)).readUInt8(0); }
  async readU16(addr) { return (await this.readMemory(addr, 2)).readUInt16LE(0); }
  async readU32(addr) { return (await this.readMemory(addr, 4)).readUInt32LE(0); }

  /** Write bytes at a bus address on the current frame (patches a save state of
   *  the paused machine and reloads it; what's on screen is unchanged). Returns
   *  whether the bytes read back as written — false if the address isn't RAM-backed
   *  in the state. The game may still overwrite the value on the next frame. */
  async writeMemory(addr, data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const state = Buffer.from(await this._rawState());
    this._mem.writeMemory(state, addr, bytes);
    await this._poke(state);
    return (await this.readMemory(addr, bytes.length)).equals(bytes);
  }
  async _poke(state) {
    this._state = null;
    await this.page.evaluate((b) => window.Emu.pokeState(b), state.toString('base64'));
  }
  async writeU8(addr, v) { await this.writeMemory(addr, Buffer.from([v & 0xff])); }
  async writeU16(addr, v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); await this.writeMemory(addr, b); }
  async writeU32(addr, v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); await this.writeMemory(addr, b); }

  /** CPU registers on the current frame. GBA: { r[0..12], sp, lr, pc, executing,
   *  cpsr, mode, thumb, flags, irqDisabled }. GB: { pc, sp, a, f, b, c, d, e, h, l,
   *  flags, ime, halted }. */
  async readCpu() { return this._mem.cpu(await this._rawState()); }

  // ---- Battery saves (.sav) ----
  /** The cartridge's battery save (.sav contents) → Buffer, or null if none. */
  async readSaveData() {
    const d = this._mem.saveData(await this._rawState());
    return d ? Buffer.from(d) : null;
  }
  /** Replace the battery save. By default the game is then reset so it boots with
   *  it (what loading a .sav means); reset:false patches it in place. A shorter
   *  file fills the start of the save area (the rest is unchanged). */
  async writeSaveData(data, { reset = true } = {}) {
    const state = Buffer.from(await this._rawState());
    const dst = this._mem.saveData(state);
    if (!dst) throw new Error('this game has no battery save');
    if (data.length > dst.length) throw new Error(`save is ${data.length} bytes; this game's save area is ${dst.length}`);
    Buffer.from(data).copy(dst);
    await this._poke(state);
    if (reset) await this.restart();
  }

  // ---- Cheats ----
  /** Set the active cheat codes (replaces the list). GBA: GameShark, Action
   *  Replay, CodeBreaker; GB/GBC: GameShark (01VVAAAA) and Game Genie. Cheats
   *  apply every frame and survive restart(). */
  async setCheats(codes) {
    this.cheats = [...codes];
    await this.page.evaluate((c) => window.Emu.setCheats(c), this.cheats);
  }

  // ---- Waiting on conditions ----
  /** Run until a condition holds (or `maxFrames` pass) and stop on the first frame
   *  where it does. Conditions:
   *   { address, as='u8', op: eq|ne|gt|lt|gte|lte|changed, value }
   *   { screen: 'changed' }            video memory differs from now
   *   { screen: 'stable', frames: 30 } video memory unchanged for N frames
   *  (Screen conditions watch VRAM/palettes/sprites/display registers, which is
   *  what the picture is made from.) → { met, frame } */
  async waitFor(cond, { maxFrames = 600, precise = false } = {}) {
    const state = await this._rawState();
    let spec;
    if (cond.screen) {
      if (!['changed', 'stable'].includes(cond.screen)) throw new Error('screen must be "changed" or "stable"');
      spec = { kind: 'video', mode: cond.screen, frames: cond.frames ?? 30, ranges: this._mem.videoRanges(state) };
    } else {
      const as = cond.as ?? 'u8';
      const width = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4 }[as];
      if (!width) throw new Error(`bad "as" ${as}`);
      const op = cond.op ?? 'eq';
      if (!['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'changed'].includes(op)) throw new Error(`bad op ${op}`);
      if (op !== 'changed' && typeof cond.value !== 'number') throw new Error(`op ${op} needs a numeric value`);
      spec = { kind: 'value', offsets: this._mem.stateOffsets(state, cond.address, width), signed: as.startsWith('s'), op, value: cond.value };
    }
    this._state = null;
    return this.page.evaluate(([sp, m, p]) => window.Emu.waitFor(sp, m, p), [spec, maxFrames, precise]);
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.host?.roms.delete(this._romToken);
    if (!this._shared) await this.host?.close();
  }
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [cmd, rom, framesArg, outArg] = process.argv.slice(2);
  if (cmd !== 'shot' || !rom) {
    console.error('Usage: node driver.mjs shot <rom> [frames=300] [out.png=out/shot.png]');
    process.exit(1);
  }
  const frames = Number(framesArg || 300);
  const out = outArg || 'out/shot.png';
  const emu = await EmuHarness.launch(rom);
  await emu.waitFrames(frames);
  await emu.screenshot(out);
  console.log(`Ran ${frames} frames of ${rom}; screenshot -> ${out} (frame ${await emu.frameNum()})`);
  await emu.close();
}
