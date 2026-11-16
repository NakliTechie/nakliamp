// The pop-out mini player (app/ui/shell/pip.mjs) against a small fake DOM: feature
// detection, the root attributes the pop-out copies, moving the bar out and back, the
// window's own close, and keys forwarded from the pop-out window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pipSupported, pipRootAttributes, createPopOut, PIP_CSS, styleSources } from '../app/ui/shell/pip.mjs';

class Node {
  constructor(name, doc) { this.name = name; this.ownerDocument = doc; this.parent = null; this.children = []; this.attrs = new Map(); this.textContent = ''; }
  append(...nodes) { for (const n of nodes) { n.remove(); n.parent = this; n.ownerDocument = this.ownerDocument; this.children.push(n); } }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  before(node) { node.remove(); const p = this.parent; p.children.splice(p.children.indexOf(this), 0, node); node.parent = p; node.ownerDocument = p.ownerDocument; }
  replaceWith(node) { const p = this.parent; node.remove(); p.children.splice(p.children.indexOf(this), 1, node); node.parent = p; node.ownerDocument = p.ownerDocument; this.parent = null; }
  cloneNode() { const c = new Node(this.name, this.ownerDocument); c.textContent = this.textContent; return c; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  get classList() { return (this.getAttribute('class') ?? '').split(' ').filter(Boolean); }
  set className(v) { this.setAttribute('class', v); }
}

function makeDoc() {
  const doc = { title: '' };
  doc.documentElement = new Node('html', doc);
  doc.head = new Node('head', doc);
  doc.body = new Node('body', doc);
  doc.documentElement.append(doc.head, doc.body);
  doc.createElement = name => new Node(name, doc);
  doc.createComment = text => Object.assign(new Node('#comment', doc), { textContent: text });
  doc.querySelectorAll = () => doc.head.children.filter(n => n.name === 'style' || n.name === 'link');
  return doc;
}

function makeEnv() {
  const doc = makeDoc();
  const style = doc.createElement('style');
  style.textContent = ':root{--bg:#fff}';
  doc.head.append(style);
  const shell = doc.createElement('div');
  const bar = doc.createElement('div');
  const after = doc.createElement('div');
  shell.append(bar, after);
  doc.body.append(shell);
  doc.documentElement.setAttribute('data-theme', 'dark');
  doc.documentElement.setAttribute('class', 'mini pip-out');
  doc.documentElement.setAttribute('style', '--accent: #123');
  const observers = [];
  const env = {
    document: doc,
    requests: [],
    windows: [],
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } },
    documentPictureInPicture: {
      async requestWindow(options) {
        env.requests.push(options);
        const listeners = {};
        const win = {
          document: makeDoc(),
          closed: false,
          addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
          dispatch(type, event = {}) { for (const fn of listeners[type] ?? []) fn(event); },
          close() { win.closed = true; win.dispatch('pagehide'); },
        };
        env.windows.push(win);
        return win;
      },
    },
  };
  return { env, doc, shell, bar, after, observers };
}

test('feature detection: only a requestWindow function counts', () => {
  assert.equal(pipSupported({}), false);
  assert.equal(pipSupported({ documentPictureInPicture: {} }), false);
  assert.equal(pipSupported({ documentPictureInPicture: { requestWindow() {} } }), true);
  assert.equal(pipSupported(null), false);
});

test('root attributes: theme and host tokens copied, opener-only classes dropped, mini added once', () => {
  assert.deepEqual(pipRootAttributes({ theme: 'dark', style: '--bg: #000', classes: ['mini', 'pip-out', 'x'] }),
    { theme: 'dark', style: '--bg: #000', classes: ['x', 'mini', 'pip-window'] });
  assert.deepEqual(pipRootAttributes({}), { theme: null, style: '', classes: ['mini', 'pip-window'] });
  assert.match(PIP_CSS, /html\.pip-window \.playerbar/);
});

test('open moves the bar into the window with the page CSS; close puts it back in place', async () => {
  const { env, doc, shell, bar, after, observers } = makeEnv();
  const seen = [];
  const pop = createPopOut({ element: bar, env, onOpen: () => seen.push('open'), onClose: () => seen.push('close') });
  assert.equal(pop.supported, true);
  assert.equal(pop.isOpen(), false);
  const win = await pop.open();
  assert.equal(pop.isOpen(), true);
  assert.deepEqual(env.requests, [{ width: 380, height: 380 }]);
  assert.equal(bar.parent, win.document.body, 'the bar is not in the pop-out body');
  assert.equal(shell.children[0].name, '#comment', 'no placeholder where the bar was');
  const styles = win.document.head.children;
  assert.equal(styles[0].textContent, ':root{--bg:#fff}', 'page CSS not copied');
  assert.equal(styles.at(-1).textContent, PIP_CSS);
  const root = win.document.documentElement;
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(root.getAttribute('style'), '--accent: #123');
  assert.deepEqual(root.classList, ['mini', 'pip-window']);
  assert.equal(observers[0].on, true);
  // A theme change in the page reaches the pop-out.
  doc.documentElement.setAttribute('data-theme', 'light');
  observers[0].fn();
  assert.equal(root.getAttribute('data-theme'), 'light');
  // A second open while open returns the same window.
  assert.equal(await pop.open(), win);
  assert.equal(env.requests.length, 1);

  assert.equal(pop.close(), true);
  assert.equal(win.closed, true);
  assert.deepEqual(shell.children, [bar, after], 'the bar did not return to its place');
  assert.equal(observers[0].on, false);
  assert.deepEqual(seen, ['open', 'close'], 'close ran its handler more than once');
  assert.equal(pop.close(), false);
});

test('the window closing itself returns the bar; keys in the window reach the page handler', async () => {
  const { env, shell, bar, after } = makeEnv();
  const keys = [];
  const pop = createPopOut({ element: bar, env, onKeydown: event => keys.push(event.key) });
  const win = await pop.open();
  win.dispatch('keydown', { key: 'N' });
  assert.deepEqual(keys, ['N']);
  win.close(); // the person closes the pop-out window
  assert.equal(pop.isOpen(), false);
  assert.deepEqual(shell.children, [bar, after]);
  // It opens again afterwards.
  await pop.open();
  assert.equal(env.windows.length, 2);
  assert.equal(bar.parent, env.windows[1].document.body);
});

test('unsupported: open refuses and nothing moves', async () => {
  const { doc, shell, bar, after } = makeEnv();
  const pop = createPopOut({ element: bar, env: { document: doc } });
  assert.equal(pop.supported, false);
  await assert.rejects(pop.open(), /no Document Picture-in-Picture/);
  assert.deepEqual(shell.children, [bar, after]);
  assert.throws(() => createPopOut({ env: {} }), TypeError);
  assert.equal(styleSources(doc).length, 1);
});
