#!/usr/bin/env node
// Replace the default skin art compiled into Webamp's bundle with neutral art
// drawn here, so NakliAmp ships no Nullsoft artwork. Webamp's code is left as
// it is; only image payloads, cursor payloads, the GEN letter widths and the
// default skin colours change.
//
// Usage: node scripts/patch-webamp-skin.mjs <upstream built/webamp.bundle.min.mjs> [out]
// Default out: vendor/webamp/webamp-2.3.1.bundle.min.mjs. The input must be the
// pinned upstream file (SHA-256 below). The output is byte-for-byte the same for
// the same input and the same Node zlib build.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';

export const UPSTREAM_SHA256 = '41817e47fdb1f969a74e0202135e72d080d73236f5f0a7709f17b696784e0035';

// ---------------------------------------------------------------- palette ----
const C = Object.freeze({
  bg: [0x6e, 0x71, 0x77], // window chrome
  hi: [0x9a, 0x9d, 0xa3], // raised edge
  lo: [0x3f, 0x42, 0x47], // sunken edge
  panel: [0x16, 0x17, 0x1a], // display panels
  ink: [0xdc, 0xde, 0xe2], // text on panels
  dim: [0x84, 0x87, 0x8d], // quiet text and fills
  engrave: [0x2a, 0x2c, 0x30], // labels painted on the chrome
  titleOn: [0x2c, 0x2f, 0x35], // focused title bar
  titleOnText: [0xe6, 0xe8, 0xec],
  titleOff: [0x5a, 0x5d, 0x63], // unfocused title bar
  titleOffText: [0xa8, 0xab, 0xb0],
  button: [0x8a, 0x8d, 0x93],
  buttonDown: [0x74, 0x77, 0x7d],
  buttonLit: [0xa6, 0xa9, 0xaf],
  icon: [0x1e, 0x20, 0x24],
  lampOn: [0xf0, 0xf2, 0xf5],
  lampOff: [0x45, 0x48, 0x4d],
});

// ------------------------------------------------------------- pixel font ----
// A 5-row pixel font drawn for this file: 3 columns, 4 for M, N and W.
// Lower-case codes use the capital shapes.
const GLYPHS = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'], H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'], J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#..#', '####', '####', '#..#', '#..#'], N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'], P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#..#', '#..#', '####', '####', '#..#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###'],
  0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'], 3: ['##.', '..#', '.#.', '..#', '##.'],
  4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'], 9: ['###', '#.#', '###', '..#', '##.'],
  ' ': ['...', '...', '...', '...', '...'], '!': ['.#.', '.#.', '.#.', '...', '.#.'],
  '"': ['#.#', '#.#', '...', '...', '...'], '#': ['#.#', '###', '#.#', '###', '#.#'],
  $: ['.##', '##.', '.#.', '.##', '##.'], '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '&': ['.#.', '#.#', '.#.', '#.#', '.##'], "'": ['.#.', '.#.', '...', '...', '...'],
  '(': ['..#', '.#.', '.#.', '.#.', '..#'], ')': ['#..', '.#.', '.#.', '.#.', '#..'],
  '*': ['...', '#.#', '.#.', '#.#', '...'], '+': ['...', '.#.', '###', '.#.', '...'],
  ',': ['...', '...', '...', '.#.', '#..'], '-': ['...', '...', '###', '...', '...'],
  '.': ['...', '...', '...', '...', '.#.'], '/': ['..#', '..#', '.#.', '#..', '#..'],
  ':': ['...', '.#.', '...', '.#.', '...'], ';': ['...', '.#.', '...', '.#.', '#..'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'], '=': ['...', '###', '...', '###', '...'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'], '?': ['##.', '..#', '.#.', '...', '.#.'],
  '@': ['.#.', '#.#', '###', '#..', '.##'], '[': ['##.', '#..', '#..', '#..', '##.'],
  '\\': ['#..', '#..', '.#.', '..#', '..#'], ']': ['.##', '..#', '..#', '..#', '.##'],
  '^': ['.#.', '#.#', '...', '...', '...'], _: ['...', '...', '...', '...', '###'],
  '`': ['#..', '.#.', '...', '...', '...'], '{': ['.##', '.#.', '##.', '.#.', '.##'],
  '|': ['.#.', '.#.', '.#.', '.#.', '.#.'], '}': ['##.', '.#.', '.##', '.#.', '##.'],
  '~': ['...', '##.', '.##', '...', '...'],
  'Ä': ['#.#', '.#.', '#.#', '###', '#.#'], 'Å': ['.#.', '...', '###', '#.#', '#.#'],
  'Ö': ['#.#', '...', '###', '#.#', '###'], '…': ['...', '...', '...', '...', '#.#'],
};
const glyphFor = ch => GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? null;
const glyphWidth = ch => (glyphFor(ch) ?? GLYPHS[' '])[0].length;
const textWidth = text => [...text].reduce((sum, ch) => sum + glyphWidth(ch) + 1, 0) - (text.length ? 1 : 0);

