'use strict';

// Tests for src/rrweb-repace.js — the readable-pacing stretch for captured rrweb
// tours. It must (a) push distinct content reveals at least minDwell apart,
// (b) leave already-spaced reveals untouched (only add time, never compress),
// (c) coalesce a multi-mutation render into one reveal, and (d) append a trailing
// hold without adding visible content.
//
//   node --test test/rrweb-repace.test.js

const test = require('node:test');
const assert = require('node:assert');
const { repace } = require('../src/rrweb-repace');

// A significant content reveal: a mutation adding >=4 element nodes.
function reveal(ts) {
  return { type: 3, timestamp: ts, data: { source: 0, adds: [
    { node: { type: 2, tagName: 'div' } }, { node: { type: 2, tagName: 'span' } },
    { node: { type: 2, tagName: 'p' } }, { node: { type: 3, textContent: 'a message body that is clearly long enough' } },
  ] } };
}
const meta = (ts) => ({ type: 4, timestamp: ts, data: {} });

function dwellsBetweenReveals(events) {
  const sig = events.filter(e => e.type === 3 && e.data && e.data.source === 0 && (e.data.adds || []).length >= 4);
  const ds = [];
  for (let i = 1; i < sig.length; i++) ds.push(sig[i].timestamp - sig[i - 1].timestamp);
  return ds;
}

test('crammed tail reveals (distinct, above coalesce) are pushed minDwell apart', () => {
  // Five distinct reveals 250ms apart (a rushed burst — above the 150ms coalesce).
  const events = [meta(0), reveal(0), reveal(250), reveal(500), reveal(750), reveal(1000)];
  const out = repace(events, { minDwellMs: 1400, coalesceMs: 150, holdMs: 0 });
  const ds = dwellsBetweenReveals(out);
  assert.ok(ds.length === 4, 'all five reveals preserved');
  for (const d of ds) assert.ok(d >= 1400, `dwell ${d} >= 1400`);
});

test('already well-paced reveals are left unchanged (only adds time)', () => {
  const events = [meta(0), reveal(0), reveal(2000), reveal(4000)];
  const out = repace(events, { minDwellMs: 1400, coalesceMs: 150, holdMs: 0 });
  assert.deepEqual(dwellsBetweenReveals(out), [2000, 2000]);
});

test('a multi-mutation render within coalesce is one reveal, not several', () => {
  // Three mutations 20ms apart = one logical render, then a distinct reveal.
  const events = [meta(0), reveal(0), reveal(20), reveal(40), reveal(500)];
  const out = repace(events, { minDwellMs: 1400, coalesceMs: 150, holdMs: 0 });
  const sig = out.filter(e => e.type === 3 && (e.data.adds || []).length >= 4);
  // The first three stay tight (within the group); the fourth is pushed to >=1400
  // after the group's anchor.
  assert.ok(sig[1].timestamp - sig[0].timestamp <= 150, 'group stays tight');
  assert.ok(sig[2].timestamp - sig[0].timestamp <= 150, 'group stays tight');
  assert.ok(sig[3].timestamp - sig[0].timestamp >= 1400, 'next reveal pushed past minDwell');
});

test('a trailing hold extends duration with a no-op (non-content) mutation', () => {
  const events = [meta(0), reveal(0), reveal(2000)];
  const out = repace(events, { minDwellMs: 1400, holdMs: 1500 });
  const last = out[out.length - 1];
  assert.equal(last.timestamp, 2000 + 1500, 'final hold at last+holdMs');
  assert.deepEqual(last.data.adds, [], 'hold adds no content');
});

test('inputs are not mutated', () => {
  const events = [meta(0), reveal(0), reveal(100)];
  const before = JSON.stringify(events);
  repace(events, { minDwellMs: 1400 });
  assert.equal(JSON.stringify(events), before);
});
