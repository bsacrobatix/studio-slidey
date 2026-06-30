<script setup>
// Interactive web-app root: loads a spec, wires the deck, renders DeckHost +
// NavController. Spec source priority: window.__SLIDEY_SPEC__ (embedded by the
// single-file build) → ?spec=<url> query param → workspace mode (slidey CLI
// viewer: /api/config + file-tree sidebar) → ./spec.json → a drop/file-picker
// overlay.
import { computed, ref, shallowRef, onMounted, onUnmounted, watch, nextTick } from 'vue';
import DeckHost from './DeckHost.vue';
import NavController from './NavController.vue';
import FileTree from './FileTree.vue';
import SceneEditor from './SceneEditor.vue';
import RrwebPlayer from '../rrweb/RrwebPlayer.vue';
import { store } from '../store.js';
import { createDeck } from '../useDeck.js';
import { installEmbedAnnotate } from '../embed-annotate.js';
import { installInlineEdit } from '../inline-edit.js';
import { initialViewFromSearch } from '../initial-view.js';
import { resolveDeckSpec, linksForScene, sceneSectionIds, SOURCE_DECK_ID } from '../collections.mjs';
import { chaptersFromEvents } from '../rrweb/chapters.js';
import { resolveEvidencePlaybackHref } from '../evidencePlayback.mjs';
import {
  audioUrlFromBase64,
  speechTextForScene,
  timedNarrationCues,
} from '../narration.mjs';

const deck = shallowRef(null);
const currentSpec = ref(null);
const sourceSpec = ref(null);
const error = ref('');
const loading = ref(true);

// Workspace (CLI viewer) state.
const workspace = ref(false);
// Embedded single-file preview (VS Code webview): no file-tree sidebar, and the
// deck auto-reloads when its spec changes on disk.
const embedded = ref(false);
const tree = shallowRef(null);       // { name, children: [...] }
const activePath = ref('');
const sidebarWidth = ref(300);
const editorWidth = ref(380);
const viewerMode = ref('browse');
const isEditMode = computed(() => viewerMode.value === 'edit');
const dirty = ref(false);
const saving = ref(false);
const saveError = ref('');
const isInlineEditing = ref(false);
const suppressDeckNavClick = ref(false);
const schema = shallowRef(null);
const sessionSpec = ref(null);         // snapshot of the latest loaded/reloaded spec
const activeSpecBaseUrl = ref('');     // base URL for currently open workspace spec
const activeSpecEditable = ref(true);
const cloning = ref(false);
const cloneError = ref('');
const collection = shallowRef(null);
const activeDeckId = ref(SOURCE_DECK_ID);
const compactViewport = ref(false);
const openCollectionMenu = ref('');
const libraryBackStack = ref([]);
const libraryForwardStack = ref([]);
const libraryDecks = computed(() => collection.value && collection.value.isCollection ? collection.value.decks : []);
const activeViewEditable = computed(() =>
  activeSpecEditable.value && (!collection.value || !collection.value.isCollection || collection.value.isSource));
const defaultDeckId = computed(() => {
  const library = sourceSpec.value && sourceSpec.value.library ? sourceSpec.value.library : {};
  return library.defaultDeck || library.activeDeck || '';
});
const collectionTitle = computed(() => {
  const spec = sourceSpec.value || {};
  const library = spec.library || {};
  return library.title || (spec.meta && spec.meta.title) || 'Collection';
});
const sourceSceneCount = computed(() => {
  const spec = sourceSpec.value || {};
  return Array.isArray(spec.scenes) ? spec.scenes.length : 0;
});
const activeSceneCount = computed(() => {
  const spec = currentSpec.value || {};
  return Array.isArray(spec.scenes) ? spec.scenes.length : 0;
});
const activeDeckInfo = computed(() => {
  const info = collection.value;
  if (!info || !info.isCollection) return null;
  return (info.decks || []).find(candidate => candidate.id === activeDeckId.value) || null;
});
const activeDeckTitle = computed(() => {
  const found = activeDeckInfo.value;
  return found ? found.title : activeDeckId.value;
});
const currentScene = computed(() => {
  const spec = currentSpec.value;
  const state = deck.value && deck.value.state;
  return spec && state && Array.isArray(spec.scenes) ? spec.scenes[state.sceneIndex] || null : null;
});
const currentLinks = computed(() => linksForScene(currentScene.value, collection.value));
const compactWorkspace = computed(() => workspace.value && !embedded.value && viewerMode.value !== 'present' && compactViewport.value);
const rrwebModal = ref({
  open: false,
  loading: false,
  error: '',
  title: '',
  ref: '',
  href: '',
  events: [],
  chapters: [],
});
const narrationPreviewSupported = computed(() => workspace.value || embedded.value);
const narrationSpeaking = ref(false);
const narrationLoading = ref(false);
const liveNarration = ref(false);
const narrationError = ref('');
const deckHasNarration = computed(() =>
  Boolean(currentSpec.value && Array.isArray(currentSpec.value.scenes)
    && currentSpec.value.scenes.some(scene => speechTextForScene(scene))));
const currentHasNarration = computed(() => Boolean(speechTextForScene(currentScene.value)));
const narrationState = computed(() => ({
  supported: narrationPreviewSupported.value,
  speaking: narrationSpeaking.value,
  loading: narrationLoading.value,
  live: liveNarration.value,
  hasSceneNarration: currentHasNarration.value,
  hasDeckNarration: deckHasNarration.value,
  error: narrationError.value,
}));
let narrationSeq = 0;
let narrationAbortController = null;
const activeNarrationAudio = new Set();
const narrationObjectUrls = new Set();
let liveNarrationTimer = null;
let liveAdvanceInProgress = false;
let videoCueState = { key: '', cues: [], spoken: new Set() };

function deckKind(option) {
  if (!option) return '';
  if (option.source) return 'Source';
  if (option.deckType === 'subset') return 'Subset';
  if (option.id === defaultDeckId.value) return 'Summary';
  if (option.deckType === 'hierarchy') return 'Deck';
  return 'Subset';
}

function isHierarchyDeckOption(option) {
  if (!option) return false;
  return Boolean(option.source || option.deckType === 'hierarchy');
}

function isSubsetDeckOption(option) {
  return Boolean(option && option.deckType === 'subset');
}

function deckSceneCount(deckId) {
  if (!sourceSpec.value || !deckId) return 0;
  if (deckId === SOURCE_DECK_ID) return sourceSceneCount.value;
  const resolved = resolveDeckSpec(sourceSpec.value, { deckId });
  if (resolved.errors && resolved.errors.length) return 0;
  return Array.isArray(resolved.spec && resolved.spec.scenes) ? resolved.spec.scenes.length : 0;
}

function deckMeta(option) {
  if (!option) return '';
  const parts = [];
  const count = option.sceneCount || deckSceneCount(option.id);
  if (option.deckType !== 'subset' && count) parts.push(`${count} slides`);
  const tags = [option.purpose, option.theme].filter(Boolean).join(' / ');
  if (tags) parts.push(tags);
  if (option.deckType === 'hierarchy' && option.parent && option.parent !== SOURCE_DECK_ID) {
    const parent = (libraryDecks.value || []).find(candidate => candidate.id === option.parent);
    if (parent) parts.push(`under ${parent.title}`);
  }
  if (option.deckType === 'subset' && option.parent) {
    const parent = (libraryDecks.value || []).find(candidate => candidate.id === option.parent);
    if (parent) parts.push(`under ${parent.title}`);
  }
  return parts.join(' · ');
}

const libraryDeckRows = computed(() => (libraryDecks.value || []).map(option => ({
  ...option,
  kind: deckKind(option),
  sceneCount: option.sceneCount || deckSceneCount(option.id),
  metaText: deckMeta(option),
})));

function deckLevel(option, byId) {
  if (!option || option.source) return 0;
  let level = 1;
  let parentId = option.parent;
  const seen = new Set([option.id]);
  while (parentId && parentId !== SOURCE_DECK_ID && byId.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId);
    level += 1;
    parentId = byId.get(parentId).parent;
  }
  return Math.min(level, 4);
}

const hierarchyDeckRows = computed(() => {
  const decks = libraryDeckRows.value || [];
  const byId = new Map(decks.map(item => [item.id, item]));
  return decks
    .filter(isHierarchyDeckOption)
    .map(option => ({
      ...option,
      level: deckLevel(option, byId),
    }));
});

const subsetDeckRows = computed(() => (libraryDeckRows.value || []).filter(isSubsetDeckOption));

const activeIsSubset = computed(() => Boolean(activeDeckInfo.value && isSubsetDeckOption(activeDeckInfo.value)));
const activeIsHierarchy = computed(() => Boolean(activeDeckInfo.value && isHierarchyDeckOption(activeDeckInfo.value)));

const activeHierarchyTrail = computed(() => {
  const decks = libraryDeckRows.value || [];
  const byId = new Map(decks.map(item => [item.id, item]));
  const source = decks.find(item => item.source) || null;
  const out = [];
  let cursor = activeDeckInfo.value;
  const seen = new Set();
  if (cursor && isSubsetDeckOption(cursor)) cursor = null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    out.unshift(cursor);
    const parentId = cursor.parent;
    cursor = parentId && parentId !== SOURCE_DECK_ID ? byId.get(parentId) : null;
  }
  if (source && (!out.length || out[0].id !== source.id)) out.unshift(source);
  return out.length ? out : (source ? [source] : []);
});

const currentSectionTitle = computed(() => {
  const scene = currentScene.value;
  const info = collection.value;
  const sectionId = sceneSectionIds(scene)[0];
  if (!scene || !sectionId || !info || !info.isCollection) return '';
  const found = (info.sections || []).find(candidate => candidate.id === sectionId);
  return found ? found.title : sectionId;
});

const activeDeckStatus = computed(() => {
  const info = activeDeckInfo.value;
  if (!info) return '';
  const parts = [deckKind(info)];
  if (info.deckType === 'subset' && activeSceneCount.value) {
    parts.push(`${activeSceneCount.value} synced slides`);
  } else if (activeSceneCount.value) {
    parts.push(`${activeSceneCount.value} slides`);
  } else if (info.source && sourceSceneCount.value) {
    parts.push(`${sourceSceneCount.value} slides`);
  }
  if (info.deckType === 'hierarchy' && info.parent && info.parent !== SOURCE_DECK_ID) {
    const parent = (libraryDecks.value || []).find(candidate => candidate.id === info.parent);
    if (parent) parts.push(`under ${parent.title}`);
  }
  if (info.deckType === 'subset') {
    const tags = [info.purpose, info.theme].filter(Boolean).join(' / ');
    if (tags) parts.push(tags);
  } else if (sourceSceneCount.value) {
    const tags = [info.purpose, info.theme].filter(Boolean).join(' / ');
    if (tags) parts.push(tags);
  }
  if (currentSectionTitle.value) parts.push(currentSectionTitle.value);
  return parts.filter(Boolean).join(' · ');
});

