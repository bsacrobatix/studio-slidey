'use strict';

// Repro for deck-navigation bleed-through:
// while an inline field is active, clicking outside must request deck-nav click
// suppression so the global NavController click handler does not advance slides.

const assert = require('node:assert/strict');
const test = require('node:test');

function makeEl({ tagName = 'div', dataEditPath = null, initialText = '' } = {}) {
  const listeners = {};
  const attrs = {};
  if (dataEditPath !== null) attrs['data-edit-path'] = dataEditPath;
  const el = {
    tagName: tagName.toUpperCase(),
    textContent: initialText,
    attrs,
    listeners,
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    classList: {
      add() {},
      remove() {},
    },
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(h => h !== handler);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = value;
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    focus() {},
    contains(node) {
      return node === el;
    },
    closest(selector) {
      if (selector === '[data-edit-path]' && attrs['data-edit-path']) return el;
      return null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
  };
  return el;
}

function makeWinAndDoc() {
  const listeners = {};
  const doc = {
    body: {
      appendChild() {},
      removeChild() {},
    },
    createElement() {
      return makeEl();
    },
    createRange() {
      return { selectNodeContents() {} };
    },
  };
  const win = {
    getComputedStyle: () => ({ font: '16px monospace', fill: '#e6edf3', color: '#e6edf3' }),
    getSelection: () => ({
      removeAllRanges() {},
      addRange() {},
    }),
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    removeEventListener() {},
  };
  return { doc, win, listeners };
}

test('inline edit outside click requests deck-nav suppression', async () => {
  const { installInlineEdit } = await import('../web/inline-edit.js');
  const { doc, win, listeners } = makeWinAndDoc();
  const deckHost = makeEl({ dataEditPath: '["title"]', initialText: 'Intro' });
  const outside = { closest: () => null, contains: () => false };
  const calls = [];
  const states = [];
  const teardown = installInlineEdit({
    isActive: () => true,
    getSpec: () => ({ scenes: [{ type: 'title', title: 'Intro' }] }),
    getSceneIndex: () => 0,
    render: async () => {},
    markDirty: () => {},
    setInlineEditing: (v) => { states.push(Boolean(v)); },
    suppressDeckClick: () => calls.push('suppress'),
  }, win, doc);
  t.after(teardown);

  // Start editing.
  listeners.click({ target: deckHost, preventDefault() {}, stopPropagation() {} });
  assert.equal(states.at(-1), true, 'inline-edit enters editing mode');

  // Clicking elsewhere in the slide commits the field via blur and should suppress
  // deck-level navigation for this click.
  listeners.click({ target: outside, preventDefault() {}, stopPropagation() {} });
  assert.equal(calls.length, 1, 'outside click requested deck-nav suppression');
});

test('inline edit does not suppress deck-nav for a click inside the same field', async () => {
  const { installInlineEdit } = await import('../web/inline-edit.js');
  const { doc, win, listeners } = makeWinAndDoc();
  const deckHost = makeEl({ dataEditPath: '["title"]', initialText: 'Intro' });
  const calls = [];
  const teardown = installInlineEdit({
    isActive: () => true,
    getSpec: () => ({ scenes: [{ type: 'title', title: 'Intro' }] }),
    getSceneIndex: () => 0,
    render: async () => {},
    markDirty: () => {},
    setInlineEditing: () => {},
    suppressDeckClick: () => calls.push('suppress'),
  }, win, doc);
  t.after(teardown);

  listeners.click({ target: deckHost, preventDefault() {}, stopPropagation() {} });
  listeners.click({ target: deckHost, preventDefault() {}, stopPropagation() {} });
  assert.equal(calls.length, 0, 'clicking the same editable field keeps editing and does not suppress nav');
});
