<script setup>
import { ref, computed, inject, nextTick, watch, onMounted } from 'vue'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'

const emit = defineEmits(['close'])

// Provided by MapView — return value of useMapAnnotations()
const api = inject('annotationsApi', null)

const minimized  = ref(false)
const positioned = ref(false)

const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const SWATCHES = [
  '#ffeb3b', '#ffb74d', '#f06292', '#e57373',
  '#81c784', '#64b5f6', '#ba68c8', '#e0e0e0'
]

const annotations = computed(() => api?.annotations.value ?? [])
const selecting   = computed(() => api?.annotationSelecting.value ?? false)
const selectedId  = computed({
  get: () => api?.selectedId.value ?? null,
  set: (v) => { if (api) api.selectedId.value = v }
})

const rowRefs = new Map()
function bindRow(id) {
  return (el) => { if (el) rowRefs.set(id, el); else rowRefs.delete(id) }
}

function toggleAdd() {
  api?.toggleSelecting()
}

// Commit on every keystroke, not just blur/change. If we waited for blur,
// clicking a swatch or placing a new note mid-edit would fire its own
// updateAnnotation() with the stale (uncommitted) `a.text` and wipe the
// text the user was typing.
function handleTextInput(id, e) {
  api?.updateAnnotation(id, { text: e.target.value })
}

function pickColor(id, color) {
  api?.updateAnnotation(id, { color })
}

function remove(id) {
  api?.removeAnnotation(id)
}

function clearAll() {
  if (!confirm('Delete all annotations for this mission?')) return
  api?.clearAnnotations()
}

function close() {
  if (api?.annotationSelecting.value) api.toggleSelecting()
  emit('close')
}

// When a user clicks a map marker, selectedId updates — scroll that row
// into view so they can edit it without hunting through the list.
watch(selectedId, async (id) => {
  if (id == null) return
  await nextTick()
  const el = rowRefs.get(id)
  if (el?.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
})
</script>

<template>
  <div
    class="annotations-panel"
    :style="{
      left: pos.x + 'px',
      top: pos.y + 'px',
      zIndex,
      visibility: positioned ? 'visible' : 'hidden'
    }"
    @pointerdown="bringToFront"
  >
    <!-- Header -->
    <div class="panel-header" @pointerdown="onPointerDown">
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-note-text-outline</v-icon>
      <span class="panel-title">Annotations</span>
      <v-spacer />
      <v-btn
        :icon="minimized ? 'mdi-chevron-down' : 'mdi-chevron-up'"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="minimized = !minimized"
      />
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="close"
      />
    </div>

    <!-- Body -->
    <div v-show="!minimized" class="panel-body">
      <!-- Add -->
      <div class="add-row">
        <v-btn
          size="x-small"
          :variant="selecting ? 'tonal' : 'text'"
          :color="selecting ? 'primary' : undefined"
          :class="selecting ? '' : 'text-medium-emphasis'"
          @pointerdown.stop
          @click.stop="toggleAdd"
        >
          <v-icon size="14">mdi-plus</v-icon>
          <span class="add-label">
            {{ selecting ? 'Click map…' : 'Add annotation' }}
          </span>
        </v-btn>
      </div>

      <div v-if="!annotations.length" class="empty-hint">
        No annotations yet. Click <em>Add</em>, then click the map to drop a sticky note.
      </div>

      <div class="list">
        <div
          v-for="a in annotations"
          :key="a.id"
          :ref="bindRow(a.id)"
          class="row"
          :class="{ selected: a.id === selectedId }"
          @pointerdown="selectedId = a.id"
        >
          <div class="row-top">
            <span class="color-dot" :style="{ background: a.color }" />
            <textarea
              class="text-input"
              rows="2"
              :value="a.text"
              @input="handleTextInput(a.id, $event)"
            />
            <v-btn
              icon="mdi-delete-outline"
              size="x-small"
              variant="text"
              class="text-medium-emphasis del-btn"
              @pointerdown.stop
              @click.stop="remove(a.id)"
            />
          </div>
          <div class="swatches">
            <button
              v-for="s in SWATCHES"
              :key="s"
              type="button"
              class="swatch"
              :class="{ active: s.toLowerCase() === (a.color || '').toLowerCase() }"
              :style="{ background: s }"
              @pointerdown.stop
              @click.stop="pickColor(a.id, s)"
            />
          </div>
        </div>
      </div>

      <template v-if="annotations.length">
        <div class="divider" />
        <v-btn
          size="x-small"
          variant="text"
          color="error"
          class="clear-btn"
          @pointerdown.stop
          @click.stop="clearAll"
        >
          <v-icon size="14">mdi-delete-sweep-outline</v-icon>
          <span class="clear-label">Clear all</span>
        </v-btn>
      </template>
    </div>
  </div>
</template>

<style scoped>
.annotations-panel {
  position: absolute;
  z-index: 2;
  width: 300px;
  background: rgba(var(--v-theme-surface), 0.95);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px 4px 8px;
  cursor: grab;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.panel-header:active { cursor: grabbing; }

.panel-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  flex: 1;
  min-width: 0;
}

.header-btn { flex-shrink: 0; }

.panel-body {
  padding: 6px 8px 8px;
  max-height: 60vh;
  overflow-y: auto;
}

.add-row { display: flex; }

.add-label {
  margin-left: 4px;
  font-size: 11px;
  text-transform: none;
  letter-spacing: 0;
}

.divider {
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  margin: 6px 0;
}

.empty-hint {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.5);
  line-height: 1.5;
  padding: 6px 2px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.row {
  padding: 6px;
  border-radius: 3px;
  border: 1px solid transparent;
  background: rgba(var(--v-theme-surface-variant), 0.25);
}

.row.selected {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.08);
}

.row-top {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.color-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 4px;
  border: 1px solid rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.text-input {
  flex: 1;
  min-width: 0;
  resize: vertical;
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 11px;
  line-height: 1.4;
  color: rgb(var(--v-theme-on-surface));
  outline: none;
  font-family: inherit;
}

.text-input:focus {
  border-color: #4a9ade;
}

.del-btn { flex-shrink: 0; }

.swatches {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  padding-left: 16px;
}

.swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.35);
  padding: 0;
  cursor: pointer;
}

.swatch.active {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
}

.clear-btn {
  width: 100%;
  justify-content: flex-start;
}

.clear-label {
  margin-left: 4px;
  font-size: 11px;
  text-transform: none;
  letter-spacing: 0;
}
</style>
