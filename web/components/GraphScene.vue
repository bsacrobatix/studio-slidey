<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import cytoscape from 'cytoscape';
import { store } from '../store.js';

const scene = computed(() => store.scene || {});
const cyRoot = ref(null);
let cy = null;
let lastNonce = 0;

function pathEntries() {
  const raw = Array.isArray(scene.value.path) && scene.value.path.length
    ? scene.value.path
    : (Array.isArray(scene.value.focus) ? scene.value.focus : []);
  return raw.map(entry => typeof entry === 'string' ? { node: entry } : entry).filter(entry => entry && entry.node);
}

const activeEntry = computed(() => {
  const path = pathEntries();
  return store.graphFocus >= 0 ? path[store.graphFocus] || null : null;
});

const activeNode = computed(() => {
  const id = activeEntry.value && activeEntry.value.node;
  return (scene.value.nodes || []).find(n => n.id === id) || null;
});

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function nodeKindColor(kind) {
  const colors = {
    requirement: cssVar('--slidey-love', '#eb6f92'),
    substrate: cssVar('--slidey-foam', '#9ccfd8'),
    proof: cssVar('--slidey-gold', '#f6c177'),
    application: cssVar('--slidey-pine', '#31748f'),
    dependency: cssVar('--slidey-foam', '#9ccfd8'),
    environment: cssVar('--slidey-iris', '#c4a7e7'),
  };
  return colors[kind] || cssVar('--slidey-surface', '#2a273f');
}

function elements() {
  const nodes = (scene.value.nodes || []).map(n => ({
    group: 'nodes',
    data: {
      id: String(n.id),
      label: String(n.label || n.id),
      sub: String(n.sub || ''),
      kind: String(n.kind || ''),
      weight: Number(n.weight || 1),
      width: Number(n.w || n.width || 210),
      height: Number(n.h || n.height || 100),
      color: n.color || nodeKindColor(n.kind),
      textColor: n.textColor || cssVar('--slidey-text', '#e0def4'),
    },
    position: n.position || (Number.isFinite(n.x) && Number.isFinite(n.y) ? { x: n.x, y: n.y } : undefined),
    classes: [n.kind, n.className, n.classes].flat().filter(Boolean).join(' '),
  }));
  const edges = (scene.value.edges || []).map((e, idx) => ({
    group: 'edges',
    data: {
      id: String(e.id || `${e.from}-${e.to}-${idx}`),
      source: String(e.from),
      target: String(e.to),
      label: String(e.label || ''),
      weight: Number(e.weight || e.influence || 2),
      color: e.color || cssVar('--slidey-iris', '#c4a7e7'),
      curve: e.curve || 'bezier',
    },
    classes: [e.kind, e.className, e.classes].flat().filter(Boolean).join(' '),
  }));
  return [...nodes, ...edges];
}

function layoutConfig({ animate = false } = {}) {
  const name = scene.value.layout || (hasPinnedPositions() ? 'preset' : 'cose');
  const common = {
    name,
    animate: animate && !document.body.classList.contains('instant'),
    animationDuration: Number(scene.value.animationMs || 700),
    fit: true,
    padding: Number(scene.value.padding || 55),
  };
  if (name === 'breadthfirst') {
    return {
      ...common,
      directed: scene.value.directed !== false,
      spacingFactor: Number(scene.value.spacingFactor || 1.15),
      roots: Array.isArray(scene.value.roots) ? scene.value.roots.map(id => `#${CSS.escape(String(id))}`).join(', ') : undefined,
    };
  }
  if (name === 'concentric') {
    const center = activeEntry.value && activeEntry.value.node;
    return {
      ...common,
      minNodeSpacing: Number(scene.value.minNodeSpacing || 90),
      concentric: node => node.id() === center ? 10 : Number(node.data('weight') || 1),
      levelWidth: () => 2,
    };
  }
  if (name === 'cose') {
    return {
      ...common,
      nodeDimensionsIncludeLabels: true,
      idealEdgeLength: Number(scene.value.idealEdgeLength || 210),
      nodeOverlap: Number(scene.value.nodeOverlap || 26),
      randomize: scene.value.randomize === true,
    };
  }
  return common;
}

function hasPinnedPositions() {
  return (scene.value.nodes || []).some(n => n.position || (Number.isFinite(n.x) && Number.isFinite(n.y)));
}

