<script setup>
import { ref, computed, inject, watch, onMounted } from 'vue'
import { useTracksStore } from '@/stores/tracks'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { bullseyeCall, formatDistance } from '@/services/geometry'
import CoordInput from '@/components/CoordInput.vue'

const emit = defineEmits(['close'])

// Provided by MapView — return value of useMapBullseye()
const be = inject('bullseyeApi', null)

const tracksStore   = useTracksStore()
const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()

const minimized  = ref(false)
const positioned = ref(false)

const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const bullseye  = computed(() => be?.bullseye.value ?? null)
const selecting = computed(() => be?.bullseyeSelecting.value ?? false)

// Local mirrors of editable config — committed on blur / Enter.
const nameInput         = ref('')
const intervalInput     = ref(1852)
const countInput        = ref(5)

function syncFromBullseye() {
  const b = bullseye.value
  if (!b) return
  nameInput.value     = b.name
  intervalInput.value = b.ringInterval
  countInput.value    = b.ringCount
}

const unitLabel = computed(() => 'm')

function toggleSet() {
  be?.toggleSelecting()
}

function clearBullseye() {
  be?.clearBullseye()
}

function commitName() {
  const s = String(nameInput.value ?? '').trim()
  if (!s) { syncFromBullseye(); return }
  be?.updateBullseye({ name: s })
}

function commitInterval() {
  const n = Number(intervalInput.value)
  if (!Number.isFinite(n) || n <= 0) { syncFromBullseye(); return }
  be?.updateBullseye({ ringInterval: n })
}

function commitCount() {
  const n = Math.round(Number(countInput.value))
  if (!Number.isFinite(n) || n <= 0 || n > 20) { syncFromBullseye(); return }
  be?.updateBullseye({ ringCount: n })
}

function toggleCardinals(val) {
  be?.updateBullseye({ showCardinals: Boolean(val) })
}

// CoordInput commits as [lng, lat].
function commitCenter([lng, lat]) {
  be?.updateBullseye({ lat, lon: lng })
}

// Prefer the live drag coords while a drag is in progress so the CoordInput
// (and therefore the operator's view of the centre) tracks the cursor rather
// than the last committed value. Mirrors how ManualTrackPanel consumes the
// `draggingTrack` broadcast.
const centerLngLat = computed(() => {
  const d = be?.draggingBullseye?.value
  if (d) return [d.lng, d.lat]
  const b = bullseye.value
  if (!b) return null
  return [b.lon, b.lat]
})

// Track list with live bullseye calls. Friendly-only — bullseye calls are
// used to report own-force positions to other friendlies, so hostile / neutral
// / unknown contacts don't belong in this list. AIS vessels are excluded too
// (they have no affiliation concept and would flood the panel).
//
// Affiliation source:
//   - CoT:            char [2] of `cotType` ('a-f-…' → 'f' friendly)
//   - Manual track:   `properties.affiliation` ('f' / 'h' / 'n' / 'u')
const trackRows = computed(() => {
  const b = bullseye.value
  if (!b) return []
  const center = [b.lon, b.lat]
  const rows = []

  for (const t of tracksStore.tracks.values()) {
    if (t.cotType?.[2] !== 'f') continue
    const c = bullseyeCall(center, [t.lon, t.lat])
    if (!c) continue
    rows.push({
      key: `cot:${t.uid}`,
      label: t.callsign || t.uid,
      kind: 'cot',
      ...c
    })
  }

  for (const f of featuresStore.features) {
    if (f.type !== 'manual-track') continue
    try {
      const geom = JSON.parse(f.geometry)
      if (geom.type !== 'Point') continue
      const props = JSON.parse(f.properties)
      if (props.affiliation !== 'f') continue
      const c = bullseyeCall(center, geom.coordinates)
      if (!c) continue
      rows.push({
        key: `feature:${f.id}`,
        label: props.callsign || props.name || `#${f.id}`,
        kind: 'feature',
        ...c
      })
    } catch {
      /* malformed feature — skip */
    }
  }

  rows.sort((a, b) => a.range - b.range)
  return rows
})

const KIND_ICON = {
  cot:     'mdi-radio-tower',
  feature: 'mdi-map-marker-outline'
}

function kindIcon(kind) {
  return KIND_ICON[kind] ?? 'mdi-map-marker-outline'
}

function formatCall(row) {
  const brg = String(Math.round(row.bearing)).padStart(3, '0')
  return `${brg} / ${formatDistance(row.range, settingsStore.distanceUnits)}`
}

function close() {
  if (be?.bullseyeSelecting.value) be.toggleSelecting()
  emit('close')
}

