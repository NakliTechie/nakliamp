// Review C: shell findings with a pure core (N3, N27, N28, N34, N42, N43, N44) and the
// request items from review batches A, B and D that index.html wires.
// The browser behaviour of N3, N6 to N8 and N30 is checked in test/review-c-keys.html.
// Run: node --test test/review-c-shell.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seekValueText, trackAnnouncement } from '../app/ui/shell/format.mjs';
import { lyricsSidecar } from '../app/ui/v1x-network.mjs';
import { sidecarPlan } from '../app/net/lrclib.mjs';
import { licenceEntries, LICENCE_FILES } from '../app/ui/licences.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script type="module">'));
const fnBody = name => {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  return script.slice(start, script.indexOf('\n}\n', start));
};

test('N3: the queue and the timers run from an interval and the engine\'s ended event, not from animation frames', () => {
  const clock = fnBody('renderClock');
  assert.equal(/maybeAdvance|tickTimers/.test(clock), false, 'renderClock still advances or ticks timers');
  assert.match(script, /setInterval\(tickPlayback, 250\)/);
  assert.match(script, /engine\.on\('ended', \(\) => maybeAdvance\(engine\.state\(\)\)\)/);
  const tick = fnBody('tickPlayback');
  assert.match(tick, /tickTimers\(state\)/);
  assert.match(tick, /maybeAdvance\(state\)/);
});

test('N20 request: the shell registers pcmDecoder', () => {
  assert.match(script, /import \{ pcmDecoder \} from '\.\/app\/decode\/pcm\.mjs';/);
  assert.match(script, /const SOFTWARE_DECODERS = \[\n {2}pcmDecoder,\n\];/);
});

test('N34: lyrics.save_sidecar on an instrumental track refuses with not-found, not a TypeError', () => {
  const instrumental = lyricsSidecar('Album/Intro.flac', { instrumental: true, text: '' }, sidecarPlan);
  assert.deepEqual(instrumental.refusal.code, 'not-found');
  assert.match(instrumental.refusal.message, /instrumental/);
  assert.equal(lyricsSidecar('Album/Intro.flac', null, sidecarPlan).refusal.code, 'not-found');
  const saved = lyricsSidecar('Album/Song.flac', { text: '[00:01.00]Hi' }, sidecarPlan);
  assert.deepEqual({ path: saved.path, name: saved.name }, { path: 'Album/Song.lrc', name: 'Song.lrc' });
  assert.equal(lyricsSidecar('Song.mp3', { text: 'x' }, sidecarPlan).path, 'Song.lrc');
});

test('N42: the seek slider speaks minutes and seconds', () => {
  assert.equal(seekValueText(137.42, 245), '2:17 of 4:05');
  assert.equal(seekValueText(5, null), '0:05');
  assert.match(script, /setAttribute\('aria-valuetext', text\)/);
});

test('N44: a polite live region names each new track', () => {
  assert.equal(trackAnnouncement({ title: 'Halo', artist: 'Beyoncé' }), 'Now playing: Halo by Beyoncé');
  assert.equal(trackAnnouncement({ title: '' }), 'Now playing: Untitled track');
  assert.match(html, /<p class="sr-only" id="now-announce" role="status" aria-live="polite" aria-atomic="true"><\/p>/);
});

// WCAG relative luminance contrast.
function contrast(a, b) {
  const lum = hex => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));

test('N43: accent and faint text reach 4.5:1 and field borders 3:1 on every surface', () => {
  const light = tokens(html.slice(html.indexOf(':root{'), html.indexOf(':root[data-theme="dark"]')));
  const dark = { ...light, ...tokens(html.slice(html.indexOf(':root[data-theme="dark"]'), html.indexOf('*{box-sizing'))) };
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const surface of ['bg', 'panel', 'panel-2']) {
      for (const text of ['accent', 'faint', 'muted', 'text']) {
        assert.ok(contrast(set[text], set[surface]) >= 4.5, `${name} --${text} on --${surface}: ${contrast(set[text], set[surface]).toFixed(2)}`);
      }
      assert.ok(contrast(set['field-line'], set[surface]) >= 3, `${name} --field-line on --${surface}`);
    }
  }
  assert.match(html, /input:not\(\[type=checkbox\]\)[^{]*\{border-color:var\(--field-line\)\}/);
});

