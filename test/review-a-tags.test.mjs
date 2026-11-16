// Review 2026-11-17, tag findings N1, N13, N14 and N31 (app/tags/).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readTags } from '../app/library/metadata.mjs';
import { upgradeId3, listId3v24Frames, PRIV_OWNER_23 } from '../app/tags/id3.mjs';
import { writeTags, writeTagsDetailed, planTagWrite, missingId3Frames } from '../app/tags/write.mjs';
import {
  saveTagsToHandle, listTagBackups, restoreTagBackup, pruneTagBackups, deleteTagBackup, BACKUP_DIRECTORY,
} from '../app/tags/save.mjs';
import { listPictures, parseFlacPicture } from '../app/tags/pictures.mjs';
import { fixture, blobBytes, equalBytes, mp3Audio, id3Tag, latin1, concat, PNG, JPEG, ascii, flacAudio } from './tags-helpers.mjs';
import { fakeFile, fakeDirectory } from './review-a-fakes.mjs';

const enc = (text) => new TextEncoder().encode(text);

function apic23(mime, type, bytes) {
  return concat(new Uint8Array([0]), enc(mime), new Uint8Array([0, type, 0]), bytes);
}
const TXXX_RG = concat(latin1('REPLAYGAIN_TRACK_GAIN'), new Uint8Array([0]), enc('-6.20 dB'));
const USLT = concat(new Uint8Array([0]), enc('eng'), new Uint8Array([0]), enc('la la la'));
const APIC = apic23('image/png', 3, PNG);

/** The shape old iTunes versions wrote: a three-letter id padded with a zero byte, then the usual frames. */
const ITUNES_V23 = [
  ['TIT2', latin1('Old Title')],
  ['TCP\0', latin1('1')],
  ['TXXX', TXXX_RG],
  ['USLT', USLT],
  ['APIC', APIC],
];

async function legacyMp3(frames, flags = 0) {
  const audio = mp3Audio(await fixture('audio-mp3.mp3'));
  return { bytes: concat(id3Tag(3, frames, flags), audio), audio };
}

function frameBody(bytes, id) {
  return listId3v24Frames(bytes).find((frame) => frame.id === id)?.body ?? null;
}

test('N1: an iTunes ID3v2.3 tag with TCP\\0 keeps APIC, USLT and TXXX ReplayGain through a save', async () => {
  const { bytes, audio } = await legacyMp3(ITUNES_V23);
  const handle = fakeFile('itunes.mp3', bytes);
  const root = fakeDirectory();
  const result = await saveTagsToHandle(handle, { title: 'New Title' }, { backupRoot: async () => root, path: 'Music/itunes.mp3' });
  const output = handle.state.bytes;
  const ids = listId3v24Frames(output).map((frame) => frame.id).sort();
  assert.deepEqual(ids, ['APIC', 'TCMP', 'TIT2', 'TXXX', 'USLT']);
  assert.ok(equalBytes(frameBody(output, 'APIC'), APIC), 'cover art byte for byte');
  assert.ok(equalBytes(frameBody(output, 'USLT'), USLT), 'lyrics byte for byte');
  assert.ok(equalBytes(frameBody(output, 'TXXX'), TXXX_RG), 'ReplayGain byte for byte');
  assert.ok(equalBytes(frameBody(output, 'TCMP'), latin1('1')), 'TCP\\0 converted to TCMP losslessly');
  assert.equal(result.after.title, 'New Title');
  assert.ok(equalBytes(mp3Audio(output), audio), 'audio unchanged');
  assert.ok(result.notes.some((note) => /TCP\\x00 as TCMP/.test(note)), 'the confirm notes name the rename');
  assert.ok(root.directories.get(BACKUP_DIRECTORY).files.has('itunes.mp3'), 'backup kept');
});

