import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sniffLibav } from '../app/decode/libav.mjs';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url)).then(buffer => new Uint8Array(buffer));

const box = (type, ...children) => {
  const body = children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, 8 + body);
  out.set([...type].map(c => c.charCodeAt(0)), 4);
  let at = 8;
  for (const child of children) { out.set(child, at); at += child.length; }
  return out;
};
const raw = bytes => Uint8Array.from(bytes);
const stsd = (...entries) => box('stsd', raw([0, 0, 0, 0, 0, 0, 0, entries.length]), ...entries);
const mp4 = (entryType, { moovFirst = true } = {}) => {
  const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd(box(entryType, raw(Array.from({ length: 28 }).fill(0)))))))));
  const ftyp = box('ftyp', raw([0x4d, 0x34, 0x41, 0x20, 0, 0, 2, 0]));
  const mdat = box('mdat', raw(Array.from({ length: 64 }).fill(7)));
  const parts = moovFirst ? [ftyp, moov, mdat] : [ftyp, mdat, moov];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

test('the ALAC fixture sniffs as alac', async () => {
  assert.equal(sniffLibav(await fixture('audio-alac.m4a')), 'alac');
});

test('an AAC M4A stays with the faster rungs', async () => {
  assert.equal(sniffLibav(await fixture('audio-aac.m4a')), null);
});

test('alac is found with moov before and after the media data', () => {
  assert.equal(sniffLibav(mp4('alac')), 'alac');
  assert.equal(sniffLibav(mp4('alac', { moovFirst: false })), 'alac');
  assert.equal(sniffLibav(mp4('mp4a')), null);
});

test('the existing containers still sniff by magic bytes', async () => {
  assert.equal(sniffLibav(await fixture('audio-wavpack.wv')), 'wavpack');
  assert.equal(sniffLibav(await fixture('audio-wmav2.wma')), 'wma');
  assert.equal(sniffLibav(await fixture('audio-flac.flac')), null);
});

test('a truncated or lying MP4 is refused, not thrown', () => {
  const whole = mp4('alac');
  assert.equal(sniffLibav(whole.subarray(0, 40)), null);
  const lying = whole.slice();
  new DataView(lying.buffer).setUint32(16, 0xffffff00); // moov size past the end
  assert.equal(sniffLibav(lying), null);
  const zero = whole.slice();
  new DataView(zero.buffer).setUint32(16, 4); // moov size smaller than its header
  assert.equal(sniffLibav(zero), null);
});