function linkMeta(link) {
  if (!link) return '';
  const parts = [];
  if (link.section) {
    const found = (collection.value && collection.value.sections || []).find(section => section.id === String(link.section));
    parts.push(found && found.title ? found.title : String(link.section));
  }
  if (link.deckTitle) parts.push(link.deckTitle);
  return parts.join(' -> ');
}

function deckOptionById(deckId) {
  return (libraryDeckRows.value || []).find(option => option.id === deckId) || null;
}

const hierarchyLinkRows = computed(() => currentLinks.value
  .filter(link => isHierarchyDeckOption(deckOptionById(link.deck)))
  .map(link => {
    const active = activeDeckInfo.value;
    const relation = active && active.parent === link.deck ? 'Parent' : 'Go deeper';
    return {
      ...link,
      relation,
      metaText: linkMeta(link),
    };
  }));

const subsetLinkRows = computed(() => currentLinks.value
  .filter(link => isSubsetDeckOption(deckOptionById(link.deck)))
  .map(link => ({
    ...link,
    metaText: linkMeta(link),
  })));

const activeHierarchySummary = computed(() => {
  let trail = activeHierarchyTrail.value || [];
  if (trail.length > 2 && trail[0] && trail[0].source) trail = trail.slice(1);
  if (!trail.length) return activeDeckTitle.value;
  return trail.map(crumb => crumb.title).join(' / ');
});

const activeSubsetSummary = computed(() => {
  if (activeIsSubset.value) return activeDeckTitle.value;
  const count = subsetDeckRows.value.length;
  return count ? `${count} view${count === 1 ? '' : 's'}` : 'None';
});

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function stringOrNull(value) {
  const found = firstPresent(value);
  return found == null ? null : String(found);
}

function sectionTitle(sectionId) {
  if (!sectionId) return '';
  const found = (collection.value && collection.value.sections || [])
    .find(section => section.id === String(sectionId));
  return found && found.title ? found.title : String(sectionId);
}

function currentSceneTitle() {
  const scene = currentScene.value;
  if (!scene) return '';
  return scene.title || scene.heading || scene.label || scene.eyebrow || '';
}

function currentLibraryLocation() {
  const state = deck.value && deck.value.state;
  const scene = currentScene.value;
  const sections = sceneSectionIds(scene);
  const section = sections[0] || null;
  const sceneId = scene
    ? firstPresent(scene._library && scene._library.sourceId, scene.id, scene.key)
    : null;
  const deckTitle = activeDeckTitle.value || activeDeckId.value;
  const foundSectionTitle = currentSectionTitle.value || sectionTitle(section);
  const foundSceneTitle = currentSceneTitle();
  return {
    deck: activeDeckId.value,
    scene: stringOrNull(sceneId),
    section: stringOrNull(section),
    step: state ? state.stepIndex : null,
    label: foundSectionTitle || foundSceneTitle || deckTitle,
    deckTitle,
    sectionTitle: foundSectionTitle,
    sceneTitle: foundSceneTitle,
  };
}

function decorateLibraryLocation(raw) {
  if (!raw || !raw.deck) return null;
  const deckId = String(raw.deck);
  const option = deckOptionById(deckId);
  const section = stringOrNull(firstPresent(raw.section, raw.sectionId));
  const deckTitle = raw.deckTitle || (option && option.title) || deckId;
  const foundSectionTitle = raw.sectionTitle || sectionTitle(section);
  const foundSceneTitle = raw.sceneTitle || '';
  const rawStep = firstPresent(raw.step, raw.stepIndex);
  const step = rawStep == null || Number.isNaN(Number(rawStep)) ? null : Math.max(0, Math.floor(Number(rawStep)));
  return {
    deck: deckId,
    scene: stringOrNull(firstPresent(raw.scene, raw.sceneId)),
    section,
    step,
    label: raw.label || raw.title || foundSectionTitle || foundSceneTitle || deckTitle,
    deckTitle,
    sectionTitle: foundSectionTitle,
    sceneTitle: foundSceneTitle,
  };
}

function affordanceForLocation(raw, kind) {
  const location = decorateLibraryLocation(raw);
  if (!location) return null;
  const context = firstPresent(
    location.sectionTitle && location.sectionTitle !== location.deckTitle ? location.sectionTitle : null,
    location.sceneTitle && location.sceneTitle !== location.deckTitle ? location.sceneTitle : null,
    location.label && location.label !== location.deckTitle ? location.label : null,
  );
  return {
    ...location,
    action: kind === 'down' ? 'Return down' : 'Back up',
    title: location.deckTitle || location.label || location.deck,
    context: context ? String(context) : '',
  };
}

function stackTop(stack) {
  return stack && stack.length ? stack[stack.length - 1] : null;
}

const libraryBackAffordance = computed(() => affordanceForLocation(stackTop(libraryBackStack.value), 'up'));
const libraryForwardAffordance = computed(() => affordanceForLocation(stackTop(libraryForwardStack.value), 'down'));

function isSameLibraryLocation(a, b) {
  if (!a || !b || a.deck !== b.deck) return false;
  const aScene = a.scene || '';
  const bScene = b.scene || '';
  const aSection = a.section || '';
  const bSection = b.section || '';
  if (aScene && bScene && aScene !== bScene) return false;
  if (aSection && bSection && aSection !== bSection) return false;
  return true;
}

function trimStackThroughTarget(stack, target) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (isSameLibraryLocation(stack[i], target)) return stack.slice(0, i);
  }
  return stack;
}

function isDeckAncestor(ancestorId, deckId) {
  if (!ancestorId || !deckId || ancestorId === deckId) return false;
  const decks = libraryDeckRows.value || [];
  const byId = new Map(decks.map(item => [item.id, item]));
  let cursor = byId.get(deckId);
  const seen = new Set([deckId]);
  while (cursor) {
    const parent = cursor.source ? null : (cursor.parent || SOURCE_DECK_ID);
    if (!parent || seen.has(parent)) return false;
    if (parent === ancestorId) return true;
    seen.add(parent);
    cursor = byId.get(parent);
  }
  return false;
}

function relationToDeck(targetDeckId) {
  const currentDeckId = activeDeckId.value;
  if (isDeckAncestor(targetDeckId, currentDeckId)) return 'up';
  if (isDeckAncestor(currentDeckId, targetDeckId)) return 'down';
  return 'across';
}

function capStack(stack) {
  return stack.slice(Math.max(0, stack.length - 8));
}

function commitLibraryNavigationTrail(origin, target, mode) {
  if (!origin || !target) return;
  const back = libraryBackStack.value.slice();
  const forward = libraryForwardStack.value.slice();
  if (mode === 'back') {
    back.pop();
    libraryBackStack.value = back;
    libraryForwardStack.value = capStack([...forward, origin]);
    return;
  }
  if (mode === 'forward') {
    libraryBackStack.value = capStack([...back, origin]);
    libraryForwardStack.value = forward.slice(0, -1);
    return;
  }

  if (relationToDeck(target.deck) === 'up') {
    libraryBackStack.value = trimStackThroughTarget(back, target);
    libraryForwardStack.value = [origin];
    return;
  }

  libraryBackStack.value = capStack([...back, origin]);
  libraryForwardStack.value = [];
}

function resetLibraryNavigationTrail() {
  libraryBackStack.value = [];
  libraryForwardStack.value = [];
}

function toggleCollectionMenu(menu) {
  openCollectionMenu.value = openCollectionMenu.value === menu ? '' : menu;
}

function closeCollectionMenu() {
  openCollectionMenu.value = '';
}

function onWindowKeydown(e) {
  if (e.key === 'Escape' && rrwebModal.value.open) {
    closeRrwebModal();
    return;
  }
  if (e.key === 'Escape') closeCollectionMenu();
}

function onWindowClick() {
  closeCollectionMenu();
}

function clearLiveNarrationTimer() {
  if (liveNarrationTimer) {
    clearTimeout(liveNarrationTimer);
    liveNarrationTimer = null;
  }
}

function resetVideoCueState() {
  videoCueState = { key: '', cues: [], spoken: new Set() };
}

function currentNarrationMeta() {
  const spec = currentSpec.value || sourceSpec.value || {};
  return (spec.meta && spec.meta.narration) || {};
}

function updateNarrationActivity() {
  narrationSpeaking.value = narrationLoading.value || activeNarrationAudio.size > 0;
}

function revokeNarrationUrl(url) {
  if (!url || !narrationObjectUrls.has(url)) return;
  narrationObjectUrls.delete(url);
  try { URL.revokeObjectURL(url); } catch (_) {}
}

function stopNarrationAudioOnly() {
  narrationSeq += 1;
  if (narrationAbortController) {
    try { narrationAbortController.abort(); } catch (_) {}
    narrationAbortController = null;
  }
  narrationLoading.value = false;
  for (const audio of activeNarrationAudio) {
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (_) {}
  }
  activeNarrationAudio.clear();
  for (const url of Array.from(narrationObjectUrls)) revokeNarrationUrl(url);
  updateNarrationActivity();
}

function stopNarration(opts = {}) {
  liveNarration.value = false;
  clearLiveNarrationTimer();
  resetVideoCueState();
  stopNarrationAudioOnly();
  if (opts.pauseVideo !== false && currentScene.value && currentScene.value.type === 'video') {
    try {
      window.dispatchEvent(new CustomEvent('slidey:video-command', { detail: { action: 'pause' } }));
    } catch (_) { /* no active video scene */ }
  }
}

async function requestNarrationAudio(text, signal) {
  const res = await fetch('/api/narration-audio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: String(text || ''), meta: currentNarrationMeta() }),
    signal,
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch (_) {
    payload = {};
  }
  if (!res.ok) {
    throw new Error(payload.error || `edge-tts narration failed (${res.status})`);
  }
  if (!payload.audioBase64) throw new Error('edge-tts narration response did not include audio');
  const url = audioUrlFromBase64(payload.audioBase64, payload.mime || 'audio/mpeg');
  narrationObjectUrls.add(url);
  return url;
}

function playNarrationUrl(url, token, opts = {}) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    activeNarrationAudio.add(audio);
    updateNarrationActivity();
    let settled = false;
    const finish = (ok, err) => {
      if (settled) return;
      settled = true;
      activeNarrationAudio.delete(audio);
      revokeNarrationUrl(url);
      updateNarrationActivity();
      if (token !== narrationSeq) {
        resolve(false);
        return;
      }
      if (err) narrationError.value = String(err.message || err);
      if (ok && typeof opts.onDone === 'function') opts.onDone();
      resolve(ok);
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false, new Error('Could not play edge-tts narration audio'));
    audio.play().catch(err => finish(false, err));
  });
}

