// embed-annotate — slidey's producer side of the generic embed annotation
// protocol. When an embedding host (e.g. a kitsoki annotation surface) turns on
// annotation mode, the LIVE deck — which owns its own DOM — lets the operator
// point at a real element on the slide on screen and posts a precise anchor back:
//
//   host → deck:  { type: 'embed:annotate', enabled: boolean }
//   deck → host:  { type: 'embed:pick', producer:'slidey', scope, ref, label, bbox }
//
// `ref` is the opaque element id `<sceneIndex>/<field>` the host round-trips into
// a refine; `scope` is the scene index; `bbox` is the element's on-screen rect.
// The host needs NO slidey knowledge — slidey owns the element model here, in one
// place, keyed off the deck's existing stable element ids (no per-component tags).

// Scene type → the editable elements on that slide. `field` is the spec field a
// reviser edits; the emitted ref is `<sceneIndex>/<field>`. `selector` locates the
// rendered node; `selectorAll` + `fieldPattern` handle repeated elements (cards).
export const SCENE_ELEMENTS = {
  title: [
    { field: 'eyebrow', selector: '#title-card-eyebrow', label: 'eyebrow' },
    { field: 'title', selector: '#title-card-title', label: 'title' },
    { field: 'subtitle', selector: '#title-card-subtitle', label: 'subtitle' },
  ],
  narrative: [
    { field: 'eyebrow', selector: '#narrative-eyebrow', label: 'eyebrow' },
    { field: 'lede', selector: '#narrative-lede', label: 'lede' },
    { field: 'body', selector: '#narrative-body', label: 'body' },
  ],
  image: [
    { field: 'title', selector: '#image-title', label: 'title' },
    { field: 'src', selector: '#image-frame', label: 'image' },
    { field: 'caption', selector: '#image-caption', label: 'caption' },
  ],
  book: [
    { field: 'title', selector: '#book-title', label: 'title' },
    { field: 'caption', selector: '#book-caption', label: 'caption' },
  ],
  'diagram-svg': [
    { field: 'title', selector: '#diagramsvg-title', label: 'title' },
    { field: 'caption', selector: '#diagramsvg-caption', label: 'caption' },
  ],
  cards: [
    { field: 'title', selector: '#cards-title', label: 'title' },
    { fieldPattern: 'card_', selectorAll: '.cards-card', label: 'card' },
  ],
};

export function sceneElements(sceneType) {
  return SCENE_ELEMENTS[sceneType] || [];
}

function toTarget(node, ref, label) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null;
  const r = node.getBoundingClientRect();
  return { ref, label, bbox: [r.x, r.y, r.width, r.height] };
}

// buildPickTargets queries the live deck DOM for the current scene's editable
// elements and returns {ref, label, bbox} for each one present. Missing elements
// (an optional caption a slide omits) are skipped.
export function buildPickTargets(root, sceneType, sceneIndex) {
  const out = [];
  for (const el of sceneElements(sceneType)) {
    if (el.selectorAll) {
      const nodes = root.querySelectorAll(el.selectorAll);
      let i = 0;
      nodes.forEach((node) => {
        const t = toTarget(node, `${sceneIndex}/${el.fieldPattern}${i}`, `${el.label} ${i}`);
        if (t) out.push(t);
        i += 1;
      });
    } else {
      const node = root.querySelector(el.selector);
      const t = toTarget(node, `${sceneIndex}/${el.field}`, el.label);
      if (t) out.push(t);
    }
  }
  return out;
}

// installEmbedAnnotate wires the producer side to the window. ctx supplies live
// accessors (getRoot/getSceneType/getSceneIndex) so the controller always reads
// the CURRENT slide. Returns a teardown function.
//
// Browser-only effects (the marker overlay) are isolated behind `doc`/`win`
// (injectable for tests). The pure target math lives in buildPickTargets above.
export function installEmbedAnnotate(ctx, win, doc) {
  win = win || (typeof window !== 'undefined' ? window : undefined);
  doc = doc || (typeof document !== 'undefined' ? document : undefined);
  if (!win || !doc) return () => {};

  let overlay = null;

  function clearOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function postPick(t) {
    const payload = {
      type: 'embed:pick',
      producer: 'slidey',
      scope: String(ctx.getSceneIndex()),
      ref: t.ref,
      label: t.label,
      bbox: t.bbox,
    };
    try { win.parent.postMessage(payload, '*'); } catch (_) { /* no parent */ }
  }

  function renderOverlay() {
    clearOverlay();
    const root = ctx.getRoot();
    if (!root) return;
    const targets = buildPickTargets(root, ctx.getSceneType(), ctx.getSceneIndex());
    overlay = doc.createElement('div');
    overlay.setAttribute('data-slidey-annotate', '1');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    for (const t of targets) {
      const [x, y, w, h] = t.bbox;
      const marker = doc.createElement('button');
      marker.type = 'button';
      marker.setAttribute('data-slidey-el', t.ref);
      marker.title = t.label;
      marker.style.cssText =
        `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        'pointer-events:auto;cursor:pointer;background:rgba(56,189,248,0.18);' +
        'border:2px solid rgba(56,189,248,0.9);border-radius:6px;padding:0;';
      marker.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); postPick(t); });
      overlay.appendChild(marker);
    }
    doc.body.appendChild(overlay);
  }

  function onMessage(ev) {
    const d = ev && ev.data;
    if (!d || d.type !== 'embed:annotate') return;
    if (d.enabled) renderOverlay();
    else clearOverlay();
  }

  win.addEventListener('message', onMessage);
  return () => { win.removeEventListener('message', onMessage); clearOverlay(); };
}
