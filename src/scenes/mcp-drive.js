/**
 * SLIDEY — MCP drive scene
 *
 * Shows a Claude Code-style operator prompt, the MCP tools the driver invokes,
 * and the resulting outcome in one reusable terminal-like layout.
 *
 * Spec:
 *   {
 *     "type": "mcp-drive",
 *     "title": "Planning",
 *     "agent": "kitsoki-mcp-drive",
 *     "story": "stories/kitsoki-dev/app.yaml",
 *     "prompt": "use kitsoki-mcp-drive agent to ...",
 *     "calls": [
 *       { "tool": "session.new", "args": "{ story_path: ... }", "result": "handle=plan-42" }
 *     ],
 *     "outcome": {
 *       "status": "proposal ready",
 *       "lines": ["plan artifact saved", "next gate waits for approval"]
 *     }
 *   }
 *
 * Reveal order: prompt chrome → calls → outcome.
 */

'use strict';

const TIMING = require('../timing');

async function render(page, scene, ctx) {
  await page.evaluate(s => window.slidey.showMcpDrive(s), scene);
  await ctx.setState('mcpdrive_prompt');
  if ((scene.calls || []).length) await ctx.setState('mcpdrive_calls');
  if (scene.outcome) await ctx.setState('mcpdrive_outcome');
  if (scene.caption) await ctx.setState('mcpdrive_caption');
  await ctx.hold(scene.hold ?? TIMING.mcpdrive_hold ?? TIMING.code_hold, 'mcpdrive_hold');
  await page.evaluate(() => window.slidey.hideMcpDrive());
  await ctx.hold(TIMING.inter_scene, 'inter_scene');
}

module.exports = { render };
