/**
 * SLIDEY — Objectives scene
 *
 * Status-forward report layout for objective tracking. Each row gets a large
 * visual status glyph so DONE / ISSUE / NEXT state is readable before the text.
 *
 * Spec:
 *   {
 *     "type": "objectives",
 *     "title": "Objective status",
 *     "items": [
 *       { "label": "Harness objective", "status": "done", "detail": "..." },
 *       { "label": "HTML preview", "status": "issue", "detail": "..." }
 *     ],
 *     "caption": "Core harness complete; preview still blocked.",
 *     "hold": 220
 *   }
 *
 * Reveal order: title → one step per objective → caption.
 */

'use strict';

const TIMING = require('../timing');

const MAX_ITEMS = 6;

async function render(page, scene, ctx) {
  await page.evaluate(s => window.slidey.showObjectives(s), scene);
  if (scene.title) await ctx.setState('objectives_title');
  const items = (scene.items || []).slice(0, MAX_ITEMS);
  for (let i = 0; i < items.length; i++) {
    await ctx.setState(`objectives_item_${i}`);
  }
  if (scene.caption) await ctx.setState('objectives_caption');
  await ctx.hold(scene.hold ?? TIMING.objectives_hold ?? TIMING.cards_hold, 'objectives_hold');
  await page.evaluate(() => window.slidey.hideObjectives());
  await ctx.hold(TIMING.inter_scene, 'inter_scene');
}

module.exports = { render, MAX_ITEMS };
