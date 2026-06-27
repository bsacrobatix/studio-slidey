'use strict';

const fs = require('fs');
const path = require('path');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const CHECKOUT_ROOT = path.resolve(__dirname, '..', '..', '..');
const PACKAGED_DIST_DIR = path.join(EXTENSION_ROOT, '.slidey-dist');
const PACKAGED_RUNTIME_DIR = path.join(EXTENSION_ROOT, '.slidey-runtime', 'src');
const DIST_DIR = fs.existsSync(path.join(PACKAGED_DIST_DIR, 'index.html'))
  ? PACKAGED_DIST_DIR
  : path.join(CHECKOUT_ROOT, 'dist');
const RUNTIME_SRC_DIR = fs.existsSync(path.join(PACKAGED_RUNTIME_DIR, 'schema.js'))
  ? PACKAGED_RUNTIME_DIR
  : path.join(CHECKOUT_ROOT, 'src');
const SPEC_EXT = new Set(['.json', '.jsonl']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-render', 'dist-web-single', '.slidey-dist', '.slidey-runtime', '.git']);

// The sidebar tree only auto-lists specs that follow the `.slidey.json`
// convention (plus generated `.jsonl` traces). Plain `.json` files still
// preview when opened explicitly, they just don't clutter the picker.
function isDiscoverableSpec(name) {
  return /\.slidey\.json$/i.test(name) || /\.jsonl$/i.test(name);
}

function safeResolve(root, rel) {
  const abs = path.resolve(root, '.' + path.sep + (rel || ''));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

function posixRel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function buildTree(absDir, root, relDir = '') {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      const children = buildTree(path.join(absDir, e.name), root, childRel);
      if (children.length) dirs.push({ name: e.name, type: 'dir', path: childRel, children });
    } else if (e.isFile() && isDiscoverableSpec(e.name)) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      files.push({ name: e.name, type: 'file', path: rel });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

function readSpec(absFile) {
  if (/\.jsonl$/i.test(absFile)) {
    return require(path.join(RUNTIME_SRC_DIR, 'trace')).buildSpecFromFile(absFile);
  }
  return JSON.parse(fs.readFileSync(absFile, 'utf8'));
}

function response(status, body) {
  return { status, body };
}

function assetBaseFor(webview, vscode, absFile) {
  if (!webview || !vscode) return null;
  const uri = webview.asWebviewUri(vscode.Uri.file(path.dirname(absFile))).toString();
  return uri.endsWith('/') ? uri : `${uri}/`;
}

function handleApiRequest({ root, openFile, webview, vscode }, request) {
  const url = new URL(request.url, 'https://slidey.local');
  const pathname = decodeURIComponent(url.pathname);
  const workspaceRoot = path.resolve(root);

  if (pathname === '/api/config') {
    // `embedded` tells the web app it's the single-file VS Code preview: no
    // file-tree sidebar, auto-reload on disk changes (see App.vue).
    return response(200, { root: workspaceRoot, openFile, embedded: true });
  }

  if (pathname === '/api/tree') {
    return response(200, {
      name: path.basename(workspaceRoot) || workspaceRoot,
      type: 'dir',
      path: '',
      children: buildTree(workspaceRoot, workspaceRoot),
    });
  }

  if (pathname === '/api/schema') {
    try {
      return response(200, require(path.join(RUNTIME_SRC_DIR, 'schema')).SCHEMA);
    } catch (err) {
      return response(500, { error: String(err.message || err) });
    }
  }

  if (pathname === '/api/spec' && request.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    const abs = safeResolve(workspaceRoot, rel);
    if (!abs || !fs.existsSync(abs)) return response(404, { error: `not found: ${rel}` });
    try {
      const stat = fs.statSync(abs);
      const spec = readSpec(abs);
      const dir = path.dirname(rel).replace(/\\/g, '/');
      return response(200, {
        spec,
        dir: dir === '.' ? '' : dir,
        assetBase: assetBaseFor(webview, vscode, abs),
        mtimeMs: stat.mtimeMs,
      });
    } catch (err) {
      return response(400, { error: String(err.message || err) });
    }
  }

  // POST /api/spec is handled out-of-band in the webview message handler
  // (handleSpecWrite) because writing through the editor model is async; this
  // synchronous path only ever sees it if that interception is bypassed.
  if (pathname === '/api/spec' && request.method === 'POST') {
    return response(405, { error: 'spec writes are handled asynchronously' });
  }

  if (pathname === '/api/stat') {
    const rel = url.searchParams.get('path') || '';
    const abs = safeResolve(workspaceRoot, rel);
    if (!abs || !fs.existsSync(abs)) return response(404, { error: `not found: ${rel}` });
    try {
      return response(200, { mtimeMs: fs.statSync(abs).mtimeMs });
    } catch (err) {
      return response(400, { error: String(err.message || err) });
    }
  }

  return response(404, { error: `unknown Slidey preview route: ${pathname}` });
}

// Validate + persist an edited spec posted from the webview. Async because we
// write through the editor's document model (so the change joins VS Code's undo
// history and dirty/save lifecycle) rather than mutating the file on disk
// behind the editor's back. Mirrors the CLI viewer's POST /api/spec contract.
async function handleSpecWrite({ root, vscode }, request) {
  const workspaceRoot = path.resolve(root);
  const url = new URL(request.url, 'https://slidey.local');
  const rel = url.searchParams.get('path') || '';
  const abs = safeResolve(workspaceRoot, rel);
  if (!abs || !fs.existsSync(abs)) return response(404, { error: `not found: ${rel}` });
  if (!/\.json$/i.test(abs)) return response(400, { error: 'only .json specs can be edited in the preview' });

  let payload;
  try {
    payload = JSON.parse(request.body || '{}');
  } catch (err) {
    return response(400, { error: `invalid JSON body: ${err.message}` });
  }
  if (!payload || typeof payload.spec !== 'object' || Array.isArray(payload.spec)) {
    return response(400, { error: 'expected { spec } JSON body' });
  }
  if (!Array.isArray(payload.spec.scenes) || !payload.spec.scenes.length) {
    return response(400, { error: 'spec must have a non-empty "scenes" array' });
  }

  try {
    const mtimeMs = await writeSpecDocument(vscode, abs, payload.spec);
    return response(200, { ok: true, mtimeMs });
  } catch (err) {
    return response(400, { error: String(err.message || err) });
  }
}

// Replace the file's contents with the pretty-printed spec. When the real
// `vscode` API is present we route through a WorkspaceEdit + document.save() so
// the write is a normal editor edit (undoable, integrated with the dirty flag).
// In tests / non-VS Code hosts (no WorkspaceEdit) we fall back to a plain disk
// write. Either way we return the resulting mtime for the viewer's reload watch.
async function writeSpecDocument(vscode, abs, spec) {
  const text = JSON.stringify(spec, null, 2) + '\n';
  if (vscode && vscode.workspace && typeof vscode.WorkspaceEdit === 'function') {
    const uri = vscode.Uri.file(abs);
    let doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
    if (!doc) doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const lastLine = doc.lineCount > 0 ? doc.lineCount - 1 : 0;
    const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(lastLine).range.end);
    edit.replace(uri, fullRange, text);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) throw new Error('VS Code rejected the spec edit');
    await doc.save();
  } else {
    fs.writeFileSync(abs, text, 'utf8');
  }
  return fs.statSync(abs).mtimeMs;
}

