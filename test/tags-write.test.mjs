// Round-trip tests for app/tags/write.mjs: write tags into every committed
// fixture of a writable format, re-read with the library reader, and check
// the audio payload is byte-identical.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readTags } from '../app/library/metadata.mjs';
import { writeTags, writeTagsDetailed, inspectTagFormat, normalisePatch, TagWriteError } from '../app/tags/write.mjs';
import { listId3v24Frames } from '../app/tags/id3.mjs';
import {
  fixture, blobBytes, equalBytes, mp3Audio, flacAudio, flacBlockTypes, oggAudioPages, oggCrc,
  mp4Mdat, mp4ChunkOffsets, mp4Find, fastStart, PNG, JPEG, ascii,
} from './tags-helpers.mjs';

const FULL = Object.freeze({
  title: 'Nový název – ü', artist: 'Ärtist', album: 'Ålbum', albumArtist: 'Various Artists',
  trackNo: 3, trackTotal: 12, discNo: 1, discTotal: 2, year: 1999, genre: 'Jazz', rating: 4,
  picture: { mime: 'image/png', bytes: PNG },
});

const TEXT_EXPECT = ['title', 'artist', 'album', 'albumArtist', 'trackNo', 'trackTotal', 'discNo', 'discTotal', 'year', 'genre'];

function assertTags(tags, patch, { rating = true } = {}) {
  for (const field of TEXT_EXPECT) assert.equal(tags[field], patch[field], field);
  assert.ok(tags.picture, 'picture present');
  assert.equal(tags.picture.mime, patch.picture.mime);
  assert.ok(equalBytes(tags.picture.bytes, patch.picture.bytes), 'picture bytes');
  if (rating && tags.rating !== undefined) assert.equal(tags.rating, patch.rating, 'rating');
}

const CASES = [
  {
    name: 'audio-mp3.mp3',
    format: 'mp3',
    audio: (bytes) => mp3Audio(bytes),
  },
  {
    name: 'audio-flac.flac',
    format: 'flac',
    audio: (bytes) => { const { streaminfo, frames } = flacAudio(bytes); return new Uint8Array([...streaminfo, ...frames]); },
  },
  {
    name: 'audio-vorbis.ogg',
    format: 'ogg-vorbis',
    audio: (bytes) => oggPayload(bytes, 3),
  },
  {
    name: 'audio-opus.ogg',
    format: 'ogg-opus',
    audio: (bytes) => oggPayload(bytes, 2),
  },
  {
    name: 'audio-aac.m4a',
    format: 'mp4',
    audio: (bytes) => mp4Mdat(bytes),
    rating: false,
  },
];

/** Audio pages with sequence number and CRC masked out: lacing, granule and body must match. */
function oggPayload(bytes, headerPackets) {
  const { audioPages } = oggAudioPages(bytes, headerPackets);
  const parts = [];
  for (const page of audioPages) {
    parts.push(...page.raw.subarray(0, 18), ...page.raw.subarray(26));
  }
  return new Uint8Array(parts);
}

