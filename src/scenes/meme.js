/**
 * SLIDEY — Meme scene
 *
 * Renders a meme-template slide. The template id (scene.template) resolves to a
 * registry entry that carries the blank image URL plus per-box geometry and
 * semantic field names. The blank image is fetched + cached (src/memes/cache.js)
 * and inlined as a data URI so the render is deterministic and self-contained.
 *
 * Captions reveal one box at a time so a multi-panel meme (Drake, Distracted
 * Boyfriend, Expanding Brain) builds up like any other slidey scene.
 */
'use strict';

const TIMING = require('../timing');
const registry = require('../memes/registry');
const { memeImageDataUri } = require('../memes/cache');

// How many caption boxes actually have text (so reveal steps match content).
function filledBoxes(scene, template) {
  const boxes = (template && template.boxes) || [];
  return boxes.filter((b, i) => captionFor(scene, b, i) !== '');
}

function captionFor(scene, box, i) {
  if (scene.fields && box.field in scene.fields) return String(scene.fields[box.field] ?? '');
  if (Array.isArray(scene.text) && scene.text[i] != null) return String(scene.text[i]);
  return '';
}

async function render(page, scene, ctx) {
  const template = registry.get(scene.template);
  const dataUri = template ? await memeImageDataUri(template) : '';

  await page.evaluate((s, uri) => window.slidey.showMeme(s, uri), scene, dataUri);

  if (scene.title) await ctx.setState('meme_title');
  await ctx.setState('meme_frame');
  const n = filledBoxes(scene, template).length;
  for (let i = 0; i < n; i++) await ctx.setState(`meme_box_${i}`);
  if (scene.caption) await ctx.setState('meme_caption');

  await ctx.hold(scene.hold ?? TIMING.meme_hold ?? TIMING.image_hold, 'meme_hold');
  await page.evaluate(() => window.slidey.hideMeme());
  await ctx.hold(TIMING.inter_scene, 'inter_scene');
}

module.exports = { render, filledBoxes, captionFor };
