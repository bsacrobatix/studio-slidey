#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_MARKER = ' [chrome inline smoke]';
const DEFAULT_PORT = 4341;

function parseArgs(argv) {
  const opts = {
    spec: '',
    chrome: CHROME_DEFAULT,
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    marker: DEFAULT_MARKER,
    fieldIndex: 0,
    timeoutMs: 45000,
    headless: false,
    inPlace: false,
    keepCopy: false,
    copySpecName: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (!opts.spec) opts.spec = arg;
      continue;
    }

    if (arg === '--headless') {
      opts.headless = true;
      continue;
    }
    if (arg === '--in-place') {
      opts.inPlace = true;
      continue;
    }
    if (arg === '--keep-copy') {
      opts.keepCopy = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }

    const next = argv[i + 1];
    if (!next) throw new Error(`missing value for ${arg}`);

    if (arg === '--spec') opts.spec = next;
    else if (arg === '--chrome') opts.chrome = next;
    else if (arg === '--port') opts.port = Number(next);
    else if (arg === '--host') opts.host = next;
    else if (arg === '--marker') opts.marker = next;
    else if (arg === '--field-index') opts.fieldIndex = Number(next);
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(next);
    else if (arg === '--copy-spec-name') opts.copySpecName = next;
    else throw new Error(`unknown flag ${arg}`);

    i++;
  }

  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node tools/slidey-edit-mode-smoke.js --spec <spec.json> [options]',
    '',
    'Options:',
    '  --spec <path>            Spec to open in the Slidey workspace viewer',
    '  --in-place               Edit and verify the original spec instead of a temp copy',
    `  --chrome <path>           Chrome executable (default: ${CHROME_DEFAULT})`,
    `  --port <n>                Viewer port (default: ${DEFAULT_PORT})`,
    '  --host <host>             URL host to open (default: 127.0.0.1)',
    `  --marker <text>           Text suffix appended during inline edit (default: "${DEFAULT_MARKER}")`,
    '  --field-index <n>         Which visible editable field to edit first (default: 0)',
    '  --headless                Use Puppeteer headless mode',
    '  --timeout-ms <ms>         Puppeteer timeout budget (default: 45000)',
    '  --keep-copy               Keep the temp spec copy on disk',
    '  --copy-spec-name <name>    Temp spec basename (default: slidey-edit-mode-smoke-copy.slidey.json)',
    '  --help                    Show usage',
    '',
    'Examples:',
    '  node tools/slidey-edit-mode-smoke.js --spec examples/hello.slidey.json',
    '  node tools/slidey-edit-mode-smoke.js --spec /path/to/spec.json --marker " [ok]" --headless',
  ].join('\n');
}

function fail(msg, code = 1) {
  const err = new Error(`[slidey-edit-mode-smoke] ${msg}`);
  err.code = code;
  throw err;
}

function splitLines(data) {
  return String(data || '').split('\n');
}

async function waitForViewerUrl(child, timeoutMs = 20000) {
  return await new Promise((resolve, reject) => {
    const start = Date.now();
    let resolved = false;

    const onLine = (chunk) => {
      if (resolved) return;
      const lines = splitLines(chunk);
      let lastText = '';

      for (const line of lines) {
        const text = String(line || '').trim();
        if (!text) continue;
        lastText = text;
        const match = text.match(/Viewer\s*:\s*(https?:\/\/[^\s]+)/i);
        if (match) {
          resolved = true;
          cleanup();
          resolve(match[1]);
          return;
        }
      }

      if (lastText.startsWith('[slidey] ERROR')) {
        resolved = true;
        cleanup();
        reject(new Error(lastText));
      }
    };

    const cleanup = () => {
      clearInterval(checker);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };

    const onStdout = (chunk) => onLine(chunk);
    const onStderr = (chunk) => onLine(chunk);
    const onExit = (code) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error(`viewer process exited before reporting URL (code ${code})`));
    };

    const checker = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        resolved = true;
        cleanup();
        reject(new Error('timed out waiting for slidey viewer URL'));
      }
    }, 100);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
  });
}

