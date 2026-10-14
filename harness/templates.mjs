// Starter projects (../templates): a small working game per toolchain, with a
// test, a gbtest.json and a dev container. createProject copies one.

import { cp, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export const TEMPLATES = {
  'gb-asm': 'Game Boy, RGBDS assembly',
  'gb-c': 'Game Boy, GBDK-2020 C',
  'gba-c': 'Game Boy Advance, C with arm-none-eabi-gcc',
  'gba-tonc': 'Game Boy Advance, C with devkitARM + libtonc',
  'gba-butano': 'Game Boy Advance, C++ with Butano',
};

/** Copy template `name` into `dest` (which must not exist or be empty).
 *  Returns the files written, relative to dest. */
export async function createProject(name, dest) {
  if (!TEMPLATES[name]) throw new Error(`unknown template "${name}"; one of ${Object.keys(TEMPLATES).join(', ')}`);
  const st = await stat(dest).catch(() => null);
  if (st && (!st.isDirectory() || (await readdir(dest)).length)) throw new Error(`${dest} already exists and is not empty`);
  const src = path.join(DIR, name);
  await cp(src, dest, {
    recursive: true,
    // Leave out build output (including ROMs and ELFs built in place).
    filter: (f) => {
      const rel = path.relative(src, f).split(path.sep);
      return !rel.includes('build') && !rel.includes('out') && !rel.includes('node_modules') && !/\.(gba|elf|sav)$/i.test(f);
    },
  });
  // npm leaves .gitignore files out of packages; write it back.
  await writeFile(path.join(dest, '.gitignore'), name.startsWith('gba-') && name !== 'gba-c' ? 'build/\nout/\n*.gba\n*.elf\n*.diff.png\n' : 'build/\n*.diff.png\nout/\n');
  const files = [];
  const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else files.push(path.relative(dest, p)); } };
  await walk(dest);
  return files.sort();
}
