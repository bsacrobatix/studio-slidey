<script setup>
import { computed } from 'vue';
import { store } from '../store.js';

const scene = computed(() => store.scene || {});
const calls = computed(() => Array.isArray(scene.value.calls) ? scene.value.calls.slice(0, 6) : []);
const outcome = computed(() => {
  const out = scene.value.outcome;
  if (!out || typeof out !== 'object') return null;
  return out;
});
const outcomeLines = computed(() => {
  if (!outcome.value) return [];
  return Array.isArray(outcome.value.lines) ? outcome.value.lines.slice(0, 5) : [];
});

function callStatus(c) {
  return c && c.status ? c.status : 'ok';
}
</script>

<template>
  <div id="mcpdrive-region" class="scene-region active">
    <div id="mcpdrive-shell">
      <div
        id="mcpdrive-prompt"
        class="mcpdrive-prompt reveal"
        :class="{ shown: store.isRevealed('mcpdrive-prompt') }"
      >
        <div class="mcpdrive-topbar">
          <span class="mcpdrive-dots"><i></i><i></i><i></i></span>
          <span class="mcpdrive-app">Claude Code</span>
          <span v-if="scene.title" class="mcpdrive-mode">{{ scene.title }}</span>
          <span class="mcpdrive-agent">{{ scene.agent || 'kitsoki-mcp-drive' }}</span>
          <span v-if="scene.story" class="mcpdrive-story">{{ scene.story }}</span>
        </div>
        <div class="mcpdrive-input">
          <span class="mcpdrive-caret">&gt;</span>
          <span class="mcpdrive-text">{{ scene.prompt || '' }}</span>
        </div>
      </div>

      <div
        id="mcpdrive-calls"
        class="mcpdrive-calls reveal"
        :class="{ shown: store.isRevealed('mcpdrive-calls') }"
      >
        <div class="mcpdrive-section-label">MCP tool calls</div>
        <div v-for="(c, i) in calls" :key="i" class="mcpdrive-call" :class="`mcpdrive-call-${callStatus(c)}`">
          <div class="mcpdrive-call-head">
            <span class="mcpdrive-call-index">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="mcpdrive-tool">{{ c.tool }}</span>
            <span class="mcpdrive-status">{{ callStatus(c).toUpperCase() }}</span>
          </div>
          <div v-if="c.args" class="mcpdrive-args">{{ c.args }}</div>
          <div v-if="c.result" class="mcpdrive-result">{{ c.result }}</div>
        </div>
      </div>

      <div
        v-if="outcome"
        id="mcpdrive-outcome"
        class="mcpdrive-outcome reveal"
        :class="{ shown: store.isRevealed('mcpdrive-outcome') }"
      >
        <div class="mcpdrive-section-label">Outcome</div>
        <div class="mcpdrive-outcome-main">
          <span class="mcpdrive-outcome-status">{{ outcome.status || 'done' }}</span>
          <span v-if="outcome.ref" class="mcpdrive-outcome-ref">{{ outcome.ref }}</span>
        </div>
        <div v-for="(line, i) in outcomeLines" :key="i" class="mcpdrive-outcome-line">{{ line }}</div>
      </div>
    </div>

    <div
      v-if="scene.caption"
      id="mcpdrive-caption"
      class="mcpdrive-caption reveal"
      :class="{ shown: store.isRevealed('mcpdrive-caption') }"
    >{{ scene.caption }}</div>
  </div>
</template>

<style scoped>
#mcpdrive-region {
  gap: 18px;
  width: 100%;
  max-width: 1740px;
  margin: 0 auto;
  text-align: left;
}