// ------------------------------------------------------------------ image ----
class Img {
  constructor(w, h, fill = C.bg) {
    this.w = w; this.h = h; this.px = new Uint8Array(w * h * 3);
    this.rect(0, 0, w, h, fill);
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
  }
  rect(x, y, w, h, c) { for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) this.set(i, j, c); return this; }
  /** A one-pixel frame: light top-left and dark bottom-right when raised. */
  edge(x, y, w, h, raised = true) {
    const a = raised ? C.hi : C.lo; const b = raised ? C.lo : C.hi;
    this.rect(x, y, w, 1, a); this.rect(x, y, 1, h, a);
    this.rect(x, y + h - 1, w, 1, b); this.rect(x + w - 1, y, 1, h, b);
    return this;
  }
  well(x, y, w, h, fill = C.panel) { this.rect(x, y, w, h, fill); return this.edge(x, y, w, h, false); }
  text(text, x, y, c, scale = 1) {
    let at = x;
    for (const ch of text) {
      const g = glyphFor(ch);
      if (g) g.forEach((row, j) => [...row].forEach((p, i) => { if (p === '#') this.rect(at + i * scale, y + j * scale, scale, scale, c); }));
      at += (glyphWidth(ch) + 1) * scale;
    }
    return this;
  }
  textCentred(text, y, c, x0 = 0, w = this.w) { return this.text(text, x0 + Math.floor((w - textWidth(text)) / 2), y, c); }
  /** Raised (or pressed) button face with a one-pixel frame. */
  button(x, y, w, h, pressed = false, face = null) {
    this.rect(x, y, w, h, face ?? (pressed ? C.buttonDown : C.button));
    return this.edge(x, y, w, h, !pressed);
  }
  blit(src, x, y) {
    for (let j = 0; j < src.h; j += 1) for (let i = 0; i < src.w; i += 1) {
      const k = (j * src.w + i) * 3;
      this.set(x + i, y + j, [src.px[k], src.px[k + 1], src.px[k + 2]]);
    }
    return this;
  }
  grip(x, y, h, n = 3, c = C.lo) { for (let k = 0; k < n; k += 1) this.rect(x + k * 2, y, 1, h, c); return this; }
}

// ------------------------------------------------------------------ icons ----
// Each draws into img with its centre at (cx, cy).
const icons = {
  play(img, cx, cy, c) { for (let i = 0; i < 5; i += 1) img.rect(cx - 2 + i, cy - 4 + i, 1, 9 - 2 * i, c); },
  pause(img, cx, cy, c) { img.rect(cx - 3, cy - 4, 2, 9, c); img.rect(cx + 1, cy - 4, 2, 9, c); },
  stop(img, cx, cy, c) { img.rect(cx - 3, cy - 3, 7, 7, c); },
  prev(img, cx, cy, c) { img.rect(cx - 4, cy - 4, 2, 9, c); for (let i = 0; i < 5; i += 1) img.rect(cx + 2 - i, cy - 4 + i, 1, 9 - 2 * i, c); },
  next(img, cx, cy, c) { for (let i = 0; i < 5; i += 1) img.rect(cx - 3 + i, cy - 4 + i, 1, 9 - 2 * i, c); img.rect(cx + 2, cy - 4, 2, 9, c); },
  eject(img, cx, cy, c) { for (let i = 0; i < 4; i += 1) img.rect(cx - i, cy - 4 + i, 2 * i + 1, 1, c); img.rect(cx - 4, cy + 1, 9, 2, c); },
  close(img, cx, cy, c) { for (let i = -2; i <= 2; i += 1) { img.set(cx + i, cy + i, c); img.set(cx + i, cy - i, c); } },
  minimise(img, cx, cy, c) { img.rect(cx - 2, cy + 2, 5, 1, c); },
  shade(img, cx, cy, c) { img.rect(cx - 2, cy - 2, 5, 1, c); img.rect(cx - 2, cy, 5, 1, c); },
  unshade(img, cx, cy, c) { img.rect(cx - 2, cy - 2, 5, 5, c); img.rect(cx - 1, cy - 1, 3, 3, C.button); },
  menu(img, cx, cy, c) { img.rect(cx - 1, cy - 1, 3, 3, c); },
};
/** A 9x9 window button with an icon. */
function smallButton(kind, pressed) {
  const img = new Img(9, 9).button(0, 0, 9, 9, pressed);
  icons[kind](img, pressed ? 5 : 4, pressed ? 5 : 4, C.icon);
  return img;
}
/** A mini transport icon (5x5 area) for the playlist's action row. */
function miniIcon(img, kind, x, y) {
  const c = C.engrave;
  if (kind === 'play') for (let i = 0; i < 3; i += 1) img.rect(x + 1 + i, y + i, 1, 5 - 2 * i, c);
  if (kind === 'pause') { img.rect(x, y, 2, 5, c); img.rect(x + 3, y, 2, 5, c); }
  if (kind === 'stop') img.rect(x, y, 5, 5, c);
  if (kind === 'prev') { img.rect(x, y, 1, 5, c); for (let i = 0; i < 3; i += 1) img.rect(x + 3 - i, y + i, 1, 5 - 2 * i, c); }
  if (kind === 'next') { for (let i = 0; i < 3; i += 1) img.rect(x + 1 + i, y + i, 1, 5 - 2 * i, c); img.rect(x + 4, y, 1, 5, c); }
  if (kind === 'eject') { for (let i = 0; i < 3; i += 1) img.rect(x + 2 - i, y + i, 2 * i + 1, 1, c); img.rect(x, y + 4, 5, 1, c); }
}