function rebuild() {
  if (!cyRoot.value) return;
  const pending = new Promise(resolve => {
    if (cy) cy.destroy();
    cy = cytoscape({
      container: cyRoot.value,
      elements: elements(),
      wheelSensitivity: 0.25,
      userZoomingEnabled: scene.value.interactive === true,
      userPanningEnabled: scene.value.interactive === true,
      boxSelectionEnabled: false,
      autoungrabify: true,
      style: [
        {
          selector: 'node',
          style: {
            shape: 'ellipse',
            width: ele => ele.data('width'),
            height: ele => ele.data('height'),
            'background-color': ele => ele.data('color'),
            'border-color': 'rgba(255,255,255,0.62)',
            'border-width': 3,
            label: ele => ele.data('sub') ? `${ele.data('label')}\n${ele.data('sub')}` : ele.data('label'),
            color: ele => ele.data('textColor'),
            'font-family': cssVar('--slidey-font-family', 'ui-sans-serif, system-ui, sans-serif'),
            'font-size': Number(scene.value.nodeFontSize || 24),
            'font-weight': 760,
            'text-wrap': 'wrap',
            'text-max-width': ele => Math.max(120, ele.data('width') - 26),
            'text-valign': 'center',
            'text-halign': 'center',
            'line-height': 1.12,
            'text-outline-color': 'rgba(6,10,20,0.76)',
            'text-outline-width': 3,
            'overlay-opacity': 0,
            'transition-property': 'border-width, opacity, background-color, line-color, target-arrow-color, width',
            'transition-duration': document.body.classList.contains('instant') ? 0 : 320,
          },
        },
        {
          selector: 'edge',
          style: {
            width: ele => Math.max(2, Math.min(12, Number(ele.data('weight') || 2))),
            'line-color': ele => ele.data('color'),
            'target-arrow-color': ele => ele.data('color'),
            'target-arrow-shape': 'triangle',
            'curve-style': ele => ele.data('curve') || 'bezier',
            opacity: 0.58,
            label: ele => ele.data('label'),
            color: cssVar('--slidey-text', '#e0def4'),
            'font-family': cssVar('--slidey-font-family', 'ui-sans-serif, system-ui, sans-serif'),
            'font-size': Number(scene.value.edgeFontSize || 20),
            'font-weight': 760,
            'text-background-color': 'rgba(9,14,26,0.88)',
            'text-background-opacity': 1,
            'text-background-padding': 6,
            'text-border-color': 'rgba(255,255,255,0.12)',
            'text-border-width': 1,
            'text-border-opacity': 1,
            'text-rotation': 'autorotate',
            'text-margin-y': -12,
          },
        },
        { selector: '.seen', style: { opacity: 0.92 } },
        { selector: 'edge.seen', style: { opacity: 0.78 } },
        {
          selector: '.related',
          style: {
            opacity: 0.9,
            'line-color': ele => ele.data('color'),
            'target-arrow-color': ele => ele.data('color'),
          },
        },
        {
          selector: '.active',
          style: {
            opacity: 1,
            'border-width': 8,
            'border-color': cssVar('--slidey-gold', '#f6c177'),
          },
        },
        {
          selector: 'edge.active',
          style: {
            opacity: 1,
            width: ele => Math.max(6, Math.min(14, Number(ele.data('weight') || 2) + 2)),
            'line-color': cssVar('--slidey-gold', '#f6c177'),
            'target-arrow-color': cssVar('--slidey-gold', '#f6c177'),
          },
        },
        { selector: '.dim', style: { opacity: 0.28 } },
      ],
    });

    const layout = cy.layout(layoutConfig({ animate: false }));
    layout.one('layoutstop', () => {
      cy.fit(undefined, Number(scene.value.padding || 55));
      resolve();
    });
    layout.run();
    setTimeout(resolve, 1200);
  });
  if (window.__slideyPendingRenders) window.__slideyPendingRenders.add(pending);
  pending.finally(() => {
    if (window.__slideyPendingRenders) window.__slideyPendingRenders.delete(pending);
    applyFocus();
  });
}

