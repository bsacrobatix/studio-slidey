'use strict';

// embed-annotate — slidey's producer side of the embed annotation protocol.
// Pins (1) the element model → pick targets math against a fake DOM, and (2) the
// host→deck enable message producing a deck→host embed:pick on element click.

const assert = require('node:assert/strict');
const test = require('node:test');

// A tiny fake DOM: nodes addressable by id/class with a fixed bounding rect.
function fakeRoot(nodes) {
  // nodes: { '#image-title': [x,y,w,h], '.cards-card': [[...],[...]] }
  return {
    querySelector(sel) {
      const v = nodes[sel];
      if (!v || Array.isArray(v[0])) return null;
      return { getBoundingClientRect: () => ({ x: v[0], y: v[1], width: v[2], height: v[3] }) };
    },
    querySelectorAll(sel) {
      const v = nodes[sel];
      if (!v || !Array.isArray(v[0])) return [];
      return v.map((b) => ({ getBoundingClientRect: () => ({ x: b[0], y: b[1], width: b[2], height: b[3] }) }));
    },
  };
}

test('buildPickTargets emits <scene>/<field> refs with on-screen bboxes', async () => {
  const { buildPickTargets } = await import('../web/embed-annotate.js');
  const root = fakeRoot({
    '#image-title': [10, 20, 300, 40],
    '#image-frame': [10, 70, 600, 400],
    // caption omitted on this slide → skipped
  });
  const targets = buildPickTargets(root, 'image', 9);
  assert.deepEqual(
    targets.map((t) => t.ref),
    ['9/title', '9/src'],
    'image scene yields title + image element refs for scene 9 (caption absent → skipped)',
  );
  assert.equal(targets[0].label, 'title');
  assert.deepEqual(targets[1].bbox, [10, 70, 600, 400]);
});

test('buildPickTargets expands repeated cards to card_<i>', async () => {
  const { buildPickTargets } = await import('../web/embed-annotate.js');
  const root = fakeRoot({
    '#cards-title': [0, 0, 100, 30],
    '.cards-card': [[0, 40, 200, 100], [220, 40, 200, 100], [440, 40, 200, 100]],
  });
  const refs = buildPickTargets(root, 'cards', 1).map((t) => t.ref);
  assert.deepEqual(refs, ['1/title', '1/card_0', '1/card_1', '1/card_2']);
});

test('enabling annotation mode posts embed:pick on element click', async (t) => {
  const { installEmbedAnnotate } = await import('../web/embed-annotate.js');

  const posted = [];
  const listeners = {};
  const win = {
    parent: { postMessage: (m) => posted.push(m) },
    requestAnimationFrame: (fn) => fn(), // run rebuilds synchronously in the test
    addEventListener: (type, h) => { listeners[type] = h; },
    removeEventListener: (type) => { delete listeners[type]; },
  };
  // Minimal fake document: createElement nodes that record click handlers; body
  // collects appended overlays. querySelector resolves the deck elements.
  const clickHandlers = [];
  const body = { children: [], appendChild(n) { this.children.push(n); }, removeChild(n) { this.children = this.children.filter((c) => c !== n); } };
  function makeEl() {
    return {
      style: {}, children: [],
      setAttribute() {}, appendChild(n) { this.children.push(n); }, set title(_) {},
      addEventListener(type, h) { if (type === 'click') clickHandlers.push(h); },
      parentNode: null,
    };
  }
  // Mutable scene state: the operator advances slides while annotation mode is on.
  let sceneType = 'image';
  let sceneIndex = 9;
  let deckNodes = { '#image-title': [10, 20, 300, 40], '#image-frame': [10, 70, 600, 400] };
  const doc = {
    body,
    createElement() { const el = makeEl(); return el; },
    querySelector(sel) {
      const v = deckNodes[sel];
      return v ? { getBoundingClientRect: () => ({ x: v[0], y: v[1], width: v[2], height: v[3] }) } : null;
    },
    querySelectorAll() { return []; },
  };

  const teardown = installEmbedAnnotate(
    { getRoot: () => doc, getSceneType: () => sceneType, getSceneIndex: () => sceneIndex },
    win, doc,
  );
  t.after(teardown);

  // Host turns annotation mode on → overlay built with one marker per element.
  listeners.message({ data: { type: 'embed:annotate', enabled: true } });
  assert.equal(clickHandlers.length, 2, 'a marker per pickable element');

  // Operator clicks the image element (2nd marker) → embed:pick posted.
  clickHandlers[1]({ preventDefault() {}, stopPropagation() {} });
  const pick = posted.find((m) => m.type === 'embed:pick');
  assert.ok(pick, 'embed:pick posted to parent');
  assert.equal(pick.producer, 'slidey');
  assert.equal(pick.scope, '9');
  assert.equal(pick.ref, '9/src', 'the picked element ref rides back');

  // Advance to a DIFFERENT slide (a narrative scene) — the markers must REBUILD
  // for the new slide, not stay pinned to scene 9 (the reported bug).
  sceneType = 'narrative';
  sceneIndex = 12;
  deckNodes = { '#narrative-lede': [0, 0, 400, 60], '#narrative-body': [0, 80, 800, 300] };
  posted.length = 0;
  const before = clickHandlers.length;
  listeners['slidey:scene-changed']({ detail: { sceneIndex: 12 } });
  const fresh = clickHandlers.slice(before);
  assert.equal(fresh.length, 2, 'overlay rebuilt for the new slide (lede + body)');

  fresh[0]({ preventDefault() {}, stopPropagation() {} });
  const pick2 = posted.find((m) => m.type === 'embed:pick');
  assert.equal(pick2.ref, '12/lede', 'clickable areas now target the slide on screen');
});
