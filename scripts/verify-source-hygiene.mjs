// Source hygiene gate.
//
// Why this exists: while writing the library index, two raw C0 control
// characters (NUL and UNIT SEPARATOR) reached the source as literal bytes
// inside string and template literals. They are invisible in an editor, in a
// diff, and in review, and they silently changed the value of a composite key.
// A separator is fine; an invisible one is not. Write it as an escape.
//
// The gate scans every tracked source file for raw C0 control characters other
// than tab and newline, and for a leading byte-order mark.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRECTORIES = new Set(['.git', '.worktrees', 'node_modules', 'vendor', 'plan', 'dist', 'test/fixtures']);
const SOURCE = /\.(html|js|mjs|json|css|md|sh|toml|jsonc)$/;

// Everything in C0 except tab (09) and line feed (0A). Carriage return (0D) is
// included: this repository is LF-only, so a CR is a defect too.
// oxlint-disable-next-line no-control-regex -- this check exists to find control characters
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path);
    if (SKIP_DIRECTORIES.has(entry.name) || SKIP_DIRECTORIES.has(relativePath)) continue;
    if (entry.isDirectory()) await walk(path);
    else if (SOURCE.test(entry.name)) files.push(path);
  }
}
await walk(root);

const findings = [];
for (const path of files) {
  const source = await readFile(path, 'utf8');
  if (source.charCodeAt(0) === 0xfeff) {
    findings.push(`${relative(root, path)}:1 leading byte-order mark`);
  }
  source.split('\n').forEach((line, index) => {
    const match = CONTROL.exec(line);
    if (match) {
      const code = match[0].codePointAt(0).toString(16).padStart(4, '0');
      findings.push(`${relative(root, path)}:${index + 1} raw control character U+${code.toUpperCase()} at column ${match.index + 1}`);
    }
  });
}

if (findings.length) {
  console.error('FAIL — Source hygiene:');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('Write the character as an escape (for example \\u001f) instead of a literal byte.');
  process.exit(1);
}

console.log(`PASS — Source hygiene: ${files.length} files; no raw control characters or byte-order marks`);
