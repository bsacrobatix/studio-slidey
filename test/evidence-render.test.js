'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { launchOptions, closeBrowser, doctor } = require('../src/browser');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'dist-render', 'render.html');
const haveBundle = fs.existsSync(BUNDLE);

let browserReady;
async function requireBrowser(t) {
  if (!browserReady) browserReady = doctor({ width: 320, height: 180 });
  const ready = await browserReady;
  if (!ready.ok) {
    t.skip(`browser unavailable: ${ready.error}`);
    return false;
  }
  return true;
}

test('evidence scene reveals status glyphs and reference chips', { skip: !haveBundle && 'run npm run build:render first' }, async (t) => {
  if (!await requireBrowser(t)) return;
  const browser = await puppeteer.launch(launchOptions({ width: 1920, height: 1080 }));
  t.after(() => closeBrowser(browser));

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(`file://${BUNDLE}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__slideyReady === true', { timeout: 15000 });
  await page.evaluate(() => {
    window.slidey.setMeta({ title: 'Evidence render test' });
    window.slidey.setMode('pitch');
    document.body.classList.add('instant');
  });

  const scene = {
    type: 'evidence',
    title: 'Latest check state',
    items: [
      {
        label: 'PostgreSQL',
        status: 'validated',
        detail: 'baseline red / fix green',
        refType: 'command',
        ref: 'bash tools/product-journey/checks/postgresql-oracle.sh',
      },
      {
        label: 'HTML preview',
        status: 'issue',
        detail: 'blocked in this environment',
        refType: 'log',
        ref: '.context/product-journey-runlog.md',
      },
    ],
  };
  const { stepsForScene, applyShow } = await import('../web/sceneSteps.mjs');
  await page.evaluate(applyShow, scene, {});
  for (const step of stepsForScene(scene)) {
    await page.evaluate(s => window.slidey.setState(s), step);
  }
  await page.evaluate('window.__slideySettle && window.__slideySettle()');

  const result = await page.evaluate(() => ({
    glyphs: [...document.querySelectorAll('.evidence-glyph')]
      .filter(el => Number(getComputedStyle(el).opacity) > 0.9)
      .map(el => el.textContent.trim()),
    refs: [...document.querySelectorAll('.evidence-ref code')]
      .map(el => el.textContent.trim()),
  }));

  assert.deepEqual(result.glyphs, ['✓', '!']);
  assert.deepEqual(result.refs, [
    'bash tools/product-journey/checks/postgresql-oracle.sh',
    '.context/product-journey-runlog.md',
  ]);
});
