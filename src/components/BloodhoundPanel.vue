<script setup>
import { ref, computed, inject, onMounted } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { formatDistance } from '@/services/geometry'

const emit = defineEmits(['close'])

const settingsStore = useSettingsStore()

// Provided by MapView — return value of useMapBloodhound()
const bh = inject('bloodhoundApi', null)

const minimized  = ref(false)
const positioned = ref(false)

const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const lines = computed(() => bh?.bloodhounds.value ?? [])
const selecting = computed(() => bh?.bloodhounding.value ?? false)

const KIND_ICON = {
  cot:     'mdi-radio-tower',
  ais:     'mdi-ferry',
  feature: 'mdi-map-marker-outline',
  point:   'mdi-crosshairs-gps'
}

function kindIcon(kind) {
  return KIND_ICON[kind] ?? 'mdi-map-marker-outline'
}

function distanceLabel(meters) {
  return formatDistance(meters, settingsStore.distanceUnits)
}

function toggleAdd() {
  bh?.toggleSelecting()
}

function remove(id) {
  bh?.removeBloodhound(id)
}

function clearAll() {
  bh?.clearAll()
}

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
})
</script>

<template>
  <div
    class="bloodhound-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-map-marker-distance</v-icon>
      <span class="panel-title">Bloodhound</span>
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
        @click.stop="emit('close')"
      />
    </div>

    <!-- Body -->
    <div v-show="!minimized" class="panel-body">
      <!-- Add button / selecting state -->
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
          <span class="add-label">{{ selecting ? 'Click two points…' : 'Add bloodhound' }}</span>
        </v-btn>
      </div>

      <div class="divider" />

      <!-- Line list -->
      <div v-if="lines.length === 0" class="empty-hint">
        No bloodhounds yet. Click <em>Add</em> then click two features to tie a live range line between them.
      </div>

      <div
        v-for="r in lines"
        :key="r.id"
        class="line-row"
      >
        <div class="line-body">
          <div class="endpoint-line">
            <v-icon size="12" class="endpoint-icon">{{ kindIcon(r.epA.kind) }}</v-icon>
            <span class="endpoint-label" :title="r.epA.label">{{ r.epA.label }}</span>
          </div>
          <div class="endpoint-line">
            <v-icon size="12" class="endpoint-icon">{{ kindIcon(r.epB.kind) }}</v-icon>
            <span class="endpoint-label" :title="r.epB.label">{{ r.epB.label }}</span>
          </div>
          <div class="distance-label">{{ distanceLabel(r.distanceMeters) }}</div>
        </div>
        <v-btn
          icon="mdi-close"
          size="x-small"
          variant="text"
          class="text-medium-emphasis line-remove"
          @pointerdown.stop
          @click.stop="remove(r.id)"
        />
      </div>

      <template v-if="lines.length > 0">
        <div class="divider" />
        <v-btn
          size="x-small"
          variant="text"
          color="error"
          class="clear-btn"
          @pointerdown.stop
          @click.stop="clearAll"
        >
          <v-icon size="14">mdi-delete-outline</v-icon>
          <span class="clear-label">Clear all</span>
        </v-btn>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bloodhound-panel {
  position: absolute;
  z-index: 2;
  width: 280px;
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

.panel-header:active {
  cursor: grabbing;
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  flex: 1;
  min-width: 0;
}

.header-btn {
  flex-shrink: 0;
}

.panel-body {
  padding: 6px 8px 8px;
}

.add-row {
  display: flex;
}

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
  padding: 4px 2px;
}

.line-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 2px;
}

.line-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.endpoint-line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.endpoint-icon {
  color: rgba(var(--v-theme-on-surface), 0.6);
  flex-shrink: 0;
}

.endpoint-label {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}

.distance-label {
  font-size: 11px;
  color: #4a9ade;
  font-weight: 600;
  margin-top: 1px;
}

.line-remove {
  flex-shrink: 0;
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
