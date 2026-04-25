<script setup>
import { ref, computed, watch, onMounted, inject } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { labelFromCotType } from '@/services/trackTypes'
import { formatSpeed, speedUnitLabel, parseSpeedToMs } from '@/services/geometry'
import TrackTypePicker from './TrackTypePicker.vue'
import CoordInput from './CoordInput.vue'

const KTS_TO_MS = 1852 / 3600

const props = defineProps({
  featureId: { type: Number, required: true },
  focusedId: { type: Number, default: null }
})

const emit = defineEmits(['close'])

const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()

// Live drag broadcast from `useMapManualTracks` — lets the coord grid
// refresh every mousemove frame without store writes (mirrors the
// `draggingFeature` pattern used by the draw feature panel).
const draggingTrack = inject('draggingTrack', null)

const minimized   = ref(false)
const positioned  = ref(false)
const editingName = ref(false)
const nameInput   = ref('')

// Single ref tracks which attribute field is being edited (null = none).
const editingField   = ref(null)   // null | 'hae' | 'course' | 'speed'
const editInput      = ref('')
const showTypePicker = ref(false)

const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const AFFIL_LABELS = { f: 'Friendly', h: 'Hostile', n: 'Civilian', u: 'Unknown' }
const AFFIL_COLORS = { f: '#4a9ade', h: '#f44336', n: '#4caf50', u: '#ffeb3b' }

// ---- Derived data ----

const featureRow = computed(() =>
  featuresStore.features.find(f => f.id === props.featureId) ?? null
)

const featureProps = computed(() => {
  if (!featureRow.value) return null
  return JSON.parse(featureRow.value.properties)
})

const featureGeometry = computed(() => {
  if (!featureRow.value) return null
  return JSON.parse(featureRow.value.geometry)
})

const callsign    = computed(() => featureProps.value?.callsign    ?? '—')
const affiliation = computed(() => featureProps.value?.affiliation ?? 'u')
const affilColor  = computed(() => AFFIL_COLORS[affiliation.value] ?? '#ffeb3b')
const affilLabel  = computed(() => AFFIL_LABELS[affiliation.value] ?? 'Unknown')
const cotType     = computed(() => featureProps.value?.cotType     ?? null)
const typeLabel   = computed(() => labelFromCotType(cotType.value) ?? '—')

// `coordVal` holds the [lng, lat] the CoordInput renders. It's the feature's
// committed geometry *except* during an in-flight drag, when we swap in the
// live position broadcast by `useMapManualTracks` so the sub-fields move with
// the cursor.
const coordVal = ref(null)

function syncCoord() {
  const coords = featureGeometry.value?.coordinates
  coordVal.value = coords ? [coords[0], coords[1]] : null
}

watch(featureGeometry, syncCoord, { immediate: true })

if (draggingTrack) {
  watch(draggingTrack, (d) => {
    if (!d) { syncCoord(); return }
    if (d._dbId !== props.featureId) return
    coordVal.value = [d.lng, d.lat]
  })
}

async function commitCoord([lng, lat]) {
  if (!featureRow.value) return
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
  await featuresStore.updateFeature(
    featureRow.value.id,
    { type: 'Point', coordinates: [lng, lat] },
    { ...featureProps.value }
  )
}

// Attribute display values
const haeDisplay = computed(() => {
  const v = featureProps.value?.hae
  return v != null ? `${v} m` : '—'
})

const courseDisplay = computed(() => {
  const v = featureProps.value?.course
  if (v == null) return '—'
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  const compass = dirs[Math.round(v / 22.5) % 16]
  return `${v}°  ${compass}`
})

const speedDisplay = computed(() => {
  const kts = featureProps.value?.speed
  if (kts == null) return '—'
  const ms = kts * KTS_TO_MS
  return `${formatSpeed(ms, settingsStore.distanceUnits)} (${ms.toFixed(1)} m/s)`
})

// ---- Name editing ----

function startEditName() {
  nameInput.value = callsign.value
  editingName.value = true
}

async function saveName() {
  editingName.value = false
  const trimmed = nameInput.value.trim()
  if (!trimmed || trimmed === callsign.value) return
  if (!featureRow.value) return
  await featuresStore.updateFeature(
    featureRow.value.id,
    featureGeometry.value,
    { ...featureProps.value, callsign: trimmed }
  )
}

