# Proposal: an extensible tour engine (app adapters)

**Status:** Draft v1. Nothing implemented yet.
**Area:**   `src/tour/` (capture drivers, CLI, lib API)
**Motivating consumer:** kitsoki's `@kitsoki` GitHub-loop demo (Act 2).

## Why

slidey's tour engine is "the generalized, app-agnostic successor to a per-app
Playwright recording harness" (`src/tour/capture.js:7`). It delivers on that for
**static and plain DOM** surfaces — slidey itself captures kitsoki's static
`gh-thread.html` fixture today. But its step vocabulary is a **closed set**:

- The action dispatch is a hard-coded if-chain — `goto / click / type / press /
  waitFor / wait / eval` (`src/tour/capture.js:59-68`).
- `advance` is a fixed enum — `next / click-target / route-match`
  (`src/tour/capture.js:177-186`, mirrored in `rrweb-capture.js:137-150`).
- Waiting is selector- or URL-only; there is no "wait until this page predicate
  holds".

When an app's drive needs anything outside that set, the only escape hatch is
`eval` — a raw JS string with no app helpers, no structured args, and no way to
extend `advance` or add a typed wait. So the consumer is forced to **abandon
slidey's engine and fork a bespoke capture harness**, which is exactly what
kitsoki had to do.

**The worked failure (kitsoki Act 2).** kitsoki's web UI is driven through three
app-specific seams that slidey's engine cannot express:

1. **Composer prose → slot-intent routing** — type natural-language prose into the
   kitsoki composer so it routes to a slot-bearing intent (`typeAndSend` /
   `composeVisibly`), not a literal `type` into one input.
2. **A bare-verb submit seam** — `window.__kitsokiSubmitIntent(name, slots)` for
   navigation verbs the composer can't carry.
3. **State-gated advance** — wait until the run's `state-badge` reaches a named
   machine state before the next step (not a URL/selector change).

(plus an optional fourth: reusing the app's own narration overlay,
`__startTourWithSteps`, instead of slidey's injected caption/spotlight.)

Because none of these fit the closed vocabulary, kitsoki's Act 2 fell back to a
**forked Playwright spec + the kitsoki rrweb harness**
(`tools/runstatus/tests/playwright/github-demo-act2-rrweb-capture.spec.ts`),
duplicating step-driving logic slidey already owns and **hand-stamping
`slidey.chapter` events** that slidey's own rrweb path injects for free
(`src/tour/rrweb-capture.js:125-132`). Act 1 stayed a clean slidey tour; Act 2
could not. That split is the smell this proposal removes.

## What changes

Introduce a small **tour adapter** seam. An adapter is a plain module that
registers app-specific **step verbs**, **advance strategies**, and an **init
hook**; the two capture drivers consult it for any verb/advance they don't
recognize. slidey core keeps **zero** dependency on any app — the default
behavior is refactored into a built-in `dom` adapter, and a consumer (kitsoki)
ships its own adapter module that slidey loads **by path**. This is dependency
injection at the engine boundary: slidey defines the interface, the app provides
the implementation.

### The adapter interface

```js
// kitsoki-tour-adapter.cjs — lives in the CONSUMER's repo, not slidey.
module.exports = {
  name: 'kitsoki',

  // Run once, after the app is loaded + the ready gate passes, before step 0.
  // Inject helpers / pin a bundle / wire the app's overlay. Gets the puppeteer
  // page, the parsed tour, and a ctx { base, pace, mode: 'freeze'|'rrweb' }.
  async init(page, tour, ctx) {
    await page.addScriptTag({ path: ctx.resolve('kitsoki-tour-helpers.js') });
  },

  // Custom step verbs, usable in `before:[]`, the new `drive:[]`, and as a
  // step's primary action. Each gets (page, args, ctx).
  actions: {
    composeAndSend: (page, { text }, ctx) =>
      page.evaluate((t) => window.__kitsokiComposeAndSend(t), text),
    submitIntent: (page, { name, slots }, ctx) =>
      page.evaluate((n, s) => window.__kitsokiSubmitIntent(n, s), name, slots),
  },

  // Custom advance strategies, beyond next/click-target/route-match. (page, step, ctx).
  advancers: {
    'state-match': (page, step, ctx) =>
      page.waitForFunction(
        (s) => document.querySelector('[data-testid=state-badge]')?.dataset.state === s,
        { timeout: ctx.timeout }, step.advanceState),
  },

  // OPTIONAL: drive the app's own overlay instead of slidey's injected chrome.
  // No-op by default; rrweb capture already keeps slidey overlays out of the log.
  async decorate(page, step, ctx) { /* window.__tourGoTo(step.id) … */ },
};
```

### Core changes (one seam, both drivers)

The drivers already share `runAction` / `clickSel` / `waitSel`
(`rrweb-capture.js:37` imports them from `capture.js`), so the change lands in
**one place** and both freeze-frame and rrweb modes inherit it.

1. **Action dispatch falls through to the adapter.** `runAction` keeps the
   built-in single-key verbs, then looks up any **unknown** single-key action
   object in `ctx.adapter.actions` — so `{ submitIntent: { name, slots } }` in a
   step's `before:[]` resolves to the adapter verb. Backward compatible: existing
   specs use only built-ins.
2. **A typed predicate wait, built-in.** Add `{ waitForFn: "<expr>" }` (and the
   step-level `advance: "predicate"` + `advanceFn`) so even adapter-less specs can
   wait on a page predicate, not just a selector/URL. The kitsoki `state-match`
   advancer is then a thin, named wrapper an app can ship for ergonomics.
3. **Advance lookup consults the adapter.** When `step.advance` is not a built-in,
   resolve it from `ctx.adapter.advancers`.
4. **A `drive:[]` step field** (sugar): an ordered list of adapter/built-in verbs
   that run **on-camera** mid-dwell (the rrweb path already clicks mid-dwell to
   record motion — `rrweb-capture.js:139-147`; `drive:[]` generalizes that to
   arbitrary verbs so typed prose and intent submits are captured as real motion).
5. **`init` + `decorate` hooks** are invoked at the points noted above; both are
   optional and no-op for the `dom` default.

### Loading an adapter (slidey stays app-free)

- **Tour spec:** `"adapter": "dom"` (default) | a built-in name | a **module path**
  resolved relative to the spec file.
- **CLI:** `slidey capture <tour.json> <out> --adapter ./kitsoki-tour-adapter.cjs`.
- **Lib API:** `captureToVideo(tour, out, { adapter })` /
  `captureToRrweb(tour, out, { adapter })` accept an adapter **object** directly
  (`src/tour/index.js`), and a `registerAdapter(name, mod)` export names one for
  reuse. Surface a `slidey/tour-adapter` subpath in the `exports` map
  (`package.json`) documenting the interface + a no-op base.

### The payoff for kitsoki

kitsoki deletes `github-demo-act2-rrweb-capture.spec.ts` and ships a
`kitsoki-tour-adapter.cjs` + an `act2-webviewer.tour.json`. Act 2 becomes a pure
slidey tour exactly like Act 1 — one capture path, `slidey.chapter` events
injected by slidey (no hand-stamping), and the same tour spec drives both
freeze-frame PNG iteration and the shippable rrweb clip. The reusable kitsoki
manifest (`src/tour/github-demo-manifest.ts`) becomes the single source for the
tour steps, killing the spec/manifest drift the fork reintroduced.

## Impact

- **Surface:** new `src/tour/adapters/` (the `dom` default + a no-op base + the
  registry), edits to `capture.js` (action/advance dispatch + the predicate wait
  + `init`/`decorate`/`drive` hooks), a one-line consult in `rrweb-capture.js`,
  the `--adapter` CLI flag (`src/index.js`), `{ adapter }` plumbed through
  `src/tour/index.js`, and a `slidey/tour-adapter` export.
- **Backward compatibility:** total. No-adapter specs run the `dom` adapter, whose
  verbs/advances are byte-for-byte today's behavior. New fields (`drive`,
  `waitForFn`, `advanceFn`, `adapter`) are additive.
