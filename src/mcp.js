#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { browserExecutableError, closeBrowser, launchOptions, doctor } = require('./browser');
const { validateSpec } = require('./validate');
const { SCHEMA } = require('./schema');
const { sceneShowOpts } = require('./assets');
const { auditSpec } = require('./audit');
const { runCheck } = require('./check');
const { estimateBoundaries } = require('./timing');
const { tempRoot } = require('./temp-path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RENDER_BUNDLE = path.join(ROOT_DIR, 'dist-render', 'render.html');
const SPEC_EXT = new Set(['.json', '.jsonl']);
const READONLY_SUFFIX = '.readonly.slidey.json';

// Auto-discovery (workspace_tree) lists specs that follow the `.slidey.json`
// convention plus generated `.jsonl` traces. Explicit reads stay permissive.
function isDiscoverableSpec(name) {
  return /\.(?:readonly\.)?slidey\.json$/i.test(name) || /\.jsonl$/i.test(name);
}

function isReadOnlySlideySpec(name) {
  return new RegExp(`${READONLY_SUFFIX.replace('.', '\\.')}$`, 'i').test(name);
}

function isEditableSpec(name) {
  return /\.json$/i.test(name) && !isReadOnlySlideySpec(name);
}

function ensureEditable(abs) {
  if (!isEditableSpec(abs)) {
    throw new Error('only editable .json specs can be edited; .readonly.slidey.json is read-only');
  }
}
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-render', 'dist-web-single', '.git', '.worktrees']);

// MCP uses stdout for framed JSON-RPC. Keep every existing Slidey diagnostic off
// stdout so build/render logs cannot corrupt the protocol stream.
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');

function parseArgs(argv) {
  const opts = { root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--root' || arg === '-r') && argv[i + 1]) {
      opts.root = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'slidey-mcp',
        '',
        'Usage:',
        '  slidey-mcp --root <workspace>',
        '',
        'Runs a stdio MCP server exposing Slidey viewing, editing, validation, and debugging tools.',
        '',
      ].join('\n'));
      process.exit(0);
    }
  }
  opts.root = path.resolve(opts.root);
  return opts;
}

const CONFIG = parseArgs(process.argv.slice(2));
const BROWSER_TOOL_TIMEOUT_MS = Number(process.env.SLIDEY_MCP_BROWSER_TIMEOUT_MS || 30000);
const BROWSER_TOOLS = new Set(['slidey_render_png', 'slidey_render_html', 'slidey_audit', 'slidey_doctor']);
const LAYOUT_GALLERY_PATH = path.join(ROOT_DIR, 'examples', 'layout-gallery.slidey.json');

function loadLayoutGuideDeck() {
  try {
    const raw = fs.readFileSync(LAYOUT_GALLERY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.scenes) ? parsed.scenes : [];
  } catch (_) {
    return [];
  }
}

function layoutGalleryId(type, variant = '') {
  return variant ? `${type}-${variant}` : type;
}

function layoutGalleryLabel(scene, type, variant) {
  if (typeof scene.title === 'string' && scene.title.trim()) return scene.title.trim();
  if (typeof scene.eyebrow === 'string' && scene.eyebrow.trim()) return `${type}: ${scene.eyebrow.trim()}`;
  if (typeof scene.question === 'string' && scene.question.trim()) return `${type}: ${scene.question.trim()}`;
  if (typeof scene.lede === 'string' && scene.lede.trim()) return `${type}: ${scene.lede.trim()}`;
  return variant ? `${type} (${variant})` : type;
}

function buildLayoutGalleryFromGuide(scenes) {
  const sourceScenes = Array.isArray(scenes) ? scenes : [];
  const seen = new Set();
  const layouts = [];
  const issues = [];

  for (const scene of sourceScenes) {
    if (!scene || typeof scene !== 'object') {
      issues.push('layout guide contains a non-object scene entry');
      continue;
    }
    const type = typeof scene.type === 'string' ? scene.type.trim() : '';
    if (!type) {
      issues.push('layout guide scene is missing required "type"');
      continue;
    }
    const variant = typeof scene.variant === 'string' ? scene.variant.trim() : '';
    const id = layoutGalleryId(type, variant);
    if (seen.has(id)) continue;

    layouts.push({
      id,
      label: layoutGalleryLabel(scene, type, variant),
      type,
      variant,
      scene,
    });
    seen.add(id);
  }

  return {
    layouts,
    issues,
    valid: issues.length === 0,
    sourceScenes: sourceScenes.length,
    uniqueScenes: layouts.length,
  };
}

