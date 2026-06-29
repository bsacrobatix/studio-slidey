<script setup>
// SLIDEY — Personas / use-cases scene
//
// Two layouts that share ONE cast of personas so a viewer can see "who is doing
// what" with a consistent, stylized avatar in every place a persona appears:
//
//   variant: "cast"       — the cast intro. A card per persona: avatar + name +
//                           role + a one-line intro. Used to introduce the roles
//                           before the story runs.
//   variant: "use-cases"  — a titled list of actions, each attributed to a
//                           persona via `who: <persona-id>`. The persona's avatar
//                           renders inline beside the action so the role doing
//                           each step is legible at a glance.
//
// Personas are resolved by id from `meta.personas` (the deck-wide cast registry),
// so the same avatar identity recurs across every scene. A scene MAY also carry
// its own `personas: [...]` (full objects) to be self-contained; those merge over
// the registry by id.
//
// A persona: { id, name, role, intro, color, glyph }
//   color  accent hex (e.g. "#58a6ff") — tints the avatar ring + name
//   glyph  an emoji or 1–2 initials shown in the avatar chip (falls back to the
//          first letters of the name)
//
// Reveal step namespace (mirrors src/scenes/personas.js + stepsForScene()):
//   personas_title              → personas-title
//   personas_item_<i>           → personas-item-<i>   (one per card / case row)
//   personas_caption            → personas-caption
import { computed } from 'vue';
import { store } from '../store.js';

const sc = computed(() => store.scene || {});
const variant = computed(() => sc.value.variant || 'cast');
const isUseCases = computed(() => variant.value === 'use-cases');
const shown = name => store.isRevealed(name);

// Cast registry: meta.personas (deck-wide) overlaid with any scene-level
// personas (full objects), keyed by id. Returns a Map id → persona.
const registry = computed(() => {
  const map = new Map();
  const add = (p) => { if (p && p.id) map.set(p.id, { ...(map.get(p.id) || {}), ...p }); };
  ((store.meta && store.meta.personas) || []).forEach(add);
  (sc.value.personas || []).forEach((p) => (typeof p === 'object' ? add(p) : null));
  return map;
});