test('N1: a frame whose id ID3v2.4 cannot hold is kept inside PRIV, and the frames after it survive', async () => {
  const odd = ['TSO ', latin1('odd')];
  const { bytes } = await legacyMp3([['TIT2', latin1('A')], odd, ['USLT', USLT], ['APIC', APIC]]);
  const upgraded = upgradeId3(bytes);
  assert.deepEqual(upgraded.wrapped, ['TSO\\x20']);
  const output = await blobBytes(await writeTags(new Blob([bytes]), { album: 'B' }));
  const frames = listId3v24Frames(output);
  const priv = frames.find((frame) => frame.id === 'PRIV').body;
  assert.equal(ascii(priv, 0, PRIV_OWNER_23.length), PRIV_OWNER_23);
  const kept = priv.subarray(PRIV_OWNER_23.length + 1);
  assert.equal(ascii(kept, 0, 4), odd[0], 'the whole old frame is inside');
  assert.ok(equalBytes(kept.subarray(10), odd[1]));
  assert.ok(equalBytes(frameBody(output, 'USLT'), USLT) && equalBytes(frameBody(output, 'APIC'), APIC));
});

test('N1: a frame that runs past the tag refuses the write instead of losing the frames after it', async () => {
  const { bytes } = await legacyMp3([['TIT2', latin1('A')], ['USLT', USLT], ['APIC', APIC]]);
  // Corrupt the USLT size so it runs past the tag in both plain and syncsafe readings.
  const uslt = 10 + 10 + latin1('A').length;
  bytes.set([0x7f, 0x7f, 0x7f, 0x7f], uslt + 4);
  const plan = await planTagWrite(new Blob([bytes]), { title: 'x' });
  assert.equal(plan.writable, false);
  assert.match(plan.reason, /damaged frame/);
  const handle = fakeFile('bad.mp3', bytes);
  await assert.rejects(saveTagsToHandle(handle, { title: 'x' }, { backupRoot: async () => fakeDirectory() }), (error) => error.code === 'unsupported' || error.code === 'invalid-file');
  assert.equal(handle.state.writes, 0, 'the file was not touched');
});

test('N1: ID3v2.3 compressed and grouped frames convert losslessly; removed frames keep their old ids', async () => {
  const compressedBody = concat(new Uint8Array([0, 0, 0, 9]), new Uint8Array([0x78, 0x9c, 1, 2, 3]));
  const grouped = concat(new Uint8Array([7]), latin1('grouped'));
  const tag = id3Tag(3, [['TIT2', latin1('A')], ['TALB', latin1('Album')], ['RVAD', new Uint8Array([0, 16, 1, 2])], ['TSIZ', latin1('100')]]);
  // Build the flagged frames by hand: id3Tag writes zero flags.
  const flagged = (id, format, body) => concat(enc(id), new Uint8Array([0, 0, 0, body.length, 0, format]), body);
  const body = concat(tag.subarray(10), flagged('COMM', 0x80, compressedBody), flagged('TIT3', 0x20, grouped));
  const header = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (body.length >> 7) & 0x7f, body.length & 0x7f]);
  const result = upgradeId3(concat(header, body));
  const frames = listId3v24Frames(result.tag);
  const comm = frames.find((frame) => frame.id === 'COMM');
  assert.equal(comm.flags & 0x09, 0x09, 'compression and data-length flags set');
  assert.deepEqual([...comm.body.subarray(0, 4)], [0, 0, 0, 9], 'syncsafe decompressed size');
  assert.ok(equalBytes(comm.body.subarray(4), compressedBody.subarray(4)), 'compressed bytes unchanged');
  const tit3 = frames.find((frame) => frame.id === 'TIT3');
  assert.equal(tit3.flags & 0x40, 0x40);
  assert.ok(equalBytes(tit3.body, grouped));
  assert.deepEqual(result.legacy.sort(), ['RVAD', 'TSIZ']);
  assert.deepEqual(result.dropped, []);
});

test('N1: missingId3Frames names a frame that did not come back byte for byte', () => {
  const tag = id3Tag(3, [['TIT2', latin1('A')], ['USLT', USLT]]);
  const upgraded = upgradeId3(tag).tag;
  const expected = listId3v24Frames(upgraded).map(({ id, body }) => ({ id, body }));
  assert.deepEqual(missingId3Frames(upgraded, expected), []);
  const lost = upgradeId3(id3Tag(3, [['TIT2', latin1('A')]])).tag;
  assert.deepEqual(missingId3Frames(lost, expected), ['USLT']);
});

