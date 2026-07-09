'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('viewer narration extracts whole-slide and timed video cue text', async () => {
  const { speechTextForScene, timedNarrationCues } = await import('../web/narration.mjs');
  assert.equal(speechTextForScene({ narration: 'Hello world' }), 'Hello world');
  const cues = timedNarrationCues({
    narration: [
      { chapter: 'intro', text: 'Start here' },
      { at: 4.5, text: 'Then this' },
    ],
  }, [{ id: 'intro', start_ms: 1250 }]);
  assert.deepEqual(cues.map(c => [c.at, c.text]), [
    [1.25, 'Start here'],
    [4.5, 'Then this'],
  ]);
});

test('viewer narration maps graph focus steps to graph path notes', async () => {
  const { stepNarrationCues } = await import('../web/narration.mjs');
  const cues = stepNarrationCues({
    type: 'graph',
    title: 'Value graph',
    caption: 'Inspect the proof.',
    narration: 'The graph is the network. Hard gates come first.',
    nodes: [{ id: 'req', label: 'FIPS compliance', sub: 'hard gate' }],
    path: [{ node: 'req', note: 'FIPS is a hard gate.' }],
  }, ['graph_title', 'graph_frame', 'graph_focus_0', 'graph_caption']);

  assert.deepEqual(cues, [
    'The graph is the network.',
    'Hard gates come first.',
    'FIPS is a hard gate.',
    'Inspect the proof.',
  ]);
});

test('viewer narration can merge skipped graph title cue into first visible graph frame cue', async () => {
  const { stepNarrationCues } = await import('../web/narration.mjs');
  const cues = stepNarrationCues({
    type: 'graph',
    title: 'Value graph',
    narration: 'The title sets context. The graph is visible now.',
    nodes: [{ id: 'proof', label: 'Proof' }],
    path: [{ node: 'proof', note: 'Proof gets inspected.' }],
  }, ['graph_title', 'graph_frame', 'graph_focus_0']);

  const firstVisibleCue = cues.slice(0, 1).concat(cues[1]).filter(Boolean).join('\n');
  assert.equal(firstVisibleCue, 'The title sets context.\nThe graph is visible now.');
});

test('viewer narration can leave graph captions visual-only', async () => {
  const { stepNarrationCues } = await import('../web/narration.mjs');
  const cues = stepNarrationCues({
    type: 'graph',
    title: 'Value graph',
    caption: 'Visible footer only.',
    narrateCaption: false,
    nodes: [{ id: 'proof', label: 'Proof' }],
    path: [{ node: 'proof', note: 'Proof gets inspected.' }],
  }, ['graph_title', 'graph_frame', 'graph_focus_0', 'graph_caption']);

  assert.deepEqual(cues, [
    'Value graph',
    '',
    'Proof gets inspected.',
    '',
  ]);
});
