'use strict';

/**
 * SLIDEY — rrweb re-pacing
 *
 * A captured rrweb tour sometimes flushes a burst of content right at the end —
 * the last few messages / the final artifact all land in well under a second, so
 * the replay reads as "the last 3-5 messages are super-rushed." This stretches
 * the timeline so each DISTINCT content reveal gets a minimum readable dwell.
 *
 * It only ever ADDS time (monotonic shift; never compresses), so the already
 * well-paced early part is untouched — only reveals that arrive too soon after
 * the previous one are pushed apart. Mutations within `coalesceMs` of each other
 * are treated as ONE logical render (a multi-part message), so a single message
 * is not mistaken for several rushed ones. A trailing no-op mutation holds the
 * final frame so the last reveal is readable before the player ends.
 *
 * Mirrors the significance definition used by the QA rrweb-pacing-scan, so a clip
 * re-paced here passes that deterministic gate.
 *
 * @param {Array} events  rrweb event log (array of {type,timestamp,data})
 * @param {object} [opts]
 *   minDwellMs   minimum gap enforced between distinct reveals (default 1400)
 *   coalesceMs   reveals within this window are one render (default 150)
 *   sigMinAdds   added-node count for a mutation to count as content (default 4)
 *   sigMinText   added-text length that alone counts as content (default 24)
 *   holdMs       trailing hold on the final frame (default 1500; 0 to disable)
 * @returns {Array} a new event array (inputs not mutated)
 */
// Shared readable-dwell model (kept identical to the QA rrweb-pacing-scan so a
// re-paced clip clears that gate). The dwell a reveal needs scales with how much
// TEXT it put on screen: a one-word trace row reads in the base time, but a long
// typed answer or a streamed message needs real reading time — otherwise the
// transcript scrolls past it before it can be read. Returns ms.
function readableDwellMs(textLen, o) {
  return Math.min(o.maxDwellMs, o.minDwellMs + Math.max(0, textLen) * o.msPerChar);
}

// The longest single text block a mutation adds (the message body), scanning
// added nodes and their immediate serialized children.
function revealTextLen(adds) {
  let max = 0;
  const consider = (n) => {
    if (!n) return;
    if (n.type === 3) max = Math.max(max, String(n.textContent || '').trim().length);
    if (Array.isArray(n.childNodes)) for (const c of n.childNodes) consider(c);
  };
  for (const a of adds || []) consider(a && a.node);
  return max;
}

function repace(events, opts = {}) {
  const o = {
    minDwellMs: opts.minDwellMs ?? 1400,
    maxDwellMs: opts.maxDwellMs ?? 2800,
    msPerChar: opts.msPerChar ?? 16,
    coalesceMs: opts.coalesceMs ?? 150,
    sigMinAdds: opts.sigMinAdds ?? 4,
    sigMinText: opts.sigMinText ?? 24,
    holdMs: opts.holdMs ?? 1500,
  };
  if (!Array.isArray(events) || events.length < 2) return Array.isArray(events) ? events.slice() : events;

  // Strip any trailing no-op hold this tool appended on a previous pass, so
  // re-running is idempotent (no compounding holds, stable convergence).
  let src = events.slice();
  while (src.length && isNoopHold(src[src.length - 1])) src.pop();

  const sig = (e) => {
    if (!e || e.type !== 3 || !e.data || e.data.source !== 0) return null;
    const adds = e.data.adds;
    if (!Array.isArray(adds) || !adds.length) return null;
    let nodes = 0;
    for (const a of adds) { if (a && a.node && (a.node.type === 2 || a.node.type === 3)) nodes++; }
    const textLen = revealTextLen(adds);
    return (nodes >= o.sigMinAdds || textLen >= o.sigMinText) ? { textLen } : null;
  };

  let shift = 0;
  let lastGroupTs = null;   // shifted timestamp of the current reveal group's start
  let lastGroupLen = 0;     // the group's text weight (drives the dwell it needs)
  const out = src.map((e) => {
    let ts = e.timestamp + shift;
    const s = sig(e);
    if (s) {
      if (lastGroupTs !== null) {
        const gap = ts - lastGroupTs;
        if (gap > o.coalesceMs) {
          // A distinct reveal — ensure the PREVIOUS group stayed up long enough
          // to read its content before this one (and the scroll with it) arrives.
          const need = readableDwellMs(lastGroupLen, o);
          if (gap < need) { const extra = need - gap; shift += extra; ts += extra; }
          lastGroupTs = ts; lastGroupLen = s.textLen;
        } else {
          // same logical render — keep the anchor, take the longest text seen.
          lastGroupLen = Math.max(lastGroupLen, s.textLen);
        }
      } else {
        lastGroupTs = ts; lastGroupLen = s.textLen;
      }
    }
    return { ...e, timestamp: ts };
  });

  if (o.holdMs > 0) {
    const last = out[out.length - 1];
    out.push(noopHold(last.timestamp + o.holdMs));
  }
  return out;
}

// A no-op empty mutation: extends the replay's total time (holds the final frame)
// with no visual effect and no content for the pacing scan to see.
function noopHold(timestamp) {
  return { type: 3, timestamp, data: { source: 0, texts: [], attributes: [], removes: [], adds: [], _slideyHold: true } };
}
function isNoopHold(e) {
  return e && e.type === 3 && e.data && e.data._slideyHold === true;
}

module.exports = { repace, readableDwellMs, revealTextLen };
