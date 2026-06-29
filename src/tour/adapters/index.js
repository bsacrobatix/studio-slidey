/**
 * SLIDEY — Tour adapter registry + resolution.
 *
 * Resolves a tour's chosen adapter into a normalized adapter object the drivers
 * thread as `ctx.adapter`. Resolution sources, in order of how a tour names one:
 *
 *   - `"adapter": "dom"`            → the built-in default (today's behavior).
 *   - `"adapter": "<registered>"`   → a name passed to registerAdapter().
 *   - `"adapter": "./my.cjs"`       → a MODULE PATH, resolved relative to the
 *                                      tour spec file (ctx.resolve), then required.
 *   - lib option `{ adapter: obj }` → an adapter OBJECT passed directly (wins).
 *
 * slidey core stays app-free: it ships only `dom` here. Apps register their own
 * adapter by name (registerAdapter) or hand slidey the object/path.
 */

'use strict';

const path = require('path');

const { normalizeAdapter } = require('./base');
const { domAdapter, BUILTIN_ACTIONS, BUILTIN_ADVANCES } = require('./dom');

/** Built-in adapters, keyed by name. Apps add to this via registerAdapter(). */
const REGISTRY = new Map([
  ['dom', domAdapter],
  ['default', domAdapter],
]);

/**
 * Register an adapter module under a name so a tour spec can select it by name
 * (`"adapter": "<name>"`) without a module path. Idempotent overwrite.
 *
 * @param {string} name
 * @param {object} mod  An adapter module (see adapters/base.js for the shape).
 */
function registerAdapter(name, mod) {
  if (!name || typeof name !== 'string') throw new Error('registerAdapter: name must be a non-empty string');
  if (!mod || typeof mod !== 'object') throw new Error(`registerAdapter(${name}): module must be an object`);
  REGISTRY.set(name, mod);
}

/**
 * Resolve the adapter for a capture run into a normalized object.
 *
 * Precedence: an explicit `optAdapter` OBJECT (lib API) wins; otherwise the
 * tour's `adapter` field — a registered name, or a module path resolved relative
 * to the spec file via `resolve`. Absent/`"dom"` → the built-in default.
 *
 * @param {object} tour            Parsed tour spec (may carry `adapter`).
 * @param {object|string|null} optAdapter  Lib-API override: an adapter object, or a name.
 * @param {(p:string)=>string} resolve     Resolves a path relative to the spec file.
 * @returns {{ name, init, decorate, actions, advancers }}
 */
function resolveAdapter(tour, optAdapter, resolve) {
  // 1. A lib-API adapter object wins outright.
  if (optAdapter && typeof optAdapter === 'object') return normalizeAdapter(optAdapter);

  // 2. A name from the lib API or the tour spec.
  const sel = (typeof optAdapter === 'string' && optAdapter) || tour.adapter || 'dom';

  // 3. A registered name (incl. the built-in `dom`).
  if (REGISTRY.has(sel)) return normalizeAdapter(REGISTRY.get(sel));

  // 4. Anything path-ish: resolve relative to the spec, then require.
  if (sel.includes('/') || sel.includes('\\') || sel.endsWith('.js') || sel.endsWith('.cjs')) {
    const abs = resolve ? resolve(sel) : path.resolve(sel);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(abs);
    return normalizeAdapter(mod.default || mod);
  }

  throw new Error(`unknown tour adapter: "${sel}" (not a registered name or a module path)`);
}

module.exports = {
  registerAdapter,
  resolveAdapter,
  BUILTIN_ACTIONS,
  BUILTIN_ADVANCES,
};
