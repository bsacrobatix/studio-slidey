'use strict';

/**
 * SLIDEY — local viewer server.
 *
 * Serves the prebuilt interactive Vue viewer (web target → dist/) and exposes
 * the opened folder as a browsable workspace, so `slidey <dir>` / `slidey
 * <file.json>` open a deck (with a VS-Code-style file-tree sidebar) in the
 * browser instead of rendering a video.
 *
 * Dependency-free: Node built-ins only (the viewer bundle is prebuilt by Vite).
 *
 * Routes:
 *   GET /api/config            → { root, openFile }  (App.vue → workspace mode)
 *   GET /api/tree              → nested tree of *.slidey.json / *.readonly.slidey.json / *.jsonl under root
 *   GET /api/schema            → Slidey JSON Schema for editor metadata
 *   GET /api/spec?path=<rel>   → { spec, dir, mtimeMs, editable }  (.jsonl built via src/trace.js)
 *   POST /api/spec?path=<rel>  → save a JSON spec back to disk
 *   POST /api/clone-spec?path=<rel> → copy a read-only report deck into editable form
 *   GET /api/stat?path=<rel>   → { mtimeMs }  (poll target for live on-disk reload)
 *   GET /workspace/<rel>       → raw workspace file (spec-relative gif/img assets)
 *   *                          → static from dist/ with index.html SPA fallback
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');      // repo root (has dist/, package.json)
const DIST_DIR = path.join(ROOT_DIR, 'dist');         // `npm run build:web` output

// Directories never worth walking for specs.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-render', 'dist-web-single', '.git']);

const SPEC_EXT = new Set(['.json', '.jsonl']);
const READONLY_SUFFIX = '.readonly.slidey.json';

// Specs are auto-discovered in the sidebar tree when they are normal `.slidey.json`
// specs, read-only report `.readonly.slidey.json` specs, or generated `.jsonl`
// traces. Plain `.json` files are still readable when opened explicitly, just
// not listed.
function isDiscoverableSpec(name) {
  return /\.(?:readonly\.)?slidey\.json$/i.test(name) || /\.jsonl$/i.test(name);
}

function isReadOnlySlideySpec(filePath) {
  return new RegExp(`${READONLY_SUFFIX.replace('.', '\\.')}$`, 'i').test(filePath);
}

function isEditableSpec(filePath) {
  return /\.json$/i.test(filePath) && !isReadOnlySlideySpec(filePath);
}

function defaultCloneTarget(sourceRel) {
  const normalized = sourceRel.replace(/\\/g, '/');
  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  const editableBase = base
    .replace(/\.readonly\.slidey\.json$/i, '.slidey.json')
    .replace(/\.jsonl$/i, '.slidey.json');
  const candidate = /\.slidey\.json$/i.test(editableBase)
    ? editableBase
    : `${editableBase.replace(/\.json$/i, '')}.slidey.json`;
  return dir === '.' ? candidate : path.posix.join(dir, candidate);
}

function uniqueRel(baseRel) {
  if (!baseRel) return baseRel;
  const normalized = baseRel.replace(/\\/g, '/');
  const abs = path.resolve(normalized);
  const parsed = path.parse(abs);
  let i = 0;
  let current = normalized;
  let currentAbs = abs;
  while (fs.existsSync(currentAbs)) {
    i += 1;
    const suffix = `-${i}`;
    current = path.posix.join(
      path.posix.dirname(normalized),
      `${parsed.name}${suffix}${parsed.ext}`,
    );
    currentAbs = path.resolve(current);
  }
  return current;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
};

// ── dist/ (prebuilt viewer) ─────────────────────────────────────────────────

/** Ensure dist/ exists; build it once if missing and Vite is available. */
function ensureDist() {
  if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) return true;
  // Try an on-demand build (vite is a devDependency present in a dev checkout).
  try {
    console.log('[slidey] viewer bundle not found — building it once (npm run build:web)…');
    execFileSync('npm', ['run', 'build:web'], { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch (_) {
    // fall through to the existence re-check / error below
  }
  if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) return true;
  console.error(
    '[slidey] ERROR: the viewer bundle (dist/) is missing and could not be built.\n' +
    '         Run `npm run build:web` in the slidey checkout, then try again.',
  );
  return false;
}

// ── workspace file tree ─────────────────────────────────────────────────────

/**
 * Build a nested tree of spec files under `dir`. Returns a node:
 *   { name, type: 'dir', path, children: [...] }  |  { name, type: 'file', path }
 * `path` is POSIX-relative to the workspace root. Directories with no specs
 * (transitively) are pruned so the sidebar shows only useful folders.
 */
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
      files.push({ name: e.name, type: 'file', path: rel, editable: isEditableSpec(e.name) });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files]; // folders first, then files (VS Code ordering)
}

