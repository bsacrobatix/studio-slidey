/**
 * SLIDEY — Tour adapter: the built-in `dom` default.
 *
 * The default tour behavior, named as an adapter. It owns NO custom verbs or
 * advancers because the built-in DOM verbs (goto/click/type/press/waitFor/wait/
 * eval) and advances (next/click-target/route-match) are implemented INLINE in
 * the driver (capture.js) for byte-for-byte determinism — extracting them into
 * closures here would change nothing observable but add an indirection. So `dom`
 * is the no-op base under a stable, addressable name: a tour with no `adapter`
 * field, or `"adapter": "dom"`, resolves to exactly today's behavior.
 *
 * The SET of built-in names lives here as the single source of truth the driver
 * consults to decide "is this a built-in, or do I fall through to the adapter?".
 */

'use strict';

const { baseAdapter } = require('./base');

/** Single-key action verbs the driver handles inline (capture.js runAction). */
const BUILTIN_ACTIONS = new Set([
  'goto', 'click', 'type', 'press', 'waitFor', 'wait', 'eval', 'waitForFn',
]);

/** Advance strategies the driver handles inline (capture.js / rrweb-capture.js). */
const BUILTIN_ADVANCES = new Set([
  'next', 'click-target', 'route-match', 'predicate',
]);

const domAdapter = {
  ...baseAdapter,
  name: 'dom',
};

module.exports = { domAdapter, BUILTIN_ACTIONS, BUILTIN_ADVANCES };
