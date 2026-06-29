// SLIDEY — meme template geometry (browser/bundle side)
//
// The render + web bundles need each meme template's caption-box geometry and
// orientation to lay captions over the blank image. We bundle the vendored
// registry (data/meme-templates.json, built by scripts/build-meme-registry.js)
// and expose a tiny id → geometry lookup. This is the browser-side mirror of
// src/memes/registry.js (which the Node render pipeline uses).

// Import attribute is required for JSON in Node ESM (sceneSteps.mjs is dynamically
// imported from Node by src/pdf.js); vite/rollup honor it too when bundling.
import registry from '../data/meme-templates.json' with { type: 'json' };
import custom from '../data/meme-templates.custom.json' with { type: 'json' };

const BY_ID = new Map((registry.templates || []).map(t => [t.id, t]));
// Curated extras (templates not in memegen) override/extend the generated set.
for (const t of (custom.templates || [])) BY_ID.set(t.id, t);

export function getMemeTemplate(id) {
  if (!id) return null;
  // Forgiving lookup: try the exact lowercased key, then a canonicalized form
  // (spaces/underscores → hyphens) so "clown makeup" resolves to "clown-makeup".
  const lower = String(id).toLowerCase().trim();
  return BY_ID.get(lower) || BY_ID.get(lower.replace(/[\s_]+/g, '-')) || null;
}