function fallbackLayoutGallery() {
  return [
    { id: 'title', label: 'Title', type: 'title', variant: '', scene: { type: 'title', title: 'Title slide', subtitle: 'Add your subtitle', eyebrow: 'Section' } },
    { id: 'narrative', label: 'Narrative', type: 'narrative', variant: '', scene: { type: 'narrative', eyebrow: 'Narrative', lede: 'A short takeaway', body: 'Start writing the scene copy here.' } },
    { id: 'cards-grid', label: 'Cards (grid)', type: 'cards', variant: 'grid', scene: { type: 'cards', variant: 'grid', title: 'Grid cards', columns: 2, cards: [{ label: 'Point', sub: 'Describe a key idea' }, { label: 'Point', sub: 'Add supporting context' }] } },
    { id: 'code-source', label: 'Code block', type: 'code', variant: 'source', scene: { type: 'code', variant: 'source', title: 'Code', lang: 'javascript', code: "console.log('Hello from Slidey');" } },
    { id: 'diagram-svg', label: 'Diagram', type: 'diagram-svg', variant: '', scene: { type: 'diagram-svg', title: 'Diagram', panels: [{ label: 'Main flow', nodes: [{ id: 'start', label: 'Start' }, { id: 'end', label: 'Done' }], edges: [{ from: 'start', to: 'end' }] }] } },
    { id: 'table-data', label: 'Table', type: 'table', variant: 'data', scene: { type: 'table', variant: 'data', title: 'Table', columns: ['Stage', 'Status'], rows: [{ cells: ['Draft', 'Ready'] }] } },
    { id: 'chart-bar', label: 'Chart', type: 'chart', variant: 'bar', scene: { type: 'chart', variant: 'bar', title: 'Chart', series: [{ name: 'Series 1', points: [{ x: 'A', y: 7 }, { x: 'B', y: 12 }] }] } },
    { id: 'mermaid', label: 'Mermaid', type: 'mermaid', variant: '', scene: { type: 'mermaid', title: 'Mermaid', source: 'flowchart TD\nA[Input] --> B[Process]\nB --> C[Output]' } },
  ];
}

const LAYOUT_GUIDE_BUILD = buildLayoutGalleryFromGuide(loadLayoutGuideDeck());
const LAYOUT_GALLERY = LAYOUT_GUIDE_BUILD.layouts.length
  ? LAYOUT_GUIDE_BUILD.layouts
  : fallbackLayoutGallery();

if (LAYOUT_GUIDE_BUILD.layouts.length && !LAYOUT_GUIDE_BUILD.valid) {
  console.error(`slidey layout gallery integrity warning: ${LAYOUT_GUIDE_BUILD.issues.join('; ')}`);
}