#mcpdrive-shell {
  width: 100%;
  min-height: 740px;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 18px;
  background: var(--slidey-background, #0d1117);
  border: 1px solid var(--slidey-overlay, #30363d);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 24px 90px rgba(0, 0, 0, 0.24);
  overflow: hidden;
}

.mcpdrive-prompt,
.mcpdrive-calls,
.mcpdrive-outcome {
  border: 1px solid var(--slidey-overlay, #30363d);
  background: var(--slidey-surface, #161b22);
  border-radius: 12px;
}

.mcpdrive-calls,
.mcpdrive-outcome {
  overflow: hidden;
}

.mcpdrive-topbar {
  height: 54px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 22px;
  border-bottom: 1px solid var(--slidey-overlay, #30363d);
  font-family: 'JetBrains Mono', 'Courier New', monospace;
}

.mcpdrive-dots {
  display: inline-flex;
  gap: 8px;
  flex: 0 0 auto;
}

.mcpdrive-dots i {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--slidey-muted, #30363d);
  display: inline-block;
}

.mcpdrive-app {
  color: var(--slidey-text, #e6edf3);
  font-size: 24px;
  font-weight: 700;
}

.mcpdrive-agent {
  color: var(--slidey-gold, #58a6ff);
  font-size: 20px;
  margin-left: auto;
}

.mcpdrive-mode {
  color: var(--slidey-text, #e6edf3);
  font-size: 21px;
  font-weight: 700;
  padding-left: 14px;
  border-left: 1px solid var(--slidey-overlay, #30363d);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcpdrive-story {
  color: var(--slidey-subtle, #8b949e);
  font-size: 18px;
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcpdrive-input {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  min-height: 96px;
  padding: 22px 28px;
  font-family: 'JetBrains Mono', 'Courier New', monospace;
  font-size: 28px;
  line-height: 1.34;
  color: var(--slidey-text, #e6edf3);
}

.mcpdrive-caret {
  color: var(--slidey-gold, #58a6ff);
  flex: 0 0 auto;
}

.mcpdrive-text {
  overflow-wrap: anywhere;
}

.mcpdrive-calls {
  min-height: 350px;
  padding: 16px 20px 18px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  gap: 14px;
}

.mcpdrive-section-label {
  grid-column: 1 / -1;
  font-family: 'JetBrains Mono', 'Courier New', monospace;
  font-size: 18px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--slidey-subtle, #8b949e);
  font-weight: 700;
  margin-bottom: 2px;
}

.mcpdrive-call {
  min-height: 94px;
  border: 1px solid var(--slidey-overlay, #30363d);
  border-radius: 10px;
  background: var(--slidey-background, #0d1117);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}

.mcpdrive-call-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-family: 'JetBrains Mono', 'Courier New', monospace;
}

.mcpdrive-call-index {
  color: var(--slidey-muted, #484f58);
  font-size: 17px;
  flex: 0 0 auto;
}

.mcpdrive-tool {
  color: var(--slidey-gold, #d2a8ff);
  font-size: 24px;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcpdrive-status {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--slidey-foam, #3fb950);
  border: 1px solid var(--slidey-highlight-high, rgba(63, 185, 80, 0.45));
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 14px;
  letter-spacing: 0.1em;
}

.mcpdrive-call-issue .mcpdrive-status,
.mcpdrive-call-warn .mcpdrive-status {
  color: var(--slidey-gold, #f2cc60);
  border-color: var(--slidey-highlight-high, rgba(242, 204, 96, 0.45));
}

.mcpdrive-call-fail .mcpdrive-status {
  color: #f85149;
  border-color: rgba(248, 81, 73, 0.45);
}

.mcpdrive-args,
.mcpdrive-result {
  font-family: 'JetBrains Mono', 'Courier New', monospace;
  font-size: 18px;
  line-height: 1.28;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.mcpdrive-args {
  color: var(--slidey-subtle, #8b949e);
  -webkit-line-clamp: 2;
}

.mcpdrive-result {
  color: var(--slidey-text, #e6edf3);
  -webkit-line-clamp: 2;
}

.mcpdrive-outcome {
  min-height: 192px;
  padding: 16px 24px 18px;
  overflow: visible;
}

.mcpdrive-outcome-main {
  display: flex;
  align-items: baseline;
  gap: 18px;
  margin-bottom: 10px;
}

.mcpdrive-outcome-status {
  font-size: 32px;
  line-height: 1.16;
  color: var(--slidey-gold, #3fb950);
  font-weight: 800;
}

.mcpdrive-outcome-ref {
  font-family: 'JetBrains Mono', 'Courier New', monospace;
  color: var(--slidey-gold, #58a6ff);
  font-size: 24px;
  overflow-wrap: anywhere;
}

.mcpdrive-outcome-line {
  font-size: 22px;
  line-height: 1.28;
  color: var(--slidey-text, #cdd9e5);
  padding-left: 22px;
  position: relative;
}

.mcpdrive-outcome-line::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slidey-gold, #58a6ff);
  position: absolute;
  left: 0;
  top: 0.63em;
}

.mcpdrive-caption {
  font-size: 28px;
  line-height: 1.42;
  color: var(--slidey-text, #cdd9e5);
  text-align: center;
  max-width: 1460px;
  margin: 0 auto;
}
</style>
