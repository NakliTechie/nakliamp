// ID3v2.2 / ID3v2.3 to ID3v2.4 upgrade (app/tags/id3.mjs) and its use in writeTags.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readTags } from '../app/library/metadata.mjs';
import { upgradeId3, listId3v24Frames, readId3Header } from '../app/tags/id3.mjs';
import { writeTags, planTagWrite } from '../app/tags/write.mjs';
import {
  fixture, blobBytes, equalBytes, mp3Audio, id3Tag, latin1, utf16, concat, PNG, ascii,
} from './tags-helpers.mjs';

function apic23(mime, bytes) {
  return concat(new Uint8Array([0]), new TextEncoder().encode(mime), new Uint8Array([0, 3, 0]), bytes);
}

function txxx(description, value) {
  return concat(latin1(description), new Uint8Array([0]), new TextEncoder().encode(value));
}

async function legacyMp3(tag) {
  const audio = mp3Audio(await fixture('audio-mp3.mp3'));
  return { bytes: concat(tag, audio), audio };
}

const V23_FRAMES = [
  ['TIT2', utf16('Old Title')],
  ['TPE1', latin1('Old Artist')],
  ['TYER', latin1('1987')],
  ['TDAT', latin1('0304')],
  ['TXXX', txxx('REPLAYGAIN_TRACK_GAIN', '-6.20 dB')],
  ['COMM', concat(new Uint8Array([0]), new TextEncoder().encode('eng'), new Uint8Array([0]), new TextEncoder().encode('a comment'))],
  ['RVAD', new Uint8Array([0, 16, 1, 2, 3, 4])],
  ['APIC', apic23('image/png', PNG)],
];

test('upgradeId3 converts an ID3v2.3 tag frame by frame', () => {
  const tag = id3Tag(3, V23_FRAMES);
  const result = upgradeId3(concat(tag, new Uint8Array([0xff, 0xfb, 0x90, 0x00])));
  assert.equal(result.from, 3);
  assert.equal(result.tagLength, tag.length);
  assert.deepEqual(result.dropped, ['RVAD']);
  assert.equal(readId3Header(result.tag).major, 4);
  const frames = listId3v24Frames(result.tag);
  const ids = frames.map((frame) => frame.id);
  assert.deepEqual(ids.sort(), ['APIC', 'COMM', 'TDRC', 'TIT2', 'TPE1', 'TXXX'].sort());
  const tdrc = frames.find((frame) => frame.id === 'TDRC').body;
  assert.equal(ascii(tdrc, 1, tdrc.length - 1), '1987-04-03');
});

test('upgradeId3 reads an unsynchronised ID3v2.3 tag', async () => {
  const tag = id3Tag(3, [['TIT2', latin1('Unsync')], ['APIC', apic23('image/png', PNG)]], 0x80);
  const { bytes } = await legacyMp3(tag);
  const result = upgradeId3(bytes);
  const apic = listId3v24Frames(result.tag).find((frame) => frame.id === 'APIC').body;
  assert.ok(equalBytes(apic.subarray(apic.length - PNG.length), PNG), 'picture bytes restored');
});

test('upgradeId3 converts ID3v2.2 three-letter frames, including PIC', () => {
  const pic = concat(new Uint8Array([0]), new TextEncoder().encode('PNG'), new Uint8Array([3, 0]), PNG);
  const tag = id3Tag(2, [['TT2', latin1('Two Two')], ['TAL', latin1('Album 22')], ['TYE', latin1('1975')], ['PIC', pic], ['XYZ', latin1('?')]]);
  const result = upgradeId3(tag);
  assert.equal(result.from, 2);
  assert.deepEqual(result.dropped, ['XYZ']);
  const frames = listId3v24Frames(result.tag);
  assert.deepEqual(frames.map((frame) => frame.id), ['TIT2', 'TALB', 'TDRC', 'APIC']);
  const apic = frames.find((frame) => frame.id === 'APIC').body;
  assert.equal(ascii(apic, 1, 9), 'image/png');
});

test('upgradeId3 returns null for ID3v2.4 and for no tag', async () => {
  assert.equal(upgradeId3(await fixture('audio-mp3.mp3')), null);
  assert.equal(upgradeId3(await fixture('audio-flac.flac')), null);
});

test('writeTags turns an ID3v2.3 MP3 into ID3v2.4, keeps untouched frames and the audio', async () => {
  const { bytes, audio } = await legacyMp3(id3Tag(3, V23_FRAMES));
  const before = await readTags(new Blob([bytes]));
  assert.equal(before.title, 'Old Title');

  const plan = await planTagWrite(new Blob([bytes]), { album: 'New Album' });
  assert.equal(plan.id3Version, 3);
  assert.ok(plan.notes.some((note) => /ID3v2\.3 tag will be saved as ID3v2\.4/.test(note)));
  assert.ok(plan.notes.some((note) => /RVAD/.test(note)));

  const output = await blobBytes(await writeTags(new Blob([bytes]), { album: 'New Album' }));
  assert.equal(output[3], 4);
  const tags = await readTags(new Blob([output]));
  assert.equal(tags.title, 'Old Title');
  assert.equal(tags.artist, 'Old Artist');
  assert.equal(tags.album, 'New Album');
  assert.equal(tags.year, 1987);
  assert.ok(tags.picture && equalBytes(tags.picture.bytes, PNG));
  const ids = listId3v24Frames(output).map((frame) => frame.id);
  assert.ok(ids.includes('TXXX'), 'ReplayGain TXXX kept');
  assert.ok(ids.includes('COMM'), 'comment kept');
  assert.ok(!ids.includes('RVAD') && !ids.includes('TYER') && !ids.includes('TDAT'));
  if (tags.replayGain !== undefined && tags.replayGain !== null) assert.equal(tags.replayGain.trackGainDb, -6.2);
  assert.ok(equalBytes(mp3Audio(output), audio), 'audio unchanged');
});

test('writeTags turns an ID3v2.2 MP3 into ID3v2.4', async () => {
  const { bytes, audio } = await legacyMp3(id3Tag(2, [['TT2', latin1('Two Two')], ['TP1', latin1('Artist 22')]]));
  const plan = await planTagWrite(new Blob([bytes]));
  assert.equal(plan.id3Version, 2);
  const output = await blobBytes(await writeTags(new Blob([bytes]), { genre: 'Folk' }));
  const tags = await readTags(new Blob([output]));
  assert.equal(output[3], 4);
  assert.equal(tags.title, 'Two Two');
  assert.equal(tags.artist, 'Artist 22');
  assert.equal(tags.genre, 'Folk');
  assert.ok(equalBytes(mp3Audio(output), audio));
});

test('an ID3v2.4 MP3 gets no upgrade note', async () => {
  const plan = await planTagWrite(new Blob([await fixture('audio-mp3.mp3')]), { title: 'x' });
  assert.equal(plan.id3Version, 4);
  assert.deepEqual(plan.notes, []);
});

test('an MP3 with no ID3 tag gets one', async () => {
  const audio = mp3Audio(await fixture('audio-mp3.mp3'));
  assert.notEqual(ascii(audio, 0, 3), 'ID3');
  const output = await blobBytes(await writeTags(new Blob([audio]), { title: 'Fresh' }));
  assert.equal((await readTags(new Blob([output]))).title, 'Fresh');
  assert.ok(equalBytes(mp3Audio(output), audio));
});
