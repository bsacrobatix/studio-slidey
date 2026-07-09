<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import cytoscape from 'cytoscape';
import { store } from '../store.js';

const scene = computed(() => store.scene || {});
const cyRoot = ref(null);
let cy = null;
let lastNonce = 0;
let resizeObserver = null;
let refreshFrame = 0;
let motionFrame = 0;
let motionStartedAt = 0;
const motionBasePositions = new Map();

function pinnedPosition(node) {
  if (!node) return null;
  if (node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) return node.position;
  if (Number.isFinite(node.x) && Number.isFinite(node.y)) return { x: node.x, y: node.y };
  return null;
}

function graphGrid() {
  const template = scene.value.layoutTemplate || scene.value.template || '';
  const raw = scene.value.grid && typeof scene.value.grid === 'object' ? scene.value.grid : {};
  if (!template && !Object.keys(raw).length) return null;
  const preset = template === 'lane-grid-3x5' || template === 'grid-3x5'
    ? { columns: 5, rows: 3, x: 105, y: 95, width: 2715, height: 810 }
    : {};
  const columns = Number(raw.columns || raw.cols || preset.columns || 5);
  const rows = Number(raw.rows || raw.lanes || preset.rows || 3);
  if (!Number.isFinite(columns) || columns < 1 || !Number.isFinite(rows) || rows < 1) return null;
  const x = Number(raw.x ?? raw.left ?? preset.x ?? 0);
  const y = Number(raw.y ?? raw.top ?? preset.y ?? 0);
  const width = Number(raw.width ?? raw.w ?? preset.width ?? scene.value.layoutWidth ?? 1400);
  const height = Number(raw.height ?? raw.h ?? preset.height ?? scene.value.layoutHeight ?? 720);
  return { columns, rows, x, y, width, height };
}

function gridPosition(node) {
  const grid = graphGrid();
  if (!grid || !node) return null;
  const rawCol = node.col ?? node.column ?? node.gridColumn ?? node.grid?.col ?? node.grid?.column;
  const rawRow = node.row ?? node.lane ?? node.gridRow ?? node.grid?.row ?? node.grid?.lane;
  if (rawCol == null || rawRow == null) return null;
  const col = Number(rawCol);
  const row = Number(rawRow);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  const colGap = grid.columns > 1 ? grid.width / (grid.columns - 1) : 0;
  const rowGap = grid.rows > 1 ? grid.height / (grid.rows - 1) : 0;
  const xNudge = Number(node.xOffset ?? node.dx ?? node.grid?.xOffset ?? node.grid?.dx ?? 0);
  const yNudge = Number(node.yOffset ?? node.dy ?? node.grid?.yOffset ?? node.grid?.dy ?? 0);
  return {
    x: grid.x + (col - 1) * colGap + (Number.isFinite(xNudge) ? xNudge : 0),
    y: grid.y + (row - 1) * rowGap + (Number.isFinite(yNudge) ? yNudge : 0),
  };
}

function nodePosition(node) {
  return gridPosition(node) || pinnedPosition(node);
}

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
  const nodeById = new Map((scene.value.nodes || []).map(n => [String(n.id), n]));
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
      borderColor: n.borderColor || n.stroke || nodeKindColor(n.kind),
      textColor: n.textColor || cssVar('--slidey-text', '#e0def4'),
      glowColor: n.glowColor || n.color || nodeKindColor(n.kind),
    },
    position: nodePosition(n) || undefined,
    classes: [n.kind, n.className, n.classes].flat().filter(Boolean).join(' '),
  }));
  const edges = (scene.value.edges || []).map((e, idx) => {
    const source = nodeById.get(String(e.from));
    const target = nodeById.get(String(e.to));
    const labelOffset = edgeLabelOffset(e, source, target);
    return {
      group: 'edges',
      data: {
        id: String(e.id || `${e.from}-${e.to}-${idx}`),
        source: String(e.from),
        target: String(e.to),
        label: String(e.label || ''),
        weight: Number(e.weight || e.influence || 2),
        color: e.color || cssVar('--slidey-iris', '#c4a7e7'),
        curve: e.curve || 'bezier',
        controlPointDistances: e.controlPointDistances || e.controlDistances || e.distance || undefined,
        controlPointWeights: e.controlPointWeights || e.controlWeights || e.controlWeight || undefined,
        labelMarginX: labelOffset.x,
        labelMarginY: labelOffset.y,
      },
      classes: [e.kind, e.className, e.classes].flat().filter(Boolean).join(' '),
    };
  });
  return [...nodes, ...edges];
}

function explicitNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function edgeLabelOffset(edge, source, target) {
  const explicitX = explicitNumber(edge.labelMarginX, edge.labelX);
  const explicitY = explicitNumber(edge.labelMarginY, edge.labelY);
  if (explicitX != null || explicitY != null) {
    return { x: explicitX || 0, y: explicitY != null ? explicitY : -14 };
  }
  const targetPos = nodePosition(target);
  const resolvedSourcePos = nodePosition(source);
  if (!resolvedSourcePos || !targetPos || !edge.label) return { x: 0, y: -14 };
  const dx = targetPos.x - resolvedSourcePos.x;
  const dy = targetPos.y - resolvedSourcePos.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const grid = graphGrid();
  const layoutHeight = Number(scene.value.layoutHeight || scene.value.layoutH || (grid ? grid.y + grid.height : 720));
  const midY = (resolvedSourcePos.y + targetPos.y) / 2;
  if (absDx > absDy * 1.7) {
    const lane = midY < layoutHeight * 0.38 ? -1 : midY > layoutHeight * 0.62 ? 1 : -1;
    return { x: 0, y: lane * 42 };
  }
  if (absDy > absDx * 1.2) {
    return { x: dx >= 0 ? 58 : -58, y: dy >= 0 ? 12 : -12 };
  }
  return { x: 0, y: dy >= 0 ? 44 : -44 };
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
    const layoutWidth = Number(scene.value.layoutWidth || scene.value.layoutW || 1350);
    const layoutHeight = Number(scene.value.layoutHeight || scene.value.layoutH || 610);
    return {
      ...common,
      nodeDimensionsIncludeLabels: true,
      idealEdgeLength: Number(scene.value.idealEdgeLength || 210),
      nodeOverlap: Number(scene.value.nodeOverlap || 26),
      nestingFactor: Number(scene.value.nestingFactor || 1.2),
      gravity: Number(scene.value.gravity || 0.7),
      componentSpacing: Number(scene.value.componentSpacing || 120),
      numIter: Number(scene.value.numIter || 1200),
      randomize: scene.value.randomize === true,
      boundingBox: { x1: 0, y1: 0, x2: layoutWidth, y2: layoutHeight },
    };
  }
  return common;
}

function hasPinnedPositions() {
  return (scene.value.nodes || []).some(n => nodePosition(n));
}

function applyPinnedPositions() {
  if (!cy) return;
  for (const node of scene.value.nodes || []) {
    const pos = nodePosition(node);
    if (!pos) continue;
    const ele = cy.getElementById(String(node.id));
    if (ele && ele.length) ele.position(pos);
  }
}

