/**
 * SLIDEY - Cytoscape graph scene
 *
 * Declarative graph viewer. The first reveal shows the graph, then each
 * graph_focus_<n> reveal moves the Cytoscape camera to the next focus node.
 */

'use strict';

const TIMING = require('../timing');

function focusPath(scene) {
  const path = Array.isArray(scene.path) && scene.path.length
    ? scene.path
    : (Array.isArray(scene.focus) ? scene.focus : []);
  return path.map(entry => typeof entry === 'string' ? { node: entry } : entry).filter(entry => entry && entry.node);
}

async function render(page, scene, ctx) {
  await page.evaluate(s => window.slidey.showGraph(s), scene);
  if (scene.title) await ctx.setState('graph_title');
  await ctx.setState('graph_frame');
  const path = focusPath(scene);
  for (let i = 0; i < path.length; i++) {
    await ctx.setState(`graph_focus_${i}`);
  }
  if (scene.caption) await ctx.setState('graph_caption');
  await ctx.hold(scene.hold ?? TIMING.graph_hold, 'graph_hold');
  await page.evaluate(() => window.slidey.hideGraph());
  await ctx.hold(TIMING.inter_scene, 'inter_scene');
}

module.exports = { render };
