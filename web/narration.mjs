// Browser-side narration helpers for the interactive viewer. Speech synthesis
// happens through the local /api/narration-audio endpoint so live preview uses
// the same edge-tts voice/rate/pronunciation settings as MP4 export.

function chapterStartSeconds(chapters, id) {
  const found = (chapters || []).find(ch => String(ch && ch.id) === String(id));
  if (!found) return 0;
  if (found.start_ms != null) return Math.max(0, Number(found.start_ms) / 1000);
  if (found.timestamp != null) return Math.max(0, Number(found.timestamp) / 1000);
  return 0;
}

function collectText(value, out = []) {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectText(item, out));
    return out;
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string' && value.text.trim()) out.push(value.text.trim());
    else Object.values(value).forEach(item => collectText(item, out));
  }
  return out;
}

export function splitNarrationText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const matches = raw.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) || [raw];
  return matches.map(part => part.trim()).filter(Boolean);
}

export function speechTextForScene(scene) {
  return collectText(scene && scene.narration).join('\n').trim();
}

function pathEntries(scene) {
  const raw = Array.isArray(scene && scene.path) && scene.path.length
    ? scene.path
    : (Array.isArray(scene && scene.focus) ? scene.focus : []);
  return raw.map(entry => typeof entry === 'string' ? { node: entry } : entry).filter(entry => entry && entry.node);
}

function graphStepNarration(scene, step, sentenceQueue) {
  if (step === 'graph_title') return sentenceQueue.shift() || scene.title || '';
  if (step === 'graph_frame') return sentenceQueue.shift() || '';
  if (step === 'graph_caption') {
    const fallback = scene.narrateCaption === false || scene.captionNarration === false ? '' : scene.caption || '';
    return sentenceQueue.shift() || fallback;
  }
  const match = /^graph_focus_(\d+)$/.exec(step || '');
  if (!match) return '';
  const idx = Number(match[1]);
  const entry = pathEntries(scene)[idx] || {};
  const node = (scene.nodes || []).find(candidate => String(candidate.id) === String(entry.node)) || {};
  const fallback = sentenceQueue.shift();
  return entry.note || fallback || node.sub || node.label || '';
}

// Visible text a reveal step adds to the screen, used to align narration
// sentences to the step they describe. Returns '' for steps whose content
// can't be derived (the alignment then falls back to a positional prior).
function stepContentText(scene, step) {
  const s = scene || {};
  const txt = value => collectText(value).join(' ');
  let m;
  if ((m = /^cards_item_(\d+)$/.exec(step))) {
    const v = s.variant || 'grid';
    const i = Number(m[1]);
    if (v === 'qa') return txt(i === 0 ? s.question : s.answer);
    if (['before-after', 'versus', 'point-counterpoint', 'pros-cons'].includes(v)) {
      const side = i === 0 ? s.left : s.right;
      return txt(side || (s.cards || [])[i]);
    }
    return txt((s.cards || [])[i]);
  }
  if ((m = /^(?:objectives|evidence)_item_(\d+)$/.exec(step))) return txt((s.items || [])[Number(m[1])]);
  if ((m = /^personas_item_(\d+)$/.exec(step))) {
    return txt(((s.variant === 'use-cases' ? s.cases : s.personas) || [])[Number(m[1])]);
  }
  if ((m = /^book_item_(\d+)$/.exec(step))) return txt((s.books || [])[Number(m[1])]);
  if ((m = /^(?:diagram|diagramsvg|thread)_panel_(\d+)$/.exec(step))) return txt((s.panels || [])[Number(m[1])]);
  if ((m = /^trace_turn_(\d+)$/.exec(step))) return txt((s.turns || [])[Number(m[1])]);
  if ((m = /^transcript_card_(\d+)$/.exec(step))) return txt((s.cards || [])[Number(m[1])]);
  if ((m = /^table_row_(\d+)$/.exec(step))) return txt((s.rows || [])[Number(m[1])]);
  if (step === 'table_header') return txt(s.columns);
  if (/_title$/.test(step) || step === 'scene_header' || step === 'narrative_eyebrow') {
    return txt(s.title || s.eyebrow);
  }
  if (/_caption$/.test(step)) return txt(s.caption);
  if (step === 'narrative_body') return txt(s.body);
  if (step === 'narrative_lede') return txt(s.lede);
  if (step === 'stat_value') return txt(s.value);
  if (step === 'stat_label') return txt(s.label);
  if (step === 'stat_detail') return txt(s.detail);
  if (step === 'cta_tagline') return txt(s.tagline);
  if (step === 'cta_url') return txt(s.url);
  return '';
}