// ---- Attribute editing ----

function startEdit(field) {
  if (field === 'speed') {
    const kts = featureProps.value?.speed
    if (kts == null) {
      editInput.value = ''
    } else {
      const ms = kts * KTS_TO_MS
      const u = settingsStore.distanceUnits
      const factor = u === 'nautical' ? 1.94384 : u === 'statute' ? 2.23694 : 3.6
      editInput.value = (ms * factor).toFixed(1)
    }
  } else {
    const raw = featureProps.value?.[field]
    editInput.value = raw != null ? String(raw) : ''
  }
  editingField.value = field
}

function cancelEdit() {
  editingField.value = null
  editInput.value    = ''
}

async function saveField() {
  const field = editingField.value
  const raw   = String(editInput.value).trim()  // String() guards against number coercion from type="number"
  cancelEdit()
  if (!field || !featureRow.value) return

  let value
  if (field === 'speed') {
    if (raw === '') {
      value = null
    } else {
      const ms = parseSpeedToMs(raw, settingsStore.distanceUnits)
      if (ms == null) return
      value = ms / KTS_TO_MS  // store as knots
    }
  } else {
    value = raw === '' ? null : parseFloat(raw)
    if (value != null && isNaN(value)) return
    // Clamp course to 0–359
    if (field === 'course' && value != null) value = ((value % 360) + 360) % 360
  }

  await featuresStore.updateFeature(
    featureRow.value.id,
    featureGeometry.value,
    { ...featureProps.value, [field]: value }
  )
}

// ---- Type ----

async function saveType(newCotType) {
  showTypePicker.value = false
  if (!featureRow.value) return
  await featuresStore.updateFeature(
    featureRow.value.id,
    featureGeometry.value,
    { ...featureProps.value, cotType: newCotType }
  )
}

// ---- Delete ----

async function deleteTrack() {
  await featuresStore.removeFeature(props.featureId)
  emit('close')
}

// ---- Lifecycle ----

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
})

watch(featureRow, (row) => {
  if (!row) emit('close')
})

// Bring this panel to front when its map marker is clicked.
watch(() => props.focusedId, (id) => {
  if (id === props.featureId) bringToFront()
})
</script>

