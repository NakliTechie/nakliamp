// Review C: keyboard shortcuts behind modals and on activating elements (N7, N8).
// Run: node --test test/review-c-keys.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchShortcut, ownsActivationKeys, behindModal } from '../app/commands/run.mjs';

// A small element model: tagName, role, closest(selector) by walking parents, ownerDocument.
function el(tagName, { role = null, modal = false, parent = null, doc = null } = {}) {
  const node = {
    tagName, nodeType: 1, parentNode: parent, ownerDocument: doc ?? parent?.ownerDocument ?? null,
    getAttribute(name) { if (name === 'role') return role; if (name === 'aria-modal') return modal ? 'true' : null; return null; },
    matches(selector) {
      return selector.split(',').some(part => (part.trim() === '[aria-modal="true"]' && modal) || (part.trim() === '[role="menu"]' && role === 'menu'));
    },
    closest(selector) {
      for (let at = this; at; at = at.parentNode) if (at.matches?.(selector)) return at;
      return null;
    },
  };
  return node;
}
function doc({ openModal = false } = {}) {
  return { nodeType: 9, querySelector: selector => (openModal && selector === '[aria-modal="true"]' ? {} : null) };
}
const key = (k, target, extra = {}) => ({ key: k, code: '', target, ...extra });

test('N7: Space on a focused button, link, summary or interactive role does not toggle playback', () => {
  const d = doc();
  for (const [tag, role] of [['BUTTON', null], ['A', null], ['SUMMARY', null], ['DIV', 'button'], ['DIV', 'tab'], ['DIV', 'menuitem'], ['LI', 'option'], ['DIV', 'switch']]) {
    const target = el(tag, { role, doc: d });
    assert.equal(ownsActivationKeys(target), true, `${tag} ${role}`);
    assert.equal(matchShortcut(key(' ', target)), null, `Space on ${tag} ${role ?? ''}`);
  }
  // Space on the page itself still plays and pauses.
  assert.equal(matchShortcut(key(' ', el('BODY', { doc: d })))?.name, 'player.toggle');
  // Other single keys still work on a focused button (N on the Tools button skips the track).
  assert.equal(matchShortcut(key('n', el('BUTTON', { doc: d })))?.name, 'player.next');
});

test('N8: no shortcut acts while a modal dialog or a menu holds focus, or while a modal is open', () => {
  const d = doc({ openModal: false });
  const dialog = el('DIV', { role: 'dialog', modal: true, doc: d });
  const inside = el('BUTTON', { parent: dialog });
  for (const k of ['r', 's', 'n', ' ', 'ArrowRight']) assert.equal(matchShortcut(key(k, inside)), null, `${k} inside the dialog`);
  assert.equal(matchShortcut(key('z', inside, { ctrlKey: true })), null, 'Mod+Z inside the dialog');
  assert.equal(behindModal(inside), true);

  const menu = el('DIV', { role: 'menu', doc: d });
  assert.equal(matchShortcut(key('r', el('BUTTON', { role: 'menuitem', parent: menu }))), null, 'R inside the Tools menu');

  // Focus fell back to the body while a modal is still open.
  const open = doc({ openModal: true });
  assert.equal(matchShortcut(key('r', el('BODY', { doc: open }))), null, 'R with a modal open');
  // With no modal the same key repeats.
  assert.equal(matchShortcut(key('r', el('BODY', { doc: d })))?.name, 'queue.repeat');
});
