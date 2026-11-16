// The classic skin face refuses a .wsz without its own main window art; any other
// missing sheet falls back to the neutral art patched into the vendored bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipEntryNames, missingSkinParts, skinContentProblem } from '../app/ui/webamp-face.mjs';

/** A stored (uncompressed) zip with the given names and empty files. */
function zipOf(names) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const bytes = enc.encode(name);
    const local = new Uint8Array(30 + bytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(26, bytes.length, true);
    local.set(bytes, 30);
    const central = new Uint8Array(46 + bytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(28, bytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(bytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, names.length, true);
  ev.setUint16(10, names.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

test('zipEntryNames reads names from the central directory', () => {
  assert.deepEqual(zipEntryNames(zipOf(['main.bmp', 'skin/PLEDIT.BMP'])), ['main.bmp', 'skin/PLEDIT.BMP']);
});

test('a complete skin passes, case-insensitive and inside a folder', () => {
  assert.equal(skinContentProblem(zipOf(['Main.bmp', 'titlebar.BMP', 'MySkin/pledit.bmp', 'cbuttons.bmp'])), null);
  assert.deepEqual(missingSkinParts(['MAIN.BMP', 'x\\TITLEBAR.BMP', 'PLEDIT.BMP']), []);
});

test('a skin with only its main window passes; the rest falls back to neutral art', () => {
  assert.equal(skinContentProblem(zipOf(['main.bmp'])), null);
  assert.equal(skinContentProblem(zipOf(['Skin/MAIN.BMP', 'cbuttons.bmp'])), null);
  assert.deepEqual(missingSkinParts(['MAIN.BMP']), []);
});

test('a skin without MAIN.BMP is refused by naming it', () => {
  const problem = skinContentProblem(zipOf(['titlebar.bmp', 'pledit.bmp', 'cbuttons.bmp']));
  assert.match(problem, /lacks MAIN\.BMP/);
  assert.match(skinContentProblem(zipOf(['readme.txt'])), /MAIN\.BMP/);
});

test('bytes that are not a zip are refused in plain words', () => {
  assert.match(skinContentProblem(new Uint8Array(100)), /not a zip/);
  const damaged = zipOf(['main.bmp']);
  new DataView(damaged.buffer).setUint32(damaged.length - 22 + 16, 3, true);
  assert.match(skinContentProblem(damaged), /damaged/);
});
