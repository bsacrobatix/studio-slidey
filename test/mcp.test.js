'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

function startMcpProcess(command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return wrapMcpProcess(child);
}

function startServer(root, opts = {}) {
  return startMcpProcess(process.execPath, [path.join(__dirname, '..', 'src', 'mcp.js'), '--root', root], {
    cwd: REPO_ROOT,
    env: opts.env,
  });
}

function wrapMcpProcess(child) {
  let out = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  function resolveMessage(message) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      entry.resolve(message);
    }
  }
  child.stdout.on('data', (chunk) => {
    out = Buffer.concat([out, chunk]);
    while (true) {
      if (/^content-length:/i.test(out.slice(0, Math.min(out.length, 32)).toString('utf8'))) {
        const headerEnd = out.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = out.slice(0, headerEnd).toString('utf8');
        const match = header.match(/content-length:\s*(\d+)/i);
        if (!match) throw new Error(`malformed Content-Length header: ${header}`);
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (out.length < bodyStart + length) return;
        const raw = out.slice(bodyStart, bodyStart + length).toString('utf8');
        out = out.slice(bodyStart + length);
        if (!raw.trim()) continue;
        resolveMessage(JSON.parse(raw));
        continue;
      }
      const lineEnd = out.indexOf('\n');
      if (lineEnd === -1) return;
      const raw = out.slice(0, lineEnd).toString('utf8');
      out = out.slice(lineEnd + 1);
      if (!raw.trim()) continue;
      resolveMessage(JSON.parse(raw));
    }
  });
  child.stderr.on('data', () => {});
  child.on('exit', (code, signal) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error(`server exited while waiting for response ${id}: code=${code} signal=${signal}`));
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timed out waiting for ${method}`));
      }, 5000).unref();
    });
  }

  return { child, send };
}

function readCodexSlideyConfig() {
  const configPath = path.join(REPO_ROOT, '.codex', 'config.toml');
  if (!fs.existsSync(configPath)) return null;
  const body = fs.readFileSync(configPath, 'utf8');
  const section = body.match(/\[mcp_servers\.slidey\]([\s\S]*?)(?:\n\[|$)/);
  assert.ok(section, 'missing [mcp_servers.slidey] in .codex/config.toml');
  const text = section[1];
  const command = (text.match(/^\s*command\s*=\s*"([^"]+)"/m) || [])[1];
  const cwd = (text.match(/^\s*cwd\s*=\s*"([^"]+)"/m) || [])[1];
  const argsBody = (text.match(/^\s*args\s*=\s*\[([^\]]*)\]/m) || [])[1];
  assert.ok(command, 'missing slidey MCP command');
  assert.ok(cwd, 'missing slidey MCP cwd');
  assert.ok(argsBody, 'missing slidey MCP args');
  const args = Array.from(argsBody.matchAll(/"([^"]*)"/g), (match) => match[1]);
  return { command, args, cwd };
}

function readProjectMcpConfig() {
  const configPath = path.join(REPO_ROOT, '.mcp.json');
  const doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const server = doc.mcpServers && doc.mcpServers.slidey;
  assert.ok(server, 'missing mcpServers.slidey in .mcp.json');
  assert.equal(typeof server.command, 'string', 'slidey MCP command must be a string');
  assert.ok(Array.isArray(server.args), 'slidey MCP args must be an array');
  assert.ok(!JSON.stringify(server).includes('/Users/brad/code/slidey'), 'slidey MCP config must not reference the old checkout path');
  return server;
}

test('MCP server exposes spec editing and validation over stdio', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-mcp-test-'));
  const specPath = path.join(root, 'deck.json');
  fs.writeFileSync(specPath, JSON.stringify({
    scenes: [
      { type: 'title', title: 'Before', subtitle: 'MCP' },
    ],
  }, null, 2) + '\n');

  const server = startServer(root);
  t.after(() => server.child.kill());

  const init = await server.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.ifError(init.error);
  assert.equal(init.result.serverInfo.name, 'slidey-mcp');

  const tools = await server.send('tools/list');
  assert.ifError(tools.error);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('slidey_patch_spec'));
  assert.ok(names.includes('slidey_render_png'));
  assert.ok(names.includes('slidey_layout_gallery'));
  assert.ok(names.includes('slidey_add_slide'));
  assert.ok(names.includes('slidey_duplicate_slide'));
  assert.ok(names.includes('slidey_remove_slide'));
  assert.ok(names.includes('slidey_reorder_slide'));

  const patch = await server.send('tools/call', {
    name: 'slidey_patch_spec',
    arguments: {
      path: 'deck.json',
      operations: [
        { op: 'replace', path: '/scenes/0/title', value: 'After' },
      ],
    },
  });
  assert.ifError(patch.error);
  const patchPayload = JSON.parse(patch.result.content[0].text);
  assert.equal(patchPayload.ok, true);
  assert.equal(patchPayload.spec.scenes[0].title, 'After');

  const validate = await server.send('tools/call', {
    name: 'slidey_validate',
    arguments: { path: 'deck.json' },
  });
  assert.ifError(validate.error);
  const validation = JSON.parse(validate.result.content[0].text);
  assert.equal(validation.valid, true);

  const gallery = await server.send('tools/call', {
    name: 'slidey_layout_gallery',
    arguments: {},
  });
  assert.ifError(gallery.error);
  const galleryPayload = JSON.parse(gallery.result.content[0].text);
  assert.ok(Array.isArray(galleryPayload.layouts));
  assert.ok(galleryPayload.layouts.some((entry) => entry.id === 'title'));

  const escape = await server.send('tools/call', {
    name: 'slidey_read_spec',
    arguments: { path: '../deck.json' },
  });
  assert.ifError(escape.error);
  assert.equal(escape.result.isError, true);
  assert.match(escape.result.content[0].text, /escapes workspace root/);
});

test('MCP slide-management tools add, duplicate, reorder, and remove', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-mcp-slide-tools-'));
  const specPath = path.join(root, 'deck.json');
  fs.writeFileSync(specPath, JSON.stringify({
    scenes: [
      { type: 'title', title: 'A', subtitle: 'first' },
      { type: 'narrative', body: 'second' },
    ],
  }, null, 2) + '\n');

  const server = startServer(root);
  t.after(() => server.child.kill());

  const init = await server.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.ifError(init.error);

  const add = await server.send('tools/call', {
    name: 'slidey_add_slide',
    arguments: {
      path: 'deck.json',
      layout: 'code-source',
      insertIndex: 1,
    },
  });
  assert.ifError(add.error);
  const addPayload = JSON.parse(add.result.content[0].text);
  assert.equal(addPayload.sceneIndex, 1);
  assert.equal(addPayload.spec.scenes.length, 3);

  const duplicate = await server.send('tools/call', {
    name: 'slidey_duplicate_slide',
    arguments: {
      path: 'deck.json',
      sourceIndex: 0,
    },
  });
  assert.ifError(duplicate.error);
  const duplicatePayload = JSON.parse(duplicate.result.content[0].text);
  assert.equal(duplicatePayload.sceneIndex, 1);
  assert.equal(duplicatePayload.spec.scenes.length, 4);

  const reorder = await server.send('tools/call', {
    name: 'slidey_reorder_slide',
    arguments: {
      path: 'deck.json',
      fromIndex: 2,
      toIndex: 0,
    },
  });
  assert.ifError(reorder.error);
  const reorderPayload = JSON.parse(reorder.result.content[0].text);
  assert.equal(reorderPayload.targetIndex, 0);
  assert.equal(reorderPayload.spec.scenes[0].type, 'code');
  assert.equal(reorderPayload.spec.scenes.length, 4);

  const remove = await server.send('tools/call', {
    name: 'slidey_remove_slide',
    arguments: {
      path: 'deck.json',
      sceneIndex: 1,
    },
  });
  assert.ifError(remove.error);
  const removePayload = JSON.parse(remove.result.content[0].text);
  assert.equal(removePayload.sceneCount, 3);
});

test('MCP validates an ABSOLUTE spec path outside the workspace root', async (t) => {
  // Regression: safeResolve() previously did path.resolve(root, './' + input),
  // which mangled an absolute path into `<root>/abs/...` → "spec not found".
  // An explicit absolute path (e.g. a deck in another repo) must validate.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-mcp-root-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-mcp-elsewhere-'));
  const absSpec = path.join(elsewhere, 'outside.slidey.json');
  fs.writeFileSync(absSpec, JSON.stringify({
    scenes: [{ type: 'title', title: 'Outside', subtitle: 'absolute path' }],
  }, null, 2) + '\n');

  const server = startServer(root);
  t.after(() => server.child.kill());

  const init = await server.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.ifError(init.error);

  const validate = await server.send('tools/call', {
    name: 'slidey_validate',
    arguments: { path: absSpec },
  });
  assert.ifError(validate.error);
  assert.notEqual(validate.result.isError, true, validate.result.content && validate.result.content[0] && validate.result.content[0].text);
  const validation = JSON.parse(validate.result.content[0].text);
  assert.equal(validation.valid, true);
});

test('MCP browser diagnostics return instead of hanging when Chrome cannot launch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-mcp-browser-test-'));
  const server = startServer(root, {
    env: {
      SLIDEY_CHROME_PATH: path.join(root, 'missing-chrome'),
      SLIDEY_MCP_BROWSER_TIMEOUT_MS: '1000',
    },
  });
  t.after(() => server.child.kill());

  const init = await server.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.ifError(init.error);

  const doctor = await server.send('tools/call', {
    name: 'slidey_doctor',
    arguments: {},
  });
  assert.ifError(doctor.error);
  const payload = JSON.parse(doctor.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.executablePath, path.join(root, 'missing-chrome'));
  assert.match(payload.error, /missing-chrome|ENOENT|not found|executable/i);
});

test('Codex MCP config starts Slidey and lists tools', async (t) => {
  const config = readCodexSlideyConfig();
  if (!config) {
    t.skip('no local .codex/config.toml');
    return;
  }
  const server = startMcpProcess(config.command, config.args, { cwd: config.cwd });
  t.after(() => server.child.kill());

  const init = await server.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'slidey-mcp-test', version: '0' },
  });
  assert.ifError(init.error);
  assert.equal(init.result.serverInfo.name, 'slidey-mcp');

  const tools = await server.send('tools/list');
  assert.ifError(tools.error);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('slidey_workspace_tree'));
  assert.ok(names.includes('slidey_doctor'));
});

test('project MCP config starts Slidey from the repo root', async (t) => {
  const config = readProjectMcpConfig();
  const server = startMcpProcess(config.command, config.args, { cwd: REPO_ROOT });
  t.after(() => server.child.kill());

  const init = await server.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'slidey-project-mcp-test', version: '0' },
  });
  assert.ifError(init.error);
  assert.equal(init.result.serverInfo.name, 'slidey-mcp');

  const tools = await server.send('tools/list');
  assert.ifError(tools.error);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('slidey_workspace_tree'));
  assert.ok(names.includes('slidey_doctor'));
});
