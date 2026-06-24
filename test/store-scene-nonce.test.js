'use strict';

// Tests for store.sceneNonce — the per-scene remount key. It must bump ONLY when
// a new scene is shown (showScene / showTitleCard / loadScene), never on step
// navigation (setState). DeckHost keys the scene component on it so a previous
// same-type scene's revealed rows can't be reused and visibly fade out before the
// new scene reveals (the "rows flash on scene 4" bug).
//
//   node --test test/store-scene-nonce.test.js

const test = require('node:test');
const assert = require('node:assert');

async function freshStore() {
  // store.js is an ES module; import dynamically. The module is a singleton, so
  // each test resets the bits it touches via the public surface.
  const mod = await import('../web/store.js');
  return mod.store;
}

test('sceneNonce bumps when a new pitch scene is shown', async () => {
  const store = await freshStore();
  const a = store.sceneNonce;
  store.showScene('personas', { type: 'personas', variant: 'use-cases', cases: [{ who: 'x', action: 'a' }] });
  const b = store.sceneNonce;
  store.showScene('personas', { type: 'personas', variant: 'use-cases', cases: [{ who: 'y', action: 'b' }] });
  const c = store.sceneNonce;
  assert.ok(b > a, 'first showScene bumps');
  assert.ok(c > b, 'second showScene (same type) bumps again');
});

test('sceneNonce does NOT bump on step navigation within a scene', async () => {
  const store = await freshStore();
  store.showScene('personas', { type: 'personas', variant: 'use-cases', cases: [{ who: 'x', action: 'a' }, { who: 'y', action: 'b' }] });
  const n = store.sceneNonce;
  store.setState('personas_item_0');
  store.setState('personas_item_1');
  assert.equal(store.sceneNonce, n, 'setState must not change the remount key');
});

test('showTitleCard and loadScene also bump the nonce', async () => {
  const store = await freshStore();
  const a = store.sceneNonce;
  store.showTitleCard({ type: 'title', title: 'T' });
  assert.ok(store.sceneNonce > a, 'showTitleCard bumps');
  const b = store.sceneNonce;
  store.loadScene({ type: 'request', request: {}, response: {} }, {});
  assert.ok(store.sceneNonce > b, 'loadScene bumps');
});
