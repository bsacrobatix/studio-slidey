'use strict';

// Regression: validateSpec only JSON-Schema-validated the top-level scenes[]
// array. A hierarchy library deck's inline scenes render exactly like
// top-level scenes, but a malformed one (bad node shape, unknown type, blank
// table) sailed through `slidey validate` / slidey_validate and shipped a
// broken slide. validateLibraryDeckScenes closes that: every hierarchy deck's
// local scenes get the same schema pass, with deck-qualified error paths.

const test = require('node:test');
const assert = require('node:assert');

const { validateSpec } = require('../src/validate');

function libSpec(deckScenes, extraDecks = []) {
  return {
    meta: { mode: 'pitch' },
    scenes: [{ id: 'root', type: 'title', title: 'Root' }],
    library: {
      decks: [
        { id: 'pillar', title: 'Pillar', deckType: 'hierarchy', scenes: deckScenes },
        ...extraDecks,
      ],
    },
  };
}

test('a hierarchy deck scene with a malformed diagram-svg node is flagged with a deck-qualified path', () => {
  const r = validateSpec(libSpec([
    { id: 'ok', type: 'title', title: 'Fine' },
    { id: 'bad', type: 'diagram-svg', title: 'Broken', panels: [{ nodes: [{ id: 42, label: ['not', 'a', 'string'] }] }] },
  ]));
  assert.equal(r.valid, false);
  const text = r.errors.join('\n');
  assert.match(text, /library\.decks\["pillar"\]\.scenes\[1\]/);
  assert.match(text, /panels\/0\/nodes\/0/);
});

test('a hierarchy deck scene with an unknown type is flagged', () => {
  const r = validateSpec(libSpec([{ id: 'x', type: 'nonsense-type', title: 'Nope' }]));
  assert.equal(r.valid, false);
  assert.match(r.errors.join('\n'), /library\.decks\["pillar"\]\.scenes\[0\].*\n.*unknown type "nonsense-type"/);
});

test('a nested child hierarchy deck is validated under its own deck id', () => {
  const r = validateSpec(libSpec([
    {
      id: 'parent-scene', type: 'cards', variant: 'grid', title: 'Parent',
      cards: [{ label: 'child', deck: 'child' }],
    },
  ], []));
  assert.equal(r.valid, false, 'unknown deck link should already fail');

  const nested = {
    meta: { mode: 'pitch' },
    scenes: [{ id: 'root', type: 'title', title: 'Root' }],
    library: {
      decks: [{
        id: 'parent',
        deckType: 'hierarchy',
        scenes: [{ id: 'p1', type: 'title', title: 'Parent deck' }],
        children: [{
          id: 'child',
          deckType: 'hierarchy',
          scenes: [{ id: 'c1', type: 'table', title: 'blank table', columns: ['A'], rows: [['raw']] }],
        }],
      }],
    },
  };
  const rn = validateSpec(nested);
  assert.equal(rn.valid, false);
  assert.match(rn.errors.join('\n'), /library\.decks\["child"\]\.scenes\[0\]/);
});

test('subset decks are not double-validated — their refs are not treated as inline scenes', () => {
  const r = validateSpec(libSpec(
    [{ id: 'ok', type: 'title', title: 'Fine' }],
    [{ id: 'view', deckType: 'subset', scenes: ['root', { fromDeck: 'pillar', ref: 'ok' }] }],
  ));
  assert.equal(r.valid, true, r.errors.join('\n'));
});

test('a valid library spec with hierarchy decks stays clean', () => {
  const r = validateSpec(libSpec([
    { id: 'ok', type: 'title', title: 'Fine' },
    { id: 'diag', type: 'diagram-svg', title: 'Diagram', panels: [{ nodes: [{ id: 'a', label: 'A' }], edges: [] }] },
  ]));
  assert.equal(r.valid, true, r.errors.join('\n'));
  assert.equal(r.count, 0);
});
