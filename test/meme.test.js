'use strict';

// Tests for the meme slide type — registry lookup/search, the scene module's
// filled-box accounting, timing estimation lock-step, and the shared reveal-step
// model (sceneSteps). Pure (no network/render) so they run fast.
//
//   node --test test/meme.test.js

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../src/memes/registry');
const meme = require('../src/scenes/meme');
const TIMING = require('../src/timing');
const { estimateScene } = TIMING;

test('registry loads a sizable, well-formed catalog', () => {
  const all = registry.list();
  assert.ok(all.length >= 100, `expected >=100 templates, got ${all.length}`);
  for (const t of all.slice(0, 5)) {
    assert.equal(typeof t.id, 'string');
    assert.ok(['landscape', 'portrait', 'square', 'unknown'].includes(t.orientation));
    assert.ok(Array.isArray(t.boxes) && t.boxes.length >= 1);
  }
});

test('get() is case-insensitive and returns null for unknown ids', () => {
  assert.equal(registry.get('DB').id, 'db');
  assert.equal(registry.get('  db '), registry.get('db'));
  assert.equal(registry.get('definitely-not-a-template'), null);
  assert.equal(registry.get(''), null);
});

test('a known multi-box template carries normalized geometry + field hints', () => {
  const db = registry.get('db');
  assert.equal(db.boxes.length, 3);
  for (const b of db.boxes) {
    assert.ok(b.x >= 0 && b.x <= 1 && b.y >= 0 && b.y <= 1);
    assert.ok(b.w > 0 && b.w <= 1 && b.h > 0 && b.h <= 1);
    assert.equal(typeof b.field, 'string');
  }
});

test('search ranks exact id/name hits first and respects orientation filter', () => {
  const hits = registry.search('distracted boyfriend', { limit: 5 });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, 'db');

  const portraitOnly = registry.search('', { orientation: 'portrait', limit: 50 });
  assert.ok(portraitOnly.length > 0);
  assert.ok(portraitOnly.every(h => h.orientation === 'portrait'));
});

test('search summary exposes fields with hints but no heavy geometry', () => {
  const [top] = registry.search('drake', { limit: 1 });
  assert.equal(top.id, 'drake');
  assert.ok(Array.isArray(top.fields));
  assert.ok('hint' in top.fields[0]);
  assert.equal(top.fields.length, top.lines);
});

test('filledBoxes / captionFor count only boxes that actually have text', () => {
  const tpl = registry.get('db');
  // positional text, middle box blank → 2 filled
  const positional = { type: 'meme', template: 'db', text: ['A', '', 'C'] };
  assert.equal(meme.filledBoxes(positional, tpl).length, 2);
  assert.equal(meme.captionFor(positional, tpl.boxes[1], 1), '');

  // keyed fields take precedence over positional
  const keyed = { type: 'meme', template: 'db', text: ['A', 'B', 'C'], fields: { [tpl.boxes[0].field]: 'X' } };
  assert.equal(meme.captionFor(keyed, tpl.boxes[0], 0), 'X');
});

test('estimateScene meme matches the reveal sequence (title + frame + boxes + caption)', () => {
  const scene = { type: 'meme', template: 'db', title: 'T', text: ['A', 'B', 'C'], caption: 'cap' };
  const expected = TIMING.meme_title + TIMING.meme_frame
    + TIMING.meme_box_0 + TIMING.meme_box_1 + TIMING.meme_box_2
    + TIMING.meme_caption + TIMING.meme_hold + TIMING.inter_scene;
  assert.equal(estimateScene(scene), expected);
});

test('estimateScene meme drops title/caption frames when absent, and box count tracks filled text', () => {
  const scene = { type: 'meme', template: 'db', text: ['only-top'] };
  const expected = TIMING.meme_frame + TIMING.meme_box_0
    + TIMING.meme_hold + TIMING.inter_scene;
  assert.equal(estimateScene(scene), expected);
});

test('custom hold overrides the table hold for meme', () => {
  const scene = { type: 'meme', template: 'db', text: ['A'], hold: 999 };
  assert.equal(estimateScene(scene), TIMING.meme_frame + TIMING.meme_box_0 + 999 + TIMING.inter_scene);
});

test('noGaps meme estimate is just the hold (no reveal frames, no inter-scene)', () => {
  const scene = { type: 'meme', template: 'db', text: ['A', 'B'] };
  assert.equal(estimateScene(scene, { noGaps: true }), TIMING.meme_hold);
});

test('stepsForScene meme mirrors the scene module reveal order', async () => {
  const { stepsForScene } = await import('../web/sceneSteps.mjs');
  const scene = { type: 'meme', template: 'db', title: 'T', text: ['A', '', 'C'], caption: 'c' };
  // title, frame, two filled boxes (re-indexed 0..1), caption
  assert.deepEqual(stepsForScene(scene), ['meme_title', 'meme_frame', 'meme_box_0', 'meme_box_1', 'meme_caption']);

  const bare = { type: 'meme', template: 'db', text: ['A'] };
  assert.deepEqual(stepsForScene(bare), ['meme_frame', 'meme_box_0']);
});