async function startViewer(specPath, port, repoRoot) {
  const child = spawn(process.execPath, ['src/index.js', specPath, '--no-open', '--port', String(port)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await waitForViewerUrl(child, 30000);
  return { child, url };
}

function waitForViewerClose(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const onStop = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for slidey viewer process to exit'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.off('close', onStop);
      child.off('exit', onStop);
    };

    child.once('close', onStop);
    child.once('exit', onStop);
  });
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!opts.spec) return fail(usage());

  const repoRoot = path.resolve(__dirname, '..');
  const specInput = path.resolve(opts.spec);
  if (!fs.existsSync(specInput)) {
    fail(`spec file not found: ${specInput}`);
  }

  const workSpec = opts.inPlace
    ? specInput
    : (() => {
        const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slidey-edit-mode-smoke-'));
        const copyName = opts.copySpecName || 'slidey-edit-mode-smoke-copy.slidey.json';
        const copied = path.join(copyDir, copyName);
        fs.copyFileSync(specInput, copied);
        return copied;
      })();

  const before = fs.readFileSync(workSpec, 'utf8');
  let viewer;
  let browser;
  let page;
  const result = {
    ok: false,
    spec: workSpec,
    marker: opts.marker,
    beforeLength: before.length,
    afterLength: 0,
    editorTarget: null,
    saveEnabled: false,
    savedText: null,
  };

  try {
    viewer = await startViewer(workSpec, opts.port, repoRoot);
    const targetUrl = new URL(viewer.url);
    targetUrl.host = `${opts.host}:${targetUrl.port}`;
    const url = targetUrl.toString();

    browser = await puppeteer.launch({
      executablePath: opts.chrome,
      headless: opts.headless,
      defaultViewport: { width: 1600, height: 1000 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    await page.waitForSelector('.slidey-mode-toggle button:nth-child(2)', { timeout: opts.timeoutMs });
    await page.click('.slidey-mode-toggle button:nth-child(2)');
    await page.waitForSelector('.slidey-editor-save', { timeout: opts.timeoutMs });

    const target = await page.evaluate((fieldIndex) => {
      const candidates = Array.from(document.querySelectorAll('[data-edit-path]')).filter((n) => {
        const rect = n.getBoundingClientRect();
        const style = getComputedStyle(n);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });

      const targetEl = candidates[fieldIndex] || candidates[0];
      if (!targetEl) return null;

      targetEl.classList.add('__slidey_smoke_target');
      return {
        path: targetEl.getAttribute('data-edit-path') || '',
        before: (targetEl.textContent || '').slice(0, 200),
        tag: targetEl.tagName.toLowerCase(),
      };
    }, opts.fieldIndex);

    if (!target) fail('No visible [data-edit-path] editable target found');

    result.editorTarget = target;
    await page.click('.__slidey_smoke_target');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(opts.marker);
    await page.keyboard.press('Enter');

    await page.waitForFunction(() => {
      const save = document.querySelector('.slidey-editor-save');
      return save && save.textContent.trim() === 'Save' && !save.disabled;
    }, { timeout: opts.timeoutMs });

    result.saveEnabled = true;
    await page.click('.slidey-editor-save');

    await page.waitForFunction(() => {
      const save = document.querySelector('.slidey-editor-save');
      return save && save.textContent.trim() === 'Saved';
    }, { timeout: opts.timeoutMs });

    const after = fs.readFileSync(workSpec, 'utf8');
    result.afterLength = after.length;
    result.ok = after !== before && after.includes(opts.marker);
    result.savedText = after.includes(opts.marker) ? 'marker found' : 'marker missing';

    if (!result.ok) {
      fail('Saved file did not include marker or did not change');
    }

    console.log(
      JSON.stringify(
        {
          ...result,
          viewer: url,
          inPlace: opts.inPlace,
          tempSpec: opts.inPlace ? null : workSpec,
        },
        null,
        2,
      ),
    );
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (viewer?.child) {
      viewer.child.kill('SIGTERM');
      await waitForViewerClose(viewer.child, 3000).catch(() => {
        viewer.child.kill('SIGKILL');
        return waitForViewerClose(viewer.child, 1000).catch(() => {});
      });
    }
    if (!opts.inPlace && workSpec && !opts.keepCopy) {
      fs.rmSync(path.dirname(workSpec), { recursive: true, force: true });
    }
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    const message = String(err && err.message ? err.message : err);
    const code = Number(err && err.code) || 1;
    console.error(message);
    process.exit(code);
  });