for (const testCase of CASES) {
  test(`writeTags ${testCase.name}: every field round-trips and the audio is unchanged`, async () => {
    const input = await fixture(testCase.name);
    const info = await inspectTagFormat(new Blob([input]));
    assert.equal(info.format, testCase.format);
    assert.equal(info.writable, true);

    const output = await blobBytes(await writeTags(new Blob([input]), FULL));
    const tags = await readTags(new Blob([output]));
    assertTags(tags, FULL, { rating: testCase.rating !== false });
    assert.ok(equalBytes(testCase.audio(output), testCase.audio(input)), 'audio payload byte-identical');
    // The input must be untouched.
    assert.ok(equalBytes(input, await fixture(testCase.name)));
  });

  test(`writeTags ${testCase.name}: a second write over the first is stable`, async () => {
    const input = await fixture(testCase.name);
    const first = await blobBytes(await writeTags(new Blob([input]), FULL));
    const second = await blobBytes(await writeTags(new Blob([first]), FULL));
    // Vorbis-comment writers may move a re-set field (RATING) to the end, so
    // the first rewrite can reorder; from then on the bytes are a fixed point.
    assert.equal(second.length, first.length, 'same size');
    assert.deepEqual(await readTags(new Blob([second])), await readTags(new Blob([first])), 'same tags');
    const third = await blobBytes(await writeTags(new Blob([second]), FULL));
    assert.ok(equalBytes(third, second), `third write identical to second (${second.length} vs ${third.length} bytes)`);
    assert.ok(equalBytes(testCase.audio(third), testCase.audio(input)));
  });

  test(`writeTags ${testCase.name}: the picture survives an edit that does not name it`, async () => {
    const input = await fixture(testCase.name);
    const first = await blobBytes(await writeTags(new Blob([input]), FULL));
    const second = await blobBytes(await writeTags(new Blob([first]), { title: 'Second title', genre: null }));
    const tags = await readTags(new Blob([second]));
    assert.equal(tags.title, 'Second title');
    assert.equal(tags.genre, null, 'genre removed');
    assert.equal(tags.artist, FULL.artist, 'artist kept');
    assert.equal(tags.trackNo, 3);
    assert.ok(tags.picture && equalBytes(tags.picture.bytes, PNG), 'picture kept');
    assert.ok(equalBytes(testCase.audio(second), testCase.audio(input)), 'audio unchanged after two writes');
  });

  test(`writeTags ${testCase.name}: replacing and removing the picture`, async () => {
    const input = await fixture(testCase.name);
    const first = await blobBytes(await writeTags(new Blob([input]), FULL));
    const replaced = await blobBytes(await writeTags(new Blob([first]), { picture: { mime: 'image/jpeg', bytes: JPEG } }));
    const replacedTags = await readTags(new Blob([replaced]));
    assert.equal(replacedTags.picture.mime, 'image/jpeg');
    assert.ok(equalBytes(replacedTags.picture.bytes, JPEG));
    const removed = await blobBytes(await writeTags(new Blob([replaced]), { picture: null }));
    assert.equal((await readTags(new Blob([removed]))).picture, null);
    assert.ok(equalBytes(testCase.audio(removed), testCase.audio(input)));
  });
}

test('writeTags MP3: output is an ID3v2.4 tag with the expected frames, including POPM', async () => {
  const output = await blobBytes(await writeTags(new Blob([await fixture('audio-mp3.mp3')]), FULL));
  assert.equal(ascii(output, 0, 3), 'ID3');
  assert.equal(output[3], 4);
  const ids = listId3v24Frames(output).map((frame) => frame.id);
  for (const id of ['TIT2', 'TPE1', 'TALB', 'TPE2', 'TRCK', 'TPOS', 'TDRC', 'TCON', 'POPM', 'APIC']) assert.ok(ids.includes(id), id);
  assert.ok(ids.includes('TSSE'), 'the existing encoder frame is kept');
  const popm = listId3v24Frames(output).find((frame) => frame.id === 'POPM').body;
  const ratingByte = popm[popm.indexOf(0) + 1];
  assert.ok(ratingByte >= 196 && ratingByte < 255, `4 stars on the WMP scale, got ${ratingByte}`);
});

test('writeTags MP3: rating 0 removes POPM', async () => {
  const rated = await blobBytes(await writeTags(new Blob([await fixture('audio-mp3.mp3')]), { rating: 5 }));
  assert.ok(listId3v24Frames(rated).some((frame) => frame.id === 'POPM'));
  const unrated = await blobBytes(await writeTags(new Blob([rated]), { rating: 0 }));
  assert.ok(!listId3v24Frames(unrated).some((frame) => frame.id === 'POPM'));
});

test('writeTags FLAC: rewrites VORBIS_COMMENT and PICTURE, keeps STREAMINFO first and padding', async () => {
  const output = await blobBytes(await writeTags(new Blob([await fixture('audio-flac.flac')]), FULL));
  const types = flacBlockTypes(output);
  assert.equal(types[0], 0, 'STREAMINFO first');
  assert.ok(types.includes(4), 'VORBIS_COMMENT');
  assert.ok(types.includes(6), 'PICTURE');
  assert.ok(types.includes(1), 'PADDING');
  const text = new TextDecoder().decode(output.subarray(0, 4096));
  assert.match(text, /RATING=80/);
});