// Resolve a persona reference (an id string, or an inline persona object) to a
// fully-populated persona, falling back to a neutral placeholder.
function resolve(ref) {
  const p = typeof ref === 'string' ? registry.value.get(ref) : ref;
  const base = p || (typeof ref === 'string' ? { id: ref, name: ref } : { name: '?' });
  return {
    id: base.id || '',
    name: base.name || base.id || '?',
    role: base.role || '',
    intro: base.intro || '',
    color: base.color || '#58a6ff',
    glyph: base.glyph || initials(base.name || base.id || '?'),
    // Optional image avatar (URL or data-URI, e.g. an SVG logo). When present it
    // fills the avatar chip instead of the glyph.
    avatar: base.avatar || '',
  };
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarStyle(p) {
  return {
    color: p.color,
    borderColor: p.color,
    background: `color-mix(in srgb, ${p.color} 18%, #0d1117)`,
  };
}

// CAST: one resolved persona per scene.personas entry.
const castPersonas = computed(() => (sc.value.personas || []).map(resolve));

// USE-CASES: each case row carries its resolved persona.
const cases = computed(() => (sc.value.cases || []).map(c => ({
  action: c.action || '',
  detail: c.detail || '',
  persona: resolve(c.who),
})));

function castColumns(n) {
  if (n <= 1) return 1;
  if (n === 4) return 2;
  if (n <= 3) return n;
  return 3;
}
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${sc.value.columns || castColumns(castPersonas.value.length)}, minmax(0, 1fr))`,
}));
</script>

<template>
  <div
    id="personas-region"
    class="scene-region active"
    :class="[`personas-variant-${variant}`]"
  >
    <div
      v-if="sc.title"
      id="personas-title"
      class="personas-title reveal"
      :class="{ shown: shown('personas-title') }"
      data-edit-path='["title"]'
    >{{ sc.title }}</div>

    <!-- CAST: avatar + name + role + intro -->
    <div v-if="!isUseCases" class="personas-grid" :style="gridStyle">
      <div
        v-for="(p, i) in castPersonas"
        :key="p.id || i"
        :id="`personas-item-${i}`"
        class="persona-card reveal"
        :class="{ shown: shown(`personas-item-${i}`) }"
      >
        <div class="persona-avatar" :class="{ 'persona-avatar-img': p.avatar }" :style="avatarStyle(p)">
          <img v-if="p.avatar" :src="p.avatar" :alt="p.name" class="persona-avatar-image" />
          <template v-else>{{ p.glyph }}</template>
        </div>
        <div class="persona-body">
          <div class="persona-name" :style="{ color: p.color }">{{ p.name }}</div>
          <div v-if="p.role" class="persona-role">{{ p.role }}</div>
          <div v-if="p.intro" class="persona-intro">{{ p.intro }}</div>
        </div>
      </div>
    </div>

    <!-- USE-CASES: who-does-what action rows -->
    <div v-else class="personas-cases">
      <div
        v-for="(c, i) in cases"
        :key="i"
        :id="`personas-item-${i}`"
        class="usecase-row reveal"
        :class="{ shown: shown(`personas-item-${i}`) }"
      >
        <div class="usecase-actor">
          <div class="persona-avatar persona-avatar-sm" :class="{ 'persona-avatar-img': c.persona.avatar }" :style="avatarStyle(c.persona)">
            <img v-if="c.persona.avatar" :src="c.persona.avatar" :alt="c.persona.name" class="persona-avatar-image" />
            <template v-else>{{ c.persona.glyph }}</template>
          </div>
          <div class="usecase-actor-name" :style="{ color: c.persona.color }">{{ c.persona.name }}</div>
        </div>
        <div class="usecase-text">
          <div class="usecase-action" :data-edit-path="JSON.stringify(['cases', i, 'action'])">{{ c.action }}</div>
          <div v-if="c.detail" class="usecase-detail" :data-edit-path="JSON.stringify(['cases', i, 'detail'])">{{ c.detail }}</div>
        </div>
      </div>
    </div>

    <div
      v-if="sc.caption"
      id="personas-caption"
      class="personas-caption reveal"
      :class="{ shown: shown('personas-caption') }"
      data-edit-path='["caption"]'
    >{{ sc.caption }}</div>
  </div>
</template>

<style scoped>
#personas-region {
  gap: 30px;
  width: 100%;
  max-width: 1640px;
  margin: 0 auto;
  font-family: 'JetBrains Mono', 'Courier New', monospace;
}
.personas-title {
  font-size: 30px;
  font-weight: bold;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: #58a6ff;
  text-align: center;
}
.personas-caption {
  font-size: 22px;
  color: #cdd9e5;
  text-align: center;
  max-width: 1400px;
  line-height: 1.35;
  margin: 0 auto;
}

/* Stylized avatar chip — a colored ring with the persona's glyph/initials. */
.persona-avatar {
  flex-shrink: 0;
  width: 88px;
  height: 88px;
  border-radius: 50%;
  border: 2.5px solid #58a6ff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 44px;
  line-height: 1;
  font-weight: bold;
  box-shadow: 0 0 0 6px rgba(88, 166, 255, 0.07);
}
.persona-avatar-sm {
  width: 66px;
  height: 66px;
  font-size: 33px;
  border-width: 2px;
  box-shadow: none;
}
/* Image avatar (e.g. a logo SVG): the image fills the circular chip; the colored
   ring + halo from avatarStyle still frames it as the persona's identity. */
.persona-avatar-img { overflow: hidden; padding: 0; }
.persona-avatar-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
  display: block;
}

/* ── CAST grid ─────────────────────────────────────────────────────────────── */
.personas-grid {
  display: grid;
  gap: 22px;
  width: 100%;
  align-items: stretch;
}
.persona-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 16px;
  padding: 28px 30px;
  display: flex;
  align-items: flex-start;
  gap: 22px;
  min-width: 0;
}
.persona-body { min-width: 0; }
.persona-name {
  font-size: 34px;
  font-weight: bold;
  line-height: 1.2;
}
.persona-role {
  font-size: 23px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #8b949e;
  margin-top: 6px;
}
.persona-intro {
  font-size: 26px;
  color: #cdd9e5;
  line-height: 1.4;
  margin-top: 14px;
}

/* ── USE-CASES rows ────────────────────────────────────────────────────────── */
.personas-cases {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 1500px;
  margin: 0 auto;
}
.usecase-row {
  display: flex;
  align-items: center;
  gap: 26px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 14px;
  padding: 18px 28px;
}
.usecase-actor {
  flex-shrink: 0;
  width: 176px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
}
.usecase-actor-name {
  font-size: 22px;
  font-weight: bold;
  text-align: center;
  line-height: 1.15;
}
.usecase-text {
  min-width: 0;
  border-left: 1px solid #30363d;
  padding-left: 28px;
}
.usecase-action {
  font-size: 31px;
  color: #e6edf3;
  font-weight: bold;
  line-height: 1.3;
}
.usecase-detail {
  font-size: 25px;
  color: #8b949e;
  line-height: 1.4;
  margin-top: 9px;
}
</style>
