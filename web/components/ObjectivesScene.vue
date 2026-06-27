<script setup>
import { computed } from 'vue';
import { store } from '../store.js';

const MAX_ITEMS = 6;

const items = computed(() => (store.scene?.items || []).slice(0, MAX_ITEMS));

const STATUS = {
  done: { label: 'DONE', glyph: '✓' },
  issue: { label: 'ISSUE', glyph: '!' },
  blocked: { label: 'BLOCKED', glyph: '!' },
  next: { label: 'NEXT', glyph: '→' },
  progress: { label: 'IN PROGRESS', glyph: '…' },
  pending: { label: 'PENDING', glyph: '·' },
  skipped: { label: 'SKIPPED', glyph: '-' },
};

function norm(status) {
  return String(status || 'pending').toLowerCase().replace(/[\s_]+/g, '-');
}

function statusMeta(status) {
  return STATUS[norm(status)] || { label: String(status || 'PENDING').toUpperCase(), glyph: '?' };
}
</script>

<template>
  <div id="objectives-region" class="scene-region active">
    <div
      v-if="store.scene.title"
      id="objectives-title"
      class="reveal"
      data-edit-path='["title"]'
      :class="{ shown: store.isRevealed('objectives-title') }"
    >{{ store.scene.title }}</div>

    <div class="objectives-list">
      <article
        v-for="(item, i) in items"
        :key="i"
        :id="`objectives-item-${i}`"
        class="objective-item reveal"
        :class="[`objective-${norm(item.status)}`, { shown: store.isRevealed(`objectives-item-${i}`) }]"
      >
        <div class="objective-glyph" aria-hidden="true">{{ statusMeta(item.status).glyph }}</div>
        <div class="objective-copy">
          <div class="objective-head">
            <span class="objective-label" :data-edit-path="JSON.stringify(['items', i, 'label'])">{{ item.label }}</span>
            <span class="objective-status">{{ statusMeta(item.status).label }}</span>
          </div>
          <div class="objective-detail" :data-edit-path="JSON.stringify(['items', i, 'detail'])" data-edit-multiline>{{ item.detail }}</div>
        </div>
      </article>
    </div>

    <div
      v-if="store.scene.caption"
      id="objectives-caption"
      class="reveal"
      data-edit-path='["caption"]'
      data-edit-multiline
      :class="{ shown: store.isRevealed('objectives-caption') }"
    >{{ store.scene.caption }}</div>
  </div>
</template>

<style scoped>
#objectives-region {
  gap: 28px;
  max-width: 1660px;
  width: 100%;
  margin: 0 auto;
}

#objectives-title {
  font-size: 36px;
  font-weight: bold;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: #58a6ff;
  text-align: center;
}

.objectives-list {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr;
  gap: 18px;
}

.objective-item {
  display: grid;
  grid-template-columns: 108px 1fr;
  gap: 24px;
  align-items: center;
  min-height: 118px;
  padding: 20px 28px;
  background: #161b22;
  border: 1px solid #30363d;
  border-left-width: 10px;
  border-radius: 14px;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.22);
}

.objective-glyph {
  width: 92px;
  height: 92px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 68px;
  line-height: 1;
  font-weight: 900;
  font-family: 'JetBrains Mono', 'Courier New', monospace;
}

.objective-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.objective-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 24px;
}

.objective-label {
  color: #e6edf3;
  font-size: 32px;
  font-weight: 800;
}

.objective-status {
  flex: 0 0 auto;
  font-family: 'JetBrains Mono', 'Courier New', monospace;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.12em;
}

.objective-detail {
  color: #cdd9e5;
  font-size: 28px;
  line-height: 1.32;
}

.objective-done {
  border-left-color: #3fb950;
  background: linear-gradient(90deg, rgba(63, 185, 80, 0.16), #161b22 32%);
}
.objective-done .objective-glyph {
  color: #0d1117;
  background: #3fb950;
  box-shadow: 0 0 34px rgba(63, 185, 80, 0.35);
}
.objective-done .objective-status { color: #3fb950; }

.objective-issue,
.objective-blocked {
  border-left-color: #f85149;
  background: linear-gradient(90deg, rgba(248, 81, 73, 0.18), #161b22 34%);
}
.objective-issue .objective-glyph,
.objective-blocked .objective-glyph {
  color: #0d1117;
  background: #f85149;
  box-shadow: 0 0 34px rgba(248, 81, 73, 0.34);
}
.objective-issue .objective-status,
.objective-blocked .objective-status { color: #f85149; }

.objective-next {
  border-left-color: #d29922;
  background: linear-gradient(90deg, rgba(210, 153, 34, 0.16), #161b22 32%);
}
.objective-next .objective-glyph {
  color: #0d1117;
  background: #d29922;
  box-shadow: 0 0 34px rgba(210, 153, 34, 0.32);
}
.objective-next .objective-status { color: #d29922; }

.objective-progress,
.objective-pending,
.objective-skipped {
  border-left-color: #58a6ff;
}
.objective-progress .objective-glyph,
.objective-pending .objective-glyph,
.objective-skipped .objective-glyph {
  color: #58a6ff;
  background: rgba(88, 166, 255, 0.12);
  border: 1px solid rgba(88, 166, 255, 0.28);
}
.objective-progress .objective-status,
.objective-pending .objective-status,
.objective-skipped .objective-status { color: #58a6ff; }

#objectives-caption {
  font-size: 28px;
  color: #8b949e;
  text-align: center;
  max-width: 1450px;
  line-height: 1.45;
  margin: 0 auto;
}
</style>
