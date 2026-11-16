import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMp3Header, parseTrim, reconcileTrim } from '../app/audio/trim.mjs';

const text = value => [...value].map(char => char.charCodeAt(0));
const u32 = value => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];

/** ID3 (empty) + one MPEG-1 Layer III 44.1 kHz joint-stereo frame with Info + LAME tag. */
function mp3Bytes({ frames = 100, delay = 576, padding = 1000, encoder = 'LAME3.100', xing = 'Info' } = {}) {
  const bytes = [...text('ID3'), 4, 0, 0, 0, 0, 0, 0];
  bytes.push(0xff, 0xfb, 0x90, 0x64);
  bytes.push(...Array.from({ length: 32 }).fill(0)); // side info, MPEG-1 stereo
  bytes.push(...text(xing), ...u32(0x0f), ...u32(frames), ...u32(123456), ...Array.from({ length: 100 }).fill(0), ...u32(50));
  const lame = [...text(encoder.padEnd(9, ' ').slice(0, 9)), ...Array.from({ length: 12 }).fill(0)];
  lame.push(delay >> 4, ((delay & 0x0f) << 4) | (padding >> 8), padding & 0xff);
  bytes.push(...lame, ...Array.from({ length: 200 }).fill(0));
  return new Uint8Array(bytes);
}

function mp4Bytes(smpb = ' 00000000 00000840 000001CA 00000000003F31F6 00000000 00000000') {
  const bytes = [0, 0, 0, 24, ...text('ftypM4A '), ...Array.from({ length: 12 }).fill(0)];
  // An 'mp4a' sample entry: rate integer part at +28 from the type.
  const entry = [...text('mp4a'), ...Array.from({ length: 24 }).fill(0), 0xac, 0x44, 0, 0];
  bytes.push(0, 0, 0, 36, ...entry);
  const value = text(smpb);
  bytes.push(0, 0, 0, 20, ...text('name'), 0, 0, 0, 0, ...text('iTunSMPB'));
  bytes.push(...u32(16 + value.length), ...text('data'), 0, 0, 0, 1, 0, 0, 0, 0, ...value);
  return new Uint8Array(bytes);
}

function opusBytes({ preSkip = 312, granule = 96312 } = {}) {
  const page = granuleValue => {
    const g = [];
    let rest = granuleValue;
    for (let i = 0; i < 8; i += 1) { g.push(rest % 256); rest = Math.floor(rest / 256); }
    return [...text('OggS'), 0, 0, ...g, ...Array.from({ length: 13 }).fill(0)];
  };
  const head = [...text('OpusHead'), 1, 2, preSkip & 255, preSkip >> 8, 0x80, 0xbb, 0, 0, 0, 0, 0];
  return new Uint8Array([...page(0), ...head, ...Array.from({ length: 64 }).fill(0), ...page(granule), ...Array.from({ length: 16 }).fill(0)]);
}

test('MP3 frame header parsing: MPEG-1 Layer III 44.1 kHz stereo', () => {
  const header = parseMp3Header(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), 0);
  assert.deepEqual(header, { version: 3, sampleRate: 44100, mono: false, samplesPerFrame: 1152, sideInfoBytes: 32 });
  assert.equal(parseMp3Header(new Uint8Array([0xff, 0xfd, 0x90, 0x64]), 0), null, 'Layer II is not handled');
});

test('LAME tag gives delay, padding, and lengths', () => {
  const trim = parseTrim(mp3Bytes());
  assert.equal(trim.format, 'mp3');
  assert.equal(trim.known, true);
  assert.equal(trim.delayFrames, 576);
  assert.equal(trim.paddingFrames, 1000);
  assert.equal(trim.skipFrames, 576 + 529);
  assert.equal(trim.totalFrames, 115200);
  assert.equal(trim.validFrames, 115200 - 576 - 1000);
  assert.equal(trim.sampleRate, 44100);
});

