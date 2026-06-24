/**
 * SLIDEY — the `slidey/tour-adapter` public subpath.
 *
 * The stable entry an APP imports to author + register a tour adapter, without
 * reaching into slidey internals. Dependency injection at the tour-engine
 * boundary: slidey defines the interface here; the app provides the module.
 *
 *   const { baseAdapter, registerAdapter } = require('slidey/tour-adapter');
 *
 *   const myAdapter = {
 *     ...baseAdapter,                 // inherit the inert no-op hooks
 *     name: 'my-app',
 *     async init(page, tour, ctx) {
 *       await page.addScriptTag({ path: ctx.resolve('my-helpers.js') });
 *     },
 *     actions: {
 *       submitIntent: (page, { name, slots }, ctx) =>
 *         page.evaluate((n, s) => window.__appSubmit(n, s), name, slots),
 *     },
 *     advancers: {
 *       'state-match': (page, step, ctx) => page.waitForFunction(
 *         (s) => document.querySelector('[data-testid=state-badge]')?.dataset.state === s,
 *         { timeout: ctx.timeout }, step.advanceState),
 *     },
 *   };
 *   registerAdapter('my-app', myAdapter);  // now `"adapter": "my-app"` works.
 *
 * The adapter can instead be passed by OBJECT to captureToVideo/captureToRrweb's
 * `{ adapter }`, or named in the tour spec as `"adapter": "./my-adapter.cjs"`
 * (a module path resolved relative to the spec). See adapters/base.js for the
 * full interface + ctx contract.
 */

'use strict';

const { baseAdapter, normalizeAdapter } = require('./adapters/base');
const { registerAdapter } = require('./adapters');

module.exports = { baseAdapter, normalizeAdapter, registerAdapter };