// ------------------------------------------------------- sprite painters ----
/** A title strip: focused or not, with an optional centred label. */
function titleStrip(w, h, focused, label = '', stripH = 14) {
  const img = new Img(w, h);
  img.rect(0, 0, w, stripH, focused ? C.titleOn : C.titleOff);
  img.rect(0, stripH - 1, w, 1, C.lo);
  if (label) img.textCentred(label, 5, focused ? C.titleOnText : C.titleOffText);
  return img;
}
/** A toggle button: lamp plus label; selected = on, depressed = pressed. */
function toggle(w, h, label, on, pressed) {
  const img = new Img(w, h).button(0, 0, w, h, pressed);
  const d = pressed ? 1 : 0;
  const lampY = Math.floor((h - 3) / 2) + d;
  img.rect(3 + d, lampY, 3, 3, on ? C.lampOn : C.lampOff);
  img.text(label, 8 + d, Math.floor((h - 5) / 2) + d, C.icon);
  return img;
}
function labelButton(w, h, label, pressed) {
  const img = new Img(w, h).button(0, 0, w, h, pressed);
  const d = pressed ? 1 : 0;
  return img.text(label, Math.floor((w - textWidth(label)) / 2) + d, Math.floor((h - 5) / 2) + d, C.icon);
}
function thumb(w, h, lit) {
  const img = new Img(w, h).button(0, 0, w, h, false, lit ? C.buttonLit : C.button);
  return img.grip(Math.floor(w / 2) - 2, 2, h - 4);
}
/** Frames of a horizontal slider background, 15 px apart, `count` frames. */
function sliderFrames(w, h, count, fromCentre) {
  const img = new Img(w, h);
  for (let k = 0; k < count; k += 1) {
    const y = k * 15;
    img.well(0, y + 4, w - (fromCentre ? 0 : 3), 6);
    const inner = (fromCentre ? w : w - 3) - 2;
    if (fromCentre) {
      const half = Math.round((k / (count - 1)) * Math.floor(inner / 2));
      img.rect(Math.floor(w / 2) - half, y + 5, half * 2, 4, C.dim);
    } else {
      img.rect(1, y + 5, Math.round((k / (count - 1)) * inner), 4, C.dim);
    }
  }
  return img;
}
function eqSliderFrames(w, h) {
  const img = new Img(w, h);
  for (let n = 0; n < 28; n += 1) {
    const x = (n % 14) * 15; const y = Math.floor(n / 14) * 65;
    img.well(x + 5, y, 4, 63);
    const fill = Math.round((n / 27) * 61);
    img.rect(x + 6, y + 62 - fill, 2, fill, C.dim);
  }
  return img;
}
function playlistTop(name, w, h) {
  const focused = name.endsWith('_SELECTED') || name.includes('_SELECTED');
  const img = titleStrip(w, h, focused, name.startsWith('PLAYLIST_TITLE_BAR') ? 'PLAYLIST' : '');
  if (name.startsWith('PLAYLIST_TOP_LEFT')) { img.rect(0, 0, 1, h, C.hi); img.rect(11, h - 1, w - 11, 1, C.lo); img.rect(11, 14, 1, 6, C.lo); }
  else img.rect(0, h - 1, w, 1, C.lo);
  if (name.startsWith('PLAYLIST_TOP_RIGHT')) {
    img.rect(w - 1, 0, 1, h, C.lo); img.rect(5, 14, 1, 6, C.hi);
    img.rect(5, h - 1, w - 5, 1, C.bg);
    img.blit(smallButton('shade', false), 4, 3); img.blit(smallButton('close', false), 14, 3);
  }
  return img;
}
function genTop(name, w, h) {
  const focused = name.includes('_SELECTED');
  const img = titleStrip(w, h, focused);
  if (name.startsWith('GEN_TOP_LEFT_SELECTED') || name === 'GEN_TOP_LEFT') { img.rect(0, 0, 1, h, C.hi); img.rect(10, 14, 1, 6, C.lo); img.rect(10, h - 1, w - 10, 1, C.lo); }
  if (name.startsWith('GEN_TOP_RIGHT_SELECTED') || name === 'GEN_TOP_RIGHT') {
    img.rect(w - 1, 0, 1, h, C.lo); img.rect(w - 9, 14, 1, 6, C.hi);
    img.blit(smallButton('close', false), w - 11, 3);
  }
  return img;
}

const MAIN_BUTTONS = { PREVIOUS: 'prev', PLAY: 'play', PAUSE: 'pause', STOP: 'stop', NEXT: 'next', EJECT: 'eject' };
const PLAYLIST_LABELS = {
  ADD_URL: 'URL', ADD_DIR: 'DIR', ADD_FILE: 'FILE', REMOVE_ALL: 'ALL', CROP: 'CROP', REMOVE_SELECTED: 'SEL',
  REMOVE_MISC: 'MISC', INVERT_SELECTION: 'INV', SELECT_ZERO: 'NONE', SELECT_ALL: 'ALL', SORT_LIST: 'SORT',
  FILE_INFO: 'INFO', MISC_OPTIONS: 'OPTS', NEW_LIST: 'NEW', SAVE_LIST: 'SAVE', LOAD_LIST: 'LOAD',
};
const EQ_BANDS = [['60', 78], ['170', 96], ['310', 114], ['600', 132], ['1K', 150], ['3K', 168], ['6K', 186], ['12K', 204], ['14K', 222], ['16K', 240]];

const edgesH = (w, h) => new Img(w, h).rect(0, 0, w, 1, C.hi).rect(0, h - 1, w, 1, C.lo);
const edgesV = (w, h) => new Img(w, h).rect(0, 0, 1, h, C.hi).rect(w - 1, 0, 1, h, C.lo);
const lamp = (w, h) => new Img(w, h, C.buttonLit).rect(0, h - 1, w, 1, C.lo);
const same = (names, paint) => Object.fromEntries(names.map(n => [n, paint]));

