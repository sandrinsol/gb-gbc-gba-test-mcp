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
import { readFile, writeFile, stat, unlink, mkdir } from 'node:fs/promises';
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

function startServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(rootDir, path.normalize(urlPath));
      if (!filePath.startsWith(rootDir)) { res.writeHead(403).end(); return; }
      const info = await stat(filePath);
      if (info.isDirectory()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Browser + static server, launched once and shared by every `reuse: true` harness
// (the MCP server uses this so load_rom doesn't cold-start Chromium each time).
let sharedHost = null;

async function startHost({ headless = true } = {}) {
  const { chromium } = await import('playwright');
  const { server, port } = await startServer(ROOT);
  const browser = await chromium.launch({
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
  return {
    browser, server, port,
    async close() { await browser.close().catch(() => {}); await new Promise((r) => server.close(r)); },
  };
}

export class EmuHarness {
  constructor({ host, shared, context, page, tempRom, system, blocked }) {
    this.host = host; this._shared = shared;
    this.browser = host.browser; this.server = host.server;
    this.context = context; this.page = page;
    this._tempRom = tempRom; // copied-in ROM to clean up on close (if any)
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

    // ROM must live under ROOT so the static server can serve it. Copy if needed,
    // and remember the copy so close() can remove it.
    let served = absRom, tempRom = null;
    if (!absRom.startsWith(ROOT + path.sep)) {
      await mkdir(path.join(ROOT, 'harness', 'out'), { recursive: true });
      tempRom = path.join(ROOT, 'harness', 'out', `_rom_${process.pid}_${Date.now()}_${path.basename(absRom)}`);
      await writeFile(tempRom, await readFile(absRom));
      served = tempRom;
    }
    const romUrlPath = '/' + path.relative(ROOT, served).split(path.sep).map(encodeURIComponent).join('/');

    let host;
    if (reuse) {
      if (!sharedHost || !sharedHost.browser.isConnected()) sharedHost = await startHost({ headless });
      host = sharedHost;
    } else {
      host = await startHost({ headless });
    }
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
      if (!reuse) await host.close();
      if (tempRom) await unlink(tempRom).catch(() => {});
    };
    const url = `http://127.0.0.1:${host.port}/harness/page.html?rom=${encodeURIComponent(romUrlPath)}${fast ? '' : '&fast=0'}`;
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
    const system = await page.evaluate(() => { window.Emu.pause(); return window.Emu.system; });
    return new EmuHarness({ host, shared: reuse, context, page, tempRom, system, blocked });
  }

  /** Close the shared browser + server used by `reuse: true` harnesses. */
  static async shutdown() {
    const h = sharedHost; sharedHost = null;
    if (h) await h.close();
  }

  frameNum() { return this.page.evaluate(() => window.Emu.frameNum()); }
  videoDimensions() { return this.page.evaluate(() => window.Emu.videoDimensions()); }
  waitFrames(n) { return this.page.evaluate((n) => window.Emu.waitFrames(n), n); }
  waitUntilFrame(abs) { return this.page.evaluate((a) => window.Emu.waitUntilFrame(a), abs); }
  setButton(name, pressed) { return this.page.evaluate(([n, p]) => window.Emu.setButton(n, p), [name, pressed]); }
  /** Hold/release several buttons at once (e.g. ['A', 'B']). */
  setButtons(names, pressed) { return this.page.evaluate(([n, p]) => window.Emu.setButtons(n, p), [names, pressed]); }
  heldButtons() { return this.page.evaluate(() => window.Emu.heldButtons()); }
  /** Press, hold `hold` frames, release, settle `release` frames. `name` may be an array (combo). */
  tap(name, hold = 4, release = 4) { return this.page.evaluate(([n, h, r]) => window.Emu.tap(n, h, r), [name, hold, release]); }
  /** Fast-forward counters: { ffWaits, recoveries }. */
  stats() { return this.page.evaluate(() => window.Emu.stats); }
  restart() { return this.page.evaluate(() => window.Emu.restart()); }

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
  async _rawState() {
    return Buffer.from(await this.page.evaluate(() => window.Emu.rawState()), 'base64');
  }
  async loadState(buf) {
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

  /** Parse a fresh save state into typed RAM regions.
   *  GBA: { ewram, iwram, vram, pram, oam, io }. GB/GBC: { wram, vram, sram, hram, io }. */
  async readRegions() { return this._mem.parseState(await this._rawState()); }

  /** Read `length` bytes at a bus address. GBA e.g. 0x03000000 (IWRAM); GB/GBC e.g.
   *  0xC000 (WRAM), 0xFF80 (HRAM). Snapshots a save state, so it reflects the current
   *  frame. Addresses are interpreted for whichever console the loaded ROM is. */
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
    const state = await this._rawState();
    this._mem.writeMemory(state, addr, bytes);
    await this.page.evaluate((b) => window.Emu.pokeState(b), state.toString('base64'));
    return (await this.readMemory(addr, bytes.length)).equals(bytes);
  }
  async writeU8(addr, v) { await this.writeMemory(addr, Buffer.from([v & 0xff])); }
  async writeU16(addr, v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); await this.writeMemory(addr, b); }
  async writeU32(addr, v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); await this.writeMemory(addr, b); }

  async close() {
    await this.context?.close().catch(() => {});
    if (!this._shared) await this.host?.close();
    if (this._tempRom) await unlink(this._tempRom).catch(() => {});
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
