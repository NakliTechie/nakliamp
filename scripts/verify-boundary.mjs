import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corePath = resolve(root, 'engine/nakliamp-engine.mjs');
const core = await readFile(corePath, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  /^import \{ createReelEngine \} from '\.\/reel-engine\.mjs';$/m.test(core),
  'NakliAmp core does not import the pinned Reel boundary.',
);
assert(!/\b(document|querySelector|HTMLElement)\b/.test(core), 'NakliAmp core imports UI-layer concepts.');
assert(/export function createNakliAmpEngine/.test(core), 'NakliAmp core factory is missing.');

const sourceFiles = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.worktrees', 'vendor', 'dist'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(html|js|mjs)$/.test(entry.name)) sourceFiles.push(path);
  }
}
await walk(root);

const directIngress = [];
for (const path of sourceFiles) {
  if (path === resolve(root, 'engine/reel-engine.mjs')) continue;
  const source = await readFile(path, 'utf8');
  if (/from\s+['"][^'"]*mediabunny/i.test(source)) directIngress.push(relative(root, path));
}
assert(directIngress.length === 0, `Direct Mediabunny imports: ${directIngress.join(', ')}`);

const readme = await readFile(resolve(root, 'README.md'), 'utf8');
assert(readme.includes('no analytics — verify with the network tab.'), 'README omits the network-verifiable analytics claim.');

console.log('PASS — Engine boundary: headless NakliAmp core; pinned Reel ingress; zero direct Mediabunny imports');