- **Determinism / no-LLM posture:** unchanged. Adapters drive the same
  Puppeteer page; the kitsoki adapter still targets a **no-LLM replay** server.
  An adapter can run arbitrary page JS — same trust level as the existing `eval`
  verb, just structured.
- **Docs:** a `src/tour/README.md` (or a section in the `slidey-authoring` skill)
  documenting the adapter interface + the kitsoki adapter as the worked example;
  then delete this proposal.

## Tasks

```
## 1. Core seam
- [ ] 1.1 Extract today's verbs into a `dom` adapter; add a no-op base + registry under src/tour/adapters/
- [ ] 1.2 runAction: built-ins first, then ctx.adapter.actions[verb] for unknown single-key objects
- [ ] 1.3 Built-in predicate wait: { waitForFn } action + advance:"predicate"/advanceFn
- [ ] 1.4 Advance lookup consults ctx.adapter.advancers; add the on-camera drive:[] step field
- [ ] 1.5 Invoke init() (post-ready, pre-step-0) and optional decorate() per step, in BOTH drivers

## 2. Loading + API
- [ ] 2.1 tour.adapter (name | module path rel. to spec) + --adapter CLI flag
- [ ] 2.2 { adapter } through captureToVideo/captureToRrweb; registerAdapter() + slidey/tour-adapter export

## 3. Prove it on kitsoki
- [ ] 3.1 kitsoki ships kitsoki-tour-adapter.cjs (composeAndSend / submitIntent / state-match)
- [ ] 3.2 Replace the Act-2 fork with act2-webviewer.tour.json; clip + chapters match the current fork
- [ ] 3.3 Delete github-demo-act2-rrweb-capture.spec.ts; composite render unchanged (non-blank, chaptered)

## 4. Land
- [ ] 4.1 Document the adapter interface (src/tour/README.md) + the kitsoki worked example; delete this proposal
```

## Non-goals

- **Putting kitsoki specifics in slidey core.** The kitsoki verbs live in
  kitsoki's adapter module; slidey ships only the seam + the `dom` default.
- **The deferred real-time screencast capture mode** (`src/tour/capture.js:13`) —
  orthogonal; this proposal is about *what* a step can do, not *how* frames are
  grabbed.
- **Changing the `video` deck scene contract.** `src` / `rrweb` / `capture` +
  `chapters:"auto"` are unchanged; this only changes how the captured artifact is
  produced.
- **A general plugin marketplace.** One adapter, loaded by path, is enough; no
  discovery/registry-on-disk machinery.
