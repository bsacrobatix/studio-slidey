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
