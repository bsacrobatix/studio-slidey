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
function repace(events, opts = {}) {
  const minDwellMs = opts.minDwellMs ?? 1400;
  const coalesceMs = opts.coalesceMs ?? 150;
  const sigMinAdds = opts.sigMinAdds ?? 4;
  const sigMinText = opts.sigMinText ?? 24;
  const holdMs = opts.holdMs ?? 1500;

  if (!Array.isArray(events) || events.length < 2) return Array.isArray(events) ? events.slice() : events;

  const isSig = (e) => {
    if (!e || e.type !== 3 || !e.data || e.data.source !== 0) return false;
    const adds = e.data.adds;
    if (!Array.isArray(adds) || !adds.length) return false;
    let nodes = 0, maxText = 0;
    for (const a of adds) {
      const n = a && a.node;
      if (!n) continue;
      if (n.type === 2) nodes++;
      else if (n.type === 3) { nodes++; maxText = Math.max(maxText, String(n.textContent || '').trim().length); }
    }
    return nodes >= sigMinAdds || maxText >= sigMinText;
  };

  let shift = 0;
  let lastGroupTs = null; // shifted timestamp of the current reveal group's start
  const out = events.map((e) => {
    let ts = e.timestamp + shift;
    if (isSig(e)) {
      if (lastGroupTs !== null) {
        const gap = ts - lastGroupTs;
        if (gap > coalesceMs) {
          // A distinct reveal — ensure at least minDwell since the previous one.
          if (gap < minDwellMs) { const extra = minDwellMs - gap; shift += extra; ts += extra; }
          lastGroupTs = ts;
        }
        // gap <= coalesceMs: same logical render — leave tight, keep group anchor.
      } else {
        lastGroupTs = ts;
      }
    }
    return { ...e, timestamp: ts };
  });

  if (holdMs > 0) {
    const last = out[out.length - 1];
    // A no-op empty mutation extends the replay's total time (so the final frame
    // holds) with no visual effect and no new content for the pacing scan.
    out.push({ type: 3, timestamp: last.timestamp + holdMs, data: { source: 0, texts: [], attributes: [], removes: [], adds: [] } });
  }
  return out;
}

module.exports = { repace };