// ── safe path resolution within root ────────────────────────────────────────

/** Resolve a workspace-relative path, or null if it escapes `root`. */
function safeResolve(root, rel) {
  const abs = path.resolve(root, '.' + path.sep + (rel || ''));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

// ── request helpers ─────────────────────────────────────────────────────────

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, absFile) {
  let data;
  try {
    data = fs.readFileSync(absFile);
  } catch (_) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(absFile).toLowerCase()] || 'application/octet-stream' });
  res.end(data);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── browser open (best-effort) ──────────────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'cmd'
            : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch (_) { /* non-fatal: user can open the printed URL */ }
}

// ── server ──────────────────────────────────────────────────────────────────

/**
 * Start the viewer server.
 * @param {object} opts
 * @param {string} opts.root      absolute path of the workspace folder to serve
 * @param {string|null} opts.openFile  workspace-relative spec to auto-open (or null)
 * @param {number} opts.port      preferred port (auto-increments if taken)
 * @param {boolean} opts.open     launch the browser when true
 */
function startViewer({ root, openFile = null, port = 4321, open = true, _tries = 0 }) {
  if (!ensureDist()) process.exit(1);
  const workspaceRoot = path.resolve(root);

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      res.writeHead(400).end('Bad request');
      return;
    }
    const pathname = decodeURIComponent(url.pathname);

    // ── API ──
    if (pathname === '/api/config') {
      return sendJSON(res, 200, { root: workspaceRoot, openFile });
    }

    if (pathname === '/api/tree') {
      return sendJSON(res, 200, {
        name: path.basename(workspaceRoot) || workspaceRoot,
        type: 'dir',
        path: '',
        children: buildTree(workspaceRoot, workspaceRoot),
      });
    }

    if (pathname === '/api/schema') {
      try {
        return sendJSON(res, 200, require('./schema').SCHEMA);
      } catch (err) {
        return sendJSON(res, 500, { error: String(err.message || err) });
      }
    }

    if (pathname === '/api/spec' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || '';
      const abs = safeResolve(workspaceRoot, rel);
      if (!abs || !fs.existsSync(abs)) return sendJSON(res, 404, { error: `not found: ${rel}` });
      try {
        const mtimeMs = fs.statSync(abs).mtimeMs;
        const spec = /\.jsonl$/i.test(abs)
          ? require('./trace').buildSpecFromFile(abs)
          : JSON.parse(fs.readFileSync(abs, 'utf8'));
        const dir = path.dirname(rel).replace(/\\/g, '/');
        const editable = isEditableSpec(abs);
        return sendJSON(res, 200, {
          spec,
          dir: dir === '.' ? '' : dir,
          mtimeMs,
          editable,
        });
      } catch (err) {
        return sendJSON(res, 400, { error: String(err.message || err) });
      }
    }

    if (pathname === '/api/spec' && req.method === 'POST') {
      const rel = url.searchParams.get('path') || '';
      const abs = safeResolve(workspaceRoot, rel);
      if (!abs || !fs.existsSync(abs)) return sendJSON(res, 404, { error: `not found: ${rel}` });
      if (!isEditableSpec(abs)) {
        return sendJSON(res, 400, {
          error: 'only editable .json specs can be saved; .readonly.slidey.json is read-only',
        });
      }
      try {
        const raw = await readBody(req);
        const payload = JSON.parse(raw || '{}');
        if (!payload || typeof payload.spec !== 'object' || Array.isArray(payload.spec)) {
          return sendJSON(res, 400, { error: 'expected { spec } JSON body' });
        }
        if (!Array.isArray(payload.spec.scenes) || !payload.spec.scenes.length) {
          return sendJSON(res, 400, { error: 'spec must have a non-empty "scenes" array' });
        }
        const body = JSON.stringify(payload.spec, null, 2) + '\n';
        fs.writeFileSync(abs, body, 'utf8');
        return sendJSON(res, 200, { ok: true, mtimeMs: fs.statSync(abs).mtimeMs });
      } catch (err) {
        return sendJSON(res, 400, { error: String(err.message || err) });
      }
    }

    if (pathname === '/api/clone-spec' && req.method === 'POST') {
      const rel = url.searchParams.get('path') || '';
      const source = safeResolve(workspaceRoot, rel);
      if (!source || !fs.existsSync(source)) return sendJSON(res, 404, { error: `not found: ${rel}` });
      if (!/\.json$/i.test(source) && !/\.jsonl$/i.test(source)) {
        return sendJSON(res, 400, { error: `only JSON specs can be cloned: ${rel}` });
      }
      let payload = {};
      try {
        payload = JSON.parse(await readBody(req) || '{}');
      } catch (err) {
        return sendJSON(res, 400, { error: `invalid JSON body: ${err.message}` });
      }
      const requestedTarget = typeof payload.target === 'string' ? payload.target.trim() : '';
      const targetRel = requestedTarget
        ? requestedTarget
        : defaultCloneTarget(rel);
      const target = safeResolve(workspaceRoot, targetRel);
      if (!target) return sendJSON(res, 400, { error: 'invalid clone target path' });
      if (target === source) return sendJSON(res, 400, { error: 'clone target must differ from source' });
      const finalRel = uniqueRel(path.relative(workspaceRoot, target).replace(/\\/g, '/'));
      const finalAbs = safeResolve(workspaceRoot, finalRel);
      fs.writeFileSync(finalAbs, fs.readFileSync(source, 'utf8'), 'utf8');
      return sendJSON(res, 200, { source: rel, path: relPath(finalAbs), mtimeMs: fs.statSync(finalAbs).mtimeMs, editable: isEditableSpec(finalAbs) });
    }

    // Lightweight mtime probe so the viewer can detect on-disk edits without
    // reparsing the spec every poll. Returns mtimeMs (or 404 if gone).
    if (pathname === '/api/stat') {
      const rel = url.searchParams.get('path') || '';
      const abs = safeResolve(workspaceRoot, rel);
      if (!abs || !fs.existsSync(abs)) return sendJSON(res, 404, { error: `not found: ${rel}` });
      try {
        return sendJSON(res, 200, { mtimeMs: fs.statSync(abs).mtimeMs });
      } catch (err) {
        return sendJSON(res, 400, { error: String(err.message || err) });
      }
    }

    // ── workspace assets (spec-relative gif/img) ──
    if (pathname.startsWith('/workspace/')) {
      const rel = pathname.slice('/workspace/'.length);
      const abs = safeResolve(workspaceRoot, rel);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      return sendFile(res, abs);
    }

    // ── static viewer bundle (dist/) with SPA fallback ──
    const distRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const distAbs = safeResolve(DIST_DIR, distRel);
    if (distAbs && fs.existsSync(distAbs) && fs.statSync(distAbs).isFile()) {
      return sendFile(res, distAbs);
    }
    // Unknown non-asset route → serve the SPA shell.
    if (!path.extname(distRel)) {
      return sendFile(res, path.join(DIST_DIR, 'index.html'));
    }
    res.writeHead(404).end('Not found');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && _tries < 50) {
      startViewer({ root, openFile, port: port + 1, open, _tries: _tries + 1 });
    } else {
      console.error(`[slidey] ERROR: could not start viewer server: ${err.message}`);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log(`\n[slidey] Viewer  : ${url}`);
    console.log(`[slidey] Workspace: ${workspaceRoot}`);
    if (openFile) console.log(`[slidey] Opening : ${openFile}`);
    console.log('[slidey] Press Ctrl-C to stop.\n');
    if (open) openBrowser(url);
  });

  return server;
}

module.exports = { startViewer };
