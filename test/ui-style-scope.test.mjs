// The shell's stylesheet (index.html) and the panels (app/ui/*.mjs) share one
// document, so a bare class rule in the shell styles any panel element that
// happens to use the same class name. That is how the tag editor's cover box
// (class "art") drew the Now playing record over itself (UX review M3).
// This check lists every class that both a bare shell rule and a panel use;
// only the classes the panels are meant to borrow from the shell may appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
// Shell classes the panels use on purpose: the shared button styles.
const SHARED = new Set(['btn', 'primary']);

function shellClasses() {
  const html = readFileSync(new URL('index.html', ROOT), 'utf8');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const classes = new Set();
  // A selector that starts with a class: at a rule start or after a comma.
  for (const match of css.matchAll(/(?:^|[}\n,])\s*\.([a-zA-Z][\w-]*)/g)) classes.add(match[1]);
  return classes;
}

function panelClasses() {
  const used = new Map();
  const dir = new URL('app/ui/', ROOT);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.mjs'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(/(?:className|class)\s*:\s*['`]([^'`]+)['`]/g)) {
      for (const name of match[1].split(/\s+/)) {
        if (!/^[a-zA-Z][\w-]*$/.test(name)) continue;
        if (!used.has(name)) used.set(name, new Set());
        used.get(name).add(file);
      }
    }
  }
  return used;
}

test('no panel class name collides with a bare shell rule', () => {
  const shell = shellClasses();
  assert.ok(shell.size > 20, `found only ${shell.size} shell classes; the parser has drifted`);
  const clashes = [...panelClasses()]
    .filter(([name]) => shell.has(name) && !SHARED.has(name))
    .map(([name, files]) => `.${name} (${[...files].join(', ')})`);
  assert.deepEqual(clashes, [], `Shell rules also style panel elements: ${clashes.join('; ')}`);
});