async function speakText(text, opts = {}) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (!narrationPreviewSupported.value) {
    narrationError.value = 'Edge TTS preview is available in the Slidey web viewer and VS Code preview.';
    return false;
  }
  const cancelFirst = opts.cancel !== false;
  if (cancelFirst) stopNarrationAudioOnly();
  const token = narrationSeq;
  const controller = new AbortController();
  if (cancelFirst) narrationAbortController = controller;
  narrationError.value = '';
  narrationLoading.value = true;
  updateNarrationActivity();
  try {
    const url = await requestNarrationAudio(raw, controller.signal);
    if (token !== narrationSeq) {
      revokeNarrationUrl(url);
      return false;
    }
    return await playNarrationUrl(url, token, opts);
  } catch (err) {
    if (token === narrationSeq && (!err || err.name !== 'AbortError')) {
      narrationError.value = String(err && err.message ? err.message : err);
    }
    return false;
  } finally {
    if (narrationAbortController === controller) narrationAbortController = null;
    if (token === narrationSeq) narrationLoading.value = false;
    updateNarrationActivity();
  }
}

function videoCueKey() {
  const state = deck.value && deck.value.state;
  return `${activeDeckId.value}:${state ? state.sceneIndex : 0}:${store.sceneNonce}`;
}

function armVideoCueNarration(scene) {
  const cues = Array.isArray(scene && scene.narration)
    ? timedNarrationCues(scene, store.rrwebChapters || [])
    : [];
  videoCueState = { key: videoCueKey(), cues, spoken: new Set() };
}

async function advanceLiveNarration() {
  clearLiveNarrationTimer();
  if (!liveNarration.value || !deck.value) return;
  const state = deck.value.state;
  if (!state || state.sceneIndex + 1 >= state.sceneCount) {
    liveNarration.value = false;
    narrationSpeaking.value = false;
    resetVideoCueState();
    return;
  }
  liveAdvanceInProgress = true;
  try {
    await deck.value.gotoScene(state.sceneIndex + 1);
  } finally {
    liveAdvanceInProgress = false;
  }
  await nextTick();
  runLiveNarrationForCurrent();
}

function runLiveNarrationForCurrent() {
  if (!liveNarration.value || !deck.value) return;
  clearLiveNarrationTimer();
  resetVideoCueState();
  const scene = currentScene.value || {};
  if (scene.type === 'video') {
    armVideoCueNarration(scene);
    if (typeof scene.narration === 'string' && scene.narration.trim()) {
      speakText(scene.narration, { cancel: true });
    } else {
      stopNarrationAudioOnly();
    }
    nextTick(() => {
      try {
        window.dispatchEvent(new CustomEvent('slidey:video-command', { detail: { action: 'play' } }));
      } catch (_) { /* no active video scene */ }
    });
    const durationMs = Number(scene.duration || 0) * 1000;
    if (durationMs > 0) {
      liveNarrationTimer = setTimeout(advanceLiveNarration, durationMs + 500);
    }
    return;
  }
  const text = speechTextForScene(scene);
  if (text) {
    speakText(text, { cancel: true, onDone: advanceLiveNarration });
  } else {
    stopNarrationAudioOnly();
    liveNarrationTimer = setTimeout(advanceLiveNarration, 1200);
  }
}

function listenCurrentNarration() {
  liveNarration.value = false;
  clearLiveNarrationTimer();
  resetVideoCueState();
  const text = speechTextForScene(currentScene.value);
  if (!text) {
    narrationError.value = 'This slide has no narration.';
    return;
  }
  speakText(text, { cancel: true });
}

function startLiveNarration() {
  if (!deck.value) return;
  if (!narrationPreviewSupported.value) {
    narrationError.value = 'Edge TTS preview is available in the Slidey web viewer and VS Code preview.';
    return;
  }
  liveNarration.value = true;
  narrationError.value = '';
  runLiveNarrationForCurrent();
}

function onVideoTime(e) {
  if (!liveNarration.value) return;
  const scene = currentScene.value || {};
  if (scene.type !== 'video') return;
  if (videoCueState.key !== videoCueKey()) armVideoCueNarration(scene);
  if (!videoCueState.cues.length) return;
  const seconds = Math.max(0, Number(e && e.detail && e.detail.ms || 0) / 1000);
  for (const cue of videoCueState.cues) {
    if (videoCueState.spoken.has(cue.key)) continue;
    if (seconds + 0.12 >= cue.at) {
      videoCueState.spoken.add(cue.key);
      speakText(cue.text, { cancel: false });
    }
  }
}

function onVideoEnded() {
  if (liveNarration.value && currentScene.value && currentScene.value.type === 'video') {
    advanceLiveNarration();
  }
}

watch(() => {
  const state = deck.value && deck.value.state;
  return state ? `${activeDeckId.value}:${state.sceneIndex}:${state.pos}` : '';
}, () => {
  clearLiveNarrationTimer();
  resetVideoCueState();
  stopNarrationAudioOnly();
  if (liveNarration.value && !liveAdvanceInProgress) {
    nextTick(runLiveNarrationForCurrent);
  }
});

// Live on-disk reload: poll the open spec's mtime and offer a reload when it
// changes underneath us. A failed reload never tears down the session — it
// surfaces a transient message and leaves the current deck on screen.
const stale = ref(false);            // on-disk version differs from the loaded one
const reloadError = ref('');         // transient toast when a reload attempt fails
const reloading = ref(false);
// Save conflict (concurrent edit): set when the server rejects a save because
// the file changed on disk since we loaded it. Holds the on-disk version so the
// user can resolve it as OURS (overwrite) or THEIRS (discard local + reload).
const conflict = ref(null);          // { theirsSpec, theirsVersion } | null
let loadedMtime = 0;                 // mtime of the spec currently rendered
let latestMtime = 0;                 // most recent mtime observed on disk
let loadedVersion = '';              // content version of the spec currently rendered
let latestVersion = '';              // most recent content version observed on disk
let pollTimer = null;
let errTimer = null;
const POLL_MS = 1500;

function inferMode(spec) {
  if (spec.meta && spec.meta.mode) return spec.meta.mode;
  return (spec.scenes || []).some(scene => scene && scene.type === 'request') ? 'api' : 'pitch';
}

function isEditableResponse(data, rel) {
  if (typeof data.editable === 'boolean') return data.editable;
  if (/\.readonly\.slidey\.json$/i.test(rel || '')) return false;
  return /\.json$/i.test(rel || '');
}

function cloneSpec(raw) {
  return JSON.parse(JSON.stringify(raw));
}

function applySpecMeta(data, rel) {
  activeSpecEditable.value = isEditableResponse(data, rel);
  cloneError.value = '';
  if (!activeViewEditable.value && isEditMode.value) setViewerMode('browse');
}

function deckIdFromSearch() {
  try {
    return new URLSearchParams(window.location.search).get('deck') || null;
  } catch (_) {
    return null;
  }
}

function targetPosition(nextDeck, spec, target) {
  if (!target || !spec || !Array.isArray(spec.scenes)) return null;
  const wantScene = target.scene || target.sceneId || null;
  const wantSection = target.section || target.sectionId || null;
  const rawStep = firstPresent(target.step, target.stepIndex);
  const wantStep = rawStep == null || Number.isNaN(Number(rawStep)) ? 0 : Math.max(0, Math.floor(Number(rawStep)));
  if (!wantScene && !wantSection) return null;
  const sceneNeedle = wantScene != null ? String(wantScene) : null;
  const sectionNeedle = wantSection != null ? String(wantSection) : null;
  const idx = spec.scenes.findIndex((scene) => {
    if (!scene) return false;
    if (sceneNeedle && (String(scene.id || '') === sceneNeedle || (scene._library && String(scene._library.sourceId || '') === sceneNeedle))) return true;
    if (sectionNeedle && sceneSectionIds(scene).includes(sectionNeedle)) return true;
    return false;
  });
  return idx >= 0 ? nextDeck.posForScene(idx, wantStep) : null;
}

async function loadSpec(spec, baseUrl, restore, opts = {}) {
  stopNarration({ pauseVideo: false });
  const resolved = resolveDeckSpec(spec, { deckId: opts.deckId });
  if (resolved.errors && resolved.errors.length) {
    throw new Error(resolved.errors.join('; '));
  }
  const renderSpec = resolved.isCollection && !resolved.isSource ? resolved.spec : spec;
  if (!renderSpec || !Array.isArray(renderSpec.scenes) || !renderSpec.scenes.length) {
    throw new Error('spec must have a non-empty "scenes" array');
  }
  sourceSpec.value = spec;
  currentSpec.value = renderSpec;
  collection.value = resolved;
  activeDeckId.value = resolved.deckId || SOURCE_DECK_ID;
  store.setMeta(renderSpec.meta || {});
  store.setMode(inferMode(renderSpec));
  activeSpecBaseUrl.value = baseUrl || '';
  if (opts.resetSession !== false) {
    sessionSpec.value = cloneSpec(spec);
    dirty.value = false;
    resetLibraryNavigationTrail();
  }
  saveError.value = '';
  if (!activeViewEditable.value && isEditMode.value) setViewerMode('browse');
  const d = createDeck(currentSpec.value, baseUrl);
  // Preserve the viewer's place across a reload: map the prior scene/step onto
  // the closest position in the freshly-loaded deck before the first render, so
  // there's no flash back to the start.
  const targetPos = targetPosition(d, renderSpec, opts.target);
  if (targetPos != null) {
    d.state.pos = Math.max(0, Math.min(d.state.total - 1, targetPos));
  } else if (restore) {
    d.state.pos = Math.max(0, Math.min(d.state.total - 1,
      d.posForScene(restore.sceneIndex, restore.stepIndex)));
  }
  await d.render();
  deck.value = d;
  fitScale();
  error.value = '';
}

async function fetchSpec(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.json();
}

async function loadSchema() {
  try {
    const res = await fetch('/api/schema');
    if (res.ok) schema.value = await res.json();
  } catch (_) { /* schema metadata is optional in non-CLI contexts */ }
}

