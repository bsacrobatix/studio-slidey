---
name: slidey-debug
description: Debug Slidey render, layout, CLI, MCP, browser, rrweb/video, PDF/PNG/MP4, and deck-output failures. Use when Codex needs to diagnose a broken or ugly Slidey deck, bad scene layout, render/audit/check failure, stale render bundle, Puppeteer/browser issue, MCP slidey tool problem, timing/narration overrun, or mismatch between viewer and exported output.
---

# Slidey Debug

Use this skill to debug existing Slidey behavior. For creating or substantially rewriting a deck, use `slidey-authoring` first; return here when the question is why a deck, render, CLI command, viewer, or MCP tool behaves badly.

## Ground rules

- Do not render a full MP4 just to debug. Use `--list`, `--estimate`, `--check`, `--audit`, PNG scene renders, or PDF exports first.
- Do not run concurrent Slidey renders. Puppeteer and output-file writes can interfere with each other.
- Put transient outputs under `.artifacts/slidey-debug/<short-name>/` unless the user asks for a committed artifact.
- Preserve unrelated deck/source edits. Slidey decks are often being edited in parallel.
- Treat `dist-render/render.html` as generated. Rebuild it with `npm run build:render`; do not hand-edit it.
- Keep tests and demos no-LLM. Slidey rendering is deterministic and should not require live model calls.

## First diagnostic choice

Pick the cheapest command that answers the failure mode:

| Symptom | First command | What it tells you |
|---|---|---|
| Need scene number or duration | `node src/index.js spec.slidey.json --list` | Scene indices, types, start times, durations. |
| Narration may overrun | `node src/index.js spec.slidey.json --estimate` | Audio budget warnings without rendering. |
| `diagram-svg` node sizing/overlap | `node src/index.js spec.slidey.json out.mp4 --check` | Static geometry violations, no Chrome. |
| Visual/layout issue | `node src/index.js spec.slidey.json .artifacts/slidey-debug/<name> --scenes N` | PNG frames for direct visual inspection. |
| Real browser layout issue | `node src/index.js spec.slidey.json out.mp4 --scenes N --audit .artifacts/slidey-debug/<name>/audit.json` | Rendered geometry, overflow, tiny text, template leaks. |
| Blank/stale/broken export | `npm run build:render` then rerun the scoped PNG/PDF | Rebuilds the Vue render bundle. |
| Chrome/Puppeteer failure | `node src/index.js doctor` | Browser launch and screenshot health. |
| Schema uncertainty | `node src/index.js --schema` | Current spec schema. |

Use an output directory for PNG spot checks. Use PDF for sequence review. Use MP4 only for final timing/video/audio issues after layout is already understood.

## Source routing

Read only the files tied to the observed symptom:

- CLI argument parsing, install commands, output-mode selection: `src/index.js`.
- Render orchestration, scene dispatch, frame generation: `src/renderer.js` and the matching `src/scenes/<type>.js`.
- Timing, reveal counts, `--list`, `--estimate`: `src/timing.js`.
- Static spec/schema validation: `src/schema.js` and `src/validate.js`.
- Diagram static checks: `src/check.js`.
- Browser audit findings: `src/audit.js` plus the rendered Vue component.
- Viewer/render visual mismatch: `web/components/DeckHost.vue`, `web/sceneSteps.mjs`, `web/store.js`, and `web/components/<Name>Scene.vue`.
- HTML/PDF/PNG/MP4 media path issues: `src/video.js`, `src/overlay-render.js`, `src/rrweb-render.js`, or `src/tour/` depending on the source type.
- MCP tool failures: `src/mcp.js` and the exact tool handler branch.
- VS Code preview issues: `tools/vscode-slidey/` after confirming the CLI viewer path works.

If the deck itself is the likely bug, inspect only the affected scene and nearby `meta` fields. Common deck-level causes include missing `meta.mode: "pitch"`, wrong relative asset paths, overpacked diagram coordinates, long unwrapped node labels, and narration longer than scene duration.

## Debugging workflow

1. Capture the exact command, deck path, scene index, error text, and output format.
2. Run the cheapest diagnostic from the table. Prefer no-render commands before Chrome.
3. If visual, render only the affected scene to PNG and inspect the last reveal frame first.
4. Map the symptom to the smallest source surface using Source routing.
5. Make the smallest fix in source or deck JSON. Avoid changing generated assets by hand.
6. Re-run only the diagnostic that failed or the scoped PNG/audit needed to inspect the fix.
7. If the fix changes `web/`, rebuild the render bundle before export-oriented checks.

## Layout triage notes

- `diagram-svg` auto-layout is the default safe path. Hand-authored `x/y/w/h` coordinates require `--check` and a PNG review because boxes can grow without moving neighbors.
- A title pushed to the top or clipped caption usually means the scene content exceeds the available stage height.
- Edge labels clip at the SVG viewBox boundary. Shorten labels or move explanatory text into the caption.
- For bad cycle/process diagrams, first reduce node count or spread the viewBox before tweaking fonts.
- For tables and cards, prefer fewer rows per scene over shrinking text until it becomes unreadable.

## MCP-specific checks

- Prefer reproducing with `node src/index.js ...` first. If the CLI fails, MCP is not the root cause.
- If only MCP fails, inspect the relevant `src/mcp.js` handler and compare its args with the CLI command that works.
- For `slidey_docs`, remember the content comes from `.claude/skills/slidey-authoring/SKILL.md`, with YAML frontmatter stripped.

## Reporting

When handing back a diagnosis, include:

- The failing command or scene index.
- The root cause in deck/source terms.
- The file(s) changed or recommended.
- The cheapest successful check or remaining check to run.
