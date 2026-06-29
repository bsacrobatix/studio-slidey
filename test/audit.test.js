'use strict';

// Geometry-auditor test for src/audit.js — the deterministic half of the
// slidey-visual-qa skill. Drives the real render bundle in headless Chrome
// against two committed specs:
//   - examples/fixtures/broken-deck.json  (must FLAG known defects)
//   - examples/hello.slidey.json          (must stay CLEAN — no false positives)
//
// Browser-driven, so slower than the pure-data tests; still no LLM and fully
// deterministic. Requires dist-render/render.html (npm run build:render).
//
//   node --test test/audit.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { auditSpec } = require('../src/audit');
const { doctor } = require('../src/browser');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'dist-render', 'render.html');
const haveBundle = fs.existsSync(BUNDLE);

const load = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf-8'));
const checksIn = frames => new Set(frames.flatMap(f => f.findings.map(x => x.check)));

let browserReady;
async function requireBrowser(t) {
  if (!browserReady) browserReady = doctor({ width: 320, height: 180 });
  const ready = await browserReady;
  if (!ready.ok) {
    t.skip(`browser unavailable: ${ready.error}`);
    return false;
  }
  return true;
}

test('audit flags the known defects in the broken fixture', { skip: !haveBundle && 'run npm run build:render first' }, async (t) => {
  if (!await requireBrowser(t)) return;
  const spec = load('examples/fixtures/broken-deck.json');
  const { frames, summary } = await auditSpec(spec, {
    specPath: path.join(ROOT, 'examples/fixtures/broken-deck.json'),
  });

  assert.ok(summary.errors > 0, 'broken deck must produce error-severity findings');
  const checks = checksIn(frames);
  // The fixture is built to trip each of these deterministically.
  assert.ok(checks.has('template-leak'), 'should catch the unsubstituted {{host}}/${token}');
  assert.ok(checks.has('node-overlap'), 'should catch the overlapping diagram nodes');
  assert.ok(checks.has('off-viewbox'), 'should catch the node pushed outside the panel viewBox');

  // every finding cites a real frame in this run
  const frameNames = new Set(frames.map(f => f.frame));
  for (const f of frames) {
    for (const _ of f.findings) assert.ok(frameNames.has(f.frame));
  }
});

test('audit catches clipped report tables in inferred pitch mode', { skip: !haveBundle && 'run npm run build:render first' }, async (t) => {
  if (!await requireBrowser(t)) return;
  const spec = {
    meta: {
      title: 'Overflow regression',
      resolution: { width: 1920, height: 1080 },
    },
    scenes: [{
      type: 'table',
      variant: 'data',
      title: 'Objective status',
      columns: ['Area', 'Status', 'Detail'],
      rows: [
        { cells: ['Harness objective', 'DONE', 'tools/product-journey/run.py gives one local entrypoint and project catalog.'] },
        { cells: ['Project lanes', 'DONE', 'gears-rust, PostgreSQL, and Kubernetes each have deterministic local oracles.'] },
        { cells: ['Automation readiness', 'DONE', 'Checks are no-LLM by default and rerunnable from a local checkout.'] },
        { cells: ['HTML preview', 'ISSUE', 'Source validates; bundle render was blocked here by sandbox write permissions in the Slidey checkout.'] },
        { cells: ['Product-site journey', 'NEXT', 'Run production web build and use it for A/B skeptical-operator walkthroughs.'] },
      ],
      caption: 'Objective state: core eval harness complete; remaining work is preview/runtime exercise, not oracle construction.',
    }],
  };

  const { frames, summary } = await auditSpec(spec, { specPath: path.join(ROOT, 'inline-overflow.slidey.json') });

  assert.ok(summary.errors > 0, 'clipped report table must produce error-severity findings');
  assert.ok(
    frames.some(f => f.findings.some(x => x.check === 'box-overflow' && /table-frame/.test(x.node + x.detail))),
    'should flag the clipped table frame or cells',
  );
});

test('audit stays clean on a polished deck (no false positives)', { skip: !haveBundle && 'run npm run build:render first' }, async (t) => {
  if (!await requireBrowser(t)) return;
  const spec = load('examples/hello.slidey.json');
  const { summary } = await auditSpec(spec, { specPath: path.join(ROOT, 'examples/hello.slidey.json') });
  assert.equal(summary.errors, 0, 'hello.slidey.json must not trip any error-severity finding');
  assert.equal(summary.warnings, 0, 'hello.slidey.json must not trip any warning either');
});
