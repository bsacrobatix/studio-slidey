'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateSpec } = require('../src/validate');

function deck(scene) {
  return {
    scenes: [scene],
  };
}

test('a well-formed evidence scene validates', () => {
  const r = validateSpec(deck({
    type: 'evidence',
    title: 'Latest check state',
    items: [
      {
        label: 'PostgreSQL',
        status: 'validated',
        detail: 'baseline red / fix green',
        refType: 'command',
        ref: 'bash tools/product-journey/checks/postgresql-oracle.sh',
      },
      {
        label: 'Run log',
        status: 'implemented',
        detail: 'chronological job state',
        refType: 'path',
        ref: '.context/product-journey-runlog.md',
      },
    ],
  }));

  assert.equal(r.valid, true, r.errors.join('\n'));
});

test('evidence requires known statuses', () => {
  const r = validateSpec(deck({
    type: 'evidence',
    items: [
      { label: 'Check', status: 'looks-fine', detail: 'Ambiguous status.' },
    ],
  }));

  assert.equal(r.valid, false);
  assert.ok(r.errors.join('\n').includes('looks-fine') || r.errors.join('\n').includes('Allowed'));
});
