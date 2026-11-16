import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, isDarkHost, hostTokens, applyTheme } from '../app/ui/shell/theme.mjs';
import { createMediaSession, ACTIONS } from '../app/ui/shell/media-session.mjs';

test('resolveTheme: light by default, the choice when set, the host on system', () => {
  assert.equal(resolveTheme('system'), 'light');
  assert.equal(resolveTheme('dark'), 'dark');
  assert.equal(resolveTheme('light', { hosted: true, host: { mood: 'dark' } }), 'light');
  assert.equal(resolveTheme('system', { hosted: true, host: { mood: 'dark' } }), 'dark');
  assert.equal(resolveTheme('system', { hosted: true, host: { mood: 'light' } }), 'light');
  assert.equal(resolveTheme('system', { hosted: false, host: { mood: 'dark' } }), 'light');
});

test('isDarkHost follows Chartella: warm is dark only on a dark body', () => {
  assert.equal(isDarkHost({ mood: 'cool' }), true);
  assert.equal(isDarkHost({ mood: 'warm', colors: { BODY: '#1a1a1a' } }), true);
  assert.equal(isDarkHost({ mood: 'warm', colors: { BODY: '#f5f0e6' } }), false);
});

test('hostTokens maps host colours onto page tokens', () => {
  const tokens = hostTokens({ colors: { BODY: '#111', PANEL: '#222', INK: '#eee', ROW: '#333', ACT: '#f80' } });
  assert.equal(tokens['--bg'], '#111');
  assert.equal(tokens['--accent'], '#f80');
  assert.match(tokens['--muted'], /color-mix/);
  assert.deepEqual(hostTokens(null), {});
});

function fakeRoot() {
  const props = new Map();
  return { dataset: {}, style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) }, props };
}

test('applyTheme sets data-theme and host colours only on system inside a host', () => {
  const root = fakeRoot();
  const host = { mood: 'dark', colors: { BODY: '#111', INK: '#eee' } };
  assert.equal(applyTheme(root, 'system', { hosted: true, host }), 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.props.get('--bg'), '#111');
  assert.equal(applyTheme(root, 'light', { hosted: true, host }), 'light');
  assert.equal(root.props.has('--bg'), false);
});

function fakeSession({ refuse = [] } = {}) {
  const handlers = {};
  const positions = [];
  return {
    handlers, positions, metadata: null, playbackState: 'none',
    setActionHandler(action, fn) { if (refuse.includes(action)) throw new TypeError('unknown action'); handlers[action] = fn; },
    setPositionState(state) { positions.push(state); },
  };
}

test('media session binds the handlers it can and survives a refused action', () => {
  const session = fakeSession({ refuse: ['seekto'] });
  const calls = [];
  const handlers = Object.fromEntries(ACTIONS.map(a => [a, d => calls.push([a, d])]));
  handlers.nexttrack = () => { throw new Error('boom'); };
  const ms = createMediaSession({ mediaSession: session, MediaMetadata: null, handlers });
  assert.equal(ms.actions().includes('seekto'), false);
  assert.equal(ms.actions().includes('play'), true);
  session.handlers.play();
  session.handlers.nexttrack(); // a throwing handler must not escape
  session.handlers.seekforward({ seekOffset: 10 });
  assert.deepEqual(calls.map(c => c[0]), ['play', 'seekforward']);
  assert.equal(calls[1][1].seekOffset, 10);
});

test('media session metadata, playback state and position', () => {
  const session = fakeSession();
  class Meta { constructor(fields) { Object.assign(this, fields); } }
  const ms = createMediaSession({ mediaSession: session, MediaMetadata: Meta, handlers: {} });
  ms.setTrack({ title: 'T', artist: 'A', album: 'B', artUrl: 'blob:x' });
  assert.ok(session.metadata instanceof Meta);
  assert.equal(session.metadata.artwork[0].src, 'blob:x');
  ms.setTrack({ title: 'T' });
  assert.deepEqual(session.metadata.artwork, []);
  ms.setPlaying(true);
  assert.equal(session.playbackState, 'playing');
  ms.setPlaying(false);
  assert.equal(session.playbackState, 'paused');
  ms.setPosition({ duration: 100, position: 5.2 });
  ms.setPosition({ duration: 100, position: 5.4 }); // same whole second: skipped
  ms.setPosition({ duration: 100, position: 150 });
  ms.setPosition({ duration: NaN, position: 1 });
  assert.equal(session.positions.length, 2);
  assert.equal(session.positions[1].position, 100);
  ms.clear();
  assert.equal(session.metadata, null);
  assert.equal(session.playbackState, 'none');
});

test('media session is a no-op without the API', () => {
  const ms = createMediaSession({ mediaSession: null, handlers: { play: () => {} } });
  assert.equal(ms.supported, false);
  ms.setTrack({ title: 'x' });
  ms.setPlaying(true);
  ms.setPosition({ duration: 1, position: 0 });
  ms.clear();
});
