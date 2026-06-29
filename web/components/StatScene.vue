<script setup>
import { store } from '../store.js';
</script>

<template>
  <div id="stat-region" class="scene-region active">
    <div id="stat-value" class="reveal" data-edit-path='["value"]' :class="{ shown: store.isRevealed('stat-value') }">{{ store.scene.value || '' }}</div>
    <div id="stat-label" class="reveal" data-edit-path='["label"]' :class="{ shown: store.isRevealed('stat-label') }">{{ store.scene.label || '' }}</div>
    <div id="stat-detail" class="reveal" data-edit-path='["detail"]' data-edit-multiline :class="{ shown: store.isRevealed('stat-detail') }">{{ store.scene.detail || '' }}</div>
  </div>
</template>