function jsonText(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function okResult(value) {
  return { content: jsonText(value) };
}

function errorResult(message, details = null) {
  const payload = details ? { error: message, details } : { error: message };
  return { isError: true, content: jsonText(payload) };
}

function safeResolve(rel = '') {
  if (typeof rel !== 'string') throw new Error('path must be a string');
  // An ABSOLUTE input path is an explicit, intentional choice by the caller —
  // honor it verbatim (e.g. validating/rendering a deck that lives outside the
  // MCP workspace root, like a deck in another repo). The workspace-escape
  // guard below exists to stop RELATIVE inputs from traversing out via `../`;
  // it must not mangle an absolute path. (Previously `path.resolve(root, './' +
  // absPath)` rewrote `/abs/x` into `<root>/abs/x` → "spec not found".)
  if (path.isAbsolute(rel)) return path.resolve(rel);
  const abs = path.resolve(CONFIG.root, '.' + path.sep + rel);
  const rootWithSep = CONFIG.root.endsWith(path.sep) ? CONFIG.root : CONFIG.root + path.sep;
  if (abs !== CONFIG.root && !abs.startsWith(rootWithSep)) {
    throw new Error(`path escapes workspace root: ${rel}`);
  }
  return abs;
}

function relPath(abs) {
  return path.relative(CONFIG.root, abs).replace(/\\/g, '/');
}

function requireSpecPath(inputPath) {
  const abs = safeResolve(inputPath || '');
  if (!fs.existsSync(abs)) throw new Error(`spec not found: ${inputPath}`);
  if (!fs.statSync(abs).isFile()) throw new Error(`not a file: ${inputPath}`);
  if (!SPEC_EXT.has(path.extname(abs).toLowerCase())) {
    throw new Error(`expected a .json or .jsonl spec: ${inputPath}`);
  }
  return abs;
}

function readSpecFile(inputPath) {
  const abs = requireSpecPath(inputPath);
  const raw = fs.readFileSync(abs, 'utf8');
  const spec = /\.jsonl$/i.test(abs) ? require('./trace').buildSpecFromFile(abs) : JSON.parse(raw);
  const generated = /\.jsonl$/i.test(abs);
  return { abs, raw, spec, generated, editable: isEditableSpec(abs) && !generated };
}

function inferMode(spec) {
  if (spec && spec.meta && spec.meta.mode) return spec.meta.mode;
  return (spec.scenes || []).some(scene => scene && scene.type === 'request') ? 'api' : 'pitch';
}

function writeSpecFile(inputPath, spec) {
  const abs = requireSpecPath(inputPath);
    ensureEditable(abs);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec must be a JSON object');
  if (!Array.isArray(spec.scenes) || spec.scenes.length === 0) throw new Error('spec must have a non-empty "scenes" array');
  const body = JSON.stringify(spec, null, 2) + '\n';
  fs.writeFileSync(abs, body, 'utf8');
  return { path: relPath(abs), bytes: Buffer.byteLength(body), mtimeMs: fs.statSync(abs).mtimeMs };
}

function cloneSpecValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function layoutById(layoutId) {
  return LAYOUT_GALLERY.find((entry) => entry.id === layoutId) || null;
}

function clampSceneIndex(index, sceneCount) {
  if (!Number.isInteger(index)) throw new Error('sceneIndex must be an integer');
  if (sceneCount <= 0) throw new Error('spec must contain at least one scene');
  if (index < 0 || index >= sceneCount) throw new Error(`sceneIndex must be between 0 and ${sceneCount - 1}`);
  return index;
}

function clampIndexForInsert(index, length) {
  if (!Number.isInteger(index)) return length;
  return Math.max(0, Math.min(index, length));
}

function sanitizeScene(scene) {
  return cloneSpecValue(scene);
}

function buildTree(absDir, relDir = '') {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childAbs = path.join(absDir, entry.name);
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const children = buildTree(childAbs, childRel);
      if (children.length) dirs.push({ name: entry.name, type: 'dir', path: childRel, children });
    } else if (entry.isFile() && isDiscoverableSpec(entry.name)) {
      files.push({ name: entry.name, type: 'file', path: childRel, editable: isEditableSpec(entry.name) });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [...dirs.sort(byName), ...files.sort(byName)];
}

function pointerParts(pointer) {
  if (pointer === '') return [];
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function parentForPointer(doc, pointer) {
  const parts = pointerParts(pointer);
  if (parts.length === 0) return { parent: null, key: null };
  let parent = doc;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const idx = part === '-' ? parent.length : Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) throw new Error(`array index not found in pointer: ${pointer}`);
      parent = parent[idx];
    } else if (parent && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, part)) {
      parent = parent[part];
    } else {
      throw new Error(`object key not found in pointer: ${pointer}`);
    }
  }
  return { parent, key: parts[parts.length - 1] };
}

function getPointer(doc, pointer) {
  let node = doc;
  for (const part of pointerParts(pointer)) {
    if (Array.isArray(node)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) throw new Error(`array index not found in pointer: ${pointer}`);
      node = node[idx];
    } else if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, part)) {
      node = node[part];
    } else {
      throw new Error(`object key not found in pointer: ${pointer}`);
    }
  }
  return node;
}

function applyJsonPatch(doc, operations) {
  if (!Array.isArray(operations)) throw new Error('operations must be an array');
  const target = structuredClone(doc);
  for (const op of operations) {
    if (!op || typeof op !== 'object') throw new Error('each patch operation must be an object');
    const { parent, key } = parentForPointer(target, op.path);
    if (op.op === 'test') {
      const actual = getPointer(target, op.path);
      if (JSON.stringify(actual) !== JSON.stringify(op.value)) throw new Error(`test failed at ${op.path}`);
      continue;
    }
    if (parent === null) {
      if (op.op === 'replace') return op.value;
      throw new Error(`operation ${op.op} is not supported at the document root`);
    }
    if (Array.isArray(parent)) {
      const idx = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new Error(`invalid array index in pointer: ${op.path}`);
      if (op.op === 'add') parent.splice(idx, 0, op.value);
      else if (op.op === 'replace') {
        if (idx >= parent.length) throw new Error(`array index not found in pointer: ${op.path}`);
        parent[idx] = op.value;
      } else if (op.op === 'remove') {
        if (idx >= parent.length) throw new Error(`array index not found in pointer: ${op.path}`);
        parent.splice(idx, 1);
      } else {
        throw new Error(`unsupported patch op: ${op.op}`);
      }
    } else if (parent && typeof parent === 'object') {
      if (op.op === 'add' || op.op === 'replace') {
        if (op.op === 'replace' && !Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`object key not found in pointer: ${op.path}`);
        parent[key] = op.value;
      } else if (op.op === 'remove') {
        if (!Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`object key not found in pointer: ${op.path}`);
        delete parent[key];
      } else {
        throw new Error(`unsupported patch op: ${op.op}`);
      }
    } else {
      throw new Error(`cannot patch through non-container at ${op.path}`);
    }
  }
  return target;
}

