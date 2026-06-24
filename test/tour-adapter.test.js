'use strict';

// Unit tests for the extensible tour-engine adapter seam:
//   - src/tour/adapters/{base,dom,index}.js  (resolution + normalization)
//   - src/tour/capture.js runAction/runAdvance fall-through + the predicate wait
//   - an end-to-end freeze-frame capture proving (a) an unknown verb routes to a
//     registered adapter, (b) advance:"predicate"/advanceFn waits on a page
//     predicate, (c) a custom advancer resolves, (d) the `dom` default still
//     drives an existing-shape spec unchanged.
//
//   node --test test/tour-adapter.test.js
//
// The browser-driven cases share ONE tiny static fixture page served from a
// throwaway loopback http server — no network, deterministic (pace:0 → 1 frame
// per step). They are skipped (not failed) when no Chrome is resolvable, so the
// pure-logic cases always run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { normalizeAdapter, baseAdapter } = require('../src/tour/adapters/base');
const { resolveAdapter, registerAdapter } = require('../src/tour/adapters');
const { runAction, runAdvance } = require('../src/tour/capture');
const { captureTour } = require('../src/tour/capture');
const { defaultChromePath, browserExecutableError } = require('../src/browser');

const FIXTURE = path.join(__dirname, 'fixtures', 'tour-adapter-page.html');

const chromeReady = (() => {
  try {
    const p = defaultChromePath();
    return !!p && !browserExecutableError(p);
  } catch { return false; }
})();
const browserTest = chromeReady ? test : test.skip;

// ── Pure resolution / normalization ─────────────────────────────────────────

test('normalizeAdapter fills inert defaults for a partial module', () => {
  const a = normalizeAdapter({ name: 'x' });
  assert.equal(a.name, 'x');
  assert.equal(typeof a.init, 'function');
  assert.equal(typeof a.decorate, 'function');
  assert.deepEqual(a.actions, {});
  assert.deepEqual(a.advancers, {});
  // The no-op hooks resolve without a page.
  return Promise.all([a.init(), a.decorate()]);
});

test('resolveAdapter: absent / "dom" → the built-in default', () => {
  assert.equal(resolveAdapter({}, null, (p) => p).name, 'dom');
  assert.equal(resolveAdapter({ adapter: 'dom' }, null, (p) => p).name, 'dom');
});

test('resolveAdapter: a lib-API adapter OBJECT wins over the spec field', () => {
  const a = resolveAdapter({ adapter: 'dom' }, { name: 'override', actions: { z: () => 1 } }, (p) => p);
  assert.equal(a.name, 'override');
  assert.equal(typeof a.actions.z, 'function');
});

test('resolveAdapter: a registered name resolves', () => {
  registerAdapter('unit-reg', { name: 'unit-reg', actions: { ping: () => 'pong' } });
  const a = resolveAdapter({ adapter: 'unit-reg' }, null, (p) => p);
  assert.equal(a.name, 'unit-reg');
  assert.equal(a.actions.ping(), 'pong');
});

test('resolveAdapter: a module path is required relative to the spec (via resolve)', () => {
  // Write a throwaway adapter module and resolve it by a spec-relative path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-adp-'));
  const modPath = path.join(dir, 'my-adapter.cjs');
  fs.writeFileSync(modPath, "module.exports = { name: 'from-path', actions: { hi: () => 'hi' } };\n");
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(dir, p));
  const a = resolveAdapter({ adapter: './my-adapter.cjs' }, null, resolve);
  assert.equal(a.name, 'from-path');
  assert.equal(a.actions.hi(), 'hi');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveAdapter: an unknown bare name throws (not a name or a path)', () => {
  assert.throws(() => resolveAdapter({ adapter: 'nope-not-registered' }, null, (p) => p), /unknown tour adapter/);
});

// ── runAction fall-through + the built-in predicate wait (no browser) ────────

test('runAction routes an unknown single-key verb to ctx.adapter.actions', async () => {
  const calls = [];
  const fakePage = {};
  const ctx = { timeout: 100, adapter: normalizeAdapter({
    actions: { submitIntent: (page, args, c) => { calls.push([page, args, c]); return 'done'; } },
  }) };
  const out = await runAction(fakePage, 'http://b', { submitIntent: { name: 'open', slots: { id: 1 } } }, ctx);
  assert.equal(out, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], fakePage);
  assert.deepEqual(calls[0][1], { name: 'open', slots: { id: 1 } });
  assert.equal(calls[0][2], ctx);
});

test('runAction throws for an unknown verb with no adapter coverage', async () => {
  const ctx = { adapter: normalizeAdapter({}) };
  await assert.rejects(() => runAction({}, 'http://b', { mysteryVerb: {} }, ctx), /unknown tour action/);
});

test('runAction { waitForFn } calls page.waitForFunction with the expression', async () => {
  let seen = null;
  const fakePage = { waitForFunction: async (expr, opts) => { seen = { expr, opts }; } };
  await runAction(fakePage, 'http://b', { waitForFn: 'window.ready === true' }, { timeout: 99 });
  assert.equal(seen.expr, 'window.ready === true');
  assert.equal(seen.opts.timeout, 99);
});