test('writeTags Ogg: every output page has a valid CRC, contiguous sequence numbers and kept granules', async () => {
  for (const [name, headers] of [['audio-vorbis.ogg', 3], ['audio-opus.ogg', 2]]) {
    const input = await fixture(name);
    const output = await blobBytes(await writeTags(new Blob([input]), FULL));
    const { allPages, audioPages } = oggAudioPages(output, headers);
    allPages.forEach((page, index) => {
      assert.equal(page.crc, oggCrc(page.raw), `${name} page ${index} CRC`);
      assert.equal(page.sequence, index, `${name} page ${index} sequence`);
    });
    const before = oggAudioPages(input, headers).audioPages.map((page) => page.granule);
    assert.deepEqual(audioPages.map((page) => page.granule), before, `${name} granules`);
    assert.ok(allPages.every((page) => page.serial === allPages[0].serial));
  }
});

test('writeTags MP4: moov-before-mdat file gets its chunk offsets fixed', async () => {
  const input = fastStart(await fixture('audio-aac.m4a'));
  assert.equal((await readTags(new Blob([input]))).durationS, 1, 'the rebuilt fixture still parses');
  const output = await blobBytes(await writeTags(new Blob([input]), FULL));
  const before = mp4ChunkOffsets(input);
  const after = mp4ChunkOffsets(output);
  assert.equal(after.length, before.length);
  assert.ok(before.length > 0);
  const delta = after[0].value - before[0].value;
  assert.ok(delta > 0, 'moov grew, so the audio moved');
  before.forEach((entry, index) => {
    assert.equal(after[index].value - entry.value, delta, `chunk ${index} shifted by the moov growth`);
    assert.ok(equalBytes(output.subarray(after[index].value, after[index].value + 32), input.subarray(entry.value, entry.value + 32)), `chunk ${index} points at the same audio`);
  });
  assert.ok(equalBytes(mp4Mdat(output), mp4Mdat(input)));
  assertTags(await readTags(new Blob([output])), FULL, { rating: false });
  assert.equal(mp4Find(output, ['moov', 'udta', 'meta', 'ilst']).length, 1);
});

test('writeTags MP4: rating is reported as not written', async () => {
  const result = await writeTagsDetailed(new Blob([await fixture('audio-aac.m4a')]), { title: 'T', rating: 3 });
  assert.deepEqual(result.skipped, ['rating']);
  assert.ok(result.notes.some((note) => /rating/i.test(note)));
  assert.equal((await readTags(result.blob)).title, 'T');
});

test('writeTags refuses every other fixture format by name', async () => {
  const refused = {
    'audio-wav.wav': 'WAV', 'audio-pcm.aiff': 'AIFF', 'audio-ape.ape': 'APE', 'audio-wavpack.wv': 'WavPack',
    'audio-musepack.mpc': 'Musepack', 'audio-tta.tta': 'TTA', 'audio-wma.wma': 'WMA', 'audio-wmav2.wma': 'WMA',
    'audio-dsd.dsf': 'DSF', 'audio-pcm.caf': 'CAF', 'audio-pcm.au': 'AU', 'audio-opus.mka': 'Matroska',
  };
  for (const [name, label] of Object.entries(refused)) {
    const blob = new Blob([await fixture(name)]);
    const info = await inspectTagFormat(blob);
    assert.equal(info.writable, false, name);
    await assert.rejects(writeTags(blob, { title: 'x' }), (error) => {
      assert.ok(error instanceof TagWriteError, name);
      assert.equal(error.code, 'unsupported');
      assert.match(error.message, new RegExp(`Tag editing is not available for .*${label}`), name);
      return true;
    });
  }
});

test('normalisePatch validates fields', () => {
  assert.deepEqual(normalisePatch({ title: '  A  ', album: '', rating: 0, year: '2001', trackNo: undefined }), { title: 'A', album: null, rating: null, year: 2001 });
  assert.throws(() => normalisePatch({ composer: 'x' }), /Unknown tag field/);
  assert.throws(() => normalisePatch({ rating: 6 }), /rating/);
  assert.throws(() => normalisePatch({ trackNo: -1 }), /trackNo/);
  assert.throws(() => normalisePatch({ title: 5 }), /title/);
  assert.throws(() => normalisePatch({ picture: { mime: 'text/plain', bytes: PNG } }), /picture/);
  assert.throws(() => normalisePatch(null), /object/);
});

test('writeTags with an empty patch returns the same bytes', async () => {
  const input = await fixture('audio-flac.flac');
  assert.ok(equalBytes(await blobBytes(await writeTags(new Blob([input]), {})), input));
});
