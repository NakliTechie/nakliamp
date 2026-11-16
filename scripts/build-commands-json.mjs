#!/usr/bin/env node
// build-commands-json.mjs — write commands.json at the repo root from app/commands/commands.mjs.
// Usage: node scripts/build-commands-json.mjs [--check]   (--check exits 1 when the file is stale)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { manifest } from '../app/commands/commands.mjs';

const target = fileURLToPath(new URL('../commands.json', import.meta.url));
const text = `${JSON.stringify(manifest(), null, 2)}\n`;
const current = existsSync(target) ? readFileSync(target, 'utf8') : '';

if (process.argv.includes('--check')) {
  if (current !== text) { console.error('[commands.json] stale: run `node scripts/build-commands-json.mjs`'); process.exit(1); }
  console.log('[commands.json] up to date');
} else if (current === text) {
  console.log('[commands.json] up to date');
} else {
  writeFileSync(target, text);
  console.log(`[commands.json] wrote ${manifest().commands.length} commands`);
}
