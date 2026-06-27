// inline-edit — click-to-edit text directly on the slide in edit mode.
//
// Any rendered element tagged with `data-edit-path` (a JSON array, scene-relative,
// e.g. '["panels",0,"nodes",1,"label"]') becomes editable when the viewer is in
// edit mode. Committing reuses the SAME write path as the side form: mutate the
// in-memory spec via setByPath, re-render the deck, and mark the spec dirty — so
// the existing Save button persists the change. Nothing about saving changes.
//
// Two editing surfaces, picked by element type:
//   • SVG <text> (diagram node/edge labels): SVG text isn't reliably
//     contentEditable, so we overlay a positioned <input>/<textarea> matched to
//     the text's font, commit, then let the deck re-render (which re-runs the
//     diagram's two-pass auto-sizing).
//   • Everything else (HTML titles, ledes, captions, …): make the element itself
//     contentEditable in place.
//
// Enter commits (Shift+Enter inserts a newline in multiline fields); Esc cancels;
// blur commits. The pure spec mutation lives in spec-paths.js.

import { getByPath, setByPath, coerceValue } from './spec-paths.js';

function parsePath(raw) {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : null;
  } catch (_) { return null; }
}

function isSvgText(el) {
  return el && el.namespaceURI === 'http://www.w3.org/2000/svg' && el.tagName.toLowerCase() === 'text';
}

// installInlineEdit wires the document-level click handler. ctx supplies live
// accessors so we always read/write the CURRENT spec + scene:
//   ctx.isActive()      → editing allowed right now (edit mode AND a saveable spec)
//   ctx.getSpec()       → the reactive spec object to mutate
//   ctx.getSceneIndex() → index of the on-screen scene (paths are scene-relative)
//   ctx.render()        → re-render the deck (async); returns a promise
//   ctx.markDirty()     → flag the spec as having unsaved edits
// Returns a teardown function. Browser globals are injectable for tests.
export function installInlineEdit(ctx, win, doc) {
  win = win || (typeof window !== 'undefined' ? window : undefined);
  doc = doc || (typeof document !== 'undefined' ? document : undefined);
  if (!win || !doc) return () => {};

  let active = null; // { el, path, restore, cleanup } — the field being edited

  function resolve(el) {
    const host = el.closest && el.closest('[data-edit-path]');
    if (!host) return null;
    const rel = parsePath(host.getAttribute('data-edit-path'));
    if (!rel) return null;
    const path = ['scenes', ctx.getSceneIndex(), ...rel];
    const value = getByPath(ctx.getSpec(), path);
    // Only plain scalar text/number fields are inline-editable; structural fields
    // stay in the side form.
    if (value != null && typeof value !== 'string' && typeof value !== 'number') return null;
    const multiline = host.hasAttribute('data-edit-multiline')
      || (typeof value === 'string' && value.includes('\n'));
    const kind = typeof value === 'number' ? 'number' : 'string';
    return { host, path, value: value == null ? '' : String(value), multiline, kind };
  }

  async function commit(raw) {
    const a = active;
    if (!a) return;
    teardownEditor();
    const next = coerceValue(raw, a.kind);
    if (next === a.original) return; // no-op edit — don't dirty the spec
    setByPath(ctx.getSpec(), a.path, next);
    try { await ctx.render(); } catch (_) { /* invalid edit — deck keeps last good render */ }
    ctx.markDirty();
  }

  function cancel() { teardownEditor(); }

  function teardownEditor() {
    if (!active) return;
    if (active.cleanup) active.cleanup();
    active = null;
  }

  // ── HTML: edit the element in place via contentEditable ───────────────────
  function editHtml(host, info) {
    host.setAttribute('contenteditable', 'plaintext-only');
    host.classList.add('slidey-inline-editing');
    host.focus();
    selectAll(host);
    const onKey = (e) => {
      if (e.key === 'Enter' && !(info.multiline && e.shiftKey)) { e.preventDefault(); commit(host.textContent); }
      else if (e.key === 'Escape') { e.preventDefault(); host.textContent = info.value; cancel(); }
    };
    const onBlur = () => commit(host.textContent);
    host.addEventListener('keydown', onKey);
    host.addEventListener('blur', onBlur, { once: true });
    active = {
      host, path: info.path, kind: info.kind, original: info.value,
      cleanup() {
        host.removeAttribute('contenteditable');
        host.classList.remove('slidey-inline-editing');
        host.removeEventListener('keydown', onKey);
        host.removeEventListener('blur', onBlur);
      },
    };
  }

  // ── SVG <text>: overlay a positioned input matched to the text's font ─────
  function editSvgText(host, info) {
    const r = host.getBoundingClientRect();
    const cs = win.getComputedStyle(host);
    const field = doc.createElement(info.multiline ? 'textarea' : 'input');
    field.value = info.value;
    field.className = 'slidey-inline-svg-input';
    const pad = 6;
    field.style.cssText = [
      'position:fixed', `left:${Math.round(r.left - pad)}px`, `top:${Math.round(r.top - pad)}px`,
      `min-width:${Math.max(40, Math.round(r.width) + pad * 2)}px`,
      `font:${cs.font}`, `color:${cs.fill || cs.color}`,
      'text-align:center', 'z-index:2147483647',
    ].join(';');
    doc.body.appendChild(field);
    host.classList.add('slidey-inline-editing');
    field.focus();
    field.select();
    const onKey = (e) => {
      if (e.key === 'Enter' && !(info.multiline && e.shiftKey)) { e.preventDefault(); commit(field.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    const onBlur = () => commit(field.value);
    field.addEventListener('keydown', onKey);
    field.addEventListener('blur', onBlur, { once: true });
    active = {
      host, path: info.path, kind: info.kind, original: info.value,
      cleanup() {
        host.classList.remove('slidey-inline-editing');
        field.removeEventListener('blur', onBlur);
        if (field.parentNode) field.parentNode.removeChild(field);
      },
    };
  }

  function selectAll(el) {
    try {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = win.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) { /* selection is best-effort */ }
  }

  function onClick(e) {
    if (!ctx.isActive()) return;
    // A click outside the active field commits it (blur handles that); ignore.
    if (active && (e.target === active.host || (active.host.contains && active.host.contains(e.target)))) return;
    const info = resolve(e.target);
    if (!info) return;
    e.preventDefault();
    e.stopPropagation();
    if (active) teardownEditor();
    if (isSvgText(info.host)) editSvgText(info.host, info);
    else editHtml(info.host, info);
  }

  win.addEventListener('click', onClick, true);
  return () => {
    teardownEditor();
    win.removeEventListener('click', onClick, true);
  };
}
