import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(root, 'test/fixtures');
const manifest = JSON.parse(await readFile(resolve(root, 'test/manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1) throw new Error('Unknown fixture manifest schema.');

const declared = new Set();
for (const fixture of manifest.fixtures) {
  declared.add(fixture.file);
  const path = resolve(fixtureRoot, fixture.file);
  const info = await stat(path);
  if (info.size !== fixture.bytes) throw new Error(`${fixture.file}: byte count changed.`);
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  if (digest !== fixture.sha256) throw new Error(`${fixture.file}: SHA-256 changed.`);
}

const mediaFiles = (await readdir(fixtureRoot)).filter(file => /\.(aac|ape|flac|m4a|mka|mp3|ogg|opus|wav|wave|wma)$/i.test(file));
for (const file of mediaFiles) {
  if (!declared.has(file)) throw new Error(`${file}: undeclared golden fixture.`);
}
if (manifest.fixtures.filter(item => item.role === 'audio-positive').length !== 7) {
  throw new Error('The gate requires seven positive audio fixtures.');
}
if (manifest.fixtures.filter(item => item.role === 'audio-refusal').length !== 1) {
  throw new Error('The gate requires one named refusal fixture.');
}

console.log('PASS — Golden audio: 8 files; 7 positives; 1 WMA refusal');
