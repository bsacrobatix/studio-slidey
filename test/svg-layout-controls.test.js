'use strict';

const test = require('node:test');
const assert = require('node:assert');

const nodes = [
  { id: 'start', label: 'Start' },
  { id: 'middle', label: 'Middle' },
  { id: 'end', label: 'End' },
];

function panelWith(layout) {
  return {
    auto_layout: true,
    nodes,
    edges: [
      { from: 'start', to: 'middle' },
      { from: 'middle', to: 'end' },
    ],
    ...layout,
  };
}

test('rankdir controls primary layout axis', async () => {
  const { buildPanel } = await import('../web/svg.js');

  const tb = buildPanel(panelWith({ rankdir: 'TB' }), 0);
  const lr = buildPanel(panelWith({ rankdir: 'LR' }), 0);

  assert.ok(tb.nodes[1].rect.y > tb.nodes[0].rect.y);
  assert.ok(tb.nodes[2].rect.y > tb.nodes[1].rect.y);

  assert.ok(lr.nodes[1].rect.x > lr.nodes[0].rect.x);
  assert.ok(lr.nodes[2].rect.x > lr.nodes[1].rect.x);
  assert.ok(Math.abs(lr.nodes[1].rect.y - tb.nodes[1].rect.y) > 0);
});

test('ranksep scales spacing between successive levels', async () => {
  const { buildPanel } = await import('../web/svg.js');

  const dense = buildPanel(panelWith({ ranksep: 20 }), 0);
  const loose = buildPanel(panelWith({ ranksep: 260 }), 0);

  const denseDelta = dense.nodes[1].rect.y - dense.nodes[0].rect.y;
  const looseDelta = loose.nodes[1].rect.y - loose.nodes[0].rect.y;

  assert.ok(looseDelta > denseDelta);
});

test('nodesep scales spacing between siblings on the same rank', async () => {
  const { buildPanel } = await import('../web/svg.js');

  const branchPanel = {
    auto_layout: true,
    nodes: [
      { id: 'root', label: 'Root' },
      { id: 'left', label: 'Left' },
      { id: 'right', label: 'Right' },
    ],
    edges: [
      { from: 'root', to: 'left' },
      { from: 'root', to: 'right' },
    ],
  };

  const dense = buildPanel({ ...branchPanel, rankdir: 'LR', nodesep: 24 }, 0);
  const loose = buildPanel({ ...branchPanel, rankdir: 'LR', nodesep: 240 }, 0);

  const denseSiblingGap = Math.abs(dense.nodes[2].rect.y - dense.nodes[1].rect.y);
  const looseSiblingGap = Math.abs(loose.nodes[2].rect.y - loose.nodes[1].rect.y);

  assert.ok(looseSiblingGap > denseSiblingGap);
});

test('invalid rankdir falls back to TB direction', async () => {
  const { buildPanel } = await import('../web/svg.js');

  const badDirection = buildPanel(panelWith({ rankdir: 'diagonal' }), 0);
  const tb = buildPanel(panelWith({ rankdir: 'TB' }), 0);

  const byYBad = badDirection.nodes.map(n => n.rect.y);
  const byYTB = tb.nodes.map(n => n.rect.y);

  assert.deepEqual(byYBad.length, byYTB.length);
  assert.ok(Math.abs(byYBad[1] - byYBad[0]) > 0);
  assert.ok(Math.abs(byYTB[1] - byYTB[0]) > 0);
  assert.equal(Math.abs(byYBad[1] - byYBad[0]), Math.abs(byYTB[1] - byYTB[0]));
  assert.ok(Math.abs(byYBad[2] - byYBad[1]) > 0);
});

