#!/usr/bin/env node
/**
 * SLIDEY — Meme gallery QA deck generator
 *
 * Emits examples/meme-gallery-all.slidey.json: one `meme` scene per registry
 * template (memegen catalog + curated extras), seeded with each template's
 * example captions so every caption box is exercised. Use it to eyeball box
 * placement / legibility / orientation handling across the whole catalog.
 *
 *   node scripts/build-meme-gallery-deck.js
 *   # then render/QA, e.g. a few scenes:
 *   node -e "..."  OR the slidey-visual-qa agent
 */
'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('../src/memes/registry');

const OUT = path.resolve(__dirname, '../examples/meme-gallery-all.slidey.json');

// Seed every box: prefer the template's example caption, then the box hint, then
// the field name — so an empty example never leaves a box untestable.
function seedText(t) {
  return t.boxes.map((b, i) => {
    const ex = (t.example || [])[i];
    return (ex && ex.trim()) || b.hint || b.field;
  });
}

const templates = registry.list()
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name));

const scenes = templates.map(t => ({
  type: 'meme',
  template: t.id,
  title: `${t.name}  ·  ${t.id}  ·  ${t.orientation} ${t.width}×${t.height} · ${t.boxes.length} box`,
  text: seedText(t),
  caption: (t.keywords && t.keywords.length) ? `keywords: ${t.keywords.slice(0, 6).join(', ')}` : undefined,
  hold: 1,
}));

const deck = {
  meta: {
    title: `Meme gallery — all ${scenes.length} templates`,
    mode: 'pitch',
  },
  scenes,
};

fs.writeFileSync(OUT, JSON.stringify(deck, null, 2) + '\n');
process.stderr.write(`Wrote ${scenes.length} meme scenes → ${OUT}\n`);
const byOri = templates.reduce((m, t) => (m[t.orientation] = (m[t.orientation] || 0) + 1, m), {});
process.stderr.write(`Orientation mix: ${JSON.stringify(byOri)}\n`);