async function loadRenderPage(spec, specPath, sceneIndex, stepIndex) {
  const executableError = browserExecutableError();
  if (executableError) throw new Error(executableError);
  const puppeteer = require('puppeteer');
  require('./render-bundle').ensureRenderBundle();
  const sceneStepsPath = path.join(ROOT_DIR, 'web', 'sceneSteps.mjs');
  const sceneStepsUrl = pathToFileURL(sceneStepsPath);
  sceneStepsUrl.searchParams.set('mtime', String(fs.statSync(sceneStepsPath).mtimeMs));
  const { stepsForScene, applyShow } = await import(sceneStepsUrl.href);
  const scenes = Array.isArray(spec.scenes) ? spec.scenes : [];
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= scenes.length) {
    throw new Error(`sceneIndex must be between 0 and ${Math.max(0, scenes.length - 1)}`);
  }
  const scene = scenes[sceneIndex];
  const steps = stepsForScene(scene);
  const pageSteps = steps.length ? steps : [null];
  const resolvedStepIndex = stepIndex == null ? pageSteps.length - 1 : stepIndex;
  if (!Number.isInteger(resolvedStepIndex) || resolvedStepIndex < 0 || resolvedStepIndex >= pageSteps.length) {
    throw new Error(`stepIndex must be between 0 and ${pageSteps.length - 1} for scene ${sceneIndex}`);
  }

  const { width = 1920, height = 1080 } = (spec.meta && spec.meta.resolution) || {};
  const mode = inferMode(spec);
  const browser = await puppeteer.launch(launchOptions({ width, height }));
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(`file://${RENDER_BUNDLE}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__slideyReady === true', { timeout: 15000 });
    await page.emulateMediaType('screen');
    await page.evaluate((meta, m) => {
      window.slidey.setMeta(meta);
      window.slidey.setMode(m);
      document.body.classList.add('instant');
    }, spec.meta || {}, mode);
    await page.evaluate(applyShow, scene, sceneShowOpts(scene, specPath));
    // Apply EVERY reveal step up to and including the requested one, so the PNG
    // shows the cumulative on-screen state the audience actually sees at that
    // moment (title + items 0..N + caption) — not the single step's element in
    // isolation. setState() accumulates into the store's `revealed` set, so this
    // mirrors live nav and the geometry audit (src/audit.js applies pageSteps the
    // same way). Omitting stepIndex resolves to the last step → the fully-built
    // composite frame.
    const appliedSteps = pageSteps.slice(0, resolvedStepIndex + 1).filter(Boolean);
    if (appliedSteps.length) {
      await page.evaluate((steps) => { for (const s of steps) window.slidey.setState(s); }, appliedSteps);
    }
    const step = pageSteps[resolvedStepIndex];
    await page.evaluate('window.__slideySettle && window.__slideySettle()');
    return { browser, page, scene, step, appliedSteps, steps: pageSteps, width, height, sceneIndex, stepIndex: resolvedStepIndex };
  } catch (err) {
    await closeBrowser(browser);
    throw err;
  }
}

// Video scenes are not rendered through the Vue bundle (it excludes the rrweb
// web player; live render rasterizes natively). Emit a representative poster
// still instead — the frame a reviewer actually QAs — mirroring the PNG
// exporter (src/png.js). rrweb-log sources seek-rasterize a single frame; MP4
// `src` sources grab a frame ~10% in. Returns null if the source is missing so
// the caller can fall back to the (placeholder) Vue render.
async function renderVideoPoster(args, spec, specPath, sceneIndex, scene) {
  const executableError = browserExecutableError();
  if (executableError) throw new Error(executableError);
  const { width = 1920, height = 1080 } = (spec.meta && spec.meta.resolution) || {};
  const tmpPng = path.join(tempRoot(), `slidey-mcp-poster-${process.pid}-${sceneIndex}.png`);
  const specDir = path.dirname(specPath || '.');
  try {
    if (scene.rrweb) {
      const rrwebPath = path.resolve(specDir, scene.rrweb);
      if (!fs.existsSync(rrwebPath)) return null;
      const { extractRrwebPoster } = require('./rrweb-render');
      await extractRrwebPoster(rrwebPath, tmpPng, { width, height, fit: scene.fit || 'contain', atSec: scene.start || undefined });
    } else if (scene.src) {
      const v = require('./video');
      const src = path.resolve(specDir, scene.src);
      if (!fs.existsSync(src)) return null;
      const dur = v.probeDuration(src);
      const at = Math.max(0, scene.start || 0) + Math.min(1, (dur || 0) * 0.1);
      v.extractPoster({ src, outPng: tmpPng, width, height, fit: scene.fit || 'contain', atSec: at });
    } else {
      return null;
    }
    const data = fs.readFileSync(tmpPng).toString('base64');
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            path: args.path,
            sceneIndex,
            poster: true,
            note: 'video scene rendered as a native poster still (the Vue bundle excludes the live rrweb player)',
            source: scene.rrweb || scene.src,
            width,
            height,
          }, null, 2),
        },
        { type: 'image', mimeType: 'image/png', data },
      ],
    };
  } finally {
    try { fs.unlinkSync(tmpPng); } catch (_) { /* best-effort cleanup */ }
  }
}

async function renderPng(args) {
  const { abs, spec } = readSpecFile(args.path);
  const scenes = Array.isArray(spec.scenes) ? spec.scenes : [];
  const scene = scenes[args.sceneIndex];
  if (scene && scene.type === 'video' && (scene.rrweb || scene.src)) {
    const poster = await renderVideoPoster(args, spec, abs, args.sceneIndex, scene);
    if (poster) return poster;
  }
  const session = await loadRenderPage(spec, abs, args.sceneIndex, args.stepIndex);
  try {
    const data = await session.page.screenshot({ type: 'png', encoding: 'base64' });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            path: args.path,
            sceneIndex: session.sceneIndex,
            stepIndex: session.stepIndex,
            step: session.step,
            appliedSteps: session.appliedSteps,
            steps: session.steps,
            width: session.width,
            height: session.height,
          }, null, 2),
        },
        { type: 'image', mimeType: 'image/png', data },
      ],
    };
  } finally {
    await closeBrowser(session.browser);
  }
}

async function renderHtml(args) {
  const { abs, spec } = readSpecFile(args.path);
  const session = await loadRenderPage(spec, abs, args.sceneIndex, args.stepIndex);
  try {
    const html = await session.page.evaluate(() => {
      const root = document.getElementById('root') || document.body;
      const styles = Array.from(document.querySelectorAll('style,link[rel="stylesheet"]'))
        .map((node) => node.outerHTML)
        .join('\n');
      return [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        styles,
        '</head>',
        `<body class="${document.body.className}">`,
        root.outerHTML,
        '</body>',
        '</html>',
      ].join('\n');
    });
    return okResult({
      path: args.path,
      sceneIndex: session.sceneIndex,
      stepIndex: session.stepIndex,
      step: session.step,
      appliedSteps: session.appliedSteps,
      steps: session.steps,
      html,
    });
  } finally {
    await closeBrowser(session.browser);
  }
}

function captureConsole(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const value = fn();
    return { value, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function toolInputSchema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

const TOOLS = [
  {
    name: 'slidey_workspace_tree',
    description: 'List Slidey .slidey.json specs, read-only .readonly.slidey.json specs, and generated .jsonl trace specs.',
    inputSchema: toolInputSchema({}),
  },
  {
    name: 'slidey_read_spec',
    description: 'Read a Slidey spec. .jsonl traces and .readonly.slidey.json decks are returned read-only.',
    inputSchema: toolInputSchema({
      path: { type: 'string', description: 'Workspace-relative .slidey.json, .readonly.slidey.json, or .jsonl path.' },
    }, ['path']),
  },
  {
    name: 'slidey_write_spec',
    description: 'Replace an editable Slidey spec with a full JSON object. New decks should use the .slidey.json extension (e.g. my-deck.slidey.json).',
    inputSchema: toolInputSchema({
      path: { type: 'string', description: 'Workspace-relative path; use the .slidey.json extension for new decks.' },
      spec: { type: 'object' },
    }, ['path', 'spec']),
  },
  {
    name: 'slidey_patch_spec',
    description: 'Edit an editable .slidey.json spec with JSON Patch operations: add, replace, remove, and test.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          required: ['op', 'path'],
          properties: {
            op: { enum: ['add', 'replace', 'remove', 'test'] },
            path: { type: 'string', description: 'JSON Pointer, e.g. /scenes/0/title.' },
            value: {},
          },
        },
      },
    }, ['path', 'operations']),
  },
  {
    name: 'slidey_layout_gallery',
    description: 'List reusable scene layouts that can be inserted as new slides.',
    inputSchema: toolInputSchema({}),
  },
  {
    name: 'slidey_add_slide',
    description: 'Add a new slide from the layout gallery.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      layout: { type: 'string', description: 'One of the IDs returned by slidey_layout_gallery.' },
      insertIndex: {
        type: 'integer',
        minimum: 0,
        description: 'Insert position in scenes array. Defaults to append to end.',
      },
    }, ['path', 'layout']),
  },
  {
    name: 'slidey_duplicate_slide',
    description: 'Duplicate a slide and insert it after the original by default.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      sourceIndex: { type: 'integer', minimum: 0, description: 'Index of the source scene to duplicate.' },
      insertIndex: {
        type: 'integer',
        minimum: 0,
        description: 'Insert position in scenes array. Defaults to sourceIndex + 1.',
      },
    }, ['path', 'sourceIndex']),
  },
  {
    name: 'slidey_remove_slide',
    description: 'Remove a slide from a deck.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      sceneIndex: { type: 'integer', minimum: 0, description: 'Index of the scene to remove.' },
    }, ['path', 'sceneIndex']),
  },
  {
    name: 'slidey_reorder_slide',
    description: 'Move a slide from one index to another.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      fromIndex: { type: 'integer', minimum: 0, description: 'Source index to move.' },
      toIndex: { type: 'integer', minimum: 0, description: 'Destination index in the resulting scenes array.' },
    }, ['path', 'fromIndex', 'toIndex']),
  },
  {
    name: 'slidey_validate',
    description: 'Validate a spec against Slidey JSON Schema and semantic checks. Returns structured errors and warnings.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
    }, ['path']),
  },
  {
    name: 'slidey_scene_summary',
    description: 'Return scene indices, types, titles, reveal steps, estimated timing, and narration snippets.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      fps: { type: 'number', default: 30 },
    }, ['path']),
  },
  {
    name: 'slidey_render_png',
    description: 'Render a particular scene/reveal step as a PNG image using the real Slidey Vue render bundle.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      sceneIndex: { type: 'integer', minimum: 0 },
      stepIndex: { type: 'integer', minimum: 0, description: 'Reveal step index. Omit for final step of the scene.' },
    }, ['path', 'sceneIndex']),
  },
  {
    name: 'slidey_render_html',
    description: 'Render a particular scene/reveal step and return the HTML snapshot of the rendered slide.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      sceneIndex: { type: 'integer', minimum: 0 },
      stepIndex: { type: 'integer', minimum: 0, description: 'Reveal step index. Omit for final step of the scene.' },
    }, ['path', 'sceneIndex']),
  },
  {
    name: 'slidey_check',
    description: 'Run Slidey static diagram-svg geometry checks and return the report.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
    }, ['path']),
  },
  {
    name: 'slidey_audit',
    description: 'Run the browser-based rendered geometry audit. This catches off-page content, overflow, overlap, tiny text, contrast, broken images, and template leaks.',
    inputSchema: toolInputSchema({
      path: { type: 'string' },
      sceneIndex: { type: 'integer', minimum: 0, description: 'Optional single scene to audit.' },
    }, ['path']),
  },
  {
    name: 'slidey_schema',
    description: 'Return the authoritative Slidey JSON Schema used by validation and the editor.',
    inputSchema: toolInputSchema({}),
  },
  {
    name: 'slidey_docs',
    description: 'Return the bundled LLM authoring guide for Slidey specs.',
    inputSchema: toolInputSchema({}),
  },
  {
    name: 'slidey_doctor',
    description: 'Verify headless Chrome can launch and take a screenshot for Slidey rendering tools.',
    inputSchema: toolInputSchema({}),
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'slidey_workspace_tree':
      return okResult({ root: CONFIG.root, children: buildTree(CONFIG.root) });

    case 'slidey_read_spec': {
      const { abs, raw, spec, generated, editable } = readSpecFile(args.path);
      return okResult({ path: relPath(abs), generated, editable: editable, raw: generated ? undefined : raw, spec });
    }

    case 'slidey_write_spec': {
      const written = writeSpecFile(args.path, args.spec);
      const validation = validateSpec(args.spec, { specPath: safeResolve(args.path) });
      return okResult({ ok: validation.valid, written, validation });
    }

    case 'slidey_patch_spec': {
      const { abs, spec } = readSpecFile(args.path);
      ensureEditable(abs);
      const patched = applyJsonPatch(spec, args.operations);
      const written = writeSpecFile(args.path, patched);
      const validation = validateSpec(patched, { specPath: abs });
      return okResult({ ok: validation.valid, written, validation, spec: patched });
    }
    case 'slidey_layout_gallery':
      return okResult({
        layouts: LAYOUT_GALLERY.map((entry) => ({
          id: entry.id,
          label: entry.label,
          type: entry.scene.type,
          scene: entry.scene,
        })),
      });

    case 'slidey_add_slide': {
      const { abs, spec } = readSpecFile(args.path);
      ensureEditable(abs);
      const scenes = cloneSpecValue(Array.isArray(spec.scenes) ? spec.scenes : []);
      const layout = layoutById(args.layout);
      if (!layout) {
        const validLayouts = LAYOUT_GALLERY.map((entry) => entry.id).join(', ');
        throw new Error(`unknown layout "${args.layout}". use slidey_layout_gallery to list valid values: ${validLayouts}`);
      }
      const insertIndex = clampIndexForInsert(args.insertIndex, scenes.length);
      const scene = sanitizeScene(layout.scene);
      scenes.splice(insertIndex, 0, scene);
      const updated = { ...spec, scenes };
      const written = writeSpecFile(args.path, updated);
      const validation = validateSpec(updated, { specPath: abs });
      return okResult({ ok: validation.valid, written, validation, sceneIndex: insertIndex, scene, spec: updated });
    }

    case 'slidey_duplicate_slide': {
      const { abs, spec } = readSpecFile(args.path);
      ensureEditable(abs);
      const scenes = cloneSpecValue(Array.isArray(spec.scenes) ? spec.scenes : []);
      const sourceIndex = clampSceneIndex(args.sourceIndex, scenes.length);
      const insertIndex = clampIndexForInsert(
        Number.isInteger(args.insertIndex) ? args.insertIndex : sourceIndex + 1,
        scenes.length + 1,
      );
      const scene = sanitizeScene(scenes[sourceIndex]);
      scenes.splice(insertIndex, 0, scene);
      const updated = { ...spec, scenes };
      const written = writeSpecFile(args.path, updated);
      const validation = validateSpec(updated, { specPath: abs });
      return okResult({
        ok: validation.valid,
        written,
        validation,
        sourceIndex,
        sceneIndex: insertIndex,
        scene,
        spec: updated,
      });
    }

    case 'slidey_remove_slide': {
      const { abs, spec } = readSpecFile(args.path);
      ensureEditable(abs);
      const scenes = cloneSpecValue(Array.isArray(spec.scenes) ? spec.scenes : []);
      if (scenes.length <= 1) throw new Error('deck must contain at least one scene');
      const sceneIndex = clampSceneIndex(args.sceneIndex, scenes.length);
      const removed = scenes.splice(sceneIndex, 1)[0];
      const updated = { ...spec, scenes };
      const written = writeSpecFile(args.path, updated);
      const validation = validateSpec(updated, { specPath: abs });
      return okResult({
        ok: validation.valid,
        written,
        validation,
        removedSceneIndex: sceneIndex,
        scene: removed,
        sceneCount: updated.scenes.length,
        spec: updated,
      });
    }

    case 'slidey_reorder_slide': {
      const { abs, spec } = readSpecFile(args.path);
      ensureEditable(abs);
      const scenes = cloneSpecValue(Array.isArray(spec.scenes) ? spec.scenes : []);
      const fromIndex = clampSceneIndex(args.fromIndex, scenes.length);
      const toIndex = clampSceneIndex(args.toIndex, scenes.length);
      if (fromIndex === toIndex) {
        return okResult({ ok: true, written: { path: relPath(abs), bytes: 0, mtimeMs: fs.statSync(abs).mtimeMs }, validation: validateSpec(spec, { specPath: abs }), spec, sourceIndex: fromIndex, targetIndex: toIndex });
      }
      const [scene] = scenes.splice(fromIndex, 1);
      scenes.splice(toIndex, 0, scene);
      const updated = { ...spec, scenes };
      const written = writeSpecFile(args.path, updated);
      const validation = validateSpec(updated, { specPath: abs });
      return okResult({ ok: validation.valid, written, validation, sourceIndex: fromIndex, targetIndex: toIndex, spec: updated });
    }

    case 'slidey_validate': {
      const { abs, spec, generated } = readSpecFile(args.path);
      return okResult({ path: relPath(abs), generated, ...validateSpec(spec, { specPath: abs }) });
    }

    case 'slidey_scene_summary': {
      const { abs, spec } = readSpecFile(args.path);
      const { stepsForScene } = await import(pathToFileURL(path.join(ROOT_DIR, 'web', 'sceneSteps.mjs')).href);
      const fps = args.fps || 30;
      const boundaries = estimateBoundaries(spec, null, { specPath: abs });
      return okResult({
        path: relPath(abs),
        fps,
        sceneCount: Array.isArray(spec.scenes) ? spec.scenes.length : 0,
        scenes: (spec.scenes || []).map((scene, i) => {
          const steps = stepsForScene(scene);
          const boundary = boundaries.find((b) => b.sceneIndex === i);
          const narration = Array.isArray(scene.narration)
            ? scene.narration.map((cue) => cue && cue.text).filter(Boolean).join(' ')
            : (scene.narration || '');
          return {
            sceneIndex: i,
            type: scene.type,
            title: scene.title || scene.headline || scene.eyebrow || null,
            stepCount: steps.length || 1,
            steps: steps.length ? steps : [null],
            startSeconds: boundary ? Number((boundary.startFrame / fps).toFixed(3)) : null,
            durationSeconds: boundary ? Number((boundary.durationFrames / fps).toFixed(3)) : null,
            narration: narration ? String(narration).slice(0, 240) : null,
          };
        }),
      });
    }

    case 'slidey_render_png':
      return await renderPng(args);

    case 'slidey_render_html':
      return await renderHtml(args);

    case 'slidey_check': {
      const { spec } = readSpecFile(args.path);
      const { value, output } = captureConsole(() => runCheck(spec));
      return okResult({ path: args.path, violations: value, output });
    }

    case 'slidey_audit': {
      const { abs, spec } = readSpecFile(args.path);
      const selectedScenes = Number.isInteger(args.sceneIndex) ? new Set([args.sceneIndex]) : null;
      const report = await auditSpec(spec, { specPath: abs, selectedScenes });
      return okResult({ path: relPath(abs), ...report });
    }

    case 'slidey_schema':
      return okResult(SCHEMA);

    case 'slidey_docs': {
      const guide = path.join(ROOT_DIR, '.claude', 'skills', 'slidey-authoring', 'SKILL.md');
      let body = fs.readFileSync(guide, 'utf8');
      body = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
      return okResult(body);
    }

    case 'slidey_doctor':
      return okResult(await doctor());

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function callToolWithTimeout(name, args = {}) {
  if (!BROWSER_TOOLS.has(name)) return await callTool(name, args);
  let timer;
  try {
    return await Promise.race([
      callTool(name, args),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${name} timed out after ${BROWSER_TOOL_TIMEOUT_MS}ms while launching or driving Chrome`));
        }, BROWSER_TOOL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function listResources() {
  return [
    {
      uri: 'slidey://schema',
      name: 'Slidey JSON Schema',
      description: 'Authoritative JSON Schema for Slidey specs.',
      mimeType: 'application/json',
    },
    {
      uri: 'slidey://docs',
      name: 'Slidey Authoring Guide',
      description: 'Bundled LLM-facing guide for authoring and debugging Slidey presentations.',
      mimeType: 'text/markdown',
    },
  ];
}

