/**
 * SLIDEY — Tour adapter: the no-op base.
 *
 * An adapter is dependency injection at the tour-engine boundary: slidey core
 * defines the interface (custom step verbs, custom advance strategies, and the
 * init/decorate lifecycle hooks) and an APP supplies the implementation in its
 * OWN repo. slidey ships only this base + the built-in `dom` adapter (today's
 * verbs), so core keeps ZERO dependency on any consumer.
 *
 * THE INTERFACE — every field is optional; the base supplies inert defaults.
 *
 *   {
 *     name: 'my-app',
 *
 *     // Run ONCE after the app is loaded + the ready gate passes, before step 0.
 *     // Inject helpers, pin a bundle, wire the app's own overlay. Receives the
 *     // puppeteer page, the parsed tour, and the adapter ctx (see below).
 *     async init(page, tour, ctx) {},
 *
 *     // Run per step, after the chapter boundary is marked. No-op by default;
 *     // an app can drive its own narration overlay here instead of slidey's.
 *     async decorate(page, step, ctx) {},
 *
 *     // Custom step verbs. Usable in a step's `before:[]`, the on-camera
 *     // `drive:[]`, and as a primary action. Each single-key action object whose
 *     // key is NOT a slidey built-in is looked up here:
 *     //   { submitIntent: {...} } → actions.submitIntent(page, {...}, ctx).
 *     // Each receives (page, args, ctx).
 *     actions: {},
 *
 *     // Custom advance strategies, beyond next/click-target/route-match. When a
 *     // step's `advance` is not a built-in it is resolved here:
 *     //   advancers['state-match'](page, step, ctx).
 *     // Each receives (page, step, ctx).
 *     advancers: {},
 *   }
 *
 * THE ctx — threaded to every hook/verb/advancer:
 *   { base, pace, mode: 'freeze' | 'rrweb', timeout, resolve(p) }
 *   - base     the resolved target base URL.
 *   - pace     the dwell multiplier in effect.
 *   - mode     which driver is running (freeze-frame PNG vs rrweb log).
 *   - timeout  the action timeout (ACTION_TIMEOUT), for page.waitForFunction etc.
 *   - resolve  resolves a path RELATIVE TO THE TOUR SPEC FILE (for addScriptTag).
 */

'use strict';

/**
 * The inert default adapter. A no-adapter tour runs with this composed under the
 * built-in `dom` verbs/advances, so `init`/`decorate` are no-ops and no custom
 * verbs/advancers exist — i.e. byte-for-byte today's behavior.
 */
const baseAdapter = {
  name: 'base',
  async init() {},
  async decorate() {},
  actions: {},
  advancers: {},
};

/**
 * Normalize an arbitrary adapter module into the full shape, filling inert
 * defaults so callers never have to null-check a hook or map. Pure; returns a
 * fresh object and never mutates the input.
 *
 * @param {object|null|undefined} mod  A partial adapter module (or nothing).
 * @returns {{ name, init, decorate, actions, advancers }}
 */
function normalizeAdapter(mod) {
  const a = mod || {};
  return {
    name: a.name || 'anonymous',
    init: typeof a.init === 'function' ? a.init : baseAdapter.init,
    decorate: typeof a.decorate === 'function' ? a.decorate : baseAdapter.decorate,
    actions: a.actions || {},
    advancers: a.advancers || {},
  };
}

module.exports = { baseAdapter, normalizeAdapter };
