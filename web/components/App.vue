<script setup>
// Interactive web-app root: loads a spec, wires the deck, renders DeckHost +
// NavController. Spec source priority: window.__SLIDEY_SPEC__ (embedded by the
// single-file build) → ?spec=<url> query param → workspace mode (slidey CLI
// viewer: /api/config + file-tree sidebar) → ./spec.json → a drop/file-picker
// overlay.
import { computed, ref, shallowRef, onMounted, onUnmounted } from 'vue';
import DeckHost from './DeckHost.vue';
import NavController from './NavController.vue';
import FileTree from './FileTree.vue';
import SceneEditor from './SceneEditor.vue';
import { store } from '../store.js';
import { createDeck } from '../useDeck.js';
import { installEmbedAnnotate } from '../embed-annotate.js';
import { installInlineEdit } from '../inline-edit.js';
import { initialViewFromSearch } from '../initial-view.js';

const deck = shallowRef(null);
const currentSpec = ref(null);
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
const schema = shallowRef(null);
const sessionSpec = ref(null);         // snapshot of the latest loaded/reloaded spec
const activeSpecBaseUrl = ref('');     // base URL for currently open workspace spec
const activeSpecEditable = ref(true);
const cloning = ref(false);
const cloneError = ref('');

// Live on-disk reload: poll the open spec's mtime and offer a reload when it
// changes underneath us. A failed reload never tears down the session — it
// surfaces a transient message and leaves the current deck on screen.
const stale = ref(false);            // on-disk version differs from the loaded one
const reloadError = ref('');         // transient toast when a reload attempt fails
const reloading = ref(false);
let loadedMtime = 0;                 // mtime of the spec currently rendered
let latestMtime = 0;                 // most recent mtime observed on disk
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
  if (!activeSpecEditable.value && isEditMode.value) setViewerMode('browse');
}

