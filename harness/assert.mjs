// Golden-frame comparison helpers for emulator screenshots.
//
//   import { compare, assertGolden } from './assert.mjs';
//
// compare(a, b)      -> pixel-diff metrics + a visual diff PNG
// assertGolden(...)  -> compare a screenshot to a stored golden, or create it

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng } from './png.mjs';

/** Compare two PNG buffers. `ignore` is a list of {x, y, w, h} rectangles (image
 *  pixels) left out of the comparison — clocks, timers, random sparkles.
 *  @returns {{ width, height, diffPixels, totalPixels, fraction, diffPng }} */
export function compare(aBuf, bBuf, { tolerance = 16, ignore = [] } = {}) {
  const a = decodePng(aBuf);
  const b = decodePng(bBuf);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      width: a.width, height: a.height,
      diffPixels: a.width * a.height, totalPixels: a.width * a.height,
      fraction: 1, mismatchDimensions: true, diffPng: null,
    };
  }
  const { width, height } = a;
  const out = new Uint8Array(width * height * 3); // RGB diff image
  let diffPixels = 0, total = 0;
  const ignored = (x, y) => ignore.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (y * width + x) * a.channels;
      const ib = (y * width + x) * b.channels;
      if (ignore.length && ignored(x, y)) {
        const o = (y * width + x) * 3;
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 96; // masked: dark blue
        continue;
      }
      total++;
      const dr = Math.abs(a.data[ia] - b.data[ib]);
      const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
      const db = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      const o = (y * width + x) * 3;
      if (dr > tolerance || dg > tolerance || db > tolerance) {
        diffPixels++;
        out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; // highlight diffs in red
      } else {
        // dim grayscale of the candidate so context is visible
        const g = (b.data[ib] * 0.3 + b.data[ib + 1] * 0.59 + b.data[ib + 2] * 0.11) * 0.5 | 0;
        out[o] = g; out[o + 1] = g; out[o + 2] = g;
      }
    }
  }
  return {
    width, height, diffPixels, totalPixels: total,
    fraction: total ? diffPixels / total : 0, mismatchDimensions: false,
    diffPng: encodePng({ width, height, data: out }),
  };
}

/** Assert a screenshot matches a golden PNG on disk.
 *  Missing golden, or env UPDATE_GOLDENS=1, writes the golden and passes.
 *  On mismatch above `threshold`, writes `<golden>.diff.png` and throws. */
export async function assertGolden(candidateBuf, goldenPath, { threshold = 0.02, tolerance = 16, ignore = [] } = {}) {
  const abs = path.resolve(process.cwd(), goldenPath);
  const update = process.env.UPDATE_GOLDENS === '1';
  if (!existsSync(abs) || update) {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, candidateBuf);
    return { created: true, updated: existsSync(abs) && update, fraction: 0, pass: true, goldenPath: abs };
  }
  const goldenBuf = await readFile(abs);
  const res = compare(goldenBuf, candidateBuf, { tolerance, ignore });
  const pass = res.fraction <= threshold && !res.mismatchDimensions;
  if (!pass && res.diffPng) {
    const diffPath = abs.replace(/\.png$/i, '') + '.diff.png';
    await writeFile(diffPath, res.diffPng);
    res.diffPath = diffPath;
  }
  return { created: false, pass, threshold, ...res, goldenPath: abs };
}
