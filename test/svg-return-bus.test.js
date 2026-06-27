'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('return bus lanes near the left edge are pushed into an outside gutter', async () => {
  const { buildPanel } = await import('../web/svg.js');
  const panel = buildPanel({
    nodes: [
      { id: 'proposal', label: 'proposal', x: 100, y: 135, w: 340, h: 170 },
      { id: 'build', label: 'feature', x: 500, y: 135, w: 340, h: 170 },
      { id: 'demo', label: 'demo video', x: 100, y: 430, w: 340, h: 170 },
      { id: 'qa', label: 'visual QA', x: 500, y: 430, w: 340, h: 170 },
    ],
    edges: [
      { from: 'qa', to: 'build', label: 'fix the gap', style: 'back', bus: 90, lift: 65 },
    ],
  }, 0);

  assert.equal(panel.edges[0].d, 'M 840 580 H 30 V 220 H 500');
  assert.equal(panel.edges[0].labelX, 44);
});

test('return bus lanes already farther outside keep the authored coordinate', async () => {
  const { buildPanel } = await import('../web/svg.js');
  const panel = buildPanel({
    nodes: [
      { id: 'a', label: 'A', x: 100, y: 40, w: 300, h: 110 },
      { id: 'c', label: 'C', x: 100, y: 400, w: 300, h: 110 },
    ],
    edges: [
      { from: 'c', to: 'a', style: 'back', bus: -20 },
    ],
  }, 0);

  assert.match(panel.edges[0].d, / H -20 V /);
});

test('diagram edges can pin labels at authored coordinates', async () => {
  const { buildPanel } = await import('../web/svg.js');
  const panel = buildPanel({
    nodes: [
      { id: 'a', label: 'A', x: 100, y: 40, w: 300, h: 110 },
      { id: 'b', label: 'B', x: 100, y: 300, w: 300, h: 110 },
    ],
    edges: [
      { from: 'a', to: 'b', label: 'pinned', labelX: 275, labelY: 215, labelAnchor: 'start' },
    ],
  }, 0);

  assert.equal(panel.edges[0].labelX, 275);
  assert.equal(panel.edges[0].labelY, 215);
  assert.equal(panel.edges[0].anchor, 'start');
});

test('cycle layout places nodes around a single background arrow', async () => {
  const { buildPanel } = await import('../web/svg.js');
  const panel = buildPanel({
    layout: 'cycle',
    cycle: { center: { x: 500, y: 360 }, rx: 240, ry: 160, label: 'iterate' },
    nodes: [
      { id: 'proposal', label: 'proposal', slot: 'top', w: 200, h: 120 },
      { id: 'build', label: 'feature', slot: 'right', w: 200, h: 120 },
      { id: 'demo', label: 'demo', slot: 'bottom', w: 200, h: 120 },
      { id: 'qa', label: 'QA', slot: 'left', w: 200, h: 120 },
    ],
  }, 0);

  assert.equal(panel.cycleArrows.length, 1);
  assert.equal(panel.cycleArrows[0].markerId, 'cycle-arrow-0');
  assert.deepEqual(panel.cycleArrows[0].ellipse, { cx: 500, cy: 360, rx: 320, ry: 220 });
  assert.equal(panel.cycleArrows[0].d, 'M 294 191 A 320 220 0 1 1 726 204');
  assert.deepEqual(panel.nodes.map(n => [n.id, n.rect.x, n.rect.y]), [
    ['proposal', 400, 140],
    ['build', 640, 300],
    ['demo', 400, 460],
    ['qa', 160, 300],
  ]);
});

test('cycle layout can render a recycle-mark loop with real gaps', async () => {
  const { buildPanel } = await import('../web/svg.js');
  const panel = buildPanel({
    layout: 'cycle',
    cycle: { center: { x: 500, y: 360 }, rx: 240, ry: 160, arrowRx: 280, arrowRy: 210, variant: 'recycle' },
    nodes: [
      { id: 'proposal', label: 'proposal', slot: 'left', w: 200, h: 120 },
      { id: 'build', label: 'feature', slot: 'top', w: 200, h: 120 },
      { id: 'demo', label: 'demo', slot: 'right', w: 200, h: 120 },
      { id: 'qa', label: 'QA', slot: 'bottom', w: 200, h: 120 },
    ],
  }, 0);

  assert.equal(panel.cycleArrows.length, 3);
  assert.deepEqual(panel.cycleArrows.map(a => a.markerId), ['cycle-arrow-0', 'cycle-arrow-0', 'cycle-arrow-0']);
  assert.deepEqual(panel.cycleArrows.map(a => a.d), [
    'M 315 272 C 377 140 590 146 662 247',
    'M 702 318 C 780 394 662 520 517 532',
    'M 461 528 C 315 515 226 410 293 343',
  ]);
  assert.ok(panel.cycleArrows.every(a => !a.ellipse));
});

test('cycle layout can render a recycle logo watermark', async () => {
  const { buildPanel } = await import('../web/svg.js');
  const panel = buildPanel({
    layout: 'cycle',
    cycle: { center: { x: 500, y: 360 }, variant: 'recycle-logo', glyphY: 420, glyphSize: 380 },
    nodes: [
      { id: 'proposal', label: 'proposal', slot: 'left', w: 200, h: 120 },
      { id: 'build', label: 'feature', slot: 'top', w: 200, h: 120 },
    ],
  }, 0);

  assert.deepEqual(panel.cycleArrows, [{
    glyph: '♻',
    glyphX: 500,
    glyphY: 420,
    glyphSize: 380,
    markerId: 'cycle-arrow-0',
  }]);
});
