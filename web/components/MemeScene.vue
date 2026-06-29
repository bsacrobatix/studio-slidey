<script setup>
import { computed } from 'vue';
import { store } from '../store.js';

const sc = computed(() => store.scene || {});
const shown = name => store.isRevealed(name);
const tpl = computed(() => store.memeTemplate || null);
const src = computed(() => store.memeDataUri || (tpl.value && tpl.value.blank) || '');
const fit = computed(() => (sc.value.fit === 'cover' ? 'cover' : 'contain'));
const style = computed(() => sc.value.style || {});
const impact = computed(() => style.value.impact === true);

// The container is sized to the template aspect ratio so caption boxes — which
// use the template's normalized (0..1) geometry — land exactly over the image,
// regardless of orientation (tall / wide / square all letterbox cleanly).
const aspect = computed(() => {
  const t = tpl.value;
  if (t && t.aspect) return t.aspect;
  if (t && t.width && t.height) return t.width / t.height;
  return 1;
});

// The stage available box (matches the CSS: region max-width / stage height).
const STAGE_W = 1680;
const STAGE_H = 820;

// Deterministic contain-fit: size the canvas to the template aspect ratio within
// the stage box. Captions are positioned + sized off this known pixel box, so
// portrait / landscape / square memes all letterbox cleanly with no distortion.
const canvasBox = computed(() => {
  if (fit.value === 'cover') return { w: STAGE_W, h: STAGE_H };
  let h = STAGE_H;
  let w = h * aspect.value;
  if (w > STAGE_W) { w = STAGE_W; h = w / aspect.value; }
  return { w: Math.round(w), h: Math.round(h) };
});
const canvasStyle = computed(() => ({
  width: `${canvasBox.value.w}px`,
  height: `${canvasBox.value.h}px`,
}));

function captionFor(box, i) {
  const s = sc.value;
  if (s.fields && box.field in s.fields) return String(s.fields[box.field] ?? '');
  if (Array.isArray(s.text) && s.text[i] != null) return String(s.text[i]);
  return '';
}

// Only filled boxes reveal (index must match scenes/meme.js reveal order).
const boxes = computed(() => {
  const list = (tpl.value && tpl.value.boxes) || [];
  let revealIdx = -1;
  return list.map((b, i) => {
    const text = captionFor(b, i);
    if (text !== '') revealIdx += 1;
    return { box: b, i, text, revealIdx };
  }).filter(x => x.text !== '');
});

// Deterministic auto-fit: largest font (px) at which `text` fits inside a box of
// w×h px, accounting for word wrapping. No DOM measurement (keeps renders
// reproducible). Constants approximate a condensed bold meme font.
function fitFont(text, w, h) {
  const CHAR_W = 0.64;   // avg glyph advance as a fraction of font-size (bold sans)
  const LINE_H = 1.06;
  const padW = w * 0.92, padH = h * 0.92;
  const words = text.split(/\s+/).filter(Boolean);
  const longest = words.reduce((m, x) => Math.max(m, x.length), 1);
  for (let f = Math.floor(padH); f >= 14; f--) {
    const charsPerLine = Math.max(1, Math.floor(padW / (CHAR_W * f)));
    if (longest > charsPerLine) continue;                  // a word would overflow
    const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
    if (lines * LINE_H * f <= padH) return f;
  }
  return 14;
}

function boxStyle({ box, text }) {
  const align = box.align === 'left' ? 'flex-start' : box.align === 'right' ? 'flex-end' : 'center';
  const boxW = box.w * canvasBox.value.w;
  const boxH = box.h * canvasBox.value.h;
  const fontPx = fitFont(text, boxW, boxH);
  const color = style.value.color || (impact.value ? '#fff' : (box.color === 'black' ? '#111' : '#fff'));
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
    justifyContent: align,
    textAlign: box.align || 'center',
    fontSize: `${Math.round(fontPx)}px`,
    color,
    // memegen uses counterclockwise-positive angles (PIL convention); CSS
    // rotate() is clockwise-positive, so negate to match the original meme.
    transform: box.angle ? `rotate(${-box.angle}deg)` : undefined,
    fontFamily: style.value.font || undefined,
    textTransform: style.value.uppercase === false ? 'none' : 'uppercase',
  };
}
</script>

