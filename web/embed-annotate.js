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
// The host needs NO slidey knowledge — slidey owns the element model here.
//
// Fidelity: rather than a hand-maintained per-scene-type element map (which only
// ever covered a handful of the ~20 scene types and drifted from the templates),
// we discover pickable blocks straight from the LIVE layout the deck rendered:
// every REVEALED `.reveal` block under the active scene region. Those blocks ARE
// the deck's own structural / animation units, so coverage tracks the templates
// automatically — every scene type, every meaningful block, and it follows the
// in-scene reveal transitions (a block becomes pickable exactly when it appears).
// A template can override the derived field/label per block with the optional
// `data-embed-field` / `data-embed-label` attributes when the id-derived value
// isn't the spec field (e.g. the image frame edits `src`).

// The candidate addressable blocks: a revealed `.reveal` block with a stable id,
// OR any element a template explicitly tagged `data-embed-field` (e.g. the title
// card, which renders as a `.hidden`-toggled overlay OUTSIDE a scene region and so
// has no reveal class). We do NOT scope to `.scene-region.active`: an inactive
// scene region and a hidden title card are both `display:none`, so their blocks
// measure zero and the area filter in toTarget() drops them — leaving exactly the
// blocks visible on the slide on screen. Unrevealed (`.reveal` without `.shown`)
// blocks are excluded too — you can only point at what you can see.
const PICK_SELECTOR = '.reveal.shown[id], [data-embed-field]';

function attr(node, name) {
  return node && typeof node.getAttribute === 'function' ? node.getAttribute(name) : null;
}

// Derive the spec field from the element id by dropping the scene-type prefix
// (the first hyphen-delimited segment): `image-title`→`title`, `narrative-lede`→
// `lede`, `cards-item-0`→`item-0`, `cards-caption`→`caption`.
function idToField(id) {
  const i = id.indexOf('-');
  return i >= 0 ? id.slice(i + 1) : id;
}

// A short human label for a block — its own visible text (what the operator sees),
// falling back to the field name when the block has no text (e.g. an image frame).
function textSnippet(node) {
  const t = (node && typeof node.textContent === 'string' ? node.textContent : '').trim();
  if (!t) return '';
  const flat = t.replace(/\s+/g, ' ');
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

function toTarget(node, sceneIndex) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null;
  const r = node.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return null; // not laid out / collapsed
  const field = attr(node, 'data-embed-field') || idToField(node.id || '');
  const label = attr(node, 'data-embed-label') || textSnippet(node) || field;
  return { ref: `${sceneIndex}/${field}`, label, bbox: [r.x, r.y, r.width, r.height] };
}

// buildPickTargets returns {ref, label, bbox} for every revealed, on-screen block
// of the slide currently on screen — discovered from the rendered layout, so it
// needs no per-scene-type knowledge and stays in lock-step with the templates.
export function buildPickTargets(root, sceneIndex) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const out = [];
  root.querySelectorAll(PICK_SELECTOR).forEach((node) => {
    const t = toTarget(node, sceneIndex);
    if (t) out.push(t);
  });
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
  let enabled = false;

  function clearOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  // Rebuild on the next frame so a just-navigated scene has painted its new
  // elements before we measure them (the deck re-renders the DOM async). Without
  // this the markers stay pinned to the slide that was on screen when annotation
  // mode turned on.
  function scheduleRender() {
    if (!enabled) return;
    const raf = win.requestAnimationFrame
      ? win.requestAnimationFrame.bind(win)
      : (fn) => setTimeout(fn, 16);
    raf(() => { if (enabled) renderOverlay(); });
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
    const targets = buildPickTargets(root, ctx.getSceneIndex());
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
    enabled = !!d.enabled;
    if (enabled) renderOverlay();
    else clearOverlay();
  }

  // While annotation mode is on, rebuild the markers when the deck advances to a
  // new slide (so the clickable areas follow the slide on screen) and when the
  // viewport resizes (the measured bboxes shift).
  function onSceneChanged() { scheduleRender(); }
  function onResize() { scheduleRender(); }

  win.addEventListener('message', onMessage);
  win.addEventListener('slidey:scene-changed', onSceneChanged);
  win.addEventListener('resize', onResize);
  return () => {
    win.removeEventListener('message', onMessage);
    win.removeEventListener('slidey:scene-changed', onSceneChanged);
    win.removeEventListener('resize', onResize);
    clearOverlay();
  };
}
