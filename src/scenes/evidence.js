/**
 * SLIDEY — Evidence scene
 *
 * Status-forward ledger for report artifacts, checks, commands, and proof
 * paths. Use when a generic table would bury the state in text columns.
 *
 * Spec:
 *   {
 *     "type": "evidence",
 *     "title": "Latest check state",
 *     "items": [
 *       { "label": "PostgreSQL", "status": "validated",
 *         "detail": "baseline red / fix green",
 *         "refType": "command", "ref": "bash tools/check.sh" }
 *     ]
 *   }
 *
 * Reveal order: title → one step per evidence row → caption.
 */

'use strict';

const TIMING = require('../timing');

const MAX_ITEMS = 6;

async function render(page, scene, ctx) {
  await page.evaluate(s => window.slidey.showEvidence(s), scene);
  if (scene.title) await ctx.setState('evidence_title');
  const items = (scene.items || []).slice(0, MAX_ITEMS);
  for (let i = 0; i < items.length; i++) {
    await ctx.setState(`evidence_item_${i}`);
  }
  if (scene.caption) await ctx.setState('evidence_caption');
  await ctx.hold(scene.hold ?? TIMING.evidence_hold ?? TIMING.cards_hold, 'evidence_hold');
  await page.evaluate(() => window.slidey.hideEvidence());
  await ctx.hold(TIMING.inter_scene, 'inter_scene');
}

module.exports = { render, MAX_ITEMS };