test('runAdvance handles "predicate" via advanceFn and reports built-ins unhandled', async () => {
  let seen = null;
  const fakePage = { waitForFunction: async (expr, opts) => { seen = { expr, opts }; } };
  const handledPred = await runAdvance(fakePage, { advanceFn: 'window.s===2' }, 'predicate', { timeout: 50 });
  assert.equal(handledPred, true);
  assert.equal(seen.expr, 'window.s===2');

  // A custom advancer resolves through ctx.adapter.advancers.
  let advCalled = false;
  const ctx = { timeout: 50, adapter: normalizeAdapter({ advancers: { 'state-match': async () => { advCalled = true; } } }) };
  const handledAdv = await runAdvance({}, { advanceState: 'ready' }, 'state-match', ctx);
  assert.equal(handledAdv, true);
  assert.equal(advCalled, true);

  // A built-in advance is reported as NOT handled (the caller drives it).
  const handledBuiltin = await runAdvance({}, {}, 'click-target', { adapter: normalizeAdapter({}) });
  assert.equal(handledBuiltin, false);
});

// ── End-to-end freeze-frame captures against the static fixture ──────────────

function serveFixture() {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

async function withFramesDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-tour-test-'));
  try { return await fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

browserTest('(a) an unknown action verb routes to a registered adapter on a live page', async () => {
  const srv = await serveFixture();
  const hits = [];
  const adapter = {
    name: 'fixture',
    actions: {
      // Drives a window hook the built-in verbs can't express.
      setMarker: (page, { text }) => { hits.push(text); return page.evaluate((t) => window.__setMarker(t), text); },
    },
  };
  try {
    await withFramesDir(async (framesDir) => {
      const tour = {
        target: { url: srv.url },
        startPath: '/',
        pace: 0,
        readySelector: '[data-testid=home-view]',
        steps: [
          { id: 's0', label: 'mark', before: [{ setMarker: { text: 'ADAPTER-OK' } }], dwellMs: 100 },
        ],
      };
      const res = await captureTour(tour, framesDir, { adapter, pace: 0 });
      assert.ok(res.frameCount >= 1, 'produced at least one frame');
      assert.deepEqual(hits, ['ADAPTER-OK'], 'adapter verb ran exactly once');
    });
  } finally { srv.close(); }
});

browserTest('(b) advance:"predicate" + advanceFn waits on a page predicate', async () => {
  const srv = await serveFixture();
  try {
    await withFramesDir(async (framesDir) => {
      const tour = {
        target: { url: srv.url },
        startPath: '/',
        pace: 0,
        readySelector: '[data-testid=home-view]',
        steps: [
          // Flip the badge to "ready" off-camera, then the predicate must observe it.
          {
            id: 's0', label: 'predicate', dwellMs: 100,
            before: [{ eval: "window.__advanceState('ready')" }],
            advance: 'predicate',
            advanceFn: "document.querySelector('[data-testid=state-badge]').dataset.state === 'ready'",
          },
        ],
      };
      // Resolves only if the predicate becomes true; a non-matching predicate
      // would hang to ACTION_TIMEOUT and fail the alarm-wrapped suite.
      const res = await captureTour(tour, framesDir, { pace: 0 });
      assert.ok(res.frameCount >= 1);
    });
  } finally { srv.close(); }
});

browserTest('(c) a custom adapter advancer resolves on a live page', async () => {
  const srv = await serveFixture();
  let advancerRan = false;
  const adapter = {
    name: 'fixture',
    advancers: {
      'state-match': (page, step, ctx) => {
        advancerRan = true;
        return page.waitForFunction(
          (s) => document.querySelector('[data-testid=state-badge]').dataset.state === s,
          { timeout: ctx.timeout }, step.advanceState,
        );
      },
    },
  };
  try {
    await withFramesDir(async (framesDir) => {
      const tour = {
        target: { url: srv.url },
        startPath: '/',
        pace: 0,
        readySelector: '[data-testid=home-view]',
        steps: [
          {
            id: 's0', label: 'custom-advance', dwellMs: 100,
            before: [{ eval: "window.__advanceState('ready')" }],
            advance: 'state-match', advanceState: 'ready',
          },
        ],
      };
      const res = await captureTour(tour, framesDir, { adapter, pace: 0 });
      assert.ok(res.frameCount >= 1);
      assert.equal(advancerRan, true, 'the custom advancer was consulted');
    });
  } finally { srv.close(); }
});

browserTest('(d) the dom default drives an existing-shape spec unchanged', async () => {
  const srv = await serveFixture();
  try {
    await withFramesDir(async (framesDir) => {
      // An ordinary spec: only built-in verbs/advances, NO adapter field. This is
      // exactly the shape today's tours use (cf. examples/demos/*.json).
      const tour = {
        target: { url: srv.url },
        startPath: '/',
        pace: 0,
        readySelector: '[data-testid=home-view]',
        specPath: 'features/fixture.yaml',
        steps: [
          { id: 'welcome', label: 'Welcome', caption: 'Welcome', target: '[data-testid=title]', dwellMs: 100, kind: 'explain' },
          { id: 'go', label: 'Go', target: '[data-testid=go-btn]', dwellMs: 100, kind: 'action', advance: 'click-target' },
        ],
      };
      const res = await captureTour(tour, framesDir, { pace: 0 });
      assert.equal(res.frameCount, 2, 'two steps → two held frames at pace 0');
      assert.equal(res.chapters.length, 2);
      assert.equal(res.chapters[0].id, 'welcome');
      assert.equal(res.chapters[1].id, 'go');
      // The dom adapter resolved (no custom verbs) — proven by the run completing
      // with only built-ins and the click-target advance firing.
    });
  } finally { srv.close(); }
});