function rebuild() {
  if (!cyRoot.value) return;
  stopIdleMotion();
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
            'z-index': 10,
            'border-color': ele => ele.data('borderColor'),
            'border-width': 4,
            'shadow-blur': 26,
            'shadow-color': ele => ele.data('glowColor'),
            'shadow-opacity': 0.34,
            'shadow-offset-x': 0,
            'shadow-offset-y': 0,
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
            'text-outline-color': 'rgba(6,10,20,0.88)',
            'text-outline-width': 4,
            'overlay-opacity': 0,
            'transition-property': 'border-width, opacity, background-color, line-color, target-arrow-color, width, shadow-opacity, shadow-blur',
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
            'control-point-distances': ele => ele.data('controlPointDistances'),
            'control-point-weights': ele => ele.data('controlPointWeights'),
            'line-style': ele => ele.hasClass('soft') ? 'dashed' : 'solid',
            'line-cap': 'round',
            opacity: 0.86,
            label: ele => ele.data('label'),
            color: cssVar('--slidey-text', '#e0def4'),
            'font-family': cssVar('--slidey-font-family', 'ui-sans-serif, system-ui, sans-serif'),
            'font-size': Number(scene.value.edgeFontSize || 20),
            'font-weight': 760,
            'text-background-color': 'rgba(9,14,26,0.88)',
            'text-background-opacity': 1,
            'text-background-padding': 6,
            'text-background-shape': 'roundrectangle',
            'text-border-color': 'rgba(255,255,255,0.12)',
            'text-border-width': 1,
            'text-border-opacity': 1,
            'text-rotation': 'none',
            'text-margin-x': ele => Number(ele.data('labelMarginX') || 0),
            'text-margin-y': ele => Number(ele.data('labelMarginY') || -14),
            'z-index': 30,
            'z-index-compare': 'manual',
          },
        },
        {
          selector: '.requirement',
          style: {
            'border-width': 5,
            'shadow-blur': 34,
            'shadow-opacity': 0.42,
          },
        },
        {
          selector: '.proof',
          style: {
            'border-width': 5,
            'shadow-blur': 32,
            'shadow-opacity': 0.38,
          },
        },
        { selector: '.seen', style: { opacity: 0.96 } },
        { selector: 'edge.seen', style: { opacity: 0.9 } },
        {
          selector: '.related',
          style: {
            opacity: 0.96,
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
            'shadow-blur': 48,
            'shadow-color': cssVar('--slidey-gold', '#f6c177'),
            'shadow-opacity': 0.62,
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
        { selector: '.dim', style: { opacity: 0.42, 'shadow-opacity': 0.12 } },
        { selector: 'edge.dim', style: { opacity: 0.34 } },
      ],
    });

    applyPinnedPositions();
    const layout = cy.layout(layoutConfig({ animate: false }));
    layout.one('layoutstop', () => {
      cy.fit(undefined, Number(scene.value.padding || 55));
      startIdleMotion();
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

function shouldUseIdleMotion() {
  if (!scene.value.floatMotion && !scene.value.idleMotion) return false;
  if (document.body.classList.contains('instant')) return false;
  return cy && cy.nodes().length > 1;
}

function stopIdleMotion() {
  if (motionFrame) cancelAnimationFrame(motionFrame);
  motionFrame = 0;
  motionStartedAt = 0;
  motionBasePositions.clear();
}

function startIdleMotion() {
  stopIdleMotion();
  if (!shouldUseIdleMotion()) return;
  cy.nodes().forEach((node, index) => {
    const pos = node.position();
    motionBasePositions.set(node.id(), {
      x: pos.x,
      y: pos.y,
      phase: index * 1.73,
    });
  });
  motionStartedAt = performance.now();
  tickIdleMotion(motionStartedAt);
}

function tickIdleMotion(now) {
  if (!shouldUseIdleMotion()) {
    stopIdleMotion();
    return;
  }
  const amplitude = Number(scene.value.floatAmplitude || 10);
  const speed = Number(scene.value.floatSpeed || 0.00075);
  const elapsed = now - motionStartedAt;
  cy.nodes().forEach(node => {
    const base = motionBasePositions.get(node.id());
    if (!base) return;
    node.position({
      x: base.x + Math.sin(elapsed * speed + base.phase) * amplitude,
      y: base.y + Math.cos(elapsed * speed * 0.82 + base.phase * 1.31) * amplitude * 0.72,
    });
  });
  motionFrame = requestAnimationFrame(tickIdleMotion);
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

  const entry = path[idx];
  const current = cy.getElementById(String(entry.node));
  const seenIds = new Set(path.slice(0, idx + 1).map(entry => String(entry.node)));
  cy.nodes().forEach(node => {
    if (seenIds.has(node.id())) node.addClass('seen');
    else node.addClass('dim');
  });
  current.removeClass('dim').addClass('active seen');

  const explicitEdges = new Set([entry.edge, ...(entry.edges || [])].filter(Boolean).map(String));
  cy.edges().forEach(edge => {
    const srcSeen = seenIds.has(edge.source().id());
    const tgtSeen = seenIds.has(edge.target().id());
    const touchesCurrent = edge.source().id() === current.id() || edge.target().id() === current.id();
    if (explicitEdges.has(edge.id()) || (srcSeen && tgtSeen)) edge.addClass('active');
    else if (touchesCurrent) edge.addClass('related');
    else edge.addClass('dim');
  });

  const animate = !document.body.classList.contains('instant');
  const zoom = Number(entry.zoom || scene.value.focusZoom || 1.08);
  const duration = Number(entry.durationMs || scene.value.animationMs || 700);
  cy.stop();
  if (scene.value.focusLayout) {
    cy.layout({ ...layoutConfig({ animate }), name: scene.value.focusLayout }).run();
  }
  if (entry.overview || entry.fit || entry.view === 'overview') {
    const padding = Number(entry.padding || scene.value.padding || 55);
    if (animate) cy.animate({ fit: { eles: cy.elements(), padding } }, { duration, easing: 'ease-in-out-cubic' });
    else cy.fit(undefined, padding);
    return;
  }
  if (scene.value.focusMode === 'neighborhood') {
    const eles = current.closedNeighborhood();
    const padding = Number(entry.padding || scene.value.focusPadding || 300);
    if (animate) cy.animate({ fit: { eles, padding } }, { duration, easing: 'ease-in-out-cubic' });
    else cy.fit(eles, padding);
    return;
  }
  if (animate) {
    cy.animate({ center: { eles: current }, zoom }, { duration, easing: 'ease-in-out-cubic' });
  } else {
    cy.center(current);
    cy.zoom({ level: zoom, position: current.position() });
  }
}

function refreshViewport() {
  if (!cy) return;
  if (refreshFrame) cancelAnimationFrame(refreshFrame);
  refreshFrame = requestAnimationFrame(() => {
    refreshFrame = 0;
    if (!cy || !cyRoot.value) return;
    cy.resize();
    applyFocus();
  });
}

watch(() => store.sceneNonce, async nonce => {
  if (nonce === lastNonce) return;
  lastNonce = nonce;
  await nextTick();
  rebuild();
}, { immediate: true });

watch(() => store.graphFocus, applyFocus);

watch(() => store.isRevealed('graph-frame'), async shown => {
  if (!shown) return;
  await nextTick();
  refreshViewport();
});

onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(refreshViewport);
  if (cyRoot.value) resizeObserver.observe(cyRoot.value);
});

onBeforeUnmount(() => {
  stopIdleMotion();
  if (refreshFrame) cancelAnimationFrame(refreshFrame);
  refreshFrame = 0;
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
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
