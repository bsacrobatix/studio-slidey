<script setup>
import { store } from '../store.js';
</script>

<template>
  <div id="narrative-region" class="scene-region active">
    <div id="narrative-eyebrow" class="reveal" :class="{ shown: store.isRevealed('narrative-eyebrow') }" data-edit-path='["eyebrow"]'>{{ store.scene.eyebrow || '' }}</div>
    <div id="narrative-rule"></div>
    <div id="narrative-body" class="reveal" :class="{ shown: store.isRevealed('narrative-body') }" data-edit-path='["body"]' data-edit-multiline>{{ store.scene.body || '' }}</div>
    <div id="narrative-lede" class="reveal" :class="{ shown: store.isRevealed('narrative-lede') }" data-edit-path='["lede"]' data-edit-multiline>{{ store.scene.lede || '' }}</div>
  </div>
</template>
