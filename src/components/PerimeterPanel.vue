<script setup>
import { ref, computed, inject, onMounted } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { formatDistance } from '@/services/geometry'

const emit = defineEmits(['close'])

const settingsStore = useSettingsStore()

// Provided by MapView — return value of useMapPerimeters()
const pm = inject('perimeterApi', null)

const minimized  = ref(false)
const positioned = ref(false)

const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const rows      = computed(() => pm?.perimeters.value ?? [])
const selecting = computed(() => pm?.perimeterSelecting.value ?? false)

// Local mirror of the composable's default radius — bound to the input via
// v-model. Committed back on blur / Enter so the user can type freely.
const defaultRadiusInput = ref(pm?.defaultRadius.value ?? 500)

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

function commitDefaultRadius() {
  const n = Number(defaultRadiusInput.value)
  if (!Number.isFinite(n) || n <= 0) {
    defaultRadiusInput.value = pm?.defaultRadius.value ?? 500
    return
  }
  pm?.setDefaultRadius(n)
}

function commitRowRadius(ownerKey, raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return
  pm?.setRadius(ownerKey, n)
}

function toggleAdd() {
  pm?.toggleSelecting()
}

function remove(ownerKey) {
  pm?.removePerimeter(ownerKey)
}

function toggleAlert(ownerKey, val) {
  pm?.setAlert(ownerKey, val)
}

function clearAll() {
  pm?.clearAll()
}

function close() {
  if (pm?.perimeterSelecting.value) pm.toggleSelecting()
  emit('close')
}

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
})
</script>

<template>
  <div
    class="perimeter-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-shield-outline</v-icon>
      <span class="panel-title">Perimeter</span>
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
      <!-- Default radius -->
      <div class="default-row">
        <span class="default-label">Default radius</span>
        <input
          v-model.number="defaultRadiusInput"
          type="number"
          min="1"
          step="50"
          class="radius-input"
          @change="commitDefaultRadius"
          @blur="commitDefaultRadius"
          @keydown.enter="commitDefaultRadius"
        />
        <span class="unit">m</span>
      </div>

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
          <span class="add-label">{{ selecting ? 'Click a track…' : 'Add perimeter' }}</span>
        </v-btn>
      </div>

      <div class="divider" />

      <!-- Perimeter list -->
      <div v-if="rows.length === 0" class="empty-hint">
        No perimeters yet. Click <em>Add</em> then click a track to ring it with a standoff radius.
      </div>

      <div
        v-for="r in rows"
        :key="r.ownerKey"
        class="perimeter-row"
      >
        <div class="row-body">
          <div class="owner-line">
            <v-icon size="12" class="owner-icon">{{ kindIcon(r.owner.kind) }}</v-icon>
            <span class="owner-label" :title="r.owner.label">{{ r.owner.label }}</span>
          </div>

          <div class="controls-line">
            <input
              :value="r.radius"
              type="number"
              min="1"
              step="50"
              class="radius-input-inline"
              @change="e => commitRowRadius(r.ownerKey, e.target.value)"
              @blur="e => commitRowRadius(r.ownerKey, e.target.value)"
              @keydown.enter="e => commitRowRadius(r.ownerKey, e.target.value)"
            />
            <span class="unit-inline">m</span>
            <span class="formatted-distance">({{ distanceLabel(r.radius) }})</span>
            <v-spacer />
            <label class="alert-toggle">
              <input
                type="checkbox"
                :checked="r.alert"
                @change="e => toggleAlert(r.ownerKey, e.target.checked)"
              />
              <span>Alert</span>
            </label>
          </div>

          <div v-if="r.breached.length" class="breach-line">
            <v-icon size="12" class="breach-icon">mdi-alert</v-icon>
            <span class="breach-label">
              {{ r.breached.map(b => b.label).join(', ') }}
            </span>
          </div>
        </div>
        <v-btn
          icon="mdi-close"
          size="x-small"
          variant="text"
          class="text-medium-emphasis row-remove"
          @pointerdown.stop
          @click.stop="remove(r.ownerKey)"
        />
      </div>

      <template v-if="rows.length > 0">
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
.perimeter-panel {
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

.default-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 6px;
}

.default-label {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  flex: 1;
}

.radius-input {
  width: 72px;
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 11px;
  color: rgb(var(--v-theme-on-surface));
  text-align: right;
  outline: none;
}

.radius-input:focus {
  border-color: #4a9ade;
}

.unit {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.6);
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

.perimeter-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 4px 2px;
}

.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.owner-line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.owner-icon {
  color: rgba(var(--v-theme-on-surface), 0.6);
  flex-shrink: 0;
}

.owner-label {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}

.controls-line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.radius-input-inline {
  width: 60px;
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 10px;
  color: rgb(var(--v-theme-on-surface));
  text-align: right;
  outline: none;
}

.radius-input-inline:focus {
  border-color: #4a9ade;
}

.unit-inline {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.formatted-distance {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.5);
}

.alert-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  cursor: pointer;
}

.alert-toggle input[type='checkbox'] {
  accent-color: #4a9ade;
  cursor: pointer;
}

.breach-line {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.breach-icon {
  color: #e53935;
  flex-shrink: 0;
  margin-top: 1px;
}

.breach-label {
  font-size: 10px;
  color: #e53935;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-remove {
  flex-shrink: 0;
  margin-top: -2px;
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
