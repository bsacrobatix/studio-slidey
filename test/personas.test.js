'use strict';

// Tests for the `personas` scene type — the cast / use-cases layout. Covers the
// schema branch (cast + use-cases shapes, plus meta.personas registry), the
// renderer's revealable item count, and the shared reveal-step sequence consumed
// by both the PDF exporter and the web nav.
//
//   node --test test/personas.test.js

const test = require('node:test');
const assert = require('node:assert');

const { validateSpec } = require('../src/validate');
const personas = require('../src/scenes/personas');

const META = {
  personas: [
    { id: 'pm', name: 'Priya', role: 'Product manager', intro: 'Frames the idea.', color: '#58a6ff', glyph: '🧭' },
    { id: 'dev', name: 'Devin', role: 'Developer', intro: 'Ships it.', color: '#3fb950', glyph: '🛠️' },
  ],
};

function deck(scene, meta = META) {
  return { meta: { mode: 'pitch', ...meta }, scenes: [scene] };
}

test('schema accepts a cast scene referencing meta.personas by id', () => {
  const r = validateSpec(deck({
    type: 'personas', variant: 'cast', title: 'The cast',
    personas: ['pm', 'dev'], caption: 'one pipeline',
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test('schema accepts an image avatar (logo data-URI) on a persona', () => {
  const r = validateSpec(deck({
    type: 'personas', variant: 'cast', personas: ['pm', 'dev'],
  }, { personas: [
    { id: 'pm', name: 'Priya', glyph: '🧭' },
    { id: 'dev', name: 'Devin', color: '#3fb950', avatar: 'data:image/svg+xml,%3Csvg%2F%3E' },
  ] }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test('schema accepts inline persona objects in a cast scene', () => {
  const r = validateSpec(deck({
    type: 'personas', variant: 'cast',
    personas: [{ id: 'x', name: 'X', color: '#fff' }],
  }));
  assert.deepEqual(r.errors, []);
});

test('schema accepts a use-cases scene attributing actions to personas', () => {
  const r = validateSpec(deck({
    type: 'personas', variant: 'use-cases', title: 'Who does what',
    cases: [
      { who: 'pm', action: 'Frames the idea', detail: 'intake' },
      { who: 'dev', action: 'Ships it' },
    ],
  }));
  assert.deepEqual(r.errors, []);
});

test('schema rejects an unknown persona-scene variant', () => {
  const r = validateSpec(deck({ type: 'personas', variant: 'nope', personas: [] }));
  assert.equal(r.valid, false);
});

test('schema rejects a use-case row missing required who/action', () => {
  const r = validateSpec(deck({
    type: 'personas', variant: 'use-cases', cases: [{ detail: 'orphan' }],
  }));
  assert.equal(r.valid, false);
});

test('itemCount counts personas for cast and cases for use-cases', () => {
  assert.equal(personas.itemCount({ variant: 'cast', personas: ['a', 'b', 'c'] }), 3);
  assert.equal(personas.itemCount({ variant: 'use-cases', cases: [{}, {}] }), 2);
  assert.equal(personas.itemCount({ personas: ['a'] }), 1); // default variant = cast
});

test('reveal-step sequence matches stepsForScene (title + items + caption)', async () => {
  const { stepsForScene } = await import('../web/sceneSteps.mjs');
  assert.deepEqual(
    stepsForScene({ type: 'personas', variant: 'cast', title: 't', personas: ['a', 'b'], caption: 'c' }),
    ['personas_title', 'personas_item_0', 'personas_item_1', 'personas_caption'],
  );
  assert.deepEqual(
    stepsForScene({ type: 'personas', variant: 'use-cases', cases: [{}, {}, {}] }),
    ['personas_item_0', 'personas_item_1', 'personas_item_2'],
  );
});
