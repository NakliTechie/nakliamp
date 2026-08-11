import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = Object.freeze({
  'engine/reel-engine.mjs': '56f5372eed1f15f024b17d3c24f39a6a9d60dab17aa0898900db97f23a044971',
  'vendor/mediabunny/mediabunny-1.51.0.min.mjs': '1cd761e442a173c461b1a63cba29cb0816383f3b93b78d64b6e44c6dbce85d2b',
  'vendor/mediabunny/LICENSE-MPL-2.0.txt': '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
});

for (const [path, digest] of Object.entries(expected)) {
  const bytes = await readFile(resolve(root, path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) throw new Error(`${path}: expected ${digest}, got ${actual}`);
}

const vendor = await readFile(resolve(root, 'VENDOR.md'), 'utf8');
if (!vendor.includes('28e871525b766d1ae84790e150eb447cc396badc')) {
  throw new Error('VENDOR.md omits the exact Reel commit.');
}
if (!vendor.includes('corresponding-source notice') && !vendor.includes('Corresponding Mediabunny source')) {
  throw new Error('VENDOR.md omits Mediabunny source availability.');
}

console.log('PASS — Vendor pin: Reel 28e8715; three files match SHA-256');
