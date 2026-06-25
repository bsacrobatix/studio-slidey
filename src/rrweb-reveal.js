'use strict';

/**
 * SLIDEY — rrweb conversation REVEAL TRACK (followability transform)
 *
 * A conversation clip captured from a live drive bakes in the chat component's
 * native auto-scroll: `ChatTranscript.vue` sets `scrollTop = scrollHeight` on
 * every new message, so the rrweb log records an INSTANT downward jump per turn.
 * On replay the transcript SNAPS to the bottom each time — a reply taller than
 * the fold (and the user input that triggered it) renders already scrolled
 * off-camera. The viewer can't follow it. This is the #1 "the video is jumpy /
 * you can't see the user inputs" defect, and a time-only re-pace can't fix it:
 * adding time to a snapped capture just holds the *bottom* of each message
 * longer; the top still never shows.
 *
 * The fix is to OWN the scroll the way the live `revealTurn` choreography does —
 * ease through each message instead of snapping to it. The key realization that
 * makes this doable OFFLINE (no browser, no node geometry): the recorded snap
 * events already contain the scroll trajectory. Each snap's `y` is the
 * bottom-position after that message, and the previous scroll event's `y` is
 * where we were — so the new content occupies roughly [prevY .. newY]. We
 * therefore replace each instant snap with:
 *   • a leading HOLD at prevY (the new message's opening lines sit on screen,
 *     including the just-typed user input), then
 *   • a smooth easeInOutQuad ramp of intermediate scroll events from prevY → newY
 *     over a duration that scales with the distance (a tall reply scrolls slowly
 *     and readably), then the turn's content stays put until the next turn.
 * Every later event is shifted by the time we inserted (monotonic; never
 * compresses), exactly like rrweb-repace.
 *
 * The result is a clip whose transcript scroller shows EASED reveal runs instead
 * of snaps — it clears the QA `rrweb-scroll-scan.mjs` followability gate, and a
 * viewer can read every message. Idempotent: re-running detects the eased track
 * (no remaining snaps) and is a no-op.
 *
 * Pairs with rrweb-repace (TIME) — reveal owns SCROLL. Run reveal first (it
 * inserts holds + eases), then repace if any content reveals are still rushed.
 *
 * @param {Array} events  rrweb event log (array of {type,timestamp,data})
 * @param {object} [opts]
 *   scrollId     pin the transcript scroller node id (default: auto-detect the
 *                snap-dominated node)
 *   minSnaps     a node needs ≥ this many instant downward jumps to be treated
 *                as a snapping transcript (default 3)
 *   snapMinDy    downward entry jump (px) that counts as a snap (default 40)
 *   holdMs       hold at the start of each reveal before easing down (default 900)
 *   easeMinMs    floor on a single reveal's ease duration (default 900)
 *   easeMaxMs    ceiling on a single reveal's ease duration (default 3000)
 *   msPerPx      ease duration per pixel of scroll distance (default 4)
 *   steps        intermediate scroll events per ease (default 18; ≥6 → "eased")
 *   tailHoldMs   trailing hold on the final frame (default 1500; 0 to disable)
 * @returns {Array} a new event array (inputs not mutated)
 */
