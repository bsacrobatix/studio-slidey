'use strict';

// Regression: when a deck is embedded in an iframe (e.g. a kitsoki annotation
// host), navigating to a scene must postMessage that scene to the parent so a
// feedback/refine pass targets the slide the operator is looking at — and must
// stay a no-op when the deck is the top window (not embedded).

const assert = require('node:assert/strict');
const test = require('node:test');

function makeWindow({ embedded }) {
  const posted = [];
  const parent = { postMessage: (msg) => posted.push(msg) };
  // window.slidey exposes a per-scene-type method surface; the test only cares
  // about the scene postMessage, so back every method with a no-op.
  const slidey = new Proxy({}, { get: () => () => {} });
  const win = {
    location: { href: 'http://localhost:4321/' },
    slidey,
    posted,
  };
  // Embedded → parent !== self; top window → parent === self (no-op).
  win.parent = embedded ? parent : win;
  if (!embedded) parent.postMessage = () => { throw new Error('top window must not post'); };
  return win;
}

const DECK = {
  meta: { mode: 'pitch' },
  scenes: [
    { type: 'title', title: 'Intro' },
    { type: 'cards', title: 'One anchor', cards: [{ label: 'a' }] },
    { type: 'image', title: 'Cat Wrangling', src: 'cats.png' },
  ],
};

test('embedded deck posts the current scene to the parent on navigation', async (t) => {
  const { createDeck } = await import('../web/useDeck.js');
  global.window = makeWindow({ embedded: true });
  t.after(() => { delete global.window; });

  const deck = createDeck(DECK, 'http://localhost:4321/');
  await deck.render();            // initial scene 0
  await deck.gotoScene(2);        // navigate to the Cat Wrangling slide

  // The generic, host-neutral embed protocol kitsoki listens for.
  const posted = global.window.posted.filter((m) => m && m.type === 'embed:view');
  assert.ok(posted.length >= 2, 'expected embed:view posts for initial + navigation');

  const first = posted[0];
  assert.equal(first.producer, 'slidey');
  assert.equal(first.scope, '0', 'scope is the opaque scene token the host round-trips');
  assert.equal(first.label, 'Intro');
  assert.equal(first.count, 3);

  const last = posted[posted.length - 1];
  assert.equal(last.scope, '2', 'navigation landed on scene 2');
  assert.equal(last.label, 'Cat Wrangling', 'parent learns WHICH slide is on screen');

  // A slidey-aware consumer can still use the namespaced event.
  assert.ok(global.window.posted.some((m) => m && m.type === 'slidey:scene'));
});

test('top-window (non-embedded) deck does not post to a parent', async (t) => {
  const { createDeck } = await import('../web/useDeck.js');
  global.window = makeWindow({ embedded: false });
  t.after(() => { delete global.window; });

  const deck = createDeck(DECK, 'http://localhost:4321/');
  // Would throw via the guarded postMessage if it tried to post to itself.
  await deck.render();
  await deck.gotoScene(1);
  assert.equal(global.window.posted.length, 0);
});
