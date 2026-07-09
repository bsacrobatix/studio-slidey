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

export function speechTextForScene(scene) {
  return collectText(scene && scene.narration).join('\n').trim();
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