function applyFocus() {
  if (!cy) return;
  const path = pathEntries();
  const idx = store.graphFocus;
  cy.elements().removeClass('active seen related dim');
  if (idx < 0 || !path[idx]) {
    cy.fit(undefined, Number(scene.value.padding || 55));
    return;
  }

  const current = cy.getElementById(String(path[idx].node));
  const seenIds = new Set(path.slice(0, idx + 1).map(entry => String(entry.node)));
  cy.nodes().forEach(node => {
    if (seenIds.has(node.id())) node.addClass('seen');
    else node.addClass('dim');
  });
  current.removeClass('dim').addClass('active seen');

  const explicitEdges = new Set([path[idx].edge, ...(path[idx].edges || [])].filter(Boolean).map(String));
  cy.edges().forEach(edge => {
    const srcSeen = seenIds.has(edge.source().id());
    const tgtSeen = seenIds.has(edge.target().id());
    const touchesCurrent = edge.source().id() === current.id() || edge.target().id() === current.id();
    if (explicitEdges.has(edge.id()) || (srcSeen && tgtSeen)) edge.addClass('active');
    else if (touchesCurrent) edge.addClass('related');
    else edge.addClass('dim');
  });

  const animate = !document.body.classList.contains('instant');
  const zoom = Number(path[idx].zoom || scene.value.focusZoom || 1.12);
  const duration = Number(path[idx].durationMs || scene.value.animationMs || 700);
  if (scene.value.focusLayout) {
    cy.layout({ ...layoutConfig({ animate }), name: scene.value.focusLayout }).run();
  }
  if (animate) {
    cy.animate({ center: { eles: current }, zoom }, { duration, easing: 'ease-in-out-cubic' });
  } else {
    cy.center(current);
    cy.zoom({ level: zoom, position: current.position() });
  }
}

watch(() => store.sceneNonce, async nonce => {
  if (nonce === lastNonce) return;
  lastNonce = nonce;
  await nextTick();
  rebuild();
}, { immediate: true });

watch(() => store.graphFocus, applyFocus);

onBeforeUnmount(() => {
  if (cy) cy.destroy();
  cy = null;
});
</script>

<template>
  <div id="graph-region" class="scene-region active graph-scene">
    <div
      v-if="scene.title"
      id="graph-title"
      class="graph-title reveal"
      :class="{ shown: store.isRevealed('graph-title') }"
      data-edit-path='["title"]'
    >{{ scene.title }}</div>
    <div
      id="graph-frame"
      class="graph-frame reveal"
      :class="{ shown: store.isRevealed('graph-frame') }"
    >
      <div ref="cyRoot" class="graph-canvas"></div>
      <div v-if="activeNode" class="graph-focus-card">
        <div class="graph-focus-label">{{ activeNode.label || activeNode.id }}</div>
        <div v-if="activeEntry?.note || activeNode.sub" class="graph-focus-note">{{ activeEntry?.note || activeNode.sub }}</div>
      </div>
    </div>
    <div
      v-if="scene.caption"
      id="graph-caption"
      class="graph-caption reveal"
      :class="{ shown: store.isRevealed('graph-caption') }"
      data-edit-path='["caption"]'
      data-edit-multiline
    >{{ scene.caption }}</div>
  </div>
</template>

<style scoped>
.graph-scene.active {
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 18px;
  align-items: stretch;
}

.graph-title {
  color: var(--slidey-rose, #eb6f92);
  font-size: 46px;
  font-weight: 820;
  letter-spacing: 0;
}

.graph-frame {
  position: relative;
  min-height: 0;
  width: min(1720px, 100%);
  justify-self: center;
  overflow: hidden;
}

.graph-canvas {
  position: absolute;
  inset: 0;
}

.graph-focus-card {
  position: absolute;
  right: 18px;
  bottom: 18px;
  width: min(560px, calc(100% - 36px));
  padding: 20px 24px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.18);
  background: linear-gradient(140deg, rgba(13,20,36,0.92), rgba(22,31,48,0.86));
  box-shadow: 0 18px 48px rgba(0,0,0,0.34);
  pointer-events: none;
}

.graph-focus-label {
  color: var(--slidey-text, #e0def4);
  font-size: 32px;
  line-height: 1.08;
  font-weight: 820;
  letter-spacing: 0;
}

.graph-focus-note {
  margin-top: 8px;
  color: var(--slidey-subtle, rgba(255,255,255,0.74));
  font-size: 22px;
  line-height: 1.25;
  letter-spacing: 0;
}

.graph-caption {
  justify-self: center;
  max-width: 1500px;
  color: var(--slidey-subtle, rgba(255,255,255,0.76));
  font-size: 28px;
  line-height: 1.28;
  text-align: center;
  letter-spacing: 0;
}
</style>