// ── Workspace: load a spec selected in the file tree ────────────────────────
async function openPath(rel, restore, deckId) {
  try {
    loading.value = true;
    const res = await fetch(`/api/spec?path=${encodeURIComponent(rel)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `${res.status} loading ${rel}`);
    applySpecMeta(data, rel);
    // Spec-relative gif/img assets resolve under /workspace/<dir>/ in the CLI
    // viewer, or through a VS Code webview resource URI when embedded there.
    const base = data.assetBase || new URL(`/workspace/${data.dir ? data.dir + '/' : ''}`, window.location.href).href;
    await loadSpec(data.spec, base, restore, { deckId, resetSession: true });
    activePath.value = rel;
    // Fresh file → reset the live-reload watch to this version.
    loadedMtime = latestMtime = data.mtimeMs || 0;
    loadedVersion = latestVersion = data.version || '';
    stale.value = false;
    conflict.value = null;
    clearReloadError();
    dirty.value = false;
    saveError.value = '';
  } catch (err) {
    error.value = String(err.message || err);
    deck.value = null;
  } finally {
    loading.value = false;
  }
}

async function switchLibraryDeck(deckId, target = null) {
  if (!sourceSpec.value || !deckId) return false;
  const cur = deck.value && deck.value.state;
  const restore = cur && !target ? { sceneIndex: cur.sceneIndex, stepIndex: cur.stepIndex } : null;
  const scene = currentScene.value;
  const inferredTarget = target || (scene ? {
    scene: (scene._library && scene._library.sourceId) || scene.id || null,
    section: sceneSectionIds(scene)[0] || null,
    step: cur ? cur.stepIndex : null,
  } : null);
  try {
    loading.value = true;
    await loadSpec(sourceSpec.value, activeSpecBaseUrl.value, restore, {
      deckId,
      target: inferredTarget,
      resetSession: false,
    });
    return true;
  } catch (err) {
    error.value = String(err.message || err);
    return false;
  } finally {
    loading.value = false;
  }
}

function switchLibraryDeckFromMenu(deckId, target = null) {
  closeCollectionMenu();
  switchLibraryDeck(deckId, target);
}

async function openLibraryLink(link, mode = 'link') {
  if (!link || !link.deck) return false;
  const origin = currentLibraryLocation();
  const target = decorateLibraryLocation(link);
  if (!target) return false;
  closeCollectionMenu();
  const changed = await switchLibraryDeck(target.deck, {
    scene: target.scene,
    section: target.section,
    step: target.step,
  });
  if (changed) commitLibraryNavigationTrail(origin, target, mode);
  return changed;
}

function onLibraryLinkEvent(e) {
  const link = e && e.detail;
  if (!link || !link.deck || isEditMode.value) return;
  openLibraryLink(link);
}

function openLibraryBackAffordance() {
  const target = libraryBackAffordance.value;
  if (!target) return;
  openLibraryLink(target, 'back');
}

function openLibraryForwardAffordance() {
  const target = libraryForwardAffordance.value;
  if (!target) return;
  openLibraryLink(target, 'forward');
}

// ── Live on-disk reload ─────────────────────────────────────────────────────
function clearReloadError() {
  reloadError.value = '';
  if (errTimer) { clearTimeout(errTimer); errTimer = null; }
}

// Poll the open spec's mtime; flag it stale when the file changes on disk.
async function pollMtime() {
  if (!activePath.value || !deck.value) return;
  try {
    const r = await fetch(`/api/stat?path=${encodeURIComponent(activePath.value)}`);
    if (!r.ok) return;
    const { mtimeMs, version } = await r.json();
    if (!mtimeMs) return;
    latestMtime = mtimeMs;
    latestVersion = version || '';
    // Compare content version when the server provides one (an identical-content
    // rewrite bumps mtime but not version, so it shouldn't read as stale); fall
    // back to mtime for older servers.
    const changed = version ? (loadedVersion && version !== loadedVersion) : (loadedMtime && mtimeMs !== loadedMtime);
    if (changed) {
      stale.value = true;
      // Embedded preview: there's no sidebar reload pill, so refresh in place —
      // unless the user has unsaved in-place edits, in which case auto-reloading
      // would silently discard them. Leave it stale; the floating reload button
      // lets them pull the external version manually when they're ready.
      if (embedded.value && !(isEditMode.value && dirty.value)) reloadActive();
    }
  } catch (_) { /* server gone / transient — try again next tick */ }
}

// Reload the open spec from disk. On any failure (gone, unparseable, invalid
// spec, broken render) we keep the deck that's already on screen, show a brief
// message, and carry on — never drop the user into an error state.
async function reloadActive() {
  const rel = activePath.value;
  if (!rel || reloading.value) return;
  reloading.value = true;
  clearReloadError();
  // Remember where we are so the reloaded deck lands on the same slide.
  const cur = deck.value && deck.value.state;
  const restore = cur ? { sceneIndex: cur.sceneIndex, stepIndex: cur.stepIndex } : null;
  try {
    const res = await fetch(`/api/spec?path=${encodeURIComponent(rel)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `${res.status} loading ${rel}`);
    applySpecMeta(data, rel);
    const base = data.assetBase || new URL(`/workspace/${data.dir ? data.dir + '/' : ''}`, window.location.href).href;
    await loadSpec(data.spec, base, restore, { deckId: activeDeckId.value, resetSession: true });   // swaps deck.value only on success
    loadedMtime = latestMtime = data.mtimeMs || latestMtime;
    loadedVersion = latestVersion = data.version || latestVersion;
    stale.value = false;
    conflict.value = null;
  } catch (err) {
    // Keep the current version on screen and continue.
    reloadError.value = `Reload failed — kept the previous version. ${String(err.message || err)}`;
    // Acknowledge the broken revision so we stop re-prompting for it; a further
    // edit (newer mtime) re-arms the stale flag on the next poll.
    loadedMtime = latestMtime;
    loadedVersion = latestVersion;
    stale.value = false;
    errTimer = setTimeout(clearReloadError, 8000);
  } finally {
    reloading.value = false;
  }
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const spec = JSON.parse(await file.text());
    await loadSpec(spec, '', null, { deckId: deckIdFromSearch(), resetSession: true }); // no base URL → relative gif assets won't resolve
  } catch (err) { error.value = String(err.message || err); }
}

function fitScale() {
  compactViewport.value = window.innerWidth < 760;
  const showSidebar = workspace.value && !embedded.value && viewerMode.value !== 'present' && !compactViewport.value;
  const sw = showSidebar ? sidebarWidth.value : 0;
  const ew = workspace.value && deck.value && isEditMode.value ? editorWidth.value : 0;
  const availableW = Math.max(320, window.innerWidth - sw - ew);
  const scale = Math.min(availableW / 1920, window.innerHeight / 1080);
  document.documentElement.style.setProperty('--slidey-scale', String(scale));
  document.documentElement.style.setProperty('--slidey-sidebar-w', `${sw}px`);
  document.documentElement.style.setProperty('--slidey-editor-w', `${ew}px`);
}

function setViewerMode(mode) {
  if (mode !== 'browse' && mode !== 'edit' && mode !== 'present') return;
  if (mode === 'edit' && workspace.value && !activeViewEditable.value) return;
  document.body.classList.toggle('slidey-edit-mode', mode === 'edit');
  document.body.classList.toggle('slidey-browse-mode', mode === 'browse');
  document.body.classList.toggle('slidey-present-mode', mode === 'present');
  document.body.classList.toggle('slidey-presentation-mode', mode !== 'edit');
  viewerMode.value = mode;
  try {
    localStorage.setItem('slidey.viewerMode', mode);
    localStorage.setItem('slidey.editMode', mode === 'edit' ? '1' : '0');
  } catch (_) {}
  fitScale();
}

function closeRrwebModal() {
  rrwebModal.value = {
    open: false,
    loading: false,
    error: '',
    title: '',
    ref: '',
    href: '',
    events: [],
    chapters: [],
  };
}

function rrwebEventsFromPayload(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.events)) return raw.events;
  return [];
}

function rrwebChaptersFromPayload(raw, events) {
  if (raw && Array.isArray(raw.chapters)) return raw.chapters;
  return chaptersFromEvents(events || []);
}

async function onOpenRrweb(e) {
  const detail = (e && e.detail) || {};
  const ref = String(detail.ref || '').trim();
  if (!ref) return;
  const href = resolveEvidencePlaybackHref(ref, activeSpecBaseUrl.value, window.location.href);
  rrwebModal.value = {
    open: true,
    loading: true,
    error: '',
    title: String(detail.title || detail.label || 'Session replay'),
    ref,
    href,
    events: [],
    chapters: [],
  };
  try {
    const res = await fetch(href);
    if (!res.ok) throw new Error(`${res.status} loading ${ref}`);
    const raw = await res.json();
    const events = rrwebEventsFromPayload(raw);
    if (events.length < 2) throw new Error('rrweb log has no replayable event stream');
    rrwebModal.value = {
      ...rrwebModal.value,
      loading: false,
      events,
      chapters: rrwebChaptersFromPayload(raw, events),
    };
  } catch (err) {
    rrwebModal.value = {
      ...rrwebModal.value,
      loading: false,
      error: String(err.message || err),
    };
  }
}

