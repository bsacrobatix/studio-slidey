/**
 * SLIDEY — Personas / use-cases scene
 *
 * Introduces a shared cast of personas (each with a stylized avatar) and
 * attributes use-case actions to them, so a viewer can see "who is doing what"
 * with a consistent avatar identity in every place a persona appears. The cast
 * is resolved by id from `meta.personas` (the deck-wide registry); a scene may
 * also carry inline persona objects.
 *
 * Variants (scene.variant):
 *   cast       — a card per persona: avatar + name + role + one-line intro.
 *   use-cases  — action rows, each attributed to a persona via `who: <id>`,
 *                with that persona's avatar shown inline.
 *
 * Spec:
 *   Deck registry (meta.personas):
 *     [{ "id": "pm", "name": "Priya", "role": "Product manager",
 *        "intro": "Turns an idea into a validated PRD.",
 *        "color": "#58a6ff", "glyph": "🧭" }, ...]
 *
 *   Cast scene:
 *   { "type": "personas", "variant": "cast",
 *     "title": "The cast",
 *     "personas": ["pm", "architect", "dev"],   // ids into meta.personas
 *     "caption": "...", "hold": 220 }
 *
 *   Use-cases scene:
 *   { "type": "personas", "variant": "use-cases",
 *     "title": "Design → work plan",
 *     "cases": [
 *       { "who": "dev", "action": "Decompose the design epic into tasks",
 *         "detail": "right-sized, agent-ready briefs" }, ...
 *     ],
 *     "caption": "...", "hold": 220 }
 *
 * Reveal order: title, one step per item (persona card / use-case row), caption.
 * Step base-names match stepsForScene() in web/sceneSteps.mjs.
 */

'use strict';

const TIMING = require('../timing');

function itemCount(scene) {
  return (scene.variant === 'use-cases' ? (scene.cases || []) : (scene.personas || [])).length;
}

async function render(page, scene, ctx) {
  await page.evaluate(s => window.slidey.showPersonas(s), scene);
  if (scene.title) await ctx.setState('personas_title');
  const n = itemCount(scene);
  for (let i = 0; i < n; i++) {
    await ctx.setState(`personas_item_${i}`);
  }
  if (scene.caption) await ctx.setState('personas_caption');
  await ctx.hold(scene.hold ?? TIMING.cards_hold ?? TIMING.thread_hold, 'personas_hold');
  await page.evaluate(() => window.slidey.hidePersonas());
  await ctx.hold(TIMING.inter_scene, 'inter_scene');
}

module.exports = { render, itemCount };
