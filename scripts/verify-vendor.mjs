import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = Object.freeze({
  'engine/reel-engine.mjs': '791a691fd8d0d95c9cf7fd27adf3bad2469c918f15e30ed9e57f05d0dad4c175',
  'vendor/mediabunny/mediabunny-1.51.0.min.mjs': '1cd761e442a173c461b1a63cba29cb0816383f3b93b78d64b6e44c6dbce85d2b',
  'vendor/mediabunny/LICENSE-MPL-2.0.txt': '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
  'vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm': '721e5c83cb42d1ceb880dda3be03e9a064e4031c7216814a12d91cc523942512',
  'vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs': '4894c3a8ccce82024f90428d75900855609de1a574eef6a00f7601a2048563ac',
  'vendor/libav/libav-6.10.9.0-nakliamp.loader.mjs': '272cef7c32705b2e70290cf4698350e2c888b00b789f11a97386195aa5d0b691',
  'vendor/libav/LICENSE-LGPL-2.1.txt': '20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95',
  'vendor/libav/LICENSE-LGPL-NOTICE.md': 'afb8d248e345d343a45f74a5666f850d1920fb5a0006621a5a45e570687933bf',
});

for (const [path, digest] of Object.entries(expected)) {
  const bytes = await readFile(resolve(root, path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) throw new Error(`${path}: expected ${digest}, got ${actual}`);
}

const vendor = await readFile(resolve(root, 'VENDOR.md'), 'utf8');
// The table in VENDOR.md is the human-readable half of this pin. It drifted
// once already, so every documented hash must match the file it describes.
for (const [path, digest] of Object.entries(expected)) {
  if (!vendor.includes(digest)) {
    throw new Error(`VENDOR.md does not document the current SHA-256 for ${path}.`);
  }
}
if (!vendor.includes('292b0916d7f139f6f27fe14661772a7dee43da7d')) {
  throw new Error('VENDOR.md omits the exact Reel commit.');
}
if (!vendor.includes('corresponding-source notice') && !vendor.includes('Corresponding Mediabunny source')) {
  throw new Error('VENDOR.md omits Mediabunny source availability.');
}
// LGPL-2.1 obliges the library to stay replaceable and its source locatable.
if (!vendor.includes('github.com/Yahweasel/libav.js')) {
  throw new Error('VENDOR.md omits the libav.js corresponding-source location.');
}
if (!vendor.includes('--enable-gpl')) {
  throw new Error('VENDOR.md omits the GPL-build prohibition for libav.js.');
}

console.log(`PASS — Vendor pin: Reel 292b091; ${Object.keys(expected).length} files match SHA-256`);
