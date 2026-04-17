<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useDisplay } from 'vuetify'
import SceneCard from './SceneCard.vue'
import { clampLayout, placeNewCard } from './sceneLayout.js'

const props = defineProps({
  cards:          { type: Array,  default: () => [] },
  cols:           { type: Number, default: 12 },
  rowHeight:      { type: Number, default: 120 },
  gap:            { type: Number, default: 12 },
  dragSnapStep:   { type: Number, default: 0.25 },
  resizeSnapStep: { type: Number, default: 0.1 },
})

const emit = defineEmits(['update:cards', 'commit'])

const { smAndDown } = useDisplay()

const activeCols = computed(() => smAndDown.value ? 6 : props.cols)

const canvasRef       = ref(null)
const canvasWidth     = ref(0)
const selectedCardId  = ref(null)
const activeInteraction = ref(null)
let resizeObserver    = null

const unitWidth = computed(() => {
  const w = canvasWidth.value
  if (!w) return 100
  const totalGap = Math.max(0, activeCols.value - 1) * props.gap
  return (w - totalGap) / activeCols.value
})

const canvasHeight = computed(() => {
  const maxRows = props.cards.reduce((max, card) => {
    const l = clampLayout(card.layout)
    return Math.max(max, l.y + l.h)
  }, 0)
  return Math.max(8, maxRows) * props.rowHeight + Math.max(7, maxRows - 1) * props.gap
})

function cardStyle(card) {
  const l = clampLayout(card.layout)
  return {
    left:   `${l.x * (unitWidth.value + props.gap)}px`,
    top:    `${l.y * (props.rowHeight + props.gap)}px`,
    width:  `${Math.max(l.w * unitWidth.value + (l.w - 1) * props.gap, 1)}px`,
    height: `${Math.max(l.h * props.rowHeight + (l.h - 1) * props.gap, 1)}px`,
    zIndex: card.id === selectedCardId.value ? 2 : 1,
  }
}

// ---- selection ----
function onCardPointerDown(cardId) { selectedCardId.value = cardId }
function onCanvasPointerDown(e)    { if (e.target === e.currentTarget) selectedCardId.value = null }
function onDocumentPointerDown(e) {
  if (!canvasRef.value) return
  const path = typeof e.composedPath === 'function' ? e.composedPath() : []
  if (!path.includes(canvasRef.value)) selectedCardId.value = null
}

// ---- card mutations ----
function onRemoveCard(cardId) {
  emit('update:cards', props.cards.filter(c => c.id !== cardId))
  emit('commit')
}

function onControlsChange(cardId, controls) {
  emit('update:cards', props.cards.map(c => c.id === cardId ? { ...c, controls: controls || {} } : c))
  emit('commit')
}

// ---- drag / resize ----
function onDragStart({ cardId, event }) { startInteraction('drag', cardId, event) }
function onResizeStart({ cardId, event, corner }) { startInteraction('resize', cardId, event, corner || 'se') }

function startInteraction(kind, cardId, event, corner = 'se') {
  const target = props.cards.find(c => c.id === cardId)
  if (!target) return
  selectedCardId.value = cardId
  activeInteraction.value = {
    kind, cardId, corner,
    startX: event.clientX,
    startY: event.clientY,
    startLayout: clampLayout(target.layout),
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
}

function snap(raw, step) { return step > 0 ? Math.round(raw / step) * step : raw }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)) }

function clampToGrid(layout) {
  const l = clampLayout(layout)
  const cols = activeCols.value
  const w = clamp(l.w, 1, cols)
  return { ...l, w, x: clamp(l.x, 0, Math.max(0, cols - w)) }
}

function resizeLayout(base, dc, dr, corner) {
  switch (corner) {
    case 'n':  return { ...base, y: base.y + dr, h: base.h - dr }
    case 'nw': return { ...base, x: base.x + dc, y: base.y + dr, w: base.w - dc, h: base.h - dr }
    case 'w':  return { ...base, x: base.x + dc, w: base.w - dc }
    case 'ne': return { ...base, y: base.y + dr, w: base.w + dc, h: base.h - dr }
    case 'sw': return { ...base, x: base.x + dc, w: base.w - dc, h: base.h + dr }
    case 's':  return { ...base, h: base.h + dr }
    case 'e':  return { ...base, w: base.w + dc }
    case 'se':
    default:   return { ...base, w: base.w + dc, h: base.h + dr }
  }
}

function onPointerMove(e) {
  const ia = activeInteraction.value
  if (!ia) return
  const step = ia.kind === 'resize' ? props.resizeSnapStep : props.dragSnapStep
  const dc = snap((e.clientX - ia.startX) / (unitWidth.value + props.gap), step)
  const dr = snap((e.clientY - ia.startY) / (props.rowHeight + props.gap), step)

  const next = props.cards.map(card => {
    if (card.id !== ia.cardId) return card
    const base = ia.startLayout
    const raw = ia.kind === 'drag'
      ? { ...base, x: base.x + dc, y: base.y + dr }
      : resizeLayout(base, dc, dr, ia.corner)
    return { ...card, layout: clampToGrid(raw) }
  })
  emit('update:cards', next)
}

function onPointerUp() {
  if (!activeInteraction.value) return
  emit('commit')
  activeInteraction.value = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
}

// ---- public: place a new card ----
function addCard(cardType) {
  const layout = placeNewCard(props.cards, cardType.defaultWidth, cardType.defaultHeight, activeCols.value)
  const card = {
    id: crypto.randomUUID(),
    typeId: cardType.id,
    source: cardType.defaultSource ?? null,
    controls: { ...(cardType.defaultControls ?? {}) },
    layout,
  }
  emit('update:cards', [...props.cards, card])
  emit('commit')
}

// ---- canvas width sync ----
function syncWidth() { canvasWidth.value = canvasRef.value?.clientWidth || 0 }

onMounted(async () => {
  await nextTick()
  syncWidth()
  window.addEventListener('resize', syncWidth)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  if (typeof ResizeObserver !== 'undefined' && canvasRef.value) {
    resizeObserver = new ResizeObserver(syncWidth)
    resizeObserver.observe(canvasRef.value)
  }
})

onBeforeUnmount(() => {
  if (activeInteraction.value) onPointerUp()
  window.removeEventListener('resize', syncWidth)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }
})

defineExpose({ addCard })
</script>

<template>
  <div
    ref="canvasRef"
    class="scene-canvas"
    :style="{ minHeight: `${canvasHeight}px` }"
    @pointerdown="onCanvasPointerDown"
  >
    <div
      v-for="card in cards"
      :key="card.id"
      class="scene-canvas__item"
      :style="cardStyle(card)"
      @pointerdown.capture="onCardPointerDown(card.id)"
    >
      <SceneCard
        :card="card"
        :selected="card.id === selectedCardId"
        @remove="onRemoveCard"
        @drag-start="onDragStart"
        @resize-start="onResizeStart"
        @update-controls="onControlsChange(card.id, $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.scene-canvas {
  position: relative;
  width: 100%;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  background:
    linear-gradient(rgba(var(--v-theme-on-surface), 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(var(--v-theme-on-surface), 0.04) 1px, transparent 1px),
    rgba(var(--v-theme-surface-variant), 0.15);
  background-size: 120px 120px, 120px 120px, auto;
  overflow-x: hidden;
  overflow-y: visible;
}

.scene-canvas__item {
  position: absolute;
  min-width: 0;
}
</style>