// ── Sidebar resize ──────────────────────────────────────────────────────────
function startResize(e) {
  e.preventDefault();
  const move = (ev) => {
    sidebarWidth.value = Math.max(180, Math.min(560, ev.clientX));
    fitScale();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function markDirty() {
  dirty.value = true;
  saveError.value = '';
}
function setInlineEditing(v) {
  isInlineEditing.value = Boolean(v);
}
function suppressDeckClick() {
  suppressDeckNavClick.value = true;
}
function clearDeckClickSuppression() {
  suppressDeckNavClick.value = false;
}

// Save the in-memory spec. `force` overwrites a concurrent on-disk change
// (OURS resolution); otherwise the server rejects a stale base with 409 and we
// raise the conflict bar so the user can choose OURS or THEIRS.
async function saveActive(force = false) {
  if (!activePath.value || !sourceSpec.value || saving.value || !activeViewEditable.value) return;
  // Strict: Save is bound as `@click="saveActive"`, so a click event must not be
  // mistaken for force — only an explicit `true` (the OURS path) overwrites.
  const forceWrite = force === true;
  saving.value = true;
  saveError.value = '';
  try {
    const res = await fetch(`/api/spec?path=${encodeURIComponent(activePath.value)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: sourceSpec.value, baseVersion: loadedVersion, force: forceWrite }),
    });
    const data = await res.json();
    if (res.status === 409 && data.conflict) {
      // Someone else wrote this file since we loaded it. Hold their version and
      // let the user resolve; don't lose either side silently.
      conflict.value = { theirsSpec: data.current && data.current.spec, theirsVersion: data.current && data.current.version };
      latestVersion = (data.current && data.current.version) || latestVersion;
      latestMtime = (data.current && data.current.mtimeMs) || latestMtime;
      stale.value = true;
      return;
    }
    if (!res.ok || data.error) throw new Error(data.error || `${res.status} saving ${activePath.value}`);
    loadedMtime = latestMtime = data.mtimeMs || latestMtime;
    loadedVersion = latestVersion = data.version || loadedVersion;
    stale.value = false;
    conflict.value = null;
    dirty.value = false;
    sessionSpec.value = cloneSpec(sourceSpec.value);
  } catch (err) {
    saveError.value = String(err.message || err);
  } finally {
    saving.value = false;
  }
}

// OURS — keep my edits, overwrite the concurrent on-disk version.
async function resolveConflictOurs() {
  conflict.value = null;
  await saveActive(true);
}

// THEIRS — discard my edits and adopt the on-disk version.
async function resolveConflictTheirs() {
  conflict.value = null;
  await reloadActive();
}

async function revertActive() {
  if (!workspace.value || !sourceSpec.value || !sessionSpec.value || !deck.value || !dirty.value || saving.value || !activeViewEditable.value) return;
  saveError.value = '';
  const cur = deck.value.state;
  const restore = cur ? { sceneIndex: cur.sceneIndex, stepIndex: cur.stepIndex } : null;
  try {
    await loadSpec(cloneSpec(sessionSpec.value), activeSpecBaseUrl.value, restore, {
      deckId: activeDeckId.value,
      resetSession: true,
    });
  } catch (err) {
    saveError.value = String(err.message || err);
  }
}

async function cloneActive() {
  if (!activePath.value || cloning.value || !workspace.value) return;
  cloning.value = true;
  cloneError.value = '';
  try {
    const res = await fetch(`/api/clone-spec?path=${encodeURIComponent(activePath.value)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `${res.status} cloning ${activePath.value}`);
    await openPath(data.path);
    setViewerMode('edit');
  } catch (err) {
    cloneError.value = String(err.message || err);
  } finally {
    cloning.value = false;
  }
}

let teardownAnnotate = null;
let teardownInlineEdit = null;

onMounted(async () => {
  try {
    const savedMode = localStorage.getItem('slidey.viewerMode');
    if (savedMode === 'browse' || savedMode === 'edit' || savedMode === 'present') {
      viewerMode.value = savedMode;
    } else if (localStorage.getItem('slidey.editMode') === '1') {
      viewerMode.value = 'edit';
    } else {
      viewerMode.value = 'browse';
    }
  } catch (_) {
    viewerMode.value = 'browse';
  }
  setViewerMode(viewerMode.value);
  fitScale();
  window.addEventListener('resize', fitScale);
  window.addEventListener('keydown', onWindowKeydown);
  window.addEventListener('click', onWindowClick);
  window.addEventListener('slidey:open-rrweb', onOpenRrweb);
  window.addEventListener('slidey:library-link', onLibraryLinkEvent);
  window.addEventListener('slidey:video-time', onVideoTime);
  window.addEventListener('slidey:video-ended', onVideoEnded);
  // Producer side of the embed annotation protocol: when an embedding host turns
  // on annotation mode, let the operator point at a real element on the live
  // slide and post a precise `<scene>/<field>` anchor back. Reads the CURRENT
  // slide via live accessors. No-op when not embedded.
  teardownAnnotate = installEmbedAnnotate({
    getRoot: () => document,
    getSceneType: () => store.sceneType,
    getSceneIndex: () => (deck.value && deck.value.state ? deck.value.state.sceneIndex : 0),
    gotoView: (sceneIndex, stepIndex) => {
      if (!deck.value) return;
      return deck.value.go(deck.value.posForScene(sceneIndex, stepIndex));
    },
  });
  // Click-to-edit text directly on the slide (workspace edit mode only). Writes
  // through the same in-memory spec the side form + Save button use.
  teardownInlineEdit = installInlineEdit({
    isActive: () => workspace.value && isEditMode.value && activeViewEditable.value && !!deck.value
      && /\.json$/i.test(activePath.value || ''),
    getSpec: () => currentSpec.value,
    getSceneIndex: () => (deck.value && deck.value.state ? deck.value.state.sceneIndex : 0),
    render: () => deck.value && deck.value.render(),
    markDirty,
    setInlineEditing,
    suppressDeckClick,
  });
  try {
    const initialView = initialViewFromSearch(window.location.search);
    const initialDeckId = window.__SLIDEY_INITIAL_DECK__ || deckIdFromSearch();
    // Embedded spec (single-file static build): self-contained, no fetch.
    if (window.__SLIDEY_SPEC__) {
      await loadSpec(window.__SLIDEY_SPEC__, window.location.href, initialView, {
        deckId: initialDeckId,
        resetSession: true,
      });
      return;
    }
    const param = new URLSearchParams(window.location.search).get('spec');
    if (param) {
      await loadSpec(await fetchSpec(param), new URL(param, window.location.href).href, initialView, {
        deckId: initialDeckId,
        resetSession: true,
      });
      return;
    }
    // Workspace mode: the slidey CLI viewer serves /api/config + /api/tree.
    let cfg = null;
    try {
      const r = await fetch('/api/config');
      if (r.ok) cfg = await r.json();
    } catch (_) { /* not the CLI viewer — fall through */ }
      if (cfg && cfg.root) {
        workspace.value = true;
        embedded.value = !!cfg.embedded;
        document.body.classList.add('slidey-workspace');
        if (embedded.value) {
          document.body.classList.add('slidey-embedded');
          // VS Code webview preview (embedded mode) should default to Present
          // on first load, not Edit, even when a previous session stored that.
          setViewerMode('present');
        }
        fitScale();
      // The file tree is workspace-only; embedded preview reuses the same scene
      // editor in-place.
      if (!embedded.value) {
        try { tree.value = await (await fetch('/api/tree')).json(); } catch (_) { tree.value = null; }
        await loadSchema();
      }
      if (cfg.openFile) await openPath(cfg.openFile, initialView, initialDeckId || cfg.deckId);
      if (!cfg.openFile && viewerMode.value === 'present') setViewerMode('browse');
      fitScale();
      // Watch the open spec for on-disk edits (CLI viewer only).
      pollTimer = setInterval(pollMtime, POLL_MS);
      return;
    }
    // Convenience default for `npm run dev`: a spec.json beside index.html.
    await loadSpec(await fetchSpec('./spec.json'), window.location.href, initialView, {
      deckId: initialDeckId,
      resetSession: true,
    });
  } catch (err) {
    error.value = String(err.message || err);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', fitScale);
  window.removeEventListener('keydown', onWindowKeydown);
  window.removeEventListener('click', onWindowClick);
  window.removeEventListener('slidey:open-rrweb', onOpenRrweb);
  window.removeEventListener('slidey:library-link', onLibraryLinkEvent);
  window.removeEventListener('slidey:video-time', onVideoTime);
  window.removeEventListener('slidey:video-ended', onVideoEnded);
  stopNarration({ pauseVideo: false });
  if (pollTimer) clearInterval(pollTimer);
  if (errTimer) clearTimeout(errTimer);
  if (teardownAnnotate) teardownAnnotate();
  if (teardownInlineEdit) teardownInlineEdit();
  document.body.classList.remove('slidey-edit-mode', 'slidey-presentation-mode', 'slidey-browse-mode', 'slidey-present-mode');
});
</script>

<template>
  <!-- Workspace sidebar (CLI viewer only — hidden in the embedded preview) -->
  <aside v-if="workspace && !embedded && viewerMode !== 'present' && !compactWorkspace" class="slidey-sidebar" :style="{ width: sidebarWidth + 'px' }">
    <div class="slidey-sidebar-head">
      <span class="slidey-sidebar-mark">slidey</span>
      <span class="slidey-sidebar-root" :title="tree && tree.name">{{ tree ? tree.name : '' }}</span>
      <div v-if="deck" class="slidey-mode-toggle" role="group" aria-label="Viewer mode">
        <button
          type="button"
          :class="{ active: viewerMode === 'browse' }"
          :aria-pressed="viewerMode === 'browse'"
          title="Browse mode"
          @click.stop="setViewerMode('browse')"
        >Browse</button>
        <button
          type="button"
          :class="{ active: viewerMode === 'edit' }"
          :aria-pressed="viewerMode === 'edit'"
          :disabled="!activeViewEditable"
          :title="activeViewEditable ? 'Edit mode' : 'Subset decks are read-only views of the source deck'"
          @click.stop="setViewerMode('edit')"
        >{{ activeViewEditable ? 'Edit' : 'Read-only' }}</button>
        <button
          type="button"
          :class="{ active: viewerMode === 'present' }"
          :aria-pressed="viewerMode === 'present'"
          title="Present mode — hide the sidebar and editor for full-screen display"
          @click.stop="setViewerMode('present')"
        >Present</button>
      </div>
      <!-- Live-reload affordance: appears when the open spec changes on disk. -->
      <button
        v-if="stale"
        class="slidey-reload"
        :class="{ spinning: reloading }"
        :disabled="reloading"
        title="This deck changed on disk — click to reload"
        @click.stop="reloadActive"
      >⟳ reload</button>
      <button
        v-if="activePath && deck && !activeSpecEditable"
        class="slidey-sidebar-clone"
        :disabled="cloning"
        title="Create an editable .slidey.json copy of this report deck"
        @click.stop="cloneActive"
      >{{ cloning ? 'Cloning…' : 'Clone editable copy' }}</button>
      <span v-if="cloneError" class="slidey-embedded-saveerr" :title="cloneError">⚠ {{ cloneError }}</span>
    </div>
    <div class="slidey-sidebar-body">
      <FileTree
        v-if="tree && tree.children && tree.children.length"
        :nodes="tree.children"
        :active="activePath"
        :active-deck="activeDeckId"
        :select="openPath"
      />
      <p v-else class="slidey-sidebar-empty">No .json / .jsonl specs found here.</p>
    </div>
    <div class="slidey-sidebar-resize" @mousedown="startResize"></div>
  </aside>

  <!-- Embedded preview (VS Code): floating mode controls. In-place editing
       uses the same scene editor overlay as CLI + workspace. -->
  <div v-if="embedded && deck" class="slidey-embedded-edit">
    <div class="slidey-embedded-toggle" role="group" aria-label="Viewer mode">
      <button
        type="button"
        :class="{ active: viewerMode === 'edit' }"
        :aria-pressed="viewerMode === 'edit'"
        :disabled="!activeViewEditable"
        title="Edit mode — click any text on the slide to edit it"
        @click.stop="setViewerMode('edit')"
      >Edit</button>
      <button
        type="button"
        :class="{ active: viewerMode === 'present' }"
        :aria-pressed="viewerMode === 'present'"
        title="Present mode — clean full-screen view for showing the deck"
        @click.stop="setViewerMode('present')"
      >Present</button>
    </div>
      <button
        v-if="isEditMode && !embedded"
        type="button"
        class="slidey-embedded-save"
        :class="{ dirty }"
        :disabled="!dirty || saving || !activeViewEditable"
        :title="saveError || 'Save edits back to the file'"
        @click.stop="saveActive"
      >{{ saving ? 'Saving…' : (dirty ? 'Save' : 'Saved') }}</button>
      <button
        v-if="isEditMode && !embedded"
        type="button"
        class="slidey-embedded-revert"
        :disabled="!dirty || saving || !activeViewEditable"
        title="Discard edits and revert to the last saved version"
        @click.stop="revertActive"
      >Revert</button>
    <span v-if="isEditMode && !embedded && saveError" class="slidey-embedded-saveerr" :title="saveError">⚠ save failed</span>
  </div>

  <!-- Embedded preview: floating manual-reload button (deck also auto-reloads). -->
  <button
    v-if="embedded && deck"
    class="slidey-embedded-reload"
    :class="{ spinning: reloading }"
    :disabled="reloading"
    title="Reload this deck from disk"
    aria-label="Reload deck"
    @click.stop="reloadActive"
  >⟳</button>

  <!-- Reload-failure toast: the previous deck stays on screen; this just informs. -->
  <div v-if="reloadError" class="slidey-reload-toast" @click="clearReloadError">
    <span class="slidey-reload-toast-icon">⚠</span>
    <span class="slidey-reload-toast-msg">{{ reloadError }}</span>
  </div>

  <button
    v-if="deck && libraryBackAffordance && !isEditMode"
    type="button"
    class="slidey-library-affordance slidey-library-affordance-up slidey-library-link"
    :title="libraryBackAffordance.context ? `Back up to ${libraryBackAffordance.title}: ${libraryBackAffordance.context}` : `Back up to ${libraryBackAffordance.title}`"
    @click.stop="openLibraryBackAffordance"
  >
    <span class="slidey-library-affordance-kicker">&uarr; {{ libraryBackAffordance.action }}</span>
    <span class="slidey-library-affordance-title">{{ libraryBackAffordance.title }}</span>
    <span v-if="libraryBackAffordance.context" class="slidey-library-affordance-context">{{ libraryBackAffordance.context }}</span>
  </button>

  <button
    v-if="deck && libraryForwardAffordance && !isEditMode"
    type="button"
    class="slidey-library-affordance slidey-library-affordance-down slidey-library-link"
    :title="libraryForwardAffordance.context ? `Return down to ${libraryForwardAffordance.title}: ${libraryForwardAffordance.context}` : `Return down to ${libraryForwardAffordance.title}`"
    @click.stop="openLibraryForwardAffordance"
  >
    <span class="slidey-library-affordance-kicker">&darr; {{ libraryForwardAffordance.action }}</span>
    <span class="slidey-library-affordance-title">{{ libraryForwardAffordance.title }}</span>
    <span v-if="libraryForwardAffordance.context" class="slidey-library-affordance-context">{{ libraryForwardAffordance.context }}</span>
  </button>

  <nav
    v-if="deck && libraryDeckRows.length"
    class="slidey-collection-nav"
    aria-label="Collection navigation"
    @click.stop
  >
    <div class="slidey-collection-tabs" role="group" aria-label="Collection menus">
      <button
        type="button"
        class="slidey-collection-tab"
        :class="{ active: openCollectionMenu === 'hierarchy', current: activeIsHierarchy }"
        :aria-expanded="openCollectionMenu === 'hierarchy'"
        aria-controls="slidey-hierarchy-menu"
        title="Hierarchy navigation"
        @click.stop="toggleCollectionMenu('hierarchy')"
      >
        <span class="slidey-collection-tab-label">Hierarchy</span>
        <span class="slidey-collection-tab-value" :title="activeHierarchySummary">{{ activeHierarchySummary }}</span>
      </button>
      <button
        type="button"
        class="slidey-collection-tab"
        :class="{ active: openCollectionMenu === 'subsets', current: activeIsSubset }"
        :aria-expanded="openCollectionMenu === 'subsets'"
        aria-controls="slidey-subsets-menu"
        title="Subset views"
        @click.stop="toggleCollectionMenu('subsets')"
      >
        <span class="slidey-collection-tab-label">Subsets</span>
        <span class="slidey-collection-tab-value" :title="activeSubsetSummary">{{ activeSubsetSummary }}</span>
      </button>
    </div>

    <section
      v-if="openCollectionMenu === 'hierarchy'"
      id="slidey-hierarchy-menu"
      class="slidey-collection-popover slidey-collection-popover-hierarchy"
      aria-label="Hierarchy menu"
    >
      <header class="slidey-collection-popover-head">
        <div>
          <div class="slidey-collection-kicker">Hierarchy</div>
          <div class="slidey-collection-title" :title="collectionTitle">{{ collectionTitle }}</div>
        </div>
        <div class="slidey-collection-status">{{ activeDeckStatus }}</div>
      </header>

      <div class="slidey-hierarchy-trail" aria-label="Current hierarchy path">
        <button
          v-for="(crumb, i) in activeHierarchyTrail"
          :key="crumb.id"
          type="button"
          class="slidey-hierarchy-crumb"
          :class="{ active: crumb.id === activeDeckId }"
          :title="crumb.description || crumb.title"
          @click.stop="switchLibraryDeckFromMenu(crumb.id)"
        >
          <span v-if="i" class="slidey-hierarchy-separator" aria-hidden="true">&rsaquo;</span>
          <span>{{ crumb.title }}</span>
        </button>
      </div>

      <div v-if="hierarchyLinkRows.length" class="slidey-hierarchy-next" aria-label="Hierarchy destinations from current slide">
        <div class="slidey-collection-section-label">{{ currentSectionTitle || 'Current slide' }}</div>
        <button
          v-for="(link, i) in hierarchyLinkRows"
          :key="`${link.deck}:${link.section || ''}:${link.scene || ''}:${i}`"
          type="button"
          class="slidey-hierarchy-next-row"
          @click.stop="openLibraryLink(link)"
        >
          <span class="slidey-hierarchy-next-relation">{{ link.relation }}</span>
          <span class="slidey-hierarchy-next-title">{{ link.label }}</span>
          <span v-if="link.metaText" class="slidey-hierarchy-next-meta">{{ link.metaText }}</span>
        </button>
      </div>

      <div class="slidey-hierarchy-map" aria-label="Collection hierarchy">
        <button
          v-for="option in hierarchyDeckRows"
          :key="option.id"
          type="button"
          class="slidey-hierarchy-map-row"
          :class="{ active: option.id === activeDeckId }"
          :style="{ paddingLeft: (10 + option.level * 18) + 'px' }"
          :title="option.description || option.title"
          @click.stop="switchLibraryDeckFromMenu(option.id)"
        >
          <span class="slidey-hierarchy-node" :class="`kind-${option.kind.toLowerCase()}`"></span>
          <span class="slidey-hierarchy-map-copy">
            <span class="slidey-hierarchy-map-title">{{ option.title }}</span>
            <span v-if="option.metaText" class="slidey-hierarchy-map-meta">{{ option.metaText }}</span>
          </span>
          <span class="slidey-hierarchy-map-kind">{{ option.kind }}</span>
        </button>
      </div>
    </section>

    <section
      v-if="openCollectionMenu === 'subsets'"
      id="slidey-subsets-menu"
      class="slidey-collection-popover slidey-collection-popover-subsets"
      aria-label="Subsets menu"
    >
      <header class="slidey-collection-popover-head">
        <div>
          <div class="slidey-collection-kicker">Subsets</div>
          <div class="slidey-collection-title" :title="collectionTitle">{{ collectionTitle }}</div>
        </div>
        <div class="slidey-collection-status">{{ sourceSceneCount }} source slides</div>
      </header>

      <div v-if="subsetLinkRows.length" class="slidey-subset-linked" aria-label="Subset destinations from current slide">
        <div class="slidey-collection-section-label">{{ currentSectionTitle || 'Current slide' }}</div>
        <button
          v-for="(link, i) in subsetLinkRows"
          :key="`${link.deck}:${link.section || ''}:${link.scene || ''}:${i}`"
          type="button"
          class="slidey-subset-row linked"
          @click.stop="openLibraryLink(link)"
        >
          <span class="slidey-subset-title">{{ link.label }}</span>
          <span v-if="link.metaText" class="slidey-subset-meta">{{ link.metaText }}</span>
        </button>
      </div>

      <div class="slidey-subset-list" aria-label="Subset decks">
        <button
          v-for="option in subsetDeckRows"
          :key="option.id"
          type="button"
          class="slidey-subset-row"
          :class="{ active: option.id === activeDeckId }"
          :title="option.description || option.title"
          @click.stop="switchLibraryDeckFromMenu(option.id)"
        >
          <span class="slidey-subset-main">
            <span class="slidey-subset-title">{{ option.title }}</span>
            <span class="slidey-subset-count">{{ option.sceneCount }} slides</span>
          </span>
          <span v-if="option.metaText" class="slidey-subset-meta">{{ option.metaText }}</span>
        </button>
        <div v-if="!subsetDeckRows.length" class="slidey-subset-empty">No subsets</div>
      </div>
    </section>
  </nav>

  <!-- Save conflict: the file changed on disk (e.g. an AI edit) while you had
       unsaved changes. Resolve by keeping yours or taking the on-disk version —
       neither side is discarded without a choice. -->
  <div v-if="conflict" class="slidey-conflict" role="alertdialog" aria-label="Save conflict">
    <div class="slidey-conflict-icon">⚠</div>
    <div class="slidey-conflict-body">
      <div class="slidey-conflict-title">This deck changed on disk while you were editing</div>
      <div class="slidey-conflict-msg">Saving now would overwrite the other change. Keep your version, or discard your edits and load the on-disk one.</div>
    </div>
    <div class="slidey-conflict-actions">
      <button
        type="button"
        class="slidey-conflict-ours"
        :disabled="saving || reloading"
        title="Overwrite the on-disk version with your edits"
        @click.stop="resolveConflictOurs"
      >Keep mine</button>
      <button
        type="button"
        class="slidey-conflict-theirs"
        :disabled="saving || reloading"
        title="Discard your edits and load the version on disk"
        @click.stop="resolveConflictTheirs"
      >Use on-disk</button>
    </div>
  </div>

  <DeckHost />
  <NavController
    v-if="deck"
    :key="activePath"
    :deck="deck"
    :is-inline-editing="isInlineEditing"
    :suppress-deck-click="suppressDeckNavClick"
    :clear-deck-click-suppression="clearDeckClickSuppression"
    :narration-state="narrationState"
    :listen-narration="listenCurrentNarration"
    :start-live-narration="startLiveNarration"
    :stop-narration="stopNarration"
  />
  <div
    v-if="rrwebModal.open"
    class="slidey-rrweb-modal"
    data-testid="rrweb-popout-modal"
    role="dialog"
    aria-modal="true"
    aria-label="Session replay"
    @click.self="closeRrwebModal"
  >
    <section class="slidey-rrweb-panel">
      <header class="slidey-rrweb-head">
        <div class="slidey-rrweb-titleblock">
          <div class="slidey-rrweb-kicker">Session replay</div>
          <h2>{{ rrwebModal.title }}</h2>
          <p :title="rrwebModal.href">{{ rrwebModal.ref }}</p>
        </div>
        <button
          type="button"
          class="slidey-rrweb-close"
          data-testid="rrweb-popout-close"
          aria-label="Close replay"
          @click="closeRrwebModal"
        >×</button>
      </header>
      <div class="slidey-rrweb-body">
        <div v-if="rrwebModal.loading" class="slidey-rrweb-message">Loading replay…</div>
        <div v-else-if="rrwebModal.error" class="slidey-rrweb-message error">{{ rrwebModal.error }}</div>
        <RrwebPlayer
          v-else
          data-testid="rrweb-popout-player"
          :events="rrwebModal.events"
          :chapters="rrwebModal.chapters"
          :autoplay="false"
          :controls="true"
        />
      </div>
    </section>
  </div>
  <div v-if="workspace && !embedded && viewerMode === 'present' && deck" class="slidey-present-toolbar" role="group" aria-label="Viewer mode">
    <button
      type="button"
      :class="{ active: viewerMode === 'browse' }"
      :aria-pressed="viewerMode === 'browse'"
      title="Browse mode"
      @click.stop="setViewerMode('browse')"
    >Browse</button>
      <button
        type="button"
        :class="{ active: viewerMode === 'edit' }"
        :aria-pressed="viewerMode === 'edit'"
        :disabled="!activeViewEditable"
        title="Edit mode"
        @click.stop="setViewerMode('edit')"
      >Edit</button>
  </div>
  <SceneEditor
    v-if="workspace && isEditMode && deck && currentSpec && activeViewEditable"
    :key="activePath"
    :deck="deck"
    :spec="currentSpec"
    :active-path="activePath"
    :dirty="dirty"
    :saving="saving"
    :save-error="saveError"
    :schema="schema"
    :narration-state="narrationState"
    @change="markDirty"
    @save="saveActive"
    @revert="revertActive"
    @listen-narration="listenCurrentNarration"
    @stop-narration="stopNarration"
  />

  <!-- Empty stage hint in workspace mode before a deck is chosen -->
  <div v-if="workspace && !deck" class="slidey-stage-empty">
    <p v-if="loading">Loading…</p>
    <template v-else>
      <p v-if="!embedded">Select a spec from the file tree.</p>
      <p v-if="error" class="slidey-loader-error">{{ error }}</p>
    </template>
  </div>

  <!-- Standalone loader / file picker (non-workspace) -->
  <div v-if="!deck && !workspace" class="slidey-loader">
    <div class="slidey-loader-card">
      <div class="slidey-loader-title">slidey</div>
      <p v-if="loading">Loading spec…</p>
      <template v-else>
        <p class="slidey-loader-hint">Load a scene spec to begin.</p>
        <p v-if="error" class="slidey-loader-error">{{ error }}</p>
        <label class="slidey-loader-btn">
          Choose spec.json…
          <input type="file" accept="application/json,.json" @change="onFile" hidden>
        </label>
        <p class="slidey-loader-tip">or pass <code>?spec=&lt;url&gt;</code></p>
      </template>
    </div>
  </div>
</template>

<style>
.slidey-loader {
  position: fixed; inset: 0; z-index: 2000;
  display: flex; align-items: center; justify-content: center;
  background: #0d1117; color: #e6edf3;
  font-family: 'Courier New', monospace;
}
.slidey-loader-card { text-align: center; max-width: 520px; padding: 40px; }
.slidey-loader-title {
  font-size: 56px; font-weight: bold;
  background: linear-gradient(180deg, #58a6ff, #bc8cff);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  margin-bottom: 18px;
}
.slidey-loader-hint { color: #8b949e; margin-bottom: 24px; }
.slidey-loader-error { color: #f85149; margin-bottom: 16px; }
.slidey-loader-btn {
  display: inline-block; cursor: pointer;
  padding: 12px 28px; border-radius: 8px;
  background: #1f6feb; color: #fff; font-weight: bold;
}
.slidey-loader-tip { color: #484f58; margin-top: 20px; font-size: 15px; }
.slidey-loader-tip code { color: #79c0ff; }

.slidey-rrweb-modal {
  position: fixed;
  inset: 0;
  z-index: 3200;
  display: grid;
  place-items: center;
  padding: 28px;
  box-sizing: border-box;
  background: rgba(2, 6, 12, 0.78);
  font-family: 'Courier New', monospace;
}
.slidey-rrweb-panel {
  width: min(1500px, calc(100vw - 56px));
  height: min(920px, calc(100vh - 56px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid #30363d;
  border-radius: 10px;
  overflow: hidden;
  background: #0d1117;
  color: #e6edf3;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.46);
}
.slidey-rrweb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 18px;
  border-bottom: 1px solid #30363d;
  background: #161b22;
}
.slidey-rrweb-titleblock { min-width: 0; }
.slidey-rrweb-kicker {
  color: #58a6ff;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.slidey-rrweb-titleblock h2 {
  margin: 3px 0 4px;
  font: 700 22px/1.2 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.slidey-rrweb-titleblock p {
  margin: 0;
  max-width: 980px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8b949e;
  font-size: 13px;
}
.slidey-rrweb-close {
  width: 38px;
  height: 38px;
  border: 1px solid #30363d;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #c9d1d9;
  background: #0d1117;
  font-size: 28px;
  line-height: 1;
  cursor: pointer;
}
.slidey-rrweb-close:hover,
.slidey-rrweb-close:focus-visible {
  border-color: #58a6ff;
  color: #fff;
  outline: none;
}
.slidey-rrweb-body {
  min-height: 0;
  padding: 18px;
  box-sizing: border-box;
}
.slidey-rrweb-body .rrp {
  width: 100%;
  height: 100%;
}
.slidey-rrweb-body .rrp-host {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  aspect-ratio: auto;
}
.slidey-rrweb-message {
  height: 100%;
  display: grid;
  place-items: center;
  color: #8b949e;
  font-size: 18px;
}
.slidey-rrweb-message.error { color: #ff7b72; }

/* Workspace present mode — quick return to browse/edit while full-screen. */
.slidey-present-toolbar {
  position: fixed;
  top: 14px;
  left: 14px;
  z-index: 2100;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px;
  border: 1px solid #30363d;
  border-radius: 7px;
  overflow: hidden;
  background: #161b22cc;
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}
.slidey-present-toolbar button {
  border: none;
  background: transparent;
  color: #8b949e;
  cursor: pointer;
  padding: 5px 12px;
  font-size: 12px;
  font-family: 'Courier New', monospace;
  font-weight: bold;
}
.slidey-present-toolbar button.active {
  background: #1f6feb;
  color: #fff;
}

/* Embedded preview edit controls — float over the deck, upper-left. */
.slidey-embedded-edit {
  position: fixed;
  top: 14px; left: 14px;
  z-index: 2100;
  display: flex; align-items: center; gap: 8px;
  font-family: 'Courier New', monospace;
}
.slidey-embedded-toggle {
  display: inline-flex;
  border: 1px solid #30363d;
  border-radius: 7px;
  overflow: hidden;
  background: #161b22cc;
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}
.slidey-embedded-toggle button {
  border: none; background: transparent;
  color: #8b949e; cursor: pointer;
  padding: 5px 12px; font-size: 12px; font-weight: bold;
  font-family: inherit;
}
.slidey-embedded-toggle button.active { background: #1f6feb; color: #fff; }
.slidey-embedded-save {
  border: 1px solid #30363d;
  border-radius: 7px;
  background: #161b22cc;
  color: #6e7681;
  padding: 5px 14px; font-size: 12px; font-weight: bold;
  font-family: inherit; cursor: default;
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}
.slidey-embedded-save.dirty { background: #238636; border-color: #238636; color: #fff; cursor: pointer; }
.slidey-embedded-save:disabled { cursor: default; }
.slidey-embedded-revert {
  border: 1px solid #30363d;
  border-radius: 7px;
  background: #161b22cc;
  color: #c9d1d9;
  padding: 5px 14px; font-size: 12px; font-weight: bold;
  font-family: inherit; cursor: pointer;
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}
.slidey-embedded-revert:hover:not(:disabled) { border-color: #f85149; color: #f85149; }
.slidey-embedded-revert:disabled { color: #6e7681; cursor: default; }
.slidey-embedded-saveerr { color: #f85149; font-size: 12px; }

/* Embedded preview reload button — floats over the deck, upper-right. */
.slidey-embedded-reload {
  position: fixed;
  top: 14px; right: 14px;
  z-index: 2100;
  width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid #30363d;
  border-radius: 50%;
  background: #161b22cc;
  color: #79c0ff;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.15s ease, background 0.15s ease;
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}
.slidey-embedded-reload:hover { opacity: 1; background: #1f6feb33; }
.slidey-embedded-reload:disabled { cursor: default; }
.slidey-embedded-reload.spinning {
  opacity: 1;
  animation: slidey-embedded-spin 0.8s linear infinite;
}
@keyframes slidey-embedded-spin {
  to { transform: rotate(360deg); }
}

/* Reload-failure toast — non-blocking; the previous deck stays interactive. */
.slidey-reload-toast {
  position: fixed;
  top: 16px; left: 50%;
  transform: translateX(-50%);
  z-index: 2100;
  max-width: min(680px, 80vw);
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 16px;
  border: 1px solid #9e6a03;
  border-radius: 8px;
  background: #2d2206;
  color: #f0d894;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 6px 20px rgba(0,0,0,0.4);
  cursor: pointer;
}
.slidey-reload-toast-icon { color: #e3b341; flex: none; }
.slidey-reload-toast-msg { overflow-wrap: anywhere; }

.slidey-library-affordance {
  position: fixed;
  z-index: 2088;
  max-width: min(330px, calc(100vw - var(--slidey-sidebar-w, 0px) - 32px));
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2px;
  padding: 9px 12px 10px;
  border: 1px solid #30363d;
  border-radius: 8px;
  background: #0d1117e8;
  color: #c9d1d9;
  font-family: 'Courier New', monospace;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  box-shadow: 0 10px 28px rgba(0,0,0,0.3);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}
.slidey-library-affordance-up {
  top: 14px;
  left: calc(var(--slidey-sidebar-w, 0px) + 14px);
  border-color: #58a6ff99;
  box-shadow: inset 3px 0 0 #58a6ff, 0 10px 28px rgba(0,0,0,0.3);
}
body.slidey-embedded .slidey-library-affordance-up,
body.slidey-workspace.slidey-present-mode .slidey-library-affordance-up {
  top: 58px;
}
.slidey-library-affordance-down {
  right: 18px;
  bottom: 74px;
  border-color: #3fb95099;
  box-shadow: inset -3px 0 0 #3fb950, 0 10px 28px rgba(0,0,0,0.3);
}
body.slidey-video-full .slidey-library-affordance-down {
  bottom: 18px;
}
.slidey-library-affordance:hover,
.slidey-library-affordance:focus-visible {
  outline: none;
  background: #102844f2;
  color: #f0f6fc;
}
.slidey-library-affordance-down:hover,
.slidey-library-affordance-down:focus-visible {
  background: #0f2b1af2;
}
.slidey-library-affordance-kicker,
.slidey-library-affordance-title,
.slidey-library-affordance-context {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slidey-library-affordance-kicker {
  color: #79c0ff;
  font-size: 10px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0;
}
.slidey-library-affordance-down .slidey-library-affordance-kicker {
  color: #7ee787;
}
.slidey-library-affordance-title {
  color: #f0f6fc;
  font-size: 13px;
  font-weight: bold;
}
.slidey-library-affordance-context {
  color: #8b949e;
  font-size: 11px;
}

/* Collection navigation: hierarchy and subsets stay distinct. */
.slidey-collection-nav {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 2090;
  width: min(560px, calc(100vw - 28px));
  color: #c9d1d9;
  font-family: 'Courier New', monospace;
  pointer-events: none;
  box-sizing: border-box;
}
body.slidey-embedded .slidey-collection-nav {
  top: 56px;
}
body.slidey-workspace.slidey-edit-mode .slidey-collection-nav {
  right: calc(var(--slidey-editor-w, 380px) + 14px);
  width: min(520px, calc(100vw - var(--slidey-editor-w, 380px) - 28px));
}
.slidey-collection-tabs {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  pointer-events: auto;
}
.slidey-collection-tab {
  min-width: 168px;
  max-width: 270px;
  min-height: 46px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  padding: 7px 10px;
  border: 1px solid #30363d;
  border-radius: 8px;
  background: #0d1117e8;
  color: #8b949e;
  font-family: inherit;
  text-align: left;
  box-shadow: 0 8px 24px rgba(0,0,0,0.22);
  cursor: pointer;
  box-sizing: border-box;
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}
.slidey-collection-tab:hover {
  border-color: #58a6ff;
  color: #c9d1d9;
}
.slidey-collection-tab.active {
  border-color: #58a6ff;
  background: #102844f2;
}
.slidey-collection-tab.current {
  box-shadow: inset 3px 0 0 #58a6ff, 0 8px 24px rgba(0,0,0,0.22);
}
.slidey-collection-tab:nth-child(2).active {
  border-color: #d29922;
  background: #2b2109f2;
}
.slidey-collection-tab:nth-child(2).current {
  box-shadow: inset 3px 0 0 #d29922, 0 8px 24px rgba(0,0,0,0.22);
}
.slidey-collection-tab-label,
.slidey-collection-tab-value {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slidey-collection-tab-label {
  color: #f0f6fc;
  font-size: 12px;
  font-weight: bold;
}
.slidey-collection-tab-value {
  color: #8b949e;
  font-size: 11px;
}
.slidey-collection-popover {
  width: min(520px, 100%);
  margin-top: 8px;
  margin-left: auto;
  padding: 10px;
  border: 1px solid #30363d;
  border-radius: 8px;
  background: #0d1117f4;
  box-shadow: 0 16px 40px rgba(0,0,0,0.36);
  box-sizing: border-box;
  pointer-events: auto;
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
.slidey-collection-popover-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 2px 10px;
  border-bottom: 1px solid #21262d;
}
.slidey-collection-kicker {
  color: #58a6ff;
  font-size: 10px;
  line-height: 1.2;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0;
}
.slidey-collection-popover-subsets .slidey-collection-kicker {
  color: #d29922;
}
.slidey-collection-title,
.slidey-collection-status {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slidey-collection-title {
  margin-top: 3px;
  color: #f0f6fc;
  font-size: 13px;
  font-weight: bold;
}
.slidey-collection-status {
  flex: none;
  max-width: 190px;
  padding: 3px 7px;
  border: 1px solid #30363d;
  border-radius: 999px;
  color: #8b949e;
  font-size: 10px;
}
.slidey-hierarchy-trail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 10px 2px;
  border-bottom: 1px solid #21262d;
}
.slidey-hierarchy-crumb {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  border: 0;
  background: transparent;
  color: #8b949e;
  font-family: inherit;
  font-size: 12px;
  font-weight: bold;
  cursor: pointer;
}
.slidey-hierarchy-crumb span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slidey-hierarchy-crumb:hover {
  color: #c9d1d9;
}
.slidey-hierarchy-crumb.active {
  color: #79c0ff;
}
.slidey-hierarchy-separator {
  color: #484f58;
}
.slidey-hierarchy-next,
.slidey-subset-linked {
  margin-top: 10px;
  padding: 8px;
  border: 1px solid #264f78;
  border-radius: 8px;
  background: #0b274233;
}
.slidey-subset-linked {
  border-color: #6e4f10;
  background: #3b2b0733;
}
.slidey-collection-section-label {
  margin: 0 0 6px;
  color: #8b949e;
  font-size: 11px;
  font-weight: bold;
}
.slidey-hierarchy-next-row,
.slidey-hierarchy-map-row,
.slidey-subset-row {
  width: 100%;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #c9d1d9;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
}
.slidey-hierarchy-next-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 2px 8px;
  align-items: center;
  padding: 7px 8px;
}
.slidey-hierarchy-next-row:hover,
.slidey-hierarchy-map-row:hover {
  border-color: #58a6ff;
  background: #1f6feb24;
}
.slidey-hierarchy-next-relation {
  grid-row: span 2;
  align-self: center;
  color: #79c0ff;
  font-size: 10px;
  font-weight: bold;
  text-transform: uppercase;
}
.slidey-hierarchy-next-title,
.slidey-hierarchy-next-meta,
.slidey-hierarchy-map-title,
.slidey-hierarchy-map-meta,
.slidey-subset-title,
.slidey-subset-meta {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slidey-hierarchy-next-title,
.slidey-hierarchy-map-title,
.slidey-subset-title {
  font-size: 13px;
  font-weight: bold;
}
.slidey-hierarchy-next-meta,
.slidey-hierarchy-map-meta,
.slidey-subset-meta {
  color: #8b949e;
  font-size: 11px;
}
.slidey-hierarchy-map {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 10px;
}
.slidey-hierarchy-map-row {
  min-height: 48px;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding-top: 6px;
  padding-right: 8px;
  padding-bottom: 6px;
}
.slidey-hierarchy-map-row.active {
  border-color: #58a6ff;
  background: #1f6feb2b;
}
.slidey-hierarchy-node {
  width: 11px;
  height: 11px;
  border: 2px solid #8b949e;
  border-radius: 50%;
  box-sizing: border-box;
}
.slidey-hierarchy-node.kind-source {
  border-color: #8b949e;
}
.slidey-hierarchy-node.kind-summary {
  border-color: #58a6ff;
  background: #58a6ff;
}
.slidey-hierarchy-node.kind-detail {
  border-color: #3fb950;
  background: #3fb950;
}
.slidey-hierarchy-node.kind-deck {
  border-color: #3fb950;
  background: #3fb950;
}
.slidey-hierarchy-map-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.slidey-hierarchy-map-kind,
.slidey-subset-count {
  flex: none;
  padding: 2px 6px;
  border: 1px solid #30363d;
  border-radius: 999px;
  color: #8b949e;
  font-size: 10px;
  white-space: nowrap;
}
.slidey-hierarchy-map-row.active .slidey-hierarchy-map-kind {
  border-color: #79c0ff99;
  color: #cfe8ff;
}
.slidey-subset-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 10px;
}
.slidey-subset-row {
  min-height: 50px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 8px 9px;
}
.slidey-subset-row:hover {
  border-color: #d29922;
  background: #d2992224;
}
.slidey-subset-row.active {
  border-color: #d29922;
  background: #d299222b;
  box-shadow: inset 3px 0 0 #d29922;
}
.slidey-subset-main {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.slidey-subset-empty {
  padding: 12px 4px 2px;
  color: #6e7681;
  font-size: 12px;
}

@media (max-width: 900px) {
  body.slidey-workspace.slidey-edit-mode .slidey-collection-nav {
    left: 12px;
    right: 12px;
    width: auto;
  }
}

@media (max-width: 760px) {
  .slidey-library-affordance-up {
    top: 72px;
    left: 12px;
    max-width: calc(100vw - 24px);
  }
  body.slidey-embedded .slidey-library-affordance-up,
  body.slidey-workspace.slidey-present-mode .slidey-library-affordance-up {
    top: 116px;
  }
  .slidey-library-affordance-down {
    right: 12px;
    bottom: 72px;
    max-width: calc(100vw - 24px);
  }
  .slidey-collection-nav {
    left: 12px;
    right: 12px;
    top: 12px;
    width: auto;
  }
  body.slidey-embedded .slidey-collection-nav {
    top: 56px;
  }
  .slidey-collection-tabs {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 7px;
  }
  .slidey-collection-tab {
    min-width: 0;
    max-width: none;
  }
  .slidey-collection-popover {
    width: 100%;
    max-height: min(560px, calc(100vh - 92px));
    overflow: auto;
  }
  .slidey-collection-popover-head {
    flex-direction: column;
    gap: 6px;
  }
  .slidey-collection-status {
    max-width: 100%;
  }
  .slidey-hierarchy-next-row {
    grid-template-columns: 64px minmax(0, 1fr);
  }
}

/* Save-conflict bar — concurrent edit detected; force an OURS/THEIRS choice. */
.slidey-conflict {
  position: fixed;
  top: 16px; left: 50%;
  transform: translateX(-50%);
  z-index: 2300;
  max-width: min(720px, 92vw);
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 16px;
  border: 1px solid #b06104;
  border-radius: 10px;
  background: #2a1d04;
  color: #f6dca0;
  font-family: 'Courier New', monospace;
  box-shadow: 0 8px 28px rgba(0,0,0,0.5);
}
.slidey-conflict-icon { color: #e3b341; font-size: 18px; line-height: 1.3; flex: none; }
.slidey-conflict-body { flex: 1 1 auto; min-width: 0; }
.slidey-conflict-title { font-weight: bold; font-size: 13px; margin-bottom: 4px; }
.slidey-conflict-msg { font-size: 12px; line-height: 1.45; color: #d6bd84; overflow-wrap: anywhere; }
.slidey-conflict-actions { display: flex; gap: 8px; flex: none; align-self: center; }
.slidey-conflict-actions button {
  border-radius: 7px;
  padding: 6px 14px; font-size: 12px; font-weight: bold;
  font-family: inherit; cursor: pointer; border: 1px solid transparent;
}
.slidey-conflict-actions button:disabled { cursor: default; opacity: 0.6; }
.slidey-conflict-ours { background: #1f6feb; color: #fff; }
.slidey-conflict-ours:hover:not(:disabled) { background: #388bfd; }
.slidey-conflict-theirs { background: transparent; border-color: #6e7681; color: #c9d1d9; }
.slidey-conflict-theirs:hover:not(:disabled) { border-color: #f0883e; color: #f0883e; }

/* ── Inline (in-place) text editing — only in edit mode ────────────────────── */
/* Hover affordance on anything click-to-editable. */
body.slidey-edit-mode [data-edit-path] {
  cursor: text;
}
body.slidey-edit-mode [data-edit-path]:hover {
  outline: 1.5px dashed rgba(56, 189, 248, 0.7);
  outline-offset: 2px;
  border-radius: 3px;
}
/* SVG <text> can't take an outline cleanly — tint it on hover instead. */
body.slidey-edit-mode svg text[data-edit-path]:hover {
  outline: none;
  fill: #38bdf8;
}
/* The element currently being edited in place (HTML contentEditable). */
.slidey-inline-editing {
  outline: 2px solid #1f6feb !important;
  outline-offset: 2px;
  border-radius: 3px;
  background: rgba(31, 111, 235, 0.08);
}
/* Overlay input used to edit SVG <text> (positioned in inline-edit.js). */
.slidey-inline-svg-input {
  padding: 2px 6px;
  border: 2px solid #1f6feb;
  border-radius: 4px;
  background: #0d1117;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
  outline: none;
  resize: none;
}

/* Empty-stage hint shown in workspace mode before a deck is opened. */
.slidey-stage-empty {
  position: fixed; top: 0; bottom: 0; right: 0;
  left: var(--slidey-sidebar-w, 300px);
  display: flex; flex-direction: column; gap: 8px;
  align-items: center; justify-content: center;
  color: #8b949e; font-family: 'Courier New', monospace;
  pointer-events: none;
}
</style>