function readResource(uri) {
  if (uri === 'slidey://schema') {
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(SCHEMA, null, 2) }],
    };
  }
  if (uri === 'slidey://docs') {
    const guide = path.join(ROOT_DIR, '.claude', 'skills', 'slidey-authoring', 'SKILL.md');
    let body = fs.readFileSync(guide, 'utf8');
    body = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: body }],
    };
  }
  throw new Error(`unknown resource: ${uri}`);
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return null;
  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'slidey-mcp', version: '1.0.0' },
      };
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      try {
        result = await callToolWithTimeout(params.name, params.arguments || {});
      } catch (err) {
        result = errorResult(err && err.message ? err.message : String(err));
      }
    } else if (method === 'resources/list') {
      result = { resources: listResources() };
    } else if (method === 'resources/read') {
      result = readResource(params.uri);
    } else {
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: err.code || -32000,
        message: err && err.message ? err.message : String(err),
      },
    };
  }
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

let buffer = Buffer.alloc(0);
async function dispatchRawMessage(raw) {
  if (!raw.trim()) return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch (err) {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } });
    return;
  }
  if (message.id === undefined || message.id === null) return;
  const response = await handleRequest(message);
  if (response) writeMessage(response);
}

process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (buffer.length === 0) return;

    if (/^content-length:/i.test(buffer.slice(0, Math.min(buffer.length, 32)).toString('utf8'))) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) {
        process.stderr.write('[slidey-mcp] malformed Content-Length header\n');
        buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const raw = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);
      await dispatchRawMessage(raw);
      continue;
    }

    const lineEnd = buffer.indexOf('\n');
    if (lineEnd === -1) return;
    const raw = buffer.slice(0, lineEnd).toString('utf8').trimEnd();
    buffer = buffer.slice(lineEnd + 1);
    await dispatchRawMessage(raw);
  }
});

process.stdin.resume();
