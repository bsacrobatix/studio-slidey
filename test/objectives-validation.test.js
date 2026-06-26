'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateSpec } = require('../src/validate');

function deck(scene) {
  return {
    scenes: [scene],
  };
}

test('a well-formed objectives scene validates', () => {
  const r = validateSpec(deck({
    type: 'objectives',
    title: 'Objective status',
    items: [
      { label: 'Harness objective', status: 'done', detail: 'One entrypoint is in place.' },
      { label: 'HTML preview', status: 'issue', detail: 'Bundle render is blocked in this environment.' },
      { label: 'Product-site journey', status: 'next', detail: 'Run A/B walkthroughs next.' },
    ],
  }));

  assert.equal(r.valid, true, r.errors.join('\n'));
});

test('objectives require known statuses', () => {
  const r = validateSpec(deck({
    type: 'objectives',
    items: [
      { label: 'Harness objective', status: 'finished-ish', detail: 'Ambiguous status.' },
    ],
  }));

  assert.equal(r.valid, false);
  assert.ok(r.errors.join('\n').includes('finished-ish') || r.errors.join('\n').includes('Allowed'));
});
