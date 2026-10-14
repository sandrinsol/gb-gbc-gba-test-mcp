#!/usr/bin/env node
// Start the MCP server, installing its dependencies first if they're missing
// (e.g. right after the Claude Code plugin is installed). npm's output goes to
// stderr: stdout carries the MCP protocol.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (args) => spawnSync('npx' === args[0] ? 'npx' : 'npm', args[0] === 'npx' ? args.slice(1) : args, {
  cwd: here, stdio: ['ignore', process.stderr, process.stderr], shell: process.platform === 'win32',
});
if (!existsSync(path.join(here, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
  console.error('gb-gbc-gba-test-mcp: installing dependencies (first run)…');
  if (run(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']).status !== 0) {
    console.error('gb-gbc-gba-test-mcp: `npm install` failed; run it yourself in', here);
    process.exit(1);
  }
  // The browser download can fail (offline, proxy) without blocking startup: the
  // first load_rom then explains how to fix it. Not needed with GBTEST_CHROMIUM.
  if (!process.env.GBTEST_CHROMIUM && run(['npx', 'playwright', 'install', 'chromium']).status !== 0) {
    console.error('gb-gbc-gba-test-mcp: could not download Chromium; set GBTEST_CHROMIUM or run `npx playwright install chromium`.');
  }
}
await import(pathToFileURL(path.join(here, 'mcp-server.mjs')).href).then((m) => m.main());