test('N1: an MP3 TYER that is not four digits is carried, not lost', () => {
  const result = upgradeId3(id3Tag(3, [['TYER', latin1('circa 1970')]]));
  const ids = listId3v24Frames(result.tag).map((frame) => frame.id);
  assert.deepEqual(ids, ['TYER']);
});

// ------------------------------------------------------------- N13 ----

function flacPictureBlock(typeId, mime, data, last = false) {
  const description = enc('desc');
  const body = new Uint8Array(32 + mime.length + description.length + data.length);
  const view = new DataView(body.buffer);
  let cursor = 0;
  view.setUint32(cursor, typeId); cursor += 4;
  view.setUint32(cursor, mime.length); cursor += 4;
  body.set(enc(mime), cursor); cursor += mime.length;
  view.setUint32(cursor, description.length); cursor += 4;
  body.set(description, cursor); cursor += description.length;
  view.setUint32(cursor, 10); view.setUint32(cursor + 4, 20); view.setUint32(cursor + 8, 24); view.setUint32(cursor + 12, 0); cursor += 16;
  view.setUint32(cursor, data.length); cursor += 4;
  body.set(data, cursor);
  return concat(new Uint8Array([(last ? 0x80 : 0) | 6, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body);
}

/** Insert PICTURE blocks right after STREAMINFO of the FLAC fixture. */
function withPictures(flac, blocks) {
  const length = (flac[5] << 16) | (flac[6] << 8) | flac[7];
  const after = 8 + length;
  return concat(flac.subarray(0, after), ...blocks, flac.subarray(after));
}

test('N13: a new FLAC front cover keeps the back cover byte for byte and says so', async () => {
  const source = withPictures(await fixture('audio-flac.flac'), [flacPictureBlock(3, 'image/png', PNG), flacPictureBlock(4, 'image/jpeg', JPEG)]);
  const plan = await planTagWrite(new Blob([source]), { picture: { mime: 'image/jpeg', bytes: JPEG } });
  assert.ok(plan.notes.some((note) => /1 other picture \(Cover \(back\)\) stay/.test(note)));
  const output = await blobBytes(await writeTags(new Blob([source]), { picture: { mime: 'image/jpeg', bytes: JPEG } }));
  const pictures = await listPictures(new Blob([output]), 'flac');
  assert.deepEqual(pictures.map((picture) => picture.typeId), [3, 4]);
  const back = pictures[1].picture;
  assert.equal(back.description, 'desc');
  assert.equal(back.width, 10);
  assert.ok(equalBytes(back.data, JPEG));
  assert.ok(equalBytes(flacAudio(output).frames, flacAudio(source).frames), 'audio unchanged');
  assert.ok(equalBytes((await readTags(new Blob([output]))).picture.bytes, JPEG), 'the reader shows the new front cover');
});

test('N13: a new MP3 front cover keeps a back-cover APIC byte for byte', async () => {
  const back = apic23('image/jpeg', 4, JPEG);
  const { bytes, audio } = await legacyMp3([['TIT2', latin1('A')], ['APIC', APIC], ['APIC', back]]);
  const result = await writeTagsDetailed(new Blob([bytes]), { picture: { mime: 'image/jpeg', bytes: JPEG } });
  const output = await blobBytes(result.blob);
  const apics = listId3v24Frames(output).filter((frame) => frame.id === 'APIC');
  assert.equal(apics.length, 2);
  assert.ok(apics.some((frame) => equalBytes(frame.body, back)), 'back cover kept');
  assert.ok(!apics.some((frame) => equalBytes(frame.body, APIC)), 'old front cover replaced');
  assert.ok(equalBytes((await readTags(new Blob([output]))).picture.bytes, JPEG));
  assert.ok(equalBytes(mp3Audio(output), audio));
});

test('N13: parseFlacPicture reads every field', () => {
  const block = flacPictureBlock(4, 'image/png', PNG, true);
  const picture = parseFlacPicture(block.subarray(4));
  assert.deepEqual({ ...picture, data: [...picture.data] }, {
    typeId: 4, type: 'Cover (back)', format: 'image/png', description: 'desc', width: 10, height: 20, colourDepth: 24, colours: 0, data: [...PNG],
  });
});

// ------------------------------------------------------------- N14 ----

test('N14: backups of good writes are listed with their track path and restore undoes the write', async () => {
  const original = await fixture('audio-flac.flac');
  const handle = fakeFile('song.flac', original);
  const root = fakeDirectory();
  const options = { backupRoot: async () => root };
  await saveTagsToHandle(handle, { album: 'Wrong Album' }, { ...options, path: 'Rock/song.flac', now: () => 5 });
  const list = await listTagBackups(options);
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], size: list[0].size === original.length }, {
    backup: 'song.flac', path: 'Rock/song.flac', name: 'song.flac', savedAt: 5, size: true, status: 'written', patch: { album: 'Wrong Album' },
  });
  await restoreTagBackup(handle, list[0].backup, options);
  assert.ok(equalBytes(handle.state.bytes, original), 'undo put the original back');
  assert.deepEqual(await listTagBackups(options), []);
});