async function loadSpec(spec, baseUrl, restore) {
  if (!spec || !Array.isArray(spec.scenes) || !spec.scenes.length) {
    throw new Error('spec must have a non-empty "scenes" array');
  }
  store.setMeta(spec.meta || {});
  store.setMode(inferMode(spec));
  currentSpec.value = spec;
  sessionSpec.value = cloneSpec(spec);
  activeSpecBaseUrl.value = baseUrl || '';
  dirty.value = false;
  saveError.value = '';
  const d = createDeck(currentSpec.value, baseUrl);
  // Preserve the viewer's place across a reload: map the prior scene/step onto
  // the closest position in the freshly-loaded deck before the first render, so
  // there's no flash back to the start.
  if (restore) {
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
async function openPath(rel, restore) {
  try {
    loading.value = true;
    const res = await fetch(`/api/spec?path=${encodeURIComponent(rel)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `${res.status} loading ${rel}`);
    applySpecMeta(data, rel);
    // Spec-relative gif/img assets resolve under /workspace/<dir>/ in the CLI
    // viewer, or through a VS Code webview resource URI when embedded there.
    const base = data.assetBase || new URL(`/workspace/${data.dir ? data.dir + '/' : ''}`, window.location.href).href;
    await loadSpec(data.spec, base, restore);
    activePath.value = rel;
    // Fresh file → reset the live-reload watch to this version.
    loadedMtime = latestMtime = data.mtimeMs || 0;
    stale.value = false;
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
    const { mtimeMs } = await r.json();
    if (!mtimeMs) return;
    latestMtime = mtimeMs;
    if (loadedMtime && mtimeMs !== loadedMtime) {
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
    await loadSpec(data.spec, base, restore);   // swaps deck.value only on success
    loadedMtime = latestMtime = data.mtimeMs || latestMtime;
    stale.value = false;
  } catch (err) {
    // Keep the current version on screen and continue.
    reloadError.value = `Reload failed — kept the previous version. ${String(err.message || err)}`;
    // Acknowledge the broken revision so we stop re-prompting for it; a further
    // edit (newer mtime) re-arms the stale flag on the next poll.
    loadedMtime = latestMtime;
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
    await loadSpec(spec, ''); // no base URL → relative gif assets won't resolve
  } catch (err) { error.value = String(err.message || err); }
}

function fitScale() {
  const sw = workspace.value && !embedded.value && viewerMode.value !== 'present' ? sidebarWidth.value : 0;
  const ew = workspace.value && deck.value && isEditMode.value ? editorWidth.value : 0;
  const availableW = Math.max(320, window.innerWidth - sw - ew);
  const scale = Math.min(availableW / 1920, window.innerHeight / 1080);
  document.documentElement.style.setProperty('--slidey-scale', String(scale));
  document.documentElement.style.setProperty('--slidey-sidebar-w', `${sw}px`);
  document.documentElement.style.setProperty('--slidey-editor-w', `${ew}px`);
}

function setViewerMode(mode) {
  if (mode !== 'browse' && mode !== 'edit' && mode !== 'present') return;
  if (mode === 'edit' && workspace.value && !activeSpecEditable.value) return;
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

async function saveActive() {
  if (!activePath.value || !currentSpec.value || saving.value || !activeSpecEditable.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    const res = await fetch(`/api/spec?path=${encodeURIComponent(activePath.value)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: currentSpec.value }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `${res.status} saving ${activePath.value}`);
    loadedMtime = latestMtime = data.mtimeMs || latestMtime;
    stale.value = false;
    dirty.value = false;
    sessionSpec.value = cloneSpec(currentSpec.value);
  } catch (err) {
    saveError.value = String(err.message || err);
  } finally {
    saving.value = false;
  }
}

async function revertActive() {
  if (!workspace.value || !currentSpec.value || !sessionSpec.value || !deck.value || !dirty.value || saving.value || !activeSpecEditable.value) return;
  saveError.value = '';
  const cur = deck.value.state;
  const restore = cur ? { sceneIndex: cur.sceneIndex, stepIndex: cur.stepIndex } : null;
  try {
    await loadSpec(cloneSpec(sessionSpec.value), activeSpecBaseUrl.value, restore);
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
    isActive: () => workspace.value && isEditMode.value && activeSpecEditable.value && !!deck.value
      && /\.json$/i.test(activePath.value || ''),
    getSpec: () => currentSpec.value,
    getSceneIndex: () => (deck.value && deck.value.state ? deck.value.state.sceneIndex : 0),
    render: () => deck.value && deck.value.render(),
    markDirty,
  });
  try {
    const initialView = initialViewFromSearch(window.location.search);
    // Embedded spec (single-file static build): self-contained, no fetch.
    if (window.__SLIDEY_SPEC__) {
      await loadSpec(window.__SLIDEY_SPEC__, window.location.href, initialView);
      return;
    }
    const param = new URLSearchParams(window.location.search).get('spec');
    if (param) {
      await loadSpec(await fetchSpec(param), new URL(param, window.location.href).href, initialView);
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
      if (cfg.openFile) await openPath(cfg.openFile, initialView);
      if (!cfg.openFile && viewerMode.value === 'present') setViewerMode('browse');
      fitScale();
      // Watch the open spec for on-disk edits (CLI viewer only).
      pollTimer = setInterval(pollMtime, POLL_MS);
      return;
    }
    // Convenience default for `npm run dev`: a spec.json beside index.html.
    await loadSpec(await fetchSpec('./spec.json'), window.location.href, initialView);
  } catch (err) {
    error.value = String(err.message || err);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', fitScale);
  if (pollTimer) clearInterval(pollTimer);
  if (errTimer) clearTimeout(errTimer);
  if (teardownAnnotate) teardownAnnotate();
  if (teardownInlineEdit) teardownInlineEdit();
  document.body.classList.remove('slidey-edit-mode', 'slidey-presentation-mode', 'slidey-browse-mode', 'slidey-present-mode');
});
</script>

<template>
  <!-- Workspace sidebar (CLI viewer only — hidden in the embedded preview) -->
  <aside v-if="workspace && !embedded && viewerMode !== 'present'" class="slidey-sidebar" :style="{ width: sidebarWidth + 'px' }">
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
          :disabled="!activeSpecEditable"
          :title="activeSpecEditable ? 'Edit mode' : 'Read-only: clone this report to edit'"
          @click.stop="setViewerMode('edit')"
        >{{ activeSpecEditable ? 'Edit' : 'Read-only' }}</button>
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
        :disabled="!activeSpecEditable"
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
        :disabled="!dirty || saving || !activeSpecEditable"
        :title="saveError || 'Save edits back to the file'"
        @click.stop="saveActive"
      >{{ saving ? 'Saving…' : (dirty ? 'Save' : 'Saved') }}</button>
      <button
        v-if="isEditMode && !embedded"
        type="button"
        class="slidey-embedded-revert"
        :disabled="!dirty || saving || !activeSpecEditable"
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

  <DeckHost />
  <NavController v-if="deck" :key="activePath" :deck="deck" />
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
        :disabled="!activeSpecEditable"
        title="Edit mode"
        @click.stop="setViewerMode('edit')"
      >Edit</button>
  </div>
  <SceneEditor
    v-if="workspace && isEditMode && deck && currentSpec && activeSpecEditable"
    :key="activePath"
    :deck="deck"
    :spec="currentSpec"
    :active-path="activePath"
    :dirty="dirty"
    :saving="saving"
    :save-error="saveError"
    :schema="schema"
    @change="markDirty"
    @save="saveActive"
    @revert="revertActive"
  />

  <!-- Empty stage hint in workspace mode before a deck is chosen -->
  <div v-if="workspace && !deck" class="slidey-stage-empty">
    <p v-if="loading">Loading…</p>
    <template v-else>
      <p v-if="!embedded">Select a deck from the sidebar.</p>
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
