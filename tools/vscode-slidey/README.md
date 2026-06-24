# Slidey VS Code Extension

Preview Slidey `.slidey.json` and `.jsonl` presentations in a VS Code webview
editor tab using the same built web viewer that `slidey <file>` serves in a
browser. Plain `.json` specs can also be opened explicitly with the command; the
Explorer and editor-title menus only auto-surface for `.slidey.json` decks and
`.jsonl` traces so ordinary JSON files do not clutter the UI.

## Use

Install the extension into local VS Code from the repo root:

```sh
make vscode-install-local
```

Then open a spec and run `Slidey: Preview Presentation`, or use the editor title
or Explorer context menu on a `.slidey.json` / `.jsonl` file.

The preview opens beside the JSON file and is intentionally read-only. It embeds
the Slidey viewer in single-file mode, hides the workspace file tree, serves spec
and asset reads through the VS Code webview bridge, and reloads from disk when the
source file changes. Edit the JSON in VS Code; use the preview to step through the
deck with the normal Slidey HUD and navigation.

The preview supports the same scene/runtime surface as the web viewer, including:

- `.slidey.json` specs and generated `.jsonl` trace decks.
- Local image assets resolved relative to the spec.
- Mermaid scenes rendered as themed SVG.
- `video` scenes that reference MP4 or rrweb sources, including the live rrweb
  player in the interactive viewer.

## Development

Build the viewer bundle before launching the extension:

```sh
npm run build:web
code --extensionDevelopmentPath=tools/vscode-slidey .
```

## Test

```sh
npm run test:vscode
```

The e2e test rebuilds the web viewer, mounts the extension-generated webview HTML,
bridges the preview API, and verifies that `examples/hello.slidey.json` renders with the
interactive Slidey HUD.

## Package and Install

`make vscode-install-local` is the normal local refresh command. It:

1. Runs `npm run build:web`.
2. Stages `dist/` into `.slidey-dist`.
3. Stages the small runtime modules needed by the preview API into
   `.slidey-runtime`.
4. Packages `slidey-vscode-<version>.vsix`.
5. Installs the newest VSIX with `code --install-extension --force`.

Use `CODE_CLI=/path/to/code-compatible-cli` to install into a different editor:

```sh
make vscode-install-local CODE_CLI=/path/to/code-compatible-cli
```

`make vscode-package` builds the VSIX without installing it. `make vscode-clean`
removes staged viewer/runtime assets and generated VSIX files.
