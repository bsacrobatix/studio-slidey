'use strict';

// Tests for src/rrweb-reveal.js — the conversation followability transform that
// replaces a captured chat's snap-to-bottom auto-scroll with an eased reveal
// track. It must (a) detect the snap-dominated transcript scroller, (b) replace
// each instant snap with a hold + a dense eased ramp through the SAME y-values,
// (c) only ADD time (the clip gets longer, never shorter), (d) leave an
// already-eased / non-snapping clip untouched, (e) be idempotent, and (f) not
// mutate inputs.
//
//   node --test test/rrweb-reveal.test.js

const test = require('node:test');
const assert = require('node:assert');
const { reveal, detectSnapScroller } = require('../src/rrweb-reveal');

const meta = (ts) => ({ type: 4, timestamp: ts, data: {} });
const scroll = (ts, id, y) => ({ type: 3, timestamp: ts, data: { source: 3, id, x: 0, y } });
// A content reveal (so the clip looks like a real conversation around the scrolls).
const revealEv = (ts) => ({ type: 3, timestamp: ts, data: { source: 0, adds: [
  { node: { type: 2, tagName: 'div' } }, { node: { type: 3, textContent: 'a message body here' } },
] } });

// A snapping transcript: id 7 jumps to the bottom (big instant downward y) on
// each of 4 messages, spaced > runGap apart. id 9 is a noise scroller.
function snapClip() {
  return [
    meta(0),
    revealEv(100), scroll(150, 7, 200),
    revealEv(2000), scroll(2050, 7, 700),
    revealEv(4000), scroll(4050, 7, 1300),
    revealEv(6000), scroll(6050, 7, 2000),
    revealEv(8000),
  ];
}

function scrollRuns(events, id) {
  const ys = events.filter(e => e.type === 3 && e.data && e.data.source === 3 && e.data.id === id);
  return ys;
}

test('detects the snap-dominated transcript scroller', () => {
  assert.equal(detectSnapScroller(snapClip(), { minSnaps: 3, snapMinDy: 40, runGap: 400, easeMinEvents: 6, easeMinMs: 900 }), 7);
});

test('replaces snaps with a dense eased track on the same node', () => {
  const out = reveal(snapClip(), { tailHoldMs: 0 });
  const ev = scrollRuns(out, 7);
  // Far more scroll events than the 4 original snaps (each became hold + ramp).
  assert.ok(ev.length >= 4 * 10, `expected a dense eased track, got ${ev.length} scroll events`);
  // The y trajectory still ends at the final recorded bottom (2000).
  assert.equal(ev[ev.length - 1].data.y, 2000);
  // Monotonic non-decreasing y (we eased through, never jumped back).
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].data.y >= ev[i - 1].data.y - 1, 'y eases monotonically down');
});

test('only adds time — the clip gets longer', () => {
  const src = snapClip();
  const out = reveal(src, { tailHoldMs: 0 });
  const before = src[src.length - 1].timestamp - src[0].timestamp;
  const after = out[out.length - 1].timestamp - out[0].timestamp;
  assert.ok(after > before, `revealed clip ${after}ms should exceed original ${before}ms`);
});

test('a non-snapping clip is left effectively unchanged (no scroller detected)', () => {
  const events = [meta(0), revealEv(100), revealEv(2000), revealEv(4000)];
  const out = reveal(events, { tailHoldMs: 0 });
  assert.equal(detectSnapScroller(events, { minSnaps: 3, snapMinDy: 40, runGap: 400, easeMinEvents: 6, easeMinMs: 900 }), null);
  assert.deepEqual(out.map(e => e.timestamp), events.map(e => e.timestamp));
});

test('re-running is idempotent (no snaps remain → no-op)', () => {
  const once = reveal(snapClip(), { tailHoldMs: 0 });
  const twice = reveal(once, { tailHoldMs: 0 });
  assert.deepEqual(twice.map(e => e.timestamp), once.map(e => e.timestamp));
  assert.deepEqual(
    twice.filter(e => e.data && e.data.source === 3).map(e => e.data.y),
    once.filter(e => e.data && e.data.source === 3).map(e => e.data.y),
  );
});

test('inputs are not mutated', () => {
  const events = snapClip();
  const before = JSON.stringify(events);
  reveal(events, { tailHoldMs: 0 });
  assert.equal(JSON.stringify(events), before);
});
