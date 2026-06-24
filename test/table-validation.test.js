'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { validateSpec } = require('../src/validate');

function deck(table) {
  return { meta: { mode: 'pitch' }, scenes: [{ type: 'title', title: 'x' }, table] };
}

// Regression: a table authored with raw-array rows and no `variant` parses as
// JSON but renders BLANK in the viewer (TableScene reads row.cells). Validation
// must reject it so `slidey validate` / `slidey bundle` catch it pre-ship.
test('table with raw-array rows is rejected', () => {
  const r = validateSpec(deck({
    type: 'table',
    title: 'bad',
    columns: ['A', 'B'],
    rows: [['1', '2'], ['3', '4']],
  }));
  assert.equal(r.valid, false);
  assert.match(r.errors.join('\n'), /rows\/0/);
});

test('table without a variant is rejected', () => {
  const r = validateSpec(deck({
    type: 'table',
    title: 'no variant',
    columns: ['A', 'B'],
    rows: [{ cells: ['1', '2'] }],
  }));
  assert.equal(r.valid, false);
  assert.match(r.errors.join('\n'), /variant/);
});

test('a well-formed data table validates', () => {
  const r = validateSpec(deck({
    type: 'table',
    variant: 'data',
    title: 'good',
    columns: ['Model', 'Cost'],
    rows: [{ cells: ['Opus 4.8', '$4.00'] }, { cells: ['Sonnet 4.6', '$3.02'] }],
  }));
  assert.equal(r.valid, true, r.errors.join('\n'));
});