function webviewBridgeScript() {
  return `
<script>
(() => {
  const vscode = acquireVsCodeApi();
  const pending = new Map();
  let nextId = 1;
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type !== 'slidey.response') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    const body = JSON.stringify(msg.body == null ? {} : msg.body);
    slot.resolve(new Response(body, {
      status: msg.status || 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    }));
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const raw = typeof input === 'string' ? input : (input && input.url) || '';
    const url = new URL(raw, window.location.href);
    if (url.pathname.startsWith('/api/')) {
      const id = nextId++;
      const method = (init.method || (input && input.method) || 'GET').toUpperCase();
      const body = init.body == null ? null : String(init.body);
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error('Timed out waiting for Slidey preview API response'));
        }, 15000);
      });
      vscode.postMessage({ type: 'slidey.fetch', id, url: url.pathname + url.search, method, body });
      return promise;
    }
    return nativeFetch(input, init);
  };
})();
</script>`;
}

function rewriteViewerHtml(indexHtml, webview, vscode) {
  let html = indexHtml;
  html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_m, attr, rel) => {
    const uri = webview.asWebviewUri(vscode.Uri.file(path.join(DIST_DIR, rel))).toString();
    return `${attr}="${uri}"`;
  });
  return html.replace('</head>', `${webviewBridgeScript()}\n</head>`);
}

function previewTitle(file) {
  return `Slidey: ${path.basename(file)}`;
}

async function openPreview(vscode, context, uri) {
  const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
  if (!target || target.scheme !== 'file') {
    vscode.window.showErrorMessage('Open a Slidey .json or .jsonl file to preview it.');
    return;
  }
  const file = target.fsPath;
  if (!SPEC_EXT.has(path.extname(file).toLowerCase())) {
    vscode.window.showErrorMessage('Slidey previews require a .json or .jsonl spec.');
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(target);
  const root = folder ? folder.uri.fsPath : path.dirname(file);
  const openFile = posixRel(root, file);
  const panel = vscode.window.createWebviewPanel(
    'slideyPreview',
    previewTitle(file),
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(DIST_DIR),
        vscode.Uri.file(root),
      ],
      retainContextWhenHidden: true,
    },
  );

  const index = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(index)) {
    panel.webview.html = '<!doctype html><body>Slidey viewer bundle is missing. Run npm run build:web.</body>';
    return;
  }

  panel.webview.html = rewriteViewerHtml(fs.readFileSync(index, 'utf8'), panel.webview, vscode);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || msg.type !== 'slidey.fetch') return;
    const request = { url: msg.url, method: msg.method || 'GET', body: msg.body };
    let result;
    const isSpecWrite = request.method === 'POST'
      && new URL(request.url, 'https://slidey.local').pathname === '/api/spec';
    if (isSpecWrite) {
      result = await handleSpecWrite({ root, vscode }, request);
    } else {
      result = handleApiRequest({ root, openFile, webview: panel.webview, vscode }, request);
    }
    panel.webview.postMessage({ type: 'slidey.response', id: msg.id, status: result.status, body: result.body });
  }, null, context.subscriptions);
}

function activate(context) {
  const vscode = require('vscode');
  context.subscriptions.push(vscode.commands.registerCommand('slidey.preview', (uri) => openPreview(vscode, context, uri)));
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  buildTree,
  handleApiRequest,
  handleSpecWrite,
  writeSpecDocument,
  previewTitle,
  readSpec,
  rewriteViewerHtml,
  safeResolve,
  webviewBridgeScript,
};
