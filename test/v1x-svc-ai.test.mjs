import test from 'node:test';
import assert from 'node:assert/strict';
import { similarCandidates, pickByTags, moreLikeThis, seedDescription, SIMILAR_PATHS } from '../app/ai/similar.mjs';
import {
  albumsMissingGenre, buildGenreRequest, parseGenreReply, suggestGenres, toEditRequests, canonicalGenre, GENRE_VOCABULARY,
} from '../app/ai/genres.mjs';
import { validate } from '../app/commands/run.mjs';
import { commandByName } from '../app/commands/commands.mjs';
import { fakeChat } from './v1x-svc-helpers.mjs';

const T = (id, o) => ({ id, title: `Title ${id}`, path: `/music/${id}.mp3`, ...o });
const LIB = [
  T('seed', { artist: 'Miles Davis', albumArtist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', year: 1959, playCount: 9 }),
  T('a1', { artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', year: 1959, playCount: 1 }),
  T('a2', { artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', year: 1959, playCount: 5 }),
  T('a3', { artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', year: 1959, playCount: 3 }),
  T('a4', { artist: 'Miles Davis', album: 'Sketches', genre: 'Jazz', year: 1960 }),
  T('g1', { artist: 'Coltrane', album: 'Giant Steps', genre: 'jazz', year: 1960, playCount: 2 }),
  T('g2', { artist: 'Monk', album: 'Brilliant', genre: 'Jazz', year: 1957 }),
  T('d1', { artist: 'Ella', album: 'Songbook', genre: 'Vocal Jazz', year: 1956, playCount: 4 }),
  T('d2', { artist: 'Elvis', album: 'Elvis', genre: 'Rock', year: 1956, playCount: 50 }),
  T('p1', { artist: 'Snarky', album: 'Live', genre: 'Jazz Fusion', year: 2015, playCount: 7 }),
  T('x1', { artist: 'Daft Punk', album: 'Discovery', genre: 'Electronic', year: 2001, playCount: 99 }),
];

// --------------------------------------------------------------- similar ----

test('similar: tiers run artist, genre, decade, then most-played in related genres', () => {
  const c = similarCandidates(LIB[0], LIB);
  const vias = Object.fromEntries(c.map(x => [x.trackId, x.via]));
  assert.deepEqual(c.slice(0, 4).map(x => x.trackId), ['a2', 'a3', 'a1', 'a4']);
  assert.equal(vias.g1, 'same-genre');
  assert.equal(vias.d1, 'same-decade');
  assert.equal(vias.p1, 'most-played-in-genre');
  assert.equal('d2' in vias, false); // same decade, unrelated genre
  assert.equal('x1' in vias, false);
  assert.equal('seed' in vias, false);
  assert.deepEqual(c.map(x => x.id), c.map((_, i) => i + 1));
  assert.equal(JSON.stringify(c).includes('/music/'), false);
});

test('similar: excludes queued tracks; tags-only caps two per album then fills', () => {
  const c = similarCandidates(LIB[0], LIB, { excludeIds: ['a4', 'g1'] });
  assert.equal(c.some(x => x.trackId === 'a4' || x.trackId === 'g1'), false);
  const picked = pickByTags(similarCandidates(LIB[0], LIB), 4);
  assert.deepEqual(picked, ['a2', 'a3', 'a4', 'g1']);
  assert.equal(pickByTags(similarCandidates(LIB[0], LIB.slice(0, 4)), 3).length, 3); // only one album: fill anyway
});

test('moreLikeThis: without a model the tags answer; seed text goes in as data', async () => {
  const r = await moreLikeThis({ seed: LIB[0], tracks: LIB, queuedIds: ['a2'], length: 3 });
  assert.equal(r.path, SIMILAR_PATHS.tags);
  assert.deepEqual(r.trackIds, ['a3', 'a1', 'a4']);
  assert.match(seedDescription(LIB[0]), /"Title seed" by Miles Davis \(Jazz, 1959\)/);
  await assert.rejects(moreLikeThis({ tracks: LIB }), /Play a track first/);
});

test('moreLikeThis: the model reranks candidates and unknown ids are dropped', async () => {
  const chat = fakeChat(body => {
    const table = body.messages[1].content;
    const idOf = name => Number(new RegExp(`\\n(\\d+) \\| [^\\n]*${name}`).exec(table)[1]);
    return { choices: [{ message: { content: JSON.stringify({ title: 'Cool', ids: [idOf('Brilliant'), idOf('Giant Steps'), 999] }) } }] };
  });
  const r = await moreLikeThis({ seed: LIB[0], tracks: LIB, chat, length: 2 });
  assert.equal(r.path, SIMILAR_PATHS.model);
  assert.deepEqual(r.trackIds, ['g2', 'g1']);
  assert.equal(chat.bodies[0].response_format.type, 'json_schema');
  assert.equal(chat.bodies[0].messages[1].content.includes('/music/'), false);
});

test('moreLikeThis: a failed or short model reply falls back to tags', async () => {
  const bad = await moreLikeThis({ seed: LIB[0], tracks: LIB, chat: fakeChat('no json here'), length: 4 });
  assert.equal(bad.path, SIMILAR_PATHS.failed);
  assert.equal(bad.trackIds.length, 4);
  const thrown = await moreLikeThis({ seed: LIB[0], tracks: LIB, chat: fakeChat(new Error('host down')), length: 2 });
  assert.equal(thrown.path, SIMILAR_PATHS.failed);
  assert.match(thrown.error, /host down/);
  const slow = await moreLikeThis({ seed: LIB[0], tracks: LIB, chat: () => new Promise(() => {}), timeoutMs: 20, length: 2 });
  assert.match(slow.error, /did not answer/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(moreLikeThis({ seed: LIB[0], tracks: LIB, chat: fakeChat('{}'), signal: ac.signal }));
});

// ---------------------------------------------------------------- genres ----

const UNTAGGED = [
  T('u1', { artist: 'Nina Simone', album: 'Pastel Blues' }),
  T('u2', { artist: 'Nina Simone', album: 'Pastel Blues' }),
  T('u3', { artist: 'Kraftwerk', albumArtist: 'Kraftwerk', album: 'Computer World', genre: '' }),
  T('u4', { artist: 'Someone', album: 'Mixed', genre: 'Pop' }),
  T('u5', { artist: 'Someone', album: 'Mixed' }), // album already has a genre on u4
  T('u6', { artist: 'Loose', title: 'No album' }),
];

test('genres: finds albums where no track has a genre, never tracks without an album', () => {
  const a = albumsMissingGenre(UNTAGGED);
  assert.deepEqual(a.map(x => [x.id, x.artist, x.album, x.trackIds]), [
    [1, 'Kraftwerk', 'Computer World', ['u3']],
    [2, 'Nina Simone', 'Pastel Blues', ['u1', 'u2']],
  ]);
});

test('genres: the request lists ids, artists and albums only, with a fixed vocabulary', () => {
  const body = buildGenreRequest(albumsMissingGenre(UNTAGGED));
  const user = body.messages[1].content;
  assert.match(user, /1 \| Kraftwerk \| Computer World/);
  assert.equal(user.includes('/music/'), false);
  assert.equal(user.includes('Title'), false);
  assert.deepEqual(body.response_format.json_schema.schema.properties.albums.items.properties.genre.enum, GENRE_VOCABULARY);
  assert.equal(canonicalGenre('hip-hop'), 'Hip Hop');
  assert.equal(canonicalGenre('rnb'), null);
  assert.equal(canonicalGenre('R & B'), 'R&B');
});

test('genres: parser drops unknown ids, repeats and genres outside the list', () => {
  const albums = albumsMissingGenre(UNTAGGED);
  const r = parseGenreReply('Sure! ```json\n{"albums":[{"id":1,"genre":"electronic"},{"id":1,"genre":"Pop"},{"id":"2","genre":"Blues"},{"id":9,"genre":"Jazz"},{"id":2,"genre":"Nu Jazz"}]}\n```', albums);
  assert.deepEqual(r.suggestions.map(s => [s.album, s.genre, s.trackIds]), [['Computer World', 'Electronic', ['u3']], ['Pastel Blues', 'Blues', ['u1', 'u2']]]);
  assert.deepEqual(r.dropped.map(d => d.reason), ['repeated id', 'unknown id', 'repeated id']);
  assert.equal(parseGenreReply('nothing', albums).error, 'the reply holds no JSON');
});

test('genres: suggestGenres batches, reports errors, needs a model', async () => {
  const many = Array.from({ length: 45 }, (_, i) => T(`m${i}`, { artist: `A${i}`, album: `Album ${i}` }));
  const chat = fakeChat(b => ({ choices: [{ message: { content: JSON.stringify({ albums: [{ id: Number(/\n(\d+) \|/.exec(b.messages[1].content.split('```albums')[1])[1]), genre: 'Rock' }] }) } }] }));
  const r = await suggestGenres({ tracks: many, chat });
  assert.equal(chat.bodies.length, 2);
  assert.equal(r.albumsAsked, 45);
  assert.equal(r.suggestions.length, 2);
  const none = await suggestGenres({ tracks: UNTAGGED });
  assert.equal(none.suggestions.length, 0);
  assert.match(none.errors[0], /need a model/);
  const failing = await suggestGenres({ tracks: UNTAGGED, chat: fakeChat(new Error('boom')) });
  assert.match(failing.errors[0], /boom/);
});

test('genres: approved suggestions become destructive track.edit_tags inputs that validate', () => {
  const reqs = toEditRequests([{ artist: 'Nina Simone', album: 'Pastel Blues', genre: 'blues', trackIds: ['u1', 'u2'] }, { album: 'x', genre: 'Nope', trackIds: ['z'] }]);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].scope, 'destructive');
  assert.equal(commandByName.get(reqs[0].name).scope, 'destructive');
  assert.deepEqual(reqs[0].input, { ids: ['u1', 'u2'], patch: { genre: 'Blues' } });
  assert.deepEqual(validate(commandByName.get('track.edit_tags').input, reqs[0].input), []);
  assert.match(reqs[0].label, /Pastel Blues: set genre to Blues on 2 tracks/);
});