/** Sprites whose art follows from parts of their name. */
const PATTERNS = [
  [/^CHARACTER_(\d+)$/, (m, w, h) => new Img(w, h, C.panel).text(String.fromCharCode(Number(m[1])), 0, 0, C.ink)],
  [/^GEN_TEXT_(SELECTED_)?([A-Z])$/, (m, w, h) => new Img(w, h, m[1] ? C.titleOn : C.titleOff).text(m[2], 0, 1, m[1] ? C.titleOnText : C.titleOffText)],
  [/^DIGIT_(\d)(_EX)?$/, (m, w, h) => new Img(w, h, C.panel).text(m[1], 1, 1, C.ink, 2)],
  [/^MAIN_(PREVIOUS|PLAY|PAUSE|STOP|NEXT|EJECT)_BUTTON(_ACTIVE)?$/, (m, w, h) => {
    const d = m[2] ? 1 : 0;
    const img = new Img(w, h).button(0, 0, w, h, Boolean(d));
    icons[MAIN_BUTTONS[m[1]]](img, Math.floor(w / 2) + d, Math.floor(h / 2) + d, C.icon);
    return img;
  }],
  [/^MAIN_(SHUFFLE|REPEAT)_BUTTON(_SELECTED)?(_DEPRESSED)?$/, (m, w, h) => toggle(w, h, m[1] === 'SHUFFLE' ? 'SHUFFLE' : 'REP', Boolean(m[2]), Boolean(m[3]))],
  [/^MAIN_(EQ|PLAYLIST)_BUTTON(_DEPRESSED)?(_SELECTED)?$/, (m, w, h) => toggle(w, h, m[1] === 'EQ' ? 'EQ' : 'PL', Boolean(m[3]), Boolean(m[2]))],
  [/^EQ_(ON|AUTO)_BUTTON(_SELECTED)?(_DEPRESSED)?$/, (m, w, h) => toggle(w, h, m[1], Boolean(m[2]), Boolean(m[3]))],
  [/^EQ_PRESETS_BUTTON(_SELECTED)?$/, (m, w, h) => labelButton(w, h, 'PRESETS', Boolean(m[1]))],
  [/^PLAYLIST_(.+?)(_SELECTED)?$/, (m, w, h) => {
    const whole = m[2] ? `${m[1]}${m[2]}` : m[1];
    if (PLAYLIST_LABELS[whole]) return labelButton(w, h, PLAYLIST_LABELS[whole], false);
    return PLAYLIST_LABELS[m[1]] && m[2] ? labelButton(w, h, PLAYLIST_LABELS[m[1]], true) : undefined;
  }],
  [/^MAIN_(STEREO|MONO)(_SELECTED)?$/, (m, w, h) => new Img(w, h).textCentred(m[1], 4, m[2] ? C.lampOn : C.lo)],
  [/^MAIN_CLUTTER_BAR_BUTTON_([OAIDV])_SELECTED$/, (m, w, h) => new Img(w, h, C.panel).text(m[1], 2, Math.floor((h - 5) / 2), C.lampOn)],
  [/^(PLAYLIST_TOP_|PLAYLIST_TITLE_BAR)/, (m, w, h, name) => playlistTop(name, w, h)],
  [/^GEN_TOP_/, (m, w, h, name) => genTop(name, w, h)],
];

// The unpressed title-bar buttons are part of the title bar art: Webamp only
// paints the button sprites while one is pressed.
function mainTitle(img, shadeIcon) {
  return img.blit(smallButton('menu', false), 6, 3).blit(smallButton('minimise', false), 244, 3)
    .blit(smallButton(shadeIcon, false), 254, 3).blit(smallButton('close', false), 264, 3);
}
function mainBackground(w, h) {
  const img = new Img(w, h).edge(0, 0, w, h, true);
  img.well(9, 20, 97, 46); // time, state and visualiser
  img.well(109, 22, 157, 14); // song title
  img.well(109, 41, 19, 10).text('KBPS', 131, 44, C.engrave);
  img.well(154, 41, 14, 10).text('KHZ', 171, 44, C.engrave);
  img.rect(10, 84, 255, 1, C.lo).rect(10, 85, 255, 1, C.hi);
  for (const y of [94, 97, 100]) img.rect(255, y, 9, 1, C.engrave);
  return img;
}
function clutterBar(w, h, name) {
  const img = new Img(w, h, C.panel);
  const c = name.endsWith('DISABLED') ? C.lampOff : C.dim;
  for (const [letter, y] of [['O', 4], ['A', 12], ['I', 19], ['D', 26], ['V', 34]]) img.text(letter, 2, y, c);
  return img;
}
function playlistBottomRight(w, h) {
  const img = new Img(w, h).rect(0, 0, w, 1, C.hi).rect(w - 1, 0, 1, h, C.lo).rect(0, h - 1, w, 1, C.lo);
  img.blit(labelButton(22, 18, 'LIST', false), 106, 8);
  img.well(5, 8, 62, 10).well(64, 21, 30, 10);
  ['prev', 'play', 'pause', 'stop', 'next', 'eject'].forEach((kind, i) => miniIcon(img, kind, 5 + i * 10 - (i === 5 ? 1 : 0), 24));
  for (let k = 0; k < 4; k += 1) for (let i = 0; i <= k; i += 1) img.set(w - 3 - i * 3, h - 3 - (k - i) * 3, C.lo);
  return img;
}
function eqBackground(w, h) {
  const img = new Img(w, h).edge(0, 0, w, h, true);
  img.text('+12', 44, 39, C.engrave).text('0', 52, 67, C.engrave).text('-12', 44, 94, C.engrave).text('PRE', 22, 104, C.engrave);
  for (const [label, x] of EQ_BANDS) img.text(label, x + 7 - Math.floor(textWidth(label) / 2), 104, C.engrave);
  return img.rect(64, 37, 1, 65, C.lo);
}
function eqShade(w, h, name) {
  const focused = name.endsWith('SELECTED');
  const img = titleStrip(w, h, focused).text('EQ', 8, 5, focused ? C.titleOnText : C.titleOffText);
  img.well(61, 4, 97, 6).well(164, 4, 43, 6);
  return img.blit(smallButton('unshade', false), 254, 3).blit(smallButton('close', false), 264, 3);
}
function eqLineColours(w, h) {
  const img = new Img(w, h);
  for (let y = 0; y < h; y += 1) img.set(0, y, C.ink.map((v, i) => Math.round(v + (C.dim[i] - v) * (y / (h - 1)))));
  return img;
}

