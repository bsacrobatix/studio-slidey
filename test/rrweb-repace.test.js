'use strict';

// Tests for src/rrweb-repace.js — the readable-pacing stretch for captured rrweb
// tours. It must (a) push distinct content reveals at least their readable dwell
// apart, (b) scale that dwell with the reveal's TEXT length (a long typed answer
// needs more reading time than a one-word trace row — the "scrolls past the
// user's input" defect), (c) leave already-roomy reveals untouched (only add
// time, never compress), (d) coalesce a multi-mutation render into one reveal,
// (e) append a single idempotent trailing hold, and (f) not mutate inputs.
//
//   node --test test/rrweb-repace.test.js

const test = require('node:test');
const assert = require('node:assert');
const { repace, readableDwellMs } = require('../src/rrweb-repace');

// A significant content reveal carrying a text body of the given length.
function reveal(ts, textLen = 8) {
  const text = 'x'.repeat(textLen);
  return { type: 3, timestamp: ts, data: { source: 0, adds: [
    { node: { type: 2, tagName: 'div' } }, { node: { type: 2, tagName: 'span' } },
    { node: { type: 2, tagName: 'p' } }, { node: { type: 3, textContent: text } },
  ] } };
}
const meta = (ts) => ({ type: 4, timestamp: ts, data: {} });

function revealTimes(events) {
  return events.filter(e => e.type === 3 && e.data && e.data.source === 0 && (e.data.adds || []).length >= 4)
    .map(e => e.timestamp);
}
function dwells(events) {
  const t = revealTimes(events);
  const d = [];
  for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  return d;
}

const OPTS = { minDwellMs: 1400, maxDwellMs: 3800, msPerChar: 22, coalesceMs: 150, holdMs: 0 };

test('short crammed reveals are pushed to the base dwell', () => {
  const events = [meta(0), reveal(0, 4), reveal(250, 4), reveal(500, 4)];
  const out = repace(events, OPTS);
  for (const d of dwells(out)) assert.ok(d >= 1400, `dwell ${d} >= base 1400`);
});

test('a LONG typed answer gets proportionally more dwell than a short row', () => {
  // A 90-char user answer crammed 250ms before the next reveal must be pushed to
  // its text-scaled readable dwell (1400 + 90*22 = 3380ms), not just 1400.
  const want = readableDwellMs(90, OPTS); // 3380
  const events = [meta(0), reveal(0, 90), reveal(250, 6), reveal(500, 6)];
  const out = repace(events, OPTS);
  const t = revealTimes(out);
  assert.ok(t[1] - t[0] >= want, `long reveal dwell ${t[1] - t[0]} >= ${want}`);
  assert.ok(want > 1400, 'sanity: long text needs more than the base dwell');
});

test('already-roomy reveals are left unchanged (only adds time)', () => {
  // Short text → base dwell 1400; spaced 2000 apart (> required) → no change.
  const events = [meta(0), reveal(0, 4), reveal(2000, 4), reveal(4000, 4)];
  const out = repace(events, OPTS);
  assert.deepEqual(dwells(out), [2000, 2000]);
});

test('a multi-mutation render within coalesce is one reveal, not several', () => {
  const events = [meta(0), reveal(0, 6), reveal(20, 6), reveal(40, 6), reveal(500, 6)];
  const out = repace(events, OPTS);
  const t = revealTimes(out);
  assert.ok(t[1] - t[0] <= 150 && t[2] - t[0] <= 150, 'group stays tight');
  assert.ok(t[3] - t[0] >= 1400, 'next reveal pushed past the dwell');
});

test('re-running is idempotent (single trailing hold, stable timing)', () => {
  const events = [meta(0), reveal(0, 90), reveal(250, 6), reveal(900, 6)];
  const once = repace(events, { ...OPTS, holdMs: 1500 });
  const twice = repace(once, { ...OPTS, holdMs: 1500 });
  // exactly one hold on each pass, and the second pass changes nothing.
  assert.equal(once.filter(e => e.data && e.data._slideyHold).length, 1);
  assert.equal(twice.filter(e => e.data && e.data._slideyHold).length, 1);
  assert.deepEqual(twice.map(e => e.timestamp), once.map(e => e.timestamp));
});

test('inputs are not mutated', () => {
  const events = [meta(0), reveal(0, 40), reveal(100, 40)];
  const before = JSON.stringify(events);
  repace(events, OPTS);
  assert.equal(JSON.stringify(events), before);
});