const ALIGN_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'for', 'are', 'was', 'its', 'has',
  'have', 'you', 'your', 'our', 'not', 'but', 'all', 'one', 'into', 'from',
]);

function alignTokens(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return new Set(words.filter(w => w.length > 2 && !ALIGN_STOPWORDS.has(w)));
}

function tokenOverlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  const score = inter / Math.sqrt(a.size * b.size);
  // A coincidental one-or-two-word overlap is not evidence of describing the
  // step — below this floor the positional prior should decide instead.
  return score >= 0.25 ? score : 0;
}

// Monotonic alignment of narration sentences onto reveal steps: each sentence
// is scored against each step's visible text (token overlap, plus a small
// positional prior toward the proportional spot), then a DP picks the
// non-decreasing assignment with the best total score. This keeps a sentence
// with the step it describes instead of blindly spreading sentences from step
// zero — which read each reveal's content one step early whenever the
// narration had no dedicated sentence for the title (or an extra one).
function alignSentencesToSteps(parts, stepTexts) {
  const P = parts.length;
  const S = stepTexts.length;
  const partTok = parts.map(alignTokens);
  const stepTok = stepTexts.map(alignTokens);
  const score = (i, j) =>
    tokenOverlapScore(partTok[i], stepTok[j]) +
    0.05 * (1 - Math.abs(j - (i * S) / P) / S);
  const best = Array.from({ length: P }, () => new Array(S).fill(-Infinity));
  const back = Array.from({ length: P }, () => new Array(S).fill(0));
  for (let j = 0; j < S; j += 1) best[0][j] = score(0, j);
  for (let i = 1; i < P; i += 1) {
    let runMax = -Infinity;
    let runArg = 0;
    for (let j = 0; j < S; j += 1) {
      if (best[i - 1][j] > runMax) { runMax = best[i - 1][j]; runArg = j; }
      best[i][j] = runMax + score(i, j);
      back[i][j] = runArg;
    }
  }
  let j = 0;
  for (let k = 1; k < S; k += 1) if (best[P - 1][k] > best[P - 1][j]) j = k;
  const assign = new Array(P);
  for (let i = P - 1; i >= 0; i -= 1) { assign[i] = j; j = back[i][j]; }
  return assign;
}

export function stepNarrationCues(scene, steps = []) {
  const s = scene || {};
  const stepList = Array.isArray(steps) ? steps : [];
  const wholeText = speechTextForScene(s);
  if (!stepList.length) return wholeText ? [wholeText] : [];

  if (s.type === 'graph') {
    const sentenceQueue = splitNarrationText(typeof s.narration === 'string' ? s.narration : wholeText);
    return stepList.map(step => graphStepNarration(s, step, sentenceQueue));
  }

  const textParts = Array.isArray(s.narration)
    ? collectText(s.narration)
    : splitNarrationText(wholeText);
  const cues = Array(stepList.length).fill('');
  if (!textParts.length) return cues;
  // Title-family steps score on the positional prior only: a title previews
  // the whole scene, so narration overlapping the title text is not evidence
  // the sentence belongs at the title reveal — matching it there would drag
  // every earlier sentence onto the title (monotonicity) and leave the
  // content reveals silent.
  const TITLE_STEP = /(?:^|_)title$|^scene_header$|^narrative_eyebrow$/;
  const stepTexts = stepList.map(step => (TITLE_STEP.test(step) ? '' : stepContentText(s, step)));
  const assign = stepTexts.some(t => t.trim())
    ? alignSentencesToSteps(textParts, stepTexts)
    : textParts.map((_, i) => Math.min(stepList.length - 1, Math.floor((i * stepList.length) / textParts.length)));
  textParts.forEach((part, i) => {
    const idx = assign[i];
    cues[idx] = cues[idx] ? `${cues[idx]}\n${part}` : part;
  });
  return cues;
}

export function timedNarrationCues(scene, chapters = []) {
  const n = scene && scene.narration;
  if (typeof n === 'string') {
    const text = n.trim();
    return text ? [{ key: 'scene', at: 0, text }] : [];
  }
  if (!Array.isArray(n)) return [];
  return n
    .map((cue, i) => {
      const text = cue && typeof cue.text === 'string' ? cue.text.trim() : '';
      if (!text) return null;
      const at = cue.chapter ? chapterStartSeconds(chapters, cue.chapter) : Math.max(0, Number(cue.at || 0));
      return { key: String(cue.id || cue.chapter || i), at: Number.isFinite(at) ? at : 0, text };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

export function audioUrlFromBase64(audioBase64, mime = 'audio/mpeg') {
  const raw = atob(String(audioBase64 || ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
}