test('an MP3 without a LAME tag trims nothing and says why', () => {
  const trim = parseTrim(mp3Bytes({ encoder: '\u0000\u0000\u0000\u0000' }));
  assert.equal(trim.known, false);
  assert.match(trim.note, /nothing trimmed/);
  const plain = new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...Array.from({ length: 400 }).fill(0)]);
  assert.match(parseTrim(plain).note, /no Xing\/Info header/);
  assert.equal(reconcileTrim(parseTrim(plain), 1000, 44100).applied, false);
});

test('reconcile trims an untrimmed decode, at the decode rate', () => {
  const trim = parseTrim(mp3Bytes());
  const raw = reconcileTrim(trim, 115200, 44100);
  assert.equal(raw.applied, true);
  assert.ok(Math.abs(raw.startS - 1105 / 44100) < 1e-12);
  assert.ok(Math.abs(raw.endS - (1105 + 113624) / 44100) < 1e-12);
  const resampled = reconcileTrim(trim, Math.round(115200 * 48000 / 44100), 48000);
  assert.equal(resampled.applied, true);
  assert.ok(Math.abs(resampled.startS - 1105 / 44100) < 1e-9);
});

test('reconcile leaves alone a decode the browser already trimmed', () => {
  const trim = parseTrim(mp3Bytes());
  const done = reconcileTrim(trim, 113624, 44100);
  assert.equal(done.applied, false);
  assert.match(done.reason, /already trimmed/);
});

test('reconcile handles a decoder that emitted the Info frame as silence', () => {
  const trim = parseTrim(mp3Bytes());
  const withInfo = reconcileTrim(trim, 115200 + 1152, 44100);
  assert.equal(withInfo.applied, true);
  assert.ok(Math.abs(withInfo.startS - (1105 + 1152) / 44100) < 1e-12);
});

test('reconcile refuses to guess when the decoded length matches neither', () => {
  const trim = parseTrim(mp3Bytes());
  const odd = reconcileTrim(trim, 44100 * 10, 44100);
  assert.equal(odd.applied, false);
  assert.match(odd.reason, /matches neither/);
});

test('iTunSMPB gives priming, padding and the original length', () => {
  const trim = parseTrim(mp4Bytes());
  assert.equal(trim.format, 'mp4');
  assert.equal(trim.delayFrames, 2112);
  assert.equal(trim.paddingFrames, 458);
  assert.equal(trim.validFrames, 0x3f31f6);
  assert.equal(trim.sampleRate, 44100);
  const raw = reconcileTrim(trim, 2112 + 0x3f31f6 + 458, 44100);
  assert.equal(raw.applied, true);
  assert.ok(Math.abs(raw.startS - 2112 / 44100) < 1e-12);
});

test('MP4 without iTunSMPB trims nothing', () => {
  const trim = parseTrim(mp4Bytes('').slice(0, 60));
  assert.equal(trim.known, false);
});

test('Opus pre-skip and the last granule give the valid length', () => {
  const trim = parseTrim(opusBytes());
  assert.equal(trim.format, 'opus');
  assert.equal(trim.delayFrames, 312);
  assert.equal(trim.validFrames, 96000);
  assert.equal(trim.sampleRate, 48000);
  assert.equal(reconcileTrim(trim, 96312, 48000).applied, true);
  assert.equal(reconcileTrim(trim, 96000, 48000).applied, false);
});

test('lossless formats need no trim', () => {
  const flac = new Uint8Array([...text('fLaC'), ...Array.from({ length: 40 }).fill(0)]);
  const trim = parseTrim(flac);
  assert.equal(trim.known, true);
  assert.equal(trim.format, 'flac');
  const result = reconcileTrim(trim, 1000, 44100);
  assert.equal(result.applied, false);
  assert.match(result.reason, /lossless/);
});

test('garbage and short input trim nothing', () => {
  assert.equal(parseTrim(new Uint8Array(4)).known, false);
  assert.equal(parseTrim(new Uint8Array(100).fill(7)).known, false);
  assert.equal(parseTrim(null).known, false);
});
