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

test('objectives scene reveals visible status glyphs', { skip: !haveBundle && 'run npm run build:render first' }, async (t) => {
  if (!await requireBrowser(t)) return;
  const browser = await puppeteer.launch(launchOptions({ width: 1920, height: 1080 }));
  t.after(() => closeBrowser(browser));

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(`file://${BUNDLE}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__slideyReady === true', { timeout: 15000 });
  await page.evaluate(() => {
    window.slidey.setMeta({ title: 'Objectives render test' });
    window.slidey.setMode('pitch');
    document.body.classList.add('instant');
  });

  const scene = {
    type: 'objectives',
    title: 'Objective status',
    items: [
      { label: 'Harness objective', status: 'done', detail: 'Complete.' },
      { label: 'HTML preview', status: 'issue', detail: 'Blocked.' },
    ],
  };
  const { stepsForScene, applyShow } = await import('../web/sceneSteps.mjs');
  await page.evaluate(applyShow, scene, {});
  for (const step of stepsForScene(scene)) {
    await page.evaluate(s => window.slidey.setState(s), step);
  }
  await page.evaluate('window.__slideySettle && window.__slideySettle()');

  const glyphs = await page.evaluate(() => [...document.querySelectorAll('.objective-glyph')]
    .filter(el => Number(getComputedStyle(el).opacity) > 0.9)
    .map(el => el.textContent.trim()));

  assert.deepEqual(glyphs, ['✓', '!']);
});
