// R3 in-house PCM decode. Run: node --test test/pcm.test.mjs
//
// The three fixtures are real files written by ffmpeg and afconvert, not
// hand-built ones, because the point of this tier is reading what other tools
// actually produce.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePcm, sniffPcm, PCM_CONTAINERS } from '../app/decode/pcm.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = async name => new Uint8Array(await readFile(resolve(root, 'test/fixtures', name)));

test('sniffing recognises each container and rejects others', async () => {
  assert.equal(sniffPcm(await fixture('audio-pcm.aiff')), 'aiff');
  assert.equal(sniffPcm(await fixture('audio-pcm.caf')), 'caf');
  assert.equal(sniffPcm(await fixture('audio-pcm.au')), 'au');
  assert.equal(sniffPcm(await fixture('audio-wav.wav')), null);
  assert.equal(sniffPcm(await fixture('audio-mp3.mp3')), null);
  assert.equal(sniffPcm(new Uint8Array(0)), null);
  assert.equal(sniffPcm(null), null);
});

test('AIFF decodes to real audio at the declared rate', async () => {
  const decoded = decodePcm(await fixture('audio-pcm.aiff'));
  assert.equal(decoded.container, 'aiff');
  assert.equal(decoded.sampleRate, 48000, 'the 80-bit extended sample rate must decode exactly');
  assert.equal(decoded.channelCount, 1);
  assert.ok(Math.abs(decoded.durationS - 0.25) < 0.02, `duration was ${decoded.durationS}`);
  assert.equal(decoded.channels[0].length, decoded.frames);
});

test('CAF decodes to real audio at the declared rate', async () => {
  const decoded = decodePcm(await fixture('audio-pcm.caf'));
  assert.equal(decoded.container, 'caf');
  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.channelCount, 1);
  assert.ok(Math.abs(decoded.durationS - 0.25) < 0.02, `duration was ${decoded.durationS}`);
});

test('AU mu-law decodes and expands to the full range', async () => {
  const decoded = decodePcm(await fixture('audio-pcm.au'));
  assert.equal(decoded.container, 'au');
  assert.equal(decoded.sampleRate, 48000);
  assert.ok(Math.abs(decoded.durationS - 0.25) < 0.02, `duration was ${decoded.durationS}`);
});

test('every decoded sample is a finite value inside [-1, 1]', async () => {
  for (const name of ['audio-pcm.aiff', 'audio-pcm.caf', 'audio-pcm.au']) {
    const decoded = decodePcm(await fixture(name));
    for (const channel of decoded.channels) {
      for (let index = 0; index < channel.length; index += 1) {
        const sample = channel[index];
        assert.ok(Number.isFinite(sample), `${name} sample ${index} is not finite`);
        assert.ok(sample >= -1.0001 && sample <= 1.0001, `${name} sample ${index} is ${sample}`);
      }
    }
  }
});

test('the three containers decode to audibly similar audio', async () => {
  // All three fixtures come from the same source WAV, so their loudness should
  // land close together. A wrong endianness or sign convention would not.
  const energy = async name => {
    const decoded = decodePcm(await fixture(name));
    const channel = decoded.channels[0];
    let sum = 0;
    for (const sample of channel) sum += sample * sample;
    return Math.sqrt(sum / channel.length);
  };
  const aiff = await energy('audio-pcm.aiff');
  const caf = await energy('audio-pcm.caf');
  const au = await energy('audio-pcm.au');

  assert.ok(aiff > 0.001, `AIFF decoded to near silence (${aiff})`);
  assert.ok(caf > 0.001, `CAF decoded to near silence (${caf})`);
  assert.ok(au > 0.001, `AU decoded to near silence (${au})`);
  assert.ok(Math.abs(aiff - caf) / aiff < 0.05, `AIFF ${aiff} and CAF ${caf} disagree`);
  // mu-law is lossy, so it is allowed to differ more, but not by much.
  assert.ok(Math.abs(aiff - au) / aiff < 0.3, `AIFF ${aiff} and AU ${au} disagree`);
});

test('a refusal names why, rather than returning nothing', async () => {
  const cases = [
    [await fixture('audio-mp3.mp3'), 'ERR_NAKLIAMP_PCM_UNKNOWN'],
    [new Uint8Array([0x2e, 0x73, 0x6e, 0x64, 0, 0, 0, 24, 0, 0, 0, 8, 0, 0, 0, 99, 0, 0, 0x1f, 0x40, 0, 0, 0, 1]), 'ERR_NAKLIAMP_PCM_UNSUPPORTED'],
  ];
  for (const [bytes, code] of cases) {
    assert.throws(() => decodePcm(bytes), error => {
      assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
      assert.ok(error.message.length > 10, 'the refusal did not explain itself');
      return true;
    });
  }
});

test('a truncated file is refused rather than decoded into garbage', async () => {
  const full = await fixture('audio-pcm.aiff');
  assert.throws(() => decodePcm(full.slice(0, 8)), error => error.name === 'PcmDecodeError');
});

test('the container list matches what sniffing can return', () => {
  assert.deepEqual([...PCM_CONTAINERS].sort(), ['aifc', 'aiff', 'au', 'caf']);
});