/** Sprites with art of their own, by exact name. Each painter takes (w, h, name). */
const NAMED = {
  MAIN_WINDOW_BACKGROUND: mainBackground,
  ...same(['MAIN_TITLE_BAR', 'MAIN_EASTER_EGG_TITLE_BAR'], (w, h) => mainTitle(titleStrip(w, h, false, 'NAKLIAMP'), 'shade')),
  ...same(['MAIN_TITLE_BAR_SELECTED', 'MAIN_EASTER_EGG_TITLE_BAR_SELECTED'], (w, h) => mainTitle(titleStrip(w, h, true, 'NAKLIAMP'), 'shade')),
  ...same(['MAIN_SHADE_BACKGROUND', 'MAIN_SHADE_BACKGROUND_SELECTED'], (w, h, name) =>
    mainTitle(titleStrip(w, h, name.endsWith('SELECTED')).well(77, 3, 40, 9).well(125, 3, 29, 9), 'unshade')),
  MAIN_OPTIONS_BUTTON: () => smallButton('menu', false),
  MAIN_OPTIONS_BUTTON_DEPRESSED: () => smallButton('menu', true),
  MAIN_MINIMIZE_BUTTON: () => smallButton('minimise', false),
  MAIN_MINIMIZE_BUTTON_DEPRESSED: () => smallButton('minimise', true),
  MAIN_SHADE_BUTTON: () => smallButton('shade', false),
  MAIN_SHADE_BUTTON_DEPRESSED: () => smallButton('shade', true),
  MAIN_SHADE_BUTTON_SELECTED: () => smallButton('unshade', false),
  MAIN_SHADE_BUTTON_SELECTED_DEPRESSED: () => smallButton('unshade', true),
  MAIN_CLOSE_BUTTON: () => smallButton('close', false),
  MAIN_CLOSE_BUTTON_DEPRESSED: () => smallButton('close', true),
  ...same(['MAIN_CLUTTER_BAR_BACKGROUND', 'MAIN_CLUTTER_BAR_BACKGROUND_DISABLED'], clutterBar),
  MAIN_SHADE_POSITION_BACKGROUND: (w, h) => new Img(w, h).well(0, 2, w, 3),
  ...same(['MAIN_SHADE_POSITION_THUMB', 'MAIN_SHADE_POSITION_THUMB_LEFT', 'MAIN_SHADE_POSITION_THUMB_RIGHT'], lamp),
  MAIN_PLAYING_INDICATOR: (w, h) => { const img = new Img(w, h, C.panel); for (let i = 0; i < 4; i += 1) img.rect(2 + i, 1 + i, 1, 7 - 2 * i, C.ink); return img; },
  MAIN_PAUSED_INDICATOR: (w, h) => new Img(w, h, C.panel).rect(2, 1, 2, 7, C.ink).rect(5, 1, 2, 7, C.ink),
  MAIN_STOPPED_INDICATOR: (w, h) => new Img(w, h, C.panel).rect(2, 2, 5, 5, C.ink),
  MAIN_WORKING_INDICATOR: (w, h) => new Img(w, h, C.panel).rect(0, 3, 2, 3, C.ink),
  MAIN_NOT_WORKING_INDICATOR: (w, h) => new Img(w, h, C.panel),
  MAIN_POSITION_SLIDER_BACKGROUND: (w, h) => new Img(w, h).well(0, 3, w, 4),
  MAIN_VOLUME_BACKGROUND: (w, h) => sliderFrames(w, h, 28, false),
  MAIN_BALANCE_BACKGROUND: (w, h) => sliderFrames(w, h, 28, true),
  ...same(['MAIN_POSITION_SLIDER_THUMB', 'MAIN_VOLUME_THUMB', 'MAIN_BALANCE_THUMB', 'PLAYLIST_SCROLL_HANDLE', 'EQ_SLIDER_THUMB'], (w, h) => thumb(w, h, false)),
  ...same(['MAIN_POSITION_SLIDER_THUMB_SELECTED', 'MAIN_VOLUME_THUMB_SELECTED', 'MAIN_BALANCE_THUMB_ACTIVE', 'PLAYLIST_SCROLL_HANDLE_SELECTED', 'EQ_SLIDER_THUMB_SELECTED'], (w, h) => thumb(w, h, true)),
  MINUS_SIGN: (w, h) => new Img(w, h, C.ink),
  ...same(['NO_MINUS_SIGN', 'NO_MINUS_SIGN_EX'], (w, h) => new Img(w, h, C.panel)),
  MINUS_SIGN_EX: (w, h) => new Img(w, h, C.panel).rect(1, 6, 6, 2, C.ink),
  ...same(['PLAYLIST_LEFT_TILE', 'GEN_MIDDLE_LEFT', 'GEN_MIDDLE_LEFT_BOTTOM', 'GEN_MIDDLE_RIGHT', 'GEN_MIDDLE_RIGHT_BOTTOM'], edgesV),
  PLAYLIST_RIGHT_TILE: (w, h) => edgesV(w, h).rect(5, 0, 8, h, C.panel),
  ...same(['PLAYLIST_BOTTOM_TILE', 'GEN_BOTTOM_FILL'], edgesH),
  PLAYLIST_BOTTOM_LEFT_CORNER: (w, h) => {
    const img = edgesH(w, h).rect(0, 0, 1, h, C.hi);
    for (const [label, x] of [['ADD', 14], ['REM', 43], ['SEL', 72], ['MISC', 101]]) img.blit(labelButton(22, 18, label, false), x, 8);
    return img;
  },
  PLAYLIST_BOTTOM_RIGHT_CORNER: playlistBottomRight,
  PLAYLIST_VISUALIZER_BACKGROUND: (w, h) => edgesH(w, h).well(1, 11, 74, 18),
  ...same(['PLAYLIST_SHADE_BACKGROUND', 'PLAYLIST_SHADE_BACKGROUND_LEFT'], (w, h) => titleStrip(w, h, false)),
  ...same(['PLAYLIST_SHADE_BACKGROUND_RIGHT', 'PLAYLIST_SHADE_BACKGROUND_RIGHT_SELECTED'], (w, h, name) =>
    titleStrip(w, h, name.endsWith('SELECTED')).blit(smallButton('unshade', false), w - 21, 3).blit(smallButton('close', false), w - 11, 3)),
  ...same(['PLAYLIST_ADD_MENU_BAR', 'PLAYLIST_REMOVE_MENU_BAR', 'PLAYLIST_SELECT_MENU_BAR', 'PLAYLIST_MISC_MENU_BAR', 'PLAYLIST_LIST_BAR'],
    (w, h) => new Img(w, h, C.button).rect(0, 0, 1, h, C.hi).rect(w - 1, 0, 1, h, C.lo)),
  ...same(['PLAYLIST_CLOSE_SELECTED', 'EQ_CLOSE_BUTTON_ACTIVE', 'EQ_SHADE_CLOSE_BUTTON_ACTIVE', 'GEN_CLOSE_SELECTED'], () => smallButton('close', true)),
  ...same(['PLAYLIST_COLLAPSE_SELECTED', 'EQ_MINIMIZE_BUTTON_ACTIVE'], () => smallButton('shade', true)),
  ...same(['PLAYLIST_EXPAND_SELECTED', 'EQ_MAXIMIZE_BUTTON_ACTIVE', 'EQ_MAXIMIZE_BUTTON_ACTIVE_FALLBACK'], () => smallButton('unshade', true)),
  ...same(['EQ_CLOSE_BUTTON', 'EQ_SHADE_CLOSE_BUTTON'], () => smallButton('close', false)),
  EQ_WINDOW_BACKGROUND: eqBackground,
  ...same(['EQ_TITLE_BAR', 'EQ_TITLE_BAR_SELECTED'], (w, h, name) =>
    titleStrip(w, h, name.endsWith('SELECTED'), 'EQUALISER').blit(smallButton('shade', false), 254, 3).blit(smallButton('close', false), 264, 3)),
  ...same(['EQ_SHADE_BACKGROUND', 'EQ_SHADE_BACKGROUND_SELECTED'], eqShade),
  ...same(['EQ_SHADE_VOLUME_SLIDER_LEFT', 'EQ_SHADE_VOLUME_SLIDER_CENTER', 'EQ_SHADE_VOLUME_SLIDER_RIGHT',
    'EQ_SHADE_BALANCE_SLIDER_LEFT', 'EQ_SHADE_BALANCE_SLIDER_CENTER', 'EQ_SHADE_BALANCE_SLIDER_RIGHT'], lamp),
  EQ_SLIDER_BACKGROUND: eqSliderFrames,
  EQ_GRAPH_BACKGROUND: (w, h) => {
    const img = new Img(w, h).well(0, 0, w, h);
    for (let x = 2; x < w - 2; x += 2) img.set(x, Math.floor(h / 2), C.lampOff);
    return img;
  },
  EQ_GRAPH_LINE_COLORS: eqLineColours,
  EQ_PREAMP_LINE: (w, h) => new Img(w, h, C.dim),
  GEN_BOTTOM_LEFT: (w, h) => edgesH(w, h).rect(0, 0, 1, h, C.hi),
  GEN_BOTTOM_RIGHT: (w, h) => {
    const img = edgesH(w, h).rect(w - 1, 0, 1, h, C.lo);
    for (let k = 0; k < 3; k += 1) img.rect(w - 4 - k * 3, h - 3 - (2 - k) * 3, 2, 1, C.lo);
    return img;
  },
};

