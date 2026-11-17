import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = Object.freeze({
  'engine/reel-engine.mjs': '791a691fd8d0d95c9cf7fd27adf3bad2469c918f15e30ed9e57f05d0dad4c175',
  'engine/LICENSE-reel.txt': '741108235dce3ce3947f4fb000e40cb8de7a4a3f02a18790f2cd91bbe99399bc',
  'vendor/mediabunny/mediabunny-1.51.0.min.mjs': '1cd761e442a173c461b1a63cba29cb0816383f3b93b78d64b6e44c6dbce85d2b',
  'vendor/mediabunny/LICENSE-MPL-2.0.txt': '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
  'vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm': 'cdc5ce039f8e584f01a22d94e5026a17caa61d870978920a29c898ac39b46cd3',
  'vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs': '6248df5db8d7d91f30ce4b678c851fe6030747496407a2e6deabb16ad0cf6b1a',
  'vendor/libav/libav-6.10.9.0-nakliamp.loader.mjs': '272cef7c32705b2e70290cf4698350e2c888b00b789f11a97386195aa5d0b691',
  'vendor/libav/LICENSE-LGPL-2.1.txt': '20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95',
  'vendor/libav/LICENSE-LGPL-NOTICE.md': 'a433962c03da35a986364c456529354d682b9bd596f0a0396174526b1376f463',
  'vendor/music-metadata/music-metadata-12.5.0-write.min.mjs': '3ad39ca1d79786792a249f4adf96092c1a4dec8c7bb5cfdbde7956ebe783d747',
  'vendor/music-metadata/LICENSES.txt': '20ecb284b32a4d5e911b4694d1c97ee0400637990f06e84edd75d77fa07d6d48',
  'vendor/butterchurn/butterchurn-3.0.0-beta.5.min.mjs': 'b5353af542b95cb5264069a0a4f52a23174e45745b58c48e245a3557d229b640',
  'vendor/butterchurn/presets-3.0.0-beta.4.mjs': 'a500b2b85493c37a4001033544294bdb288d0607cc591ec438562149adce4b5e',
  'vendor/butterchurn/LICENSE-MIT.txt': 'e5c204814d7119c939d9f111691e0c2008607d09c2f4679691e6dc5a10f24b98',
  'vendor/butterchurn/LICENSE-presets-MIT.txt': 'e5c204814d7119c939d9f111691e0c2008607d09c2f4679691e6dc5a10f24b98',
  'vendor/webamp/webamp-2.3.1.bundle.min.mjs': '15915991ffc5334e57ec7011a92a75e811a5e701c6358db682e2d5c8d1a3d100',
  'vendor/webamp/LICENSE-MIT.txt': 'fc7f2696d3e70b5c04659de0a843c1d7defebbb14eb2a07a38808fead88d9279',
  'vendor/webamp/LICENSES-bundled.txt': 'e129f54a59cc33a73737886ec2e2f40e6401bca7757976f82cdc844d85061365',
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
// Every vendored file ships with a licence notice beside it, and VENDOR.md names it.
for (const notice of ['engine/LICENSE-reel.txt', 'vendor/webamp/LICENSES-bundled.txt', 'vendor/libav/LICENSE-LGPL-NOTICE.md']) {
  if (!vendor.includes(notice)) throw new Error(`VENDOR.md does not name the licence notice ${notice}.`);
}
// The LGPL notice names the corresponding source, not only the licence.
const lgplNotice = await readFile(resolve(root, 'vendor/libav/LICENSE-LGPL-NOTICE.md'), 'utf8');
for (const fact of ['v6.10.9.0', 'FFmpeg 9.0', 'node mkconfig.js nakliamp', '"decoder-alac"', 'make build-nakliamp', 'github.com/NakliTechie/nakliamp']) {
  if (!lgplNotice.includes(fact)) throw new Error(`vendor/libav/LICENSE-LGPL-NOTICE.md omits ${fact}.`);
}
// The Webamp bundle's third-party notice covers the libraries the review found unnamed.
const webampNotices = await readFile(resolve(root, 'vendor/webamp/LICENSES-bundled.txt'), 'utf8');
for (const pkg of ['react 19.1.0', 'react-dom 19.1.0', 'redux 5.0.1', 'react-redux 8.1.3', 'jszip 3.10.1', 'pako 1.0.11']) {
  if (!webampNotices.includes(`\n${pkg} (`)) throw new Error(`vendor/webamp/LICENSES-bundled.txt has no section for ${pkg}.`);
}

console.log(`PASS — Vendor pin: Reel 292b091; ${Object.keys(expected).length} files match SHA-256`);