<template>
  <div id="meme-region" class="scene-region active" :class="{ 'meme-impact': impact }">
    <div
      v-if="sc.title"
      id="meme-title"
      class="meme-title reveal"
      :class="{ shown: shown('meme-title') }"
      data-edit-path='["title"]'
    >{{ sc.title }}</div>

    <div class="meme-stage">
      <div
        id="meme-frame"
        class="meme-canvas reveal"
        :class="[`meme-fit-${fit}`, { shown: shown('meme-frame') }]"
        :style="canvasStyle"
      >
        <img v-if="src" class="meme-img" :src="src" :alt="sc.title || tpl?.name || 'meme'" />
        <div v-else class="meme-missing">Unknown meme template “{{ sc.template }}”</div>

        <div
          v-for="entry in boxes"
          :key="entry.i"
          class="meme-caption-box reveal"
          :id="`meme-box-${entry.revealIdx}`"
          :class="{ shown: shown(`meme-box-${entry.revealIdx}`) }"
          :style="boxStyle(entry)"
        >{{ entry.text }}</div>
      </div>
    </div>

    <div
      v-if="sc.caption"
      id="meme-caption"
      class="meme-caption reveal"
      :class="{ shown: shown('meme-caption') }"
      data-edit-path='["caption"]'
      data-edit-multiline
    >{{ sc.caption }}</div>
  </div>
</template>

<style scoped>
#meme-region {
  display: flex;
  flex-direction: column;
  gap: 24px;
  width: 100%;
  max-width: 1680px;
  margin: 0 auto;
  align-items: center;
}

.meme-title {
  font-size: 36px;
  font-weight: bold;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--slidey-accent, #58a6ff);
  text-align: center;
}

.meme-stage {
  width: 100%;
  height: 820px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Container query units (cqh) let captions scale with the image box, which is
   sized to the template's aspect ratio — so the same geometry works for
   portrait, landscape, and square templates. */
/* Width/height are set inline (deterministic contain-fit in JS). */
.meme-canvas {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
}

.meme-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover; /* canvas already matches the image aspect → no distortion */
}

.meme-caption-box {
  position: absolute;
  display: flex;
  align-items: center;
  padding: 0 1.5%;
  line-height: 1.02;
  font-weight: 800;
  font-family: var(--slidey-heading-font, var(--slidey-font, 'Arial Narrow', 'Helvetica Neue', Impact, sans-serif));
  letter-spacing: 0.01em;
  /* Wrap at spaces; only break inside a word if it genuinely cannot fit (the
     auto-fit font sizing normally prevents this). */
  word-break: normal;
  overflow-wrap: break-word;
  overflow: hidden;
  /* Legibility on arbitrary photos even when using deck-theme colors. */
  text-shadow:
    0 0 4px rgba(0, 0, 0, 0.55),
    2px 2px 0 rgba(0, 0, 0, 0.35);
  -webkit-text-stroke: 0.4px rgba(0, 0, 0, 0.55);
}

/* Classic Impact opt-in: heavy black outline, white fill, all caps. */
.meme-impact .meme-caption-box {
  font-family: Impact, 'Arial Narrow Bold', 'Arial Black', sans-serif;
  color: #fff !important;
  -webkit-text-stroke: 2px #000;
  paint-order: stroke fill;
  text-shadow: 3px 3px 0 #000, -1px -1px 0 #000;
}

.meme-missing {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #161b22;
  color: #8b949e;
  font-family: 'JetBrains Mono', 'Courier New', monospace;
  font-size: 30px;
  text-align: center;
  padding: 40px;
}

.meme-caption {
  font-size: 28px;
  color: var(--slidey-muted, #8b949e);
  text-align: center;
  max-width: 1400px;
  line-height: 1.5;
}
</style>
