// Packaging check: `npm pack` the repo, install the tarball into an empty project,
// start the installed `gb-gbc-gba-test-mcp` bin over stdio, and drive a ROM with it.
// Proves the published package is self-contained (cores, page, modules, deps).
//
//   node tests/package.mjs   (exit 0 = pass, 1 = fail; needs the npm registry)

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeInteractiveGbRom } from './gb-roms.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

// The root (published) and harness (dev) manifests must agree.
const root = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8'));
const dev = JSON.parse(await readFile(path.join(REPO, 'harness', 'package.json'), 'utf8'));
ok('versions match', root.version === dev.version, `${root.version} / ${dev.version}`);
ok('dependencies match', JSON.stringify(root.dependencies) === JSON.stringify(dev.dependencies));
// The Claude Code plugin manifest starts the server through launch.mjs.
const plugin = JSON.parse(await readFile(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
const launch = plugin.mcpServers?.['gb-gbc-gba-test']?.args?.[0]?.replace('${CLAUDE_PLUGIN_ROOT}', REPO);
ok('plugin version matches', plugin.version === root.version, `${plugin.version} / ${root.version}`);
ok('plugin starts an existing launcher', !!launch && existsSync(launch), launch);
ok('plugin skills exist', ['gb-game-testing', 'gb-homebrew-dev', 'gb-ci-tests', 'gb-hardware', 'gb-playtest', 'gba-dev', 'butano'].every((n) => existsSync(path.join(REPO, 'skills', n, 'SKILL.md'))));
ok('plugin agent exists', existsSync(path.join(REPO, 'agents', 'gb-tester.md')));

const work = await mkdtemp(path.join(tmpdir(), 'gbtest-pkg-'));
try {
  const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const [{ filename, files }] = JSON.parse(npm(['pack', '--json', '--pack-destination', work], REPO));
  const names = files.map((f) => f.path);
  ok('tarball has the cores', ['data/cores/mgba-wasm.data', 'data/cores/gambatte-wasm.data', 'data/cores/reports/gambatte.json'].every((f) => names.includes(f)));
  ok('tarball has the page + server', names.includes('harness/page.html') && names.includes('harness/mcp-server.mjs'));
  ok('tarball has no tests or sample ROM', !names.some((f) => f.startsWith('harness/tests/') || f.endsWith('.gba')));
  ok('tarball has the templates without build output', ['templates/gb-asm/src/main.asm', 'templates/gb-c/src/main.c', 'templates/gba-c/gba.ld', 'templates/gba-c/.devcontainer/Dockerfile', 'templates/gba-tonc/src/main.c', 'templates/gba-butano/graphics/player.bmp'].every((f) => names.includes(f)) && !names.some((f) => /^templates\/[^/]+\/(build\/|[^/]+\.(gba|elf)$)/.test(f)));

  await writeFile(path.join(work, 'package.json'), '{"name":"consumer","private":true}');
  // Skip the postinstall; fetch the browser this install's Playwright expects (a
  // no-op when cached) unless GBTEST_CHROMIUM points at one.
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(work, filename)], work);
  if (!process.env.GBTEST_CHROMIUM) npm(['exec', '--', 'playwright', 'install', 'chromium'], work);
  const rom = path.join(work, 'input.gb');
  await writeFile(rom, makeInteractiveGbRom());

  const sdk = (p) => import(pathToFileURL(path.join(work, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href);
  const { Client } = await sdk('client/index.js');
  const { StdioClientTransport } = await sdk('client/stdio.js');
  const client = new Client({ name: 'pkg-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: path.join(work, 'node_modules', '.bin', 'gb-gbc-gba-test-mcp'),
    env: { ...process.env, GBTEST_ROOT: work },
    stderr: 'ignore',
  }));
  try {
    ok('installed server reports its version', client.getServerVersion()?.version === root.version);
    const load = /** @type {any} */ (await client.callTool({ name: 'load_rom', arguments: { rom: 'input.gb' } }));
    ok('installed server boots a ROM', !load.isError && load.structuredContent?.system === 'GB/GBC', load.content?.[0]?.text);
    const shot = /** @type {any} */ (await client.callTool({ name: 'screenshot', arguments: { scale: 1 } }));
    ok('installed server takes screenshots', shot.content?.some((c) => c.type === 'image'));
    execFileSync(path.join(work, 'node_modules', '.bin', 'gb-gbc-gba-test-mcp'), ['new', 'gb-c', 'mygame'], { cwd: work });
    ok('installed bin creates a project', ['src/main.c', 'Makefile', 'gbtest.json', '.gitignore', 'tests/gb/smoke.json'].every((f) => existsSync(path.join(work, 'mygame', f))));
  } finally {
    await client.close();
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
