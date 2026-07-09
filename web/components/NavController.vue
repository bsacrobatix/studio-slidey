<script setup>
// Manual click-through controller: keyboard + click navigation, plus progress
// and Edge TTS narration controls. Wraps a deck created by useDeck().
import { computed, onMounted, onUnmounted } from 'vue';
import { store } from '../store.js';

const props = defineProps({
  deck: { type: Object, required: true },
  isInlineEditing: { type: Boolean, default: false },
  suppressDeckClick: { type: Boolean, default: false },
  clearDeckClickSuppression: { type: Function, default: () => {} },
  narrationState: { type: Object, default: () => ({}) },
  listenNarration: { type: Function, default: () => {} },
  startLiveNarration: { type: Function, default: () => {} },
  stopNarration: { type: Function, default: () => {} },
});
const s = props.deck.state;
const narration = computed(() => props.narrationState || {});
const canListen = computed(() => Boolean(narration.value.supported && narration.value.hasSceneNarration && !narration.value.live));
const canPlayDeck = computed(() => Boolean(narration.value.supported && narration.value.hasDeckNarration));
const listenLabel = computed(() => (narration.value.speaking && !narration.value.live ? 'Stop' : 'Listen'));
const liveLabel = computed(() => (narration.value.live ? 'Stop deck' : 'Play deck'));
const listenTitle = computed(() => {
  if (!narration.value.supported) return 'Edge TTS preview is available in the Slidey web viewer and VS Code preview';
  if (!narration.value.hasSceneNarration) return 'This slide has no narration';
  return 'Listen to this slide narration';
});
const liveTitle = computed(() => {
  if (!narration.value.supported) return 'Edge TTS preview is available in the Slidey web viewer and VS Code preview';
  if (!narration.value.hasDeckNarration) return 'This deck has no narration';
  return narration.value.live ? 'Stop narrated deck playback' : 'Play this deck live with Edge TTS narration';
});

function onListenNarration() {
  if (narration.value.speaking && !narration.value.live) props.stopNarration();
  else props.listenNarration();
}

function onLiveNarration() {
  if (narration.value.live) props.stopNarration();
  else props.startLiveNarration();
}

function onKey(e) {
  if (e.target.closest && e.target.closest('.slidey-editor')) return;
  if (e.target.closest && e.target.closest('.slidey-ref-backdrop')) return;
  if (e.target.closest && e.target.closest('[data-slidey-reference-trigger]')) return;
  // On a video scene, Left/Right always move the SLIDE — even while the player's
  // scrub control or the <video> element has focus (which would otherwise seek
  // the media). preventDefault suppresses that default so only the deck advances.
  if (store.sceneType === 'video' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    if (e.key === 'ArrowRight') props.deck.next(); else props.deck.prev();
    return;
  }
  if (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  switch (e.key) {
    case 'ArrowRight': case ' ': case 'PageDown': case 'Enter':
      e.preventDefault(); props.deck.next(); break;
    case 'ArrowLeft': case 'PageUp': case 'Backspace':
      e.preventDefault(); props.deck.prev(); break;
    case 'Home': e.preventDefault(); props.deck.first(); break;
    case 'End':  e.preventDefault(); props.deck.last(); break;
  }
}
function onClick(e) {
  if (props.suppressDeckClick) {
    props.clearDeckClickSuppression();
    return;
  }
  if (props.isInlineEditing) return;
  // Click right 2/3 → next, left 1/3 → prev (ignore clicks on the HUD and the
  // workspace file-tree sidebar so selecting a deck doesn't advance the slide).
  if (e.target.closest('.slidey-hud')) return;
  if (e.target.closest('.slidey-sidebar')) return;
  if (e.target.closest('.slidey-editor')) return;
  if (e.target.closest('.slidey-library-link')) return;
  if (e.target.closest('.slidey-reference-rail')) return;
  if (e.target.closest('.slidey-ref-backdrop')) return;
  if (e.target.closest('[data-slidey-reference-trigger]')) return;
  // Clicks on the video player / its transport (play, scrub, grab) must not also
  // advance the slide, so the controls are actually usable.
  if (e.target.closest('.video-cine-holder')) return;
  if (e.clientX < window.innerWidth / 3) props.deck.prev();
  else props.deck.next();
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('click', onClick);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('click', onClick);
});
</script>