<template>
  <div
    class="manual-track-panel"
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
      <span class="affil-dot" :style="{ backgroundColor: affilColor }" />

      <template v-if="editingName">
        <input
          v-model="nameInput"
          class="name-input"
          @blur="saveName"
          @keydown.enter.prevent="saveName"
          @keydown.escape.prevent="editingName = false"
          @pointerdown.stop
          autofocus
        />
      </template>
      <template v-else>
        <span
          class="callsign"
          title="Click to rename"
          @pointerdown.stop
          @click.stop="startEditName"
        >{{ callsign }}</span>
      </template>

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

      <!-- Identity -->
      <div class="section-label">Identity</div>
      <div class="attr-grid">
        <span class="attr-key">AFFIL</span>
        <span class="attr-val">
          <span class="affil-dot affil-dot--inline" :style="{ backgroundColor: affilColor }" />
          {{ affilLabel }}
        </span>

        <span class="attr-key">TYPE</span>
        <span
          class="attr-val attr-val--editable"
          title="Click to change type"
          @pointerdown.stop
          @click.stop="showTypePicker = !showTypePicker"
        >{{ typeLabel }}</span>
      </div>

      <div v-if="showTypePicker" class="type-picker-wrap" @pointerdown.stop>
        <TrackTypePicker
          :affiliation="affiliation"
          :model-value="cotType"
          @update:model-value="saveType"
        />
      </div>

      <div class="divider" />

      <!-- Position -->
      <div class="section-label">Position</div>
      <div class="coord-row" @pointerdown.stop>
        <CoordInput :model-value="coordVal" @commit="commitCoord" />
      </div>

      <div class="divider" />

      <!-- Attributes -->
      <div class="section-label">Attributes</div>
      <div class="attr-grid">

        <!-- Altitude -->
        <span class="attr-key">ALT</span>
        <template v-if="editingField === 'hae'">
          <input
            v-model="editInput"
            class="attr-input"
            placeholder="meters"
            type="text"
            inputmode="decimal"
            @blur="saveField"
            @keydown.enter.prevent="saveField"
            @keydown.escape.prevent="cancelEdit"
            @pointerdown.stop
            autofocus
          />
        </template>
        <span
          v-else
          class="attr-val attr-val--editable"
          title="Click to edit"
          @pointerdown.stop
          @click.stop="startEdit('hae')"
        >{{ haeDisplay }}</span>

        <!-- Heading -->
        <span class="attr-key">HDG</span>
        <template v-if="editingField === 'course'">
          <input
            v-model="editInput"
            class="attr-input"
            placeholder="0–359°"
            type="text"
            inputmode="decimal"
            @blur="saveField"
            @keydown.enter.prevent="saveField"
            @keydown.escape.prevent="cancelEdit"
            @pointerdown.stop
            autofocus
          />
        </template>
        <span
          v-else
          class="attr-val attr-val--editable"
          title="Click to edit"
          @pointerdown.stop
          @click.stop="startEdit('course')"
        >{{ courseDisplay }}</span>

        <!-- Speed -->
        <span class="attr-key">SPD</span>
        <template v-if="editingField === 'speed'">
          <input
            v-model="editInput"
            class="attr-input"
            :placeholder="speedUnitLabel(settingsStore.distanceUnits)"
            type="text"
            inputmode="decimal"
            @blur="saveField"
            @keydown.enter.prevent="saveField"
            @keydown.escape.prevent="cancelEdit"
            @pointerdown.stop
            autofocus
          />
        </template>
        <span
          v-else
          class="attr-val attr-val--editable"
          title="Click to edit"
          @pointerdown.stop
          @click.stop="startEdit('speed')"
        >{{ speedDisplay }}</span>

      </div>

      <div class="divider" />

      <v-btn
        size="x-small"
        variant="text"
        color="error"
        class="delete-btn"
        @pointerdown.stop
        @click.stop="deleteTrack"
      >
        <v-icon size="14">mdi-delete-outline</v-icon>
        <span class="delete-label">Delete</span>
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.manual-track-panel {
  position: absolute;
  z-index: 2;
  width: 230px;
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

.callsign {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
  flex: 1;
  min-width: 0;
}

.name-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  color: rgb(var(--v-theme-on-surface));
  padding: 1px 4px;
  outline: none;
}

.header-btn {
  flex-shrink: 0;
}

.panel-body {
  padding: 6px 8px 8px;
}

.section-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.38);
  margin-bottom: 3px;
}

.attr-grid {
  display: grid;
  grid-template-columns: 36px 1fr;
  column-gap: 8px;
  row-gap: 2px;
  margin-bottom: 2px;
}

.attr-key {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.45);
  align-self: center;
  padding-top: 1px;
}

.attr-val {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.87);
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  word-break: break-all;
}

.attr-val--mono {
  font-family: monospace;
  letter-spacing: 0.02em;
  font-size: 10px;
}

.coord-row {
  margin-bottom: 2px;
}

.attr-val--editable {
  cursor: text;
  border-radius: 2px;
  padding: 0 2px;
  margin: 0 -2px;
}

.attr-val--editable:hover {
  background: rgba(var(--v-theme-surface-variant), 0.4);
}

.attr-val--editable.attr-val:empty::before,
.attr-val--editable[data-empty]::before {
  content: '—';
  color: rgba(var(--v-theme-on-surface), 0.3);
}

.attr-input {
  font-size: 11px;
  font-family: monospace;
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border: 1px solid rgba(var(--v-theme-primary), 0.5);
  border-radius: 2px;
  color: rgb(var(--v-theme-on-surface));
  padding: 1px 4px;
  outline: none;
  width: 100%;
  /* Hide browser number spinners */
  -moz-appearance: textfield;
}

.attr-input::-webkit-outer-spin-button,
.attr-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
}

.type-picker-wrap {
  margin-top: 4px;
  padding: 6px;
  background: rgba(var(--v-theme-surface-variant), 0.15);
  border-radius: 3px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
}

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 5px 0;
}

.affil-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.affil-dot--inline {
  width: 7px;
  height: 7px;
}

.delete-btn {
  width: 100%;
  justify-content: flex-start;
}

.delete-label {
  font-size: 11px;
  margin-left: 4px;
}
</style>