// Keep editable inputs aligned with the underlying bullseye. The composable
// may mutate it (e.g., initial placement from the map click) while the panel
// is already mounted, so the inputs need to pick that up.
watch(bullseye, syncFromBullseye, { immediate: true, deep: true })

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
})
</script>

<template>
  <div
    class="bullseye-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-bullseye</v-icon>
      <span class="panel-title">Bullseye</span>
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
      <!-- Place / replace bullseye -->
      <div class="add-row">
        <v-btn
          size="x-small"
          :variant="selecting ? 'tonal' : 'text'"
          :color="selecting ? 'primary' : undefined"
          :class="selecting ? '' : 'text-medium-emphasis'"
          @pointerdown.stop
          @click.stop="toggleSet"
        >
          <v-icon size="14">{{ bullseye ? 'mdi-crosshairs' : 'mdi-plus' }}</v-icon>
          <span class="add-label">
            {{ selecting ? 'Click map…' : (bullseye ? 'Move bullseye' : 'Set bullseye') }}
          </span>
        </v-btn>
      </div>

      <div v-if="!bullseye" class="empty-hint">
        No bullseye set. Click <em>Set</em> then click the map to place a reference point.
      </div>

      <template v-if="bullseye">
        <div class="divider" />

        <!-- Name -->
        <div class="config-row">
          <span class="config-label">Name</span>
          <input
            v-model="nameInput"
            type="text"
            class="text-input"
            @change="commitName"
            @blur="commitName"
            @keydown.enter="commitName"
          />
        </div>

        <!-- Ring interval -->
        <div class="config-row">
          <span class="config-label">Ring interval</span>
          <input
            v-model.number="intervalInput"
            type="number"
            min="1"
            step="100"
            class="num-input"
            @change="commitInterval"
            @blur="commitInterval"
            @keydown.enter="commitInterval"
          />
          <span class="unit">{{ unitLabel }}</span>
        </div>

        <!-- Ring count -->
        <div class="config-row">
          <span class="config-label">Ring count</span>
          <input
            v-model.number="countInput"
            type="number"
            min="1"
            max="20"
            step="1"
            class="num-input"
            @change="commitCount"
            @blur="commitCount"
            @keydown.enter="commitCount"
          />
        </div>

        <!-- Cardinals -->
        <div class="config-row">
          <label class="cardinal-toggle">
            <input
              type="checkbox"
              :checked="bullseye.showCardinals"
              @change="e => toggleCardinals(e.target.checked)"
            />
            <span>Show cardinal spokes</span>
          </label>
        </div>

        <div class="divider" />

        <!-- Center — editable. Commits on Enter or when focus leaves the group. -->
        <div class="center-row">
          <div class="center-head">
            <v-icon size="12" class="owner-icon">mdi-crosshairs-gps</v-icon>
            <span class="center-label">Center</span>
          </div>
          <CoordInput :model-value="centerLngLat" @commit="commitCenter" />
        </div>

        <!-- Track list -->
        <div v-if="trackRows.length === 0" class="empty-hint">
          No tracks to report.
        </div>

        <div
          v-for="r in trackRows"
          :key="r.key"
          class="track-row"
        >
          <v-icon size="12" class="owner-icon">{{ kindIcon(r.kind) }}</v-icon>
          <span class="track-label" :title="r.label">{{ r.label }}</span>
          <span class="track-call">{{ formatCall(r) }}</span>
        </div>

        <div class="divider" />

        <v-btn
          size="x-small"
          variant="text"
          color="error"
          class="clear-btn"
          @pointerdown.stop
          @click.stop="clearBullseye"
        >
          <v-icon size="14">mdi-delete-outline</v-icon>
          <span class="clear-label">Clear bullseye</span>
        </v-btn>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bullseye-panel {
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

.config-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px;
}

.config-label {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  flex: 1;
}

.text-input {
  width: 120px;
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 11px;
  color: rgb(var(--v-theme-on-surface));
  outline: none;
}

.text-input:focus,
.num-input:focus {
  border-color: #4a9ade;
}

.num-input {
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

.unit {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.cardinal-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.8);
  cursor: pointer;
}

.cardinal-toggle input[type='checkbox'] {
  accent-color: #4a9ade;
  cursor: pointer;
}

.center-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 2px 6px;
}

.center-head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.center-label {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.track-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 2px;
  min-width: 0;
}

.owner-icon {
  color: rgba(var(--v-theme-on-surface), 0.6);
  flex-shrink: 0;
}

.track-label {
  font-size: 11px;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-call {
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: rgba(var(--v-theme-on-surface), 0.75);
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
