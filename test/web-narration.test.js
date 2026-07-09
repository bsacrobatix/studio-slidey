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
