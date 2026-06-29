#!/usr/bin/env node
/**
 * SLIDEY — Meme template registry builder (dev-time, run once / on refresh)
 *
 * Fetches the open-source memegen.link template catalog and, for each template,
 * its source `config.yml` (which carries per-text-box geometry + a semantic
 * example for every field). Normalizes everything into a single vendored
 * registry — data/meme-templates.json — that ships with slidey.
 *
 * The registry is the source of truth for the `meme` scene type: it tells the
 * renderer where each caption goes, what each field *means* (example hint), and
 * the template's orientation so the layout can letterbox tall/wide/square memes
 * onto the 1920×1080 stage without distortion.
 *
 * Blank template *images* are NOT vendored — they are fetched + cached at render
 * time (see src/memes/cache.js). Only lightweight metadata lives in the repo.
 *
 * Usage:  node scripts/build-meme-registry.js [--limit N] [--concurrency C]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATES_API = 'https://api.memegen.link/templates';
const CONFIG_RAW = id =>
  `https://raw.githubusercontent.com/jacebrowning/memegen/main/templates/${id}/config.yml`;
const OUT = path.resolve(__dirname, '../data/meme-templates.json');

const argv = process.argv.slice(2);
const arg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};
const LIMIT = Number(arg('--limit', 0)) || 0;
const CONCURRENCY = Number(arg('--concurrency', 8));

// ── Tiny, targeted parser for memegen config.yml ────────────────────────────
// The format is regular: a top-level `text:` key whose value is a list of
// mappings, each a flat set of `key: value` pairs. We only need the geometry
// keys; this avoids pulling in a full YAML dependency for a one-time script.
function parseConfig(yaml) {
  const lines = yaml.split(/\r?\n/);
  const out = { name: null, source: null, keywords: [], text: [], example: [] };
  let section = null;      // 'text' | 'example' | 'keywords' | null
  let cur = null;          // current text-box mapping
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const topKey = raw.match(/^([a-z_]+):\s*(.*)$/i);
    if (topKey && !raw.startsWith(' ') && !raw.startsWith('-')) {
      // flush current text box
      if (cur) { out.text.push(cur); cur = null; }
      const key = topKey[1];
      const val = topKey[2];
      if (key === 'text') { section = 'text'; }
      else if (key === 'example') { section = 'example'; }
      else if (key === 'keywords') { section = 'keywords'; }
      else if (key === 'name') { out.name = stripQuotes(val); section = null; }
      else if (key === 'source') { out.source = stripQuotes(val); section = null; }
      else section = null;
      continue;
    }
    if (section === 'text') {
      const item = raw.match(/^\s*-\s*([a-z_]+):\s*(.*)$/i);
      if (item) { if (cur) out.text.push(cur); cur = {}; cur[item[1]] = num(item[2]); continue; }
      const kv = raw.match(/^\s+([a-z_]+):\s*(.*)$/i);
      if (kv && cur) cur[kv[1]] = num(kv[2]);
    } else if (section === 'example') {
      const item = raw.match(/^\s*-\s*(.*)$/);
      if (item) out.example.push(stripQuotes(item[1]));
    } else if (section === 'keywords') {
      const item = raw.match(/^\s*-\s*(.*)$/);
      if (item && item[1].trim()) out.keywords.push(stripQuotes(item[1]));
    }
  }
  if (cur) out.text.push(cur);
  return out;
}
const stripQuotes = s => String(s || '').trim().replace(/^['"]|['"]$/g, '');
const num = s => {
  const t = stripQuotes(s);
  if (t === '') return t;
  const n = Number(t);
  return Number.isNaN(n) ? t : n;
};

// ── Image dimensions from JPEG / PNG / GIF headers (no decode) ───────────────
function imageDims(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {           // PNG
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49) {           // GIF
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {           // JPEG — scan for SOF
    let off = 2;
    while (off < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF0..SOF15 except DHT(c4) DAC(cc) RST markers
      if (marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      const len = buf.readUInt16BE(off + 2);
      off += 2 + len;
    }
  }
  return { w: 0, h: 0 };
}

function orientation(w, h) {
  if (!w || !h) return 'unknown';
  const r = w / h;
  if (r > 1.15) return 'landscape';
  if (r < 0.87) return 'portrait';
  return 'square';
}

// Build normalized text boxes. memegen anchor_x/anchor_y is the box top-left,
// scale_x/scale_y the box w/h, all as fractions of the image (origin top-left).
function boxesFromConfig(cfg, lines) {
  if (Array.isArray(cfg.text) && cfg.text.length) {
    return cfg.text.map((t, i) => ({
      field: `text${i + 1}`,
      hint: cfg.example[i] || null,
      x: clamp(t.anchor_x ?? 0.05),
      y: clamp(t.anchor_y ?? 0.05),
      w: clamp(t.scale_x ?? 0.9),
      h: clamp(t.scale_y ?? 0.18),
      align: t.align || 'center',
      color: t.color || 'white',
      angle: t.angle || 0,
    }));
  }
  return defaultBoxes(lines, cfg.example);
}

// Default top→bottom stack when a template has no custom text geometry.
function defaultBoxes(lines, example = []) {
  const n = Math.max(1, lines || 2);
  const h = 0.18, marginX = 0.04;
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0.04
      : 0.03 + (i / (n - 1)) * (1 - h - 0.06);
    boxes.push({
      field: i === 0 ? 'top' : i === n - 1 ? 'bottom' : `mid${i}`,
      hint: example[i] || null,
      x: marginX, y: clamp(y), w: 1 - marginX * 2, h,
      align: 'center', color: 'white', angle: 0,
    });
  }
  return boxes;
}
const clamp = v => Math.max(0, Math.min(1, Number(v) || 0));

// ── Concurrency helper ──────────────────────────────────────────────────────
async function mapPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.text();
}
async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  process.stderr.write(`Fetching template catalog from ${TEMPLATES_API}…\n`);
  const list = await (await fetch(TEMPLATES_API)).json();
  let templates = list;
  if (LIMIT) templates = templates.slice(0, LIMIT);
  process.stderr.write(`Got ${templates.length} templates. Fetching geometry + dims…\n`);

  let done = 0;
  const entries = await mapPool(templates, async (t) => {
    const [cfgYaml, blankBuf] = await Promise.all([
      fetchText(CONFIG_RAW(t.id)).catch(() => null),
      fetchBuf(t.blank).catch(() => null),
    ]);
    const cfg = cfgYaml ? parseConfig(cfgYaml) : { text: [], example: t.example?.text || [] };
    if (!cfg.example?.length && t.example?.text) cfg.example = t.example.text;
    const dims = blankBuf ? imageDims(blankBuf) : { w: 0, h: 0 };
    const boxes = boxesFromConfig(cfg, t.lines);
    done++;
    if (done % 20 === 0) process.stderr.write(`  …${done}/${templates.length}\n`);
    return {
      id: t.id,
      name: t.name,
      keywords: Array.from(new Set([...(t.keywords || []), ...(cfg.keywords || [])])).filter(Boolean),
      lines: t.lines,
      width: dims.w,
      height: dims.h,
      aspect: dims.w && dims.h ? Number((dims.w / dims.h).toFixed(4)) : null,
      orientation: orientation(dims.w, dims.h),
      blank: t.blank,
      example: cfg.example || (t.example?.text ?? []),
      source: t.source || cfg.source || null,
      boxes,
    };
  }, CONCURRENCY);

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out = {
    _generator: 'scripts/build-meme-registry.js',
    _source: 'https://memegen.link (template metadata + geometry, open source)',
    count: entries.length,
    templates: entries,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  const byOri = entries.reduce((m, e) => (m[e.orientation] = (m[e.orientation] || 0) + 1, m), {});
  process.stderr.write(`Wrote ${entries.length} templates → ${OUT}\n`);
  process.stderr.write(`Orientation mix: ${JSON.stringify(byOri)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
