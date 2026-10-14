// Run a project's build and turn the compiler output into a short list of
// errors and warnings (GCC/Clang, SDCC/GBDK, RGBDS, GNU ld), so an agent reads
// "src/main.c:12:5: error: 'x' undeclared" instead of a page of make output.

import { spawn } from 'node:child_process';
import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';

/** @typedef {{ level: 'error' | 'warning', file?: string, line?: number, col?: number, msg: string }} Diagnostic */

/** Errors and warnings in build output, in order, without duplicates. @returns {Diagnostic[]} */
export function parseDiagnostics(output) {
  const lines = output.split(/\r?\n/);
  /** @type {Diagnostic[]} */
  const out = [];
  const seen = new Set();
  const add = (d) => {
    const key = `${d.level}|${d.file}|${d.line}|${d.msg}`;
    if (!seen.has(key)) { seen.add(key); out.push(d); }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning)(?:\s+\d+)?:\s*(.+)$/.exec(l)) && !/^collect2|\/ld$|^make/.test(m[1])) {
      add({ level: m[4] === 'warning' ? 'warning' : 'error', file: m[1], line: +m[2], ...(m[3] ? { col: +m[3] } : {}), msg: m[5].trim() });
    } else if ((m = /^(error|warning):\s*([^\s(][^(]*)\((\d+)\)(?:\s*->[^:]*)?:\s*(.*)$/i.exec(l))) {
      // RGBDS: "error: main.asm(12): message" or the message on the next, indented line
      let msg = m[4].trim();
      if (!msg && /^\s+\S/.test(lines[i + 1] ?? '')) msg = lines[++i].trim();
      add({ level: m[1].toLowerCase() === 'warning' ? 'warning' : 'error', file: m[2].trim(), line: +m[3], msg });
    } else if ((m = /^(.+?):\(([^)]+)\):\s*(undefined reference to .+)$/.exec(l))) {
      add({ level: 'error', file: m[1], msg: m[3].replace(/[`']/g, '"') });
    } else if ((m = /undefined reference to [`'](.+?)'/.exec(l))) {
      add({ level: 'error', msg: `undefined reference to "${m[1]}"` });
    } else if ((m = /^\?ASlink-(Error|Warning)-(.+)$/.exec(l))) {
      add({ level: m[1] === 'Error' ? 'error' : 'warning', msg: m[2].trim() });
    }
  }
  return out;
}

/** One line per diagnostic: "file:line:col: level: msg". */
export const formatDiagnostic = (d) => `${d.file ? `${d.file}${d.line ? `:${d.line}${d.col ? `:${d.col}` : ''}` : ''}: ` : ''}${d.level}: ${d.msg}`;

/** Run `command` in a shell in `cwd`. @returns {Promise<{ code: number | null, output: string, ms: number, timedOut: boolean }>} */
export function runCommand(command, cwd, { timeout = 300000, maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let output = '', timedOut = false;
    const take = (b) => { if (output.length < maxOutput) output += b.toString(); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('error', (e) => { output += `\n${e.message}`; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output, ms: Date.now() - t0, timedOut }); });
  });
}

/** A default build command for the project in `dir`, or null. */
export async function detectBuild(dir) {
  const has = async (f) => stat(path.join(dir, f)).then(() => true, () => false);
  if (await has('Makefile') || await has('makefile') || await has('GNUmakefile')) return 'make';
  if (await has('build.sh')) return 'sh build.sh';
  return null;
}

/** The ROM a build produced: the most recently written .gba/.gbc/.gb under `dir`
 *  (two levels deep, skipping node_modules and dot-dirs). */
export async function findRom(dir) {
  /** @type {{ p: string, t: number } | null} */
  let best = null;
  const walk = async (d, depth) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(p, depth + 1);
      } else if (/\.(gba|gbc|gb)$/i.test(e.name)) {
        const t = (await stat(p)).mtimeMs;
        if (best === null || t > best.t) best = { p, t };
      }
    }
  };
  await walk(dir, 0);
  return /** @type {{ p: string } | null} */ (best)?.p ?? null;
}

/** Project settings from gbtest.json in `dir` ({} if there is none). Keys: rom,
 *  build, symbols, charmap, watch, frameCounter. */
export async function readProjectConfig(dir) {
  let text;
  try { text = await readFile(path.join(dir, 'gbtest.json'), 'utf8'); } catch { return {}; }
  try { return JSON.parse(text); } catch (e) { throw new Error(`gbtest.json: ${e.message}`); }
}