/** Neutral art for one sprite of Webamp's sprite map, at its exact size. */
export function paintSprite(name, w, h) {
  if (Object.hasOwn(NAMED, name)) return NAMED[name](w, h, name);
  for (const [pattern, paint] of PATTERNS) {
    const m = pattern.exec(name);
    const img = m && paint(m, w, h, name);
    if (img) return img;
  }
  throw new Error(`No neutral art for sprite ${name}.`);
}

// -------------------------------------------------------------- encoders ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** An 8-bit RGB PNG, filter 0 on every row, zlib level 9. */
export function encodePng(img) {
  const raw = Buffer.alloc((img.w * 3 + 1) * img.h);
  for (let y = 0; y < img.h; y += 1) Buffer.from(img.px.subarray(y * img.w * 3, (y + 1) * img.w * 3)).copy(raw, y * (img.w * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const ARROW = ['#', '##', '#o#', '#oo#', '#ooo#', '#oooo#', '#ooooo#', '#oooooo#', '#ooooooo#', '#oooo####', '#oo#', '##', '#'];
const RESIZE = ['#####', '#ooo#', '#oo#', '#o#o#', '##.#o#', '....#o#', '.....#o#.##', '......#o#o#', '.......#oo#', '......#ooo#', '......#####'];
/** A 32x32 one-bit .cur: '#' black, 'o' white, anything else transparent. */
export function encodeCursor(rows, hotX, hotY) {
  const out = Buffer.alloc(22 + 40 + 8 + 128 + 128);
  out.writeUInt16LE(0, 0); out.writeUInt16LE(2, 2); out.writeUInt16LE(1, 4);
  out[6] = 32; out[7] = 32; out[8] = 2; out[9] = 0;
  out.writeUInt16LE(hotX, 10); out.writeUInt16LE(hotY, 12); out.writeUInt32LE(40 + 8 + 256, 14); out.writeUInt32LE(22, 18);
  out.writeUInt32LE(40, 22); out.writeInt32LE(32, 26); out.writeInt32LE(64, 30); out.writeUInt16LE(1, 34); out.writeUInt16LE(1, 36);
  out.writeUInt32LE(256, 42); out.writeUInt32LE(2, 54);
  out.writeUInt32LE(0x00000000, 62); out.writeUInt32LE(0x00ffffff, 66);
  for (let y = 0; y < 32; y += 1) {
    const row = 31 - y; // bottom-up
    for (let x = 0; x < 32; x += 1) {
      const p = rows[y]?.[x];
      const bit = 0x80 >> (x % 8);
      const byte = Math.floor(x / 8);
      if (p === 'o') out[70 + row * 4 + byte] |= bit; // XOR: white
      if (p !== '#' && p !== 'o') out[198 + row * 4 + byte] |= bit; // AND: transparent
    }
  }
  return out;
}

// ---------------------------------------------------- bundle inspection ----
const B64 = '[A-Za-z0-9+/=]+';
const IMAGE_RULE = new RegExp(`#webamp ([^{}]+?) \\{background-image: url\\(data:image/png;base64,(${B64})\\)\\}`, 'g');
const CURSOR_RULE = new RegExp(`([^{}'\\n]+?) \\{cursor: url\\(data:image/x-win-bitmap;base64,(${B64})\\), auto\\}`, 'g');
const GEN_WIDTH_RULE = /#webamp (\.selected )?\.gen-text-([a-z]) \{width: (\d+)px;\}/g;
// Upstream writes the default skin with bare keys; the patched bundle has JSON keys.
const DEFAULT_SKIN_START = /\{"?images"?:\{"?EQ_PREAMP_LINE"?:"/g;

/** The object literal starting at `start` (bracket-matched, strings skipped). */
const DEPTH = { '{': 1, '[': 1, '}': -1, ']': -1 };
function literalAt(text, start) {
  let depth = 0; let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1; else if (c === quote) quote = null;
    } else if ('"\'`'.includes(c)) {
      quote = c;
    } else if (DEPTH[c]) {
      depth += DEPTH[c];
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('Unterminated object literal in the bundle.');
}
const evalLiteral = src => runInNewContext(`(${src})`, Object.create(null), { timeout: 1000 });

function findOnce(text, needle) {
  if (needle instanceof RegExp) {
    const hits = [...text.matchAll(needle)];
    if (hits.length !== 1) throw new Error(`Expected exactly one ${needle} in the bundle, found ${hits.length}.`);
    return hits[0].index;
  }
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) throw new Error(`Expected exactly one ${JSON.stringify(needle.slice(0, 40))} in the bundle.`);
  return at;
}

/** Webamp's sprite map: sprite name to its size on the skin sheet. */
function spriteSizes(text) {
  const src = literalAt(text, findOnce(text, '{BALANCE:[{name:"MAIN_BALANCE_BACKGROUND"'));
  // TEXT is built in a loop from FONT_LOOKUP; every character cell is 5x6
  // (CHAR_X, CHAR_Y in skinSprites.ts), so its sprites are added per selector.
  const map = evalLiteral(src.replace(/TEXT:[A-Za-z_$][\w$]*,/, 'TEXT:[],'));
  const sizes = new Map();
  for (const sprites of Object.values(map)) for (const s of sprites) sizes.set(s.name, [s.width, s.height]);
  return sizes;
}
/** Webamp's CSS selector to sprite name map, including the generated entries. */
function selectorNames(text) {
  const map = evalLiteral(literalAt(text, findOnce(text, '{MAIN_BALANCE_BACKGROUND:["#balance"]')));
  // A selector can serve more than one sprite (the minus sign of NUMBERS and of
  // NUMS_EX share one); the rule's image size tells them apart.
  const names = new Map();
  const add = (selector, name) => {
    const list = names.get(selector) ?? [];
    if (!list.includes(name)) list.push(name);
    names.set(selector, list);
  };
  for (const [name, selectors] of Object.entries(map)) for (const s of selectors) add(s, name);
  return { names, add };
}
const pngSize = bytes => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Every base64 data URL payload in a bundle, decoded and hashed. */
export function dataAssets(text) {
  const out = [];
  const re = new RegExp(`data:([a-z-]+/[a-z0-9.+-]+);base64,(${B64})`, 'g');
  let m;
  while ((m = re.exec(text))) {
    if (m[2].length < 16) continue; // template literals such as `base64,${...}`
    out.push({ type: m[1], at: m.index, sha256: sha256(Buffer.from(m[2], 'base64')) });
  }
  return out;
}

// -------------------------------------------------------------- patching ----
const rgb = c => `rgb(${c.join(',')})`;
const VIS_COLOURS = (() => {
  const out = [rgb(C.panel), rgb([0x3c, 0x3f, 0x44])];
  for (let i = 0; i < 16; i += 1) {
    const t = i / 15;
    out.push(rgb([230, 232, 236].map((v, k) => Math.round(v + ([110, 113, 118][k] - v) * t))));
  }
  for (const v of [220, 200, 180, 160, 140]) out.push(rgb([v, v, v]));
  out.push(rgb([255, 255, 255]));
  return out;
})();
const PLAYLIST_STYLE = { normal: '#C8CACE', current: '#FFFFFF', normalbg: '#16171A', selectedbg: '#4A4D53', font: 'Arial' };
// User-visible Winamp names in Webamp's text, each replaced once (exact match).
export const REBRAND = Object.freeze([
  ['title:"Winamp Menu"', 'title:"Menu"'], // tooltip and accessible name of the options button
  ['const t="Winamp 2.91"', 'const t="NakliAmp"'], // the marquee text when nothing else shows
  ['children:"WINAMP"})', 'children:"NakliAmp"})'], // heading of the exported playlist page
  ['<title>Winamp Generated PlayList</title>', '<title>NakliAmp playlist</title>'], // its page title
  ['"Winamp Playlist.html"', '"NakliAmp playlist.html"'], // its download file name
]);
// Kept on purpose, because changing them changes behaviour, not wording:
// Redux action types, CSS class names, and the .eqf file signature that other
// players (and app/audio/eqf.mjs) read and write.
export const KEPT_NAMES = Object.freeze({
  CLOSE_WINAMP: 'Redux action type; Webamp dispatches and matches it by this exact string.',
  OPEN_WINAMP: 'Redux action type; Webamp dispatches and matches it by this exact string.',
  MINIMIZE_WINAMP: 'Redux action type; Webamp dispatches and matches it by this exact string.',
  'winamp-active': 'CSS class on pressed buttons; the skin CSS selectors match it.',
  'winamp-button': 'CSS class used in one skin CSS selector.',
  'Winamp EQ library file v1.1': 'Signature at the start of every .eqf preset file; readers check it.',
});
function rebrand(text) {
  let out = text;
  for (const [from, to] of REBRAND) {
    const count = out.split(from).length - 1;
    if (count === 1) out = out.replace(from, to);
    else if (count !== 0 || !out.includes(to)) throw new Error(`Expected one ${from} (or its replacement) in the bundle, found ${count}.`);
  }
  return out;
}
const dataUrl = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;

/**
 * Replace every default-skin asset in a Webamp 2.3.1 bundle with neutral art.
 * Pure: the same text gives the same output. Running it on its own output gives
 * the output again. Returns the new text and a list of what it replaced.
 */
export function patchWebampBundle(text) {
  const sizes = spriteSizes(text);
  const { names, add } = selectorNames(text);
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    add(`.gen-text-${letter.toLowerCase()}`, `GEN_TEXT_${letter}`);
    add(`.gen-window.selected .gen-text-${letter.toLowerCase()}`, `GEN_TEXT_SELECTED_${letter}`);
  }
  const genWidth = letter => glyphWidth(letter.toUpperCase()) + 1; // glyph plus one pixel of space
  const cache = new Map();
  const art = (name, w, h) => {
    const key = `${name}:${w}x${h}`;
    if (!cache.has(key)) cache.set(key, dataUrl('image/png', encodePng(paintSprite(name, w, h))));
    return cache.get(key);
  };
  const replaced = { images: [], cursors: 0, genWidths: 0, defaultSkin: [] };

  let out = text.replace(IMAGE_RULE, (rule, selector, b64) => {
    const [ow, oh] = pngSize(Buffer.from(b64, 'base64'));
    const code = /^\.character-(\d+)$/.exec(selector)?.[1];
    if (code) { add(selector, `CHARACTER_${code}`); sizes.set(`CHARACTER_${code}`, [5, 6]); }
    const candidates = names.get(selector) ?? [];
    const name = candidates.length === 1 ? candidates[0]
      : candidates.find(n => sizes.get(n)?.[0] === ow && sizes.get(n)?.[1] === oh);
    if (!name) throw new Error(`Base skin rule for ${selector} (${ow}x${oh}) matches no sprite in the sprite map.`);
    let size = sizes.get(name);
    if (name.startsWith('GEN_TEXT_')) size = [genWidth(name.at(-1)), 7];
    else if (!size || size[0] !== ow || size[1] !== oh) throw new Error(`${name}: sprite map says ${size}, bundle image is ${ow}x${oh}.`);
    if (name.startsWith('GEN_TEXT_') && oh !== 7) throw new Error(`${name}: expected height 7, got ${oh}.`);
    replaced.images.push(name);
    return `#webamp ${selector} {background-image: url(${art(name, ...size)})}`;
  });
  const arrow = dataUrl('image/x-win-bitmap', encodeCursor(ARROW, 0, 0));
  const resize = dataUrl('image/x-win-bitmap', encodeCursor(RESIZE, 5, 5));
  out = out.replace(CURSOR_RULE, (rule, selector) => {
    replaced.cursors += 1;
    return `${selector} {cursor: url(${/resize-target/.test(selector) ? resize : arrow}), auto}`;
  });
  out = out.replace(GEN_WIDTH_RULE, (rule, selected, letter) => {
    replaced.genWidths += 1;
    return `#webamp ${selected ?? ''}.gen-text-${letter} {width: ${genWidth(letter)}px;}`;
  });

  const at = findOnce(out, DEFAULT_SKIN_START);
  const literal = literalAt(out, at);
  const original = evalLiteral(literal);
  const images = {};
  for (const name of Object.keys(original.images)) {
    const size = sizes.get(name);
    if (!size) throw new Error(`Default skin image ${name} is not in the sprite map.`);
    images[name] = art(name, ...size);
    replaced.defaultSkin.push(name);
  }
  if (original.colors.length !== VIS_COLOURS.length) throw new Error('The default skin has an unexpected number of visualiser colours.');
  replaced.defaultSkin.push('colors', 'playlistStyle');
  out = out.slice(0, at) + JSON.stringify({ images, colors: VIS_COLOURS, playlistStyle: PLAYLIST_STYLE }) + out.slice(at + literal.length);

  out = out.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
  out = rebrand(out);
  if (replaced.images.length !== 350 || replaced.cursors !== 18 || replaced.genWidths !== 52) {
    throw new Error(`Unexpected counts: ${replaced.images.length} images, ${replaced.cursors} cursors, ${replaced.genWidths} widths.`);
  }
  return { text: out, replaced };
}

// ------------------------------------------------------------------- CLI ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input) { console.error('Usage: node scripts/patch-webamp-skin.mjs <upstream webamp.bundle.min.mjs> [out]'); process.exit(2); }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = output ? resolve(output) : resolve(root, 'vendor/webamp/webamp-2.3.1.bundle.min.mjs');
  const bytes = await readFile(input);
  const inHash = sha256(bytes);
  if (inHash !== UPSTREAM_SHA256) { console.error(`Input SHA-256 ${inHash} is not the pinned Webamp 2.3.1 bundle ${UPSTREAM_SHA256}.`); process.exit(1); }
  const { text, replaced } = patchWebampBundle(bytes.toString('utf8'));
  await writeFile(target, text);
  const sprites = new Set(replaced.images);
  console.log(`upstream ${inHash}`);
  console.log(`patched  ${sha256(Buffer.from(text))}  ${target}`);
  console.log(`replaced ${replaced.images.length} CSS images (${sprites.size} sprites), ${replaced.cursors} cursors, ${replaced.genWidths} GEN letter widths, default skin: ${replaced.defaultSkin.join(', ')}`);
  console.log(`node ${process.version}, zlib ${process.versions.zlib}`);
}