test('N14: pruning removes the oldest good-write backups and never a failed one', async () => {
  const root = fakeDirectory();
  const options = { backupRoot: async () => root };
  const flac = await fixture('audio-flac.flac');
  for (const [index, name] of ['a.flac', 'b.flac', 'c.flac'].entries()) {
    await saveTagsToHandle(fakeFile(name, flac), { title: name }, { ...options, now: () => index, backupLimitBytes: Number.MAX_SAFE_INTEGER });
  }
  const lying = async (blob) => ({ ...(await readTags(blob)), title: 'not what was written' });
  await assert.rejects(saveTagsToHandle(fakeFile('d.flac', flac), { title: 'd' }, { ...options, readTags: lying, now: () => 9 }));
  const removed = await pruneTagBackups({ ...options, maxBytes: flac.length * 2 });
  assert.deepEqual(removed, ['a.flac', 'b.flac']);
  const left = await listTagBackups(options);
  assert.deepEqual(left.map((item) => [item.backup, item.status]), [['d.flac', 'failed'], ['c.flac', 'written']]);
  await deleteTagBackup('c.flac', options);
  assert.deepEqual((await listTagBackups(options)).map((item) => item.backup), ['d.flac']);
});

// ------------------------------------------------------------- N31 ----

function id3v1(title) {
  const tail = new Uint8Array(128);
  tail.set(enc('TAG'), 0);
  tail.set(enc(title), 3);
  tail.set(enc('Old Artist'), 33);
  tail.set(enc('1999'), 93);
  tail.set(enc('keep this comment'), 97);
  tail[126] = 4;
  tail[127] = 17;
  return tail;
}

test('N31: a trailing ID3v1 tag gets the new title; its other fields stay', async () => {
  const audio = mp3Audio(await fixture('audio-mp3.mp3'));
  const source = concat(id3Tag(3, [['TIT2', latin1('Old Title')]]), audio, id3v1('Old Title'));
  const plan = await planTagWrite(new Blob([source]), { title: 'New Title' });
  assert.ok(plan.notes.some((note) => /ID3v1/.test(note)));
  const output = await blobBytes(await writeTags(new Blob([source]), { title: 'New Title' }));
  const tail = output.subarray(output.length - 128);
  assert.equal(ascii(tail, 0, 3), 'TAG');
  assert.equal(ascii(tail, 3, 9), 'New Title');
  assert.equal(tail[12], 0, 'rest of the title field cleared');
  assert.equal(ascii(tail, 33, 10), 'Old Artist');
  assert.equal(ascii(tail, 97, 17), 'keep this comment');
  assert.equal(tail[126], 4);
  assert.equal(tail[127], 17);
  const before = mp3Audio(source);
  const after = mp3Audio(output);
  assert.ok(equalBytes(after.subarray(0, after.length - 128), before.subarray(0, before.length - 128)), 'audio frames unchanged');
});