<template>
  <div class="slidey-hud">
    <div class="slidey-progress">
      <span class="slidey-scene">scene {{ s.sceneIndex + 1 }}/{{ s.sceneCount }}</span>
      <span class="slidey-sep">·</span>
      <span class="slidey-step">step {{ s.stepIndex + 1 }}/{{ s.stepsInScene }}</span>
    </div>
    <button
      type="button"
      class="slidey-jump"
      title="Jump to beginning (Home)"
      aria-label="Jump to beginning"
      :disabled="s.pos <= 0"
      @click="deck.first()"
    >⏮</button>
    <div class="slidey-bar"><div class="slidey-bar-fill" :style="{ width: (s.total > 1 ? (s.pos / (s.total - 1) * 100) : 100) + '%' }"></div></div>
    <button
      type="button"
      class="slidey-jump"
      title="Jump to end (End)"
      aria-label="Jump to end"
      :disabled="s.pos >= s.total - 1"
      @click="deck.last()"
    >⏭</button>
    <div class="slidey-narration-controls" @click.stop>
      <button
        type="button"
        class="slidey-narration-btn"
        :class="{ active: narration.speaking && !narration.live }"
        :disabled="!canListen && !(narration.speaking && !narration.live)"
        :title="listenTitle"
        @click="onListenNarration"
      >{{ listenLabel }}</button>
      <button
        type="button"
        class="slidey-narration-btn"
        :class="{ active: narration.live }"
        :disabled="!canPlayDeck && !narration.live"
        :title="liveTitle"
        @click="onLiveNarration"
      >{{ liveLabel }}</button>
      <span
        v-if="narration.error"
        class="slidey-narration-error"
        tabindex="0"
        role="status"
        :title="`Narration error: ${narration.error}`"
        :aria-label="`Narration error: ${narration.error}`"
      >
        !
        <span class="slidey-narration-error-popover">
          <strong>Narration error:</strong>
          <span>{{ narration.error }}</span>
        </span>
      </span>
    </div>
    <div class="slidey-hint">⏮ ⏭ / ← → / click to navigate</div>
  </div>
</template>

<style>
/* HUD chrome only — deliberately NOT scoped and prefixed `slidey-` so it never
   collides with the deck's verbatim template.css. */
.slidey-hud {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 22px;
  font-family: 'Courier New', monospace;
  font-size: 15px;
  color: #8b949e;
  background: linear-gradient(180deg, transparent, rgba(13,17,23,0.85));
  pointer-events: none;
}
/* While a video scene is expanded to fullscreen (VideoScene sets this body flag),
   relocate the HUD to the TOP so its bar can't collide with the player's transport
   at the bottom of the video. The gradient flips to fade downward from the top. */
body.slidey-video-full .slidey-hud {
  top: 0;
  bottom: auto;
  background: linear-gradient(0deg, transparent, rgba(13,17,23,0.92));
}
.slidey-progress { display: flex; gap: 8px; }
.slidey-scene { color: #58a6ff; }
.slidey-sep { color: #484f58; }
.slidey-bar {
  flex: 1;
  height: 4px;
  background: #21262d;
  border-radius: 2px;
  overflow: hidden;
}
.slidey-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #58a6ff, #bc8cff);
  transition: width 200ms ease-out;
}
.slidey-hint { color: #484f58; letter-spacing: 0.05em; }

/* Jump-to-beginning / jump-to-end buttons. The HUD is pointer-events:none so
   stray clicks pass through to navigate; these re-enable pointer events so they
   are clickable (the global click handler ignores anything inside .slidey-hud). */
.slidey-jump {
  pointer-events: auto;
  flex: none;
  background: none;
  border: none;
  padding: 2px 6px;
  font: inherit;
  font-size: 16px;
  line-height: 1;
  color: #8b949e;
  cursor: pointer;
  border-radius: 4px;
  transition: color 120ms ease, background 120ms ease;
}
.slidey-jump:hover:not(:disabled) { color: #58a6ff; background: rgba(88,166,255,0.12); }
.slidey-jump:disabled { opacity: 0.3; cursor: default; }
.slidey-narration-controls {
  pointer-events: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  position: relative;
}
.slidey-narration-btn {
  min-width: 66px;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: rgba(22, 27, 34, 0.78);
  color: #8b949e;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 5px 8px;
}
.slidey-narration-btn:hover:not(:disabled) {
  border-color: #58a6ff;
  color: #c9d1d9;
}
.slidey-narration-btn.active {
  border-color: #3fb950;
  color: #d2f8d2;
  background: rgba(35, 134, 54, 0.24);
}
.slidey-narration-btn:disabled {
  opacity: 0.38;
  cursor: default;
}
.slidey-narration-error {
  position: relative;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: 1px solid #da3633;
  border-radius: 50%;
  color: #ffb4ad;
  font-size: 12px;
  font-weight: bold;
  cursor: help;
  outline: none;
}
.slidey-narration-error:focus-visible {
  box-shadow: 0 0 0 2px rgba(218, 54, 51, 0.45);
}
.slidey-narration-error-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 1001;
  display: none;
  width: min(420px, calc(100vw - 44px));
  padding: 10px 12px;
  border: 1px solid rgba(248, 81, 73, 0.55);
  border-radius: 6px;
  background: rgba(22, 27, 34, 0.98);
  color: #ffd6d2;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  white-space: normal;
}
.slidey-narration-error-popover strong {
  display: block;
  margin-bottom: 4px;
  color: #ffb4ad;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.slidey-narration-error:hover .slidey-narration-error-popover,
.slidey-narration-error:focus .slidey-narration-error-popover {
  display: block;
}
</style>
