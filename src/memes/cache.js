/**
 * SLIDEY — Meme blank-image cache
 *
 * Meme template *images* are not vendored — they are fetched from memegen.link
 * on first use and cached on disk, then inlined as data URIs so the headless
 * render (and PNG/PDF/MP4 export) is deterministic and self-contained.
 *
 * Cache dir: $SLIDEY_CACHE_DIR/memes  (default ~/.cache/slidey/memes).
 * On a network failure we fall back to the remote URL so the browser can still
 * attempt to load it rather than rendering a blank frame.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

function cacheDir() {
  const base = process.env.SLIDEY_CACHE_DIR
    || path.join(os.homedir(), '.cache', 'slidey');
  return path.join(base, 'memes');
}

function extFromUrl(url) {
  const m = String(url || '').match(/\.(png|jpe?g|gif|webp)(?:\?|$)/i);
  return m ? `.${m[1].toLowerCase()}` : '.png';
}

function toDataUri(buf, ext) {
  const mime = MIME[ext] || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Resolve a template's blank image to an inlinable data URI, using the on-disk
 * cache. Returns the remote URL as a fallback if the fetch fails.
 * @param {{id:string, blank:string}} template
 */
async function memeImageDataUri(template) {
  if (!template || !template.blank) return '';
  const ext = extFromUrl(template.blank);
  const dir = cacheDir();
  const file = path.join(dir, `${template.id}${ext}`);

  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      return toDataUri(fs.readFileSync(file), ext);
    }
  } catch (_) { /* fall through to fetch */ }

  try {
    const res = await fetch(template.blank);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(file, buf); } catch (_) { /* cache write best-effort */ }
    return toDataUri(buf, ext);
  } catch (_) {
    // Offline / fetch failed — let the browser try the remote URL directly.
    return template.blank;
  }
}

/**
 * Synchronous best-effort variant: returns a cached data URI if the blank is
 * already on disk, else ''. Used by the PDF/PNG export path (sceneShowOpts is
 * sync); a cache miss just falls back to the remote blank URL in the viewer.
 */
function memeImageDataUriSync(template) {
  if (!template || !template.blank) return '';
  const ext = extFromUrl(template.blank);
  const file = path.join(cacheDir(), `${template.id}${ext}`);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      return toDataUri(fs.readFileSync(file), ext);
    }
  } catch (_) { /* ignore */ }
  return '';
}

module.exports = { memeImageDataUri, memeImageDataUriSync, cacheDir };