function reveal(events, opts = {}) {
  const o = {
    scrollId: opts.scrollId ?? null,
    minSnaps: opts.minSnaps ?? 3,
    snapMinDy: opts.snapMinDy ?? 40,
    runGap: opts.runGap ?? 400,
    easeMinEvents: opts.easeMinEvents ?? 6,
    easeMinMs: opts.easeMinMs ?? 900,
    easeMaxMs: opts.easeMaxMs ?? 3000,
    holdMs: opts.holdMs ?? 900,
    msPerPx: opts.msPerPx ?? 4,
    steps: opts.steps ?? 18,
    tailHoldMs: opts.tailHoldMs ?? 1500,
  };
  if (!Array.isArray(events) || events.length < 2) return Array.isArray(events) ? events.slice() : events;

  let src = events.slice();
  while (src.length && isNoopHold(src[src.length - 1])) src.pop();

  // Identify the transcript scroller: the node whose scroll stream is
  // snap-dominated (mirrors the QA rrweb-scroll-scan classification so the
  // followability they agree on is the same).
  const scrollId = o.scrollId != null ? o.scrollId : detectSnapScroller(src, o);
  if (scrollId == null) {
    // Nothing snaps — already followable (or no transcript scroll). Idempotent.
    return o.tailHoldMs > 0 ? withTailHold(src, o.tailHoldMs) : src;
  }

  // Walk the events, tracking the running scroll position of the transcript and
  // the cumulative time shift. Each snap on the transcript node is expanded into
  // hold + eased ramp; everything else is passed through shifted.
  const easeInOutQuad = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
  const out = [];
  let shift = 0;
  let prevY = 0;
  let lastScrollTs = -Infinity;

  for (const e of src) {
    const isScroll = e.type === 3 && e.data && e.data.source === 3 && e.data.id === scrollId
      && typeof e.data.y === 'number';
    if (!isScroll) { out.push({ ...e, timestamp: e.timestamp + shift }); continue; }

    const y = e.data.y;
    const entryJump = y - prevY;
    const newRun = e.timestamp - lastScrollTs > o.runGap;
    lastScrollTs = e.timestamp;

    // Only expand a genuine instant downward snap that starts a new run. A small
    // adjustment or an already-eased burst is passed through untouched.
    if (newRun && entryJump >= o.snapMinDy) {
      const baseTs = e.timestamp + shift;
      // 1. Hold at prevY so the new message's opening (and the user input) sits
      //    on screen before we move.
      out.push(scrollEvent(scrollId, e.data.x ?? 0, prevY, baseTs));
      shift += o.holdMs;
      // 2. Eased ramp prevY → y.
      const dur = Math.min(o.easeMaxMs, Math.max(o.easeMinMs, Math.round(entryJump * o.msPerPx)));
      const startTs = e.timestamp + shift;
      for (let i = 1; i <= o.steps; i++) {
        const p = i / o.steps;
        const yi = Math.round(prevY + entryJump * easeInOutQuad(p));
        out.push(scrollEvent(scrollId, e.data.x ?? 0, yi, startTs + Math.round(dur * p)));
      }
      shift += dur;
      prevY = y;
    } else {
      out.push({ ...e, timestamp: e.timestamp + shift });
      prevY = y;
    }
  }

  out.sort((a, b) => a.timestamp - b.timestamp);
  return o.tailHoldMs > 0 ? withTailHold(out, o.tailHoldMs) : out;
}

// Classify scroller nodes and return the id of the snap-dominated one, or null.
function detectSnapScroller(events, o) {
  const t0 = events[0].timestamp;
  const byId = new Map();
  for (const e of events) {
    if (e.type === 3 && e.data && e.data.source === 3 && typeof e.data.y === 'number') {
      if (!byId.has(e.data.id)) byId.set(e.data.id, []);
      byId.get(e.data.id).push({ ts: e.timestamp - t0, y: e.data.y });
    }
  }
  let best = null, bestSnaps = -1;
  for (const [id, scrolls] of byId) {
    const runs = [];
    let cur = null;
    for (const s of scrolls) {
      if (!cur || s.ts - cur.end > o.runGap) { cur = { start: s.ts, end: s.ts, ys: [s.y] }; runs.push(cur); }
      else { cur.end = s.ts; cur.ys.push(s.y); }
    }
    let prevEndY = 0, snaps = 0, eased = 0;
    for (const r of runs) {
      const n = r.ys.length, span = r.end - r.start, entryJump = r.ys[0] - prevEndY;
      if (n >= o.easeMinEvents && span >= o.easeMinMs) eased++;
      else if (entryJump >= o.snapMinDy) snaps++;
      prevEndY = r.ys[r.ys.length - 1];
    }
    if (snaps >= o.minSnaps && snaps > eased && snaps > bestSnaps) { bestSnaps = snaps; best = id; }
  }
  return best;
}

function scrollEvent(id, x, y, timestamp) {
  return { type: 3, timestamp, data: { source: 3, id, x, y } };
}
function withTailHold(out, holdMs) {
  const last = out[out.length - 1];
  return out.concat([noopHold(last.timestamp + holdMs)]);
}
function noopHold(timestamp) {
  return { type: 3, timestamp, data: { source: 0, texts: [], attributes: [], removes: [], adds: [], _slideyHold: true } };
}
function isNoopHold(e) {
  return e && e.type === 3 && e.data && e.data._slideyHold === true;
}

module.exports = { reveal, detectSnapScroller };