test('N27: the Licences screen lists embedded blocks in a built file, and the files on the hosted page', () => {
  const block = (id, text) => ({ id, textContent: `\n${text}\n` });
  const built = { querySelectorAll: () => [block('nakliamp-licence', 'MIT License'), block('libav-lgpl-notice', 'Source: v6.10.9.0')] };
  assert.deepEqual(licenceEntries(built), [
    { id: 'nakliamp-licence', title: 'NakliAmp (MIT)', text: 'MIT License' },
    { id: 'libav-lgpl-notice', title: 'libav.js corresponding source', text: 'Source: v6.10.9.0' },
  ]);
  const hosted = licenceEntries({ querySelectorAll: () => [] });
  assert.equal(hosted.length, LICENCE_FILES.length);
  for (const entry of hosted) assert.ok(readFileSync(new URL(`../${entry.path}`, import.meta.url), 'utf8').length > 100, entry.path);
  assert.match(html, /data-view="licences">Licences<\/button>/);
});

test('N28: single-file builds drop the classic skin menu item and refuse view.skins', () => {
  assert.match(script, /const SINGLE_FILE = typeof window\.__nakliampModule === 'function';/);
  assert.match(script, /if \(SINGLE_FILE\) document\.getElementById\('skins-item'\)\?\.remove\(\);/);
  assert.match(fnBodyOfHandler('view.skins'), /SINGLE_FILE\) throw new CommandError\('unavailable'/);
});
function fnBodyOfHandler(name) {
  const start = script.indexOf(`'${name}': `);
  return script.slice(start, script.indexOf('\n  },', start));
}

test('Requests A, B, D: playlist bytes, kept lines, freshness, entry lookup, rename follow-ups, labels', () => {
  const scan = readFileSync(new URL('../app/library/scan-core.mjs', import.meta.url), 'utf8');
  assert.match(scan, /parsePlaylist\(new Uint8Array\(await file\.arrayBuffer\(\)\), relative, \{ lastModified: file\.lastModified, size: file\.size \}\)/);
  // Every playlist rewrite checks the file first and carries header, trailer and code page.
  for (const site of ['persistPlaylist', 'renamePlaylistFile']) {
    const body = fnBody(site);
    assert.match(body, /await assertPlaylistFresh\(playlist\)/, site);
    assert.match(body, /header: playlist\.header, trailer: playlist\.trailer/, site);
  }
  assert.match(fnBodyOfHandler('playlist.remove'), /assertPlaylistFresh\(playlist\);[\s\S]*playlist\.encoding\)/);
  assert.match(fnBody('tracksForPlaylist'), /pickEntryPath/);
  assert.match(fnBody('playlistLines'), /pickEntryPath/);
  assert.match(fnBody('writeLogged'), /encodePlaylistText\(text, encoding\)/);
  assert.match(fnBody('undoLast'), /encodePlaylistText\(entry\.before, entry\.encoding/);
  const rename = fnBodyOfHandler('tags.rename_files');
  assert.match(rename, /renameWithSidecars\(row, out\)/);
  assert.match(rename, /rewriteRenamedPlaylists\(renamed, out\)/);
  assert.match(fnBody('rewriteRenamedPlaylists'), /planPlaylistRenames\(renamed, playlistRows\)\.updates[\s\S]*assertPlaylistFresh/);
  assert.match(fnBody('renameWithSidecars'), /found\.plan\.renames/);
  assert.match(script, /handleForPath: async path =>/);
  assert.match(script, /findByPath: path =>/);
  assert.match(script, /parentFor: async track =>/);
  // D: the scrobble status carries a failed save, and no "Winamp EQ" wording is left.
  assert.match(fnBodyOfHandler('scrobble.status'), /saveError: listenbrainz\.saveError\(\)/);
  assert.equal(/Winamp EQ/.test(html), false);
  assert.equal(/Winamp EQ/.test(readFileSync(new URL('../commands.json', import.meta.url), 'utf8')), false);
});
