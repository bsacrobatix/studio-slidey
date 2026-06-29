/**
 * SLIDEY — Meme template registry
 *
 * Loads the vendored template catalog (data/meme-templates.json, produced by
 * scripts/build-meme-registry.js) and exposes lookup + fuzzy search. Each
 * template carries its orientation and per-box geometry + semantic field hints,
 * so the `meme` scene knows exactly where each caption goes and what it means.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.resolve(__dirname, '../../data/meme-templates.json');
const CUSTOM_PATH = path.resolve(__dirname, '../../data/meme-templates.custom.json');

function readTemplates(p) {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(raw.templates) ? raw.templates : [];
  } catch (_) {
    return [];
  }
}

let _cache = null;
function load() {
  if (_cache) return _cache;
  // Curated extras (templates not in memegen) override/extend the generated set.
  const byId = new Map(readTemplates(REGISTRY_PATH).map(t => [t.id, t]));
  for (const t of readTemplates(CUSTOM_PATH)) byId.set(t.id, t);
  _cache = { templates: [...byId.values()], byId };
  return _cache;
}

function list() {
  return load().templates;
}

/** Normalize an id to its canonical key: lowercase, trimmed, spaces/underscores → hyphens. */
function normId(id) {
  return String(id).toLowerCase().trim().replace(/[\s_]+/g, '-');
}

function get(id) {
  if (!id) return null;
  const byId = load().byId;
  return byId.get(String(id).toLowerCase().trim()) || byId.get(normId(id)) || null;
}

/** Normalize free text to comparable tokens. */
function tokens(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9']+/g) || [];
}

/**
 * Fuzzy-search templates by id / name / keywords / example hints.
 * Returns scored matches, best first. Optional `orientation` filter
 * ('landscape' | 'portrait' | 'square') helps pick a meme that fits a slot.
 */
function search(query, opts = {}) {
  const { orientation = null, limit = 20 } = opts;
  const q = String(query || '').toLowerCase().trim();
  const qTokens = tokens(q);
  let items = list();
  if (orientation) items = items.filter(t => t.orientation === orientation);
  if (!q) return items.slice(0, limit).map(t => ({ ...summary(t), score: 0 }));

  const scored = items.map(t => {
    const name = t.name.toLowerCase();
    const id = t.id.toLowerCase();
    const hay = [
      name,
      id,
      ...(t.keywords || []),
      ...(t.example || []),
    ].join(' \n ').toLowerCase();
    let score = 0;
    if (id === q || name === q) score += 100;
    if (name.includes(q)) score += 40;
    if (id.includes(q.replace(/\s+/g, '-'))) score += 30;
    if ((t.keywords || []).some(k => k.toLowerCase().includes(q))) score += 25;
    for (const tok of qTokens) {
      if (!tok) continue;
      if (name.includes(tok)) score += 8;
      if (hay.includes(tok)) score += 3;
    }
    return { t, score };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(x => ({ ...summary(x.t), score: x.score }));
}

/** Compact, author-facing view of a template (no heavy geometry). */
function summary(t) {
  return {
    id: t.id,
    name: t.name,
    orientation: t.orientation,
    aspect: t.aspect,
    lines: t.boxes.length,
    fields: t.boxes.map(b => ({ field: b.field, hint: b.hint })),
    keywords: t.keywords,
  };
}

module.exports = { list, get, search, summary, REGISTRY_PATH };
