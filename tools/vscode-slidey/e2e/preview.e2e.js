'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const puppeteer = require('puppeteer');

const { launchOptions } = require('../../../src/browser');
const os = require('node:os');
const {
  handleApiRequest,
  handleSpecWrite,
  writeSpecDocument,
  rewriteViewerHtml,
} = require('../src/extension');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST = path.join(ROOT, 'dist');
const EXAMPLE = path.join(ROOT, 'examples', 'hello.slidey.json');
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function fakeVscodeFor(origin) {
  return {
    Uri: {
      file(file) {
        return { fsPath: file };
      },
    },
  };
}

function fakeWebviewFor(origin) {
  return {
    asWebviewUri(uri) {
      const rel = path.relative(ROOT, uri.fsPath).split(path.sep).map(encodeURIComponent).join('/');
      return `${origin}/${rel}`;
    },
  };
}

function servePreview() {
  let origin = '';
  const vscode = fakeVscodeFor();
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      const webview = fakeWebviewFor(origin);
      let html = rewriteViewerHtml(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'), webview, vscode)
        .replace('acquireVsCodeApi()', 'window.__slideyAcquireVsCodeApi()');
      html = html.replace('<script>\n(() => {', `<script>
window.__slideyAcquireVsCodeApi = () => ({
  postMessage(message) {
    fetch('/__slidey_api__', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message)
    })
      .then((res) => res.json())
      .then((reply) => window.postMessage(reply, '*'));
  }
});
</script>
<script>
(() => {`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.url === '/__slidey_api__' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = handleApiRequest({
          root: ROOT,
          openFile: path.relative(ROOT, EXAMPLE).split(path.sep).join('/'),
          webview: fakeWebviewFor(origin),
          vscode,
        }, msg);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ type: 'slidey.response', id: msg.id, status: result.status, body: result.body }));
      });
      return;
    }
    const abs = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (abs.startsWith(ROOT + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
      res.end(fs.readFileSync(abs));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      origin = `http://127.0.0.1:${port}`;
      resolve({ server, url: origin });
    });
  });
}

test('handleSpecWrite persists edited specs and rejects invalid payloads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-vscode-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rel = 'deck.slidey.json';
  const abs = path.join(dir, rel);
  fs.writeFileSync(abs, JSON.stringify({ scenes: [{ type: 'narrative', body: 'old' }] }, null, 2) + '\n');

  // No real `vscode` API here → writeSpecDocument falls back to a plain disk write.
  const writeReq = (body) => ({ url: `/api/spec?path=${encodeURIComponent(rel)}`, method: 'POST', body });

  // Happy path: a valid spec is written back, pretty-printed, with a fresh mtime.
  const newSpec = { meta: { title: 'edited' }, scenes: [{ type: 'narrative', body: 'new' }] };
  const ok = await handleSpecWrite({ root: dir }, writeReq(JSON.stringify({ spec: newSpec })));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.ok(ok.body.mtimeMs > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(abs, 'utf8')), newSpec);
  assert.ok(fs.readFileSync(abs, 'utf8').endsWith('\n'), 'spec file is newline-terminated');

  // Validation: missing scenes, bad shape, malformed JSON, unknown path all 4xx.
  assert.equal((await handleSpecWrite({ root: dir }, writeReq(JSON.stringify({ spec: { scenes: [] } })))).status, 400);
  assert.equal((await handleSpecWrite({ root: dir }, writeReq(JSON.stringify({ spec: [] })))).status, 400);
  assert.equal((await handleSpecWrite({ root: dir }, writeReq('{not json'))).status, 400);
  const missing = await handleSpecWrite({ root: dir }, { url: '/api/spec?path=nope.json', method: 'POST', body: '{}' });
  assert.equal(missing.status, 404);
});

test('writeSpecDocument routes through the VS Code editor model when available', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-vscode-doc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const abs = path.join(dir, 'deck.slidey.json');
  fs.writeFileSync(abs, 'STALE');

  // Minimal fake of the VS Code API surface writeSpecDocument relies on. It must
  // apply a WorkspaceEdit (full-range replace) and save() through to disk.
  const calls = { applied: false, saved: false };
  const fakeDoc = {
    uri: { fsPath: abs },
    lineCount: 1,
    getText: () => 'STALE',
    lineAt: () => ({ range: { end: { line: 0, character: 5 } } }),
    save: async () => { calls.saved = true; },
  };
  const vscode = {
    Uri: { file: (f) => ({ fsPath: f }) },
    Position: function (line, character) { this.line = line; this.character = character; },
    Range: function (start, end) { this.start = start; this.end = end; },
    WorkspaceEdit: function () { this.replace = (_uri, _range, text) => { this._text = text; }; },
    workspace: {
      textDocuments: [fakeDoc],
      openTextDocument: async () => fakeDoc,
      applyEdit: async (edit) => { calls.applied = true; fs.writeFileSync(abs, edit._text, 'utf8'); return true; },
    },
  };

  const spec = { scenes: [{ type: 'narrative', body: 'hi' }] };
  const mtimeMs = await writeSpecDocument(vscode, abs, spec);
  assert.ok(calls.applied, 'applied a WorkspaceEdit');
  assert.ok(calls.saved, 'saved the document');
  assert.ok(mtimeMs > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(abs, 'utf8')), spec);
});

test('VS Code preview webview opens the real Slidey viewer and selected deck', async (t) => {
  assert.ok(fs.existsSync(path.join(DIST, 'index.html')), 'dist/index.html must exist; run npm run build:web first');

  const { server, url } = await servePreview();
  t.after(() => server.close());

  const browser = await puppeteer.launch(launchOptions({ width: 1440, height: 900 }));
  t.after(() => browser.close());

  const page = await browser.newPage();
  const events = [];
  page.on('console', (msg) => events.push(`console:${msg.type()}:${msg.text()}`));
  page.on('pageerror', (err) => events.push(`pageerror:${err.message}`));
  page.on('requestfailed', (req) => events.push(`requestfailed:${req.url()}:${req.failure() && req.failure().errorText}`));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  try {
    // The embedded preview renders the deck plus the floating reload button…
    await page.waitForSelector('.slidey-embedded-reload', { timeout: 15000 });
    await page.waitForSelector('.slidey-hud', { timeout: 15000 });
  } catch (err) {
    const html = await page.evaluate(() => document.body.innerText);
    throw new Error(`${err.message}\n${events.join('\n')}\nbody:${html}`);
  }

  const state = await page.evaluate(() => ({
    hasAdapter: !!window.slidey,
    title: document.body.innerText,
    deckVisible: !!document.querySelector('.slidey-hud'),
    // …and never the file-tree sidebar (it's a single-file preview).
    hasSidebar: !!document.querySelector('.slidey-sidebar'),
    hasReload: !!document.querySelector('.slidey-embedded-reload'),
  }));

  assert.equal(state.hasAdapter, true);
  assert.equal(state.deckVisible, true);
  assert.equal(state.hasSidebar, false, 'embedded preview must not show the file-tree sidebar');
  assert.equal(state.hasReload, true, 'embedded preview must show the reload button');
  assert.match(state.title, /Hello, Slidey|Slidey/);
  assert.match(state.title, /Declarative videos from a JSON spec/);
});
