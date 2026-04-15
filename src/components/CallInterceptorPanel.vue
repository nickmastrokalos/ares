<script setup>
import { ref, computed, watch, inject, onMounted, onUnmounted } from 'vue'
import { useTracksStore } from '@/stores/tracks'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { formatSpeed, speedUnitLabel, parseSpeedToMs, distanceUnitLabel, parseDistanceToMeters } from '@/services/geometry'
import { solveIntercept } from '@/services/intercept'

const emit = defineEmits(['close'])

const tracksStore   = useTracksStore()
const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()

const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const setInterceptMarker  = inject('setInterceptMarker',  null)
const clearInterceptMarker = inject('clearInterceptMarker', null)
const flyToGeometry        = inject('flyToGeometry',        null)

// ---- Affiliation helpers ----

const AFFIL_PREFIX = { f: '[F]', h: '[H]', n: '[C]', u: '[U]' }

function affilPrefix(a) {
  return AFFIL_PREFIX[a] ?? '[?]'
}

// ---- Unified track list from both CoT tracks and manual-track features ----

const allTracks = computed(() => {
  const list = []

  // CoT tracks
  for (const t of tracksStore.tracks.values()) {
    const cotType = t.cotType ?? ''
    const char = cotType[2] ?? 'u'
    const affil = ['f', 'h', 'n'].includes(char) ? char : 'u'
    list.push({
      id: `cot:${t.uid}`,
      callsign: t.callsign ?? t.uid,
      affil,
      lon: t.lon,
      lat: t.lat,
      course: t.course ?? null,
      speedMs: t.speed ?? null,   // m/s from CoT
      hasCourse: t.course != null,
      hasSpeed: t.speed != null && t.speed > 0
    })
  }

  // Manual tracks — speed stored as knots in properties
  for (const f of featuresStore.features) {
    if (f.type !== 'manual-track') continue

    let geom = null
    let props = {}
    try { geom = JSON.parse(f.geometry) } catch { /* ignore */ }
    try { props = JSON.parse(f.properties) } catch { /* ignore */ }

    if (!geom?.coordinates) continue

    const speedKnots = props.speed ?? null
    const speedMs = speedKnots != null ? speedKnots * (1852 / 3600) : null
    const affil = props.affiliation ?? 'u'

    list.push({
      id: `manual:${f.id}`,
      callsign: props.callsign ?? `Track ${f.id}`,
      affil,
      lon: geom.coordinates[0],
      lat: geom.coordinates[1],
      course: props.course ?? null,
      speedMs,
      hasCourse: props.course != null,
      hasSpeed: speedMs != null && speedMs > 0
    })
  }

  list.sort((a, b) => a.callsign.localeCompare(b.callsign))
  return list
})

// ---- Selection state ----

const hostileId  = ref('')
const friendlyId = ref('')

const hostileTrack  = computed(() => allTracks.value.find(t => t.id === hostileId.value) ?? null)
const friendlyTrack = computed(() => allTracks.value.find(t => t.id === friendlyId.value) ?? null)

// ---- Unit labels ----

const unitLabel     = computed(() => speedUnitLabel(settingsStore.distanceUnits))
const distUnitLabel = computed(() => distanceUnitLabel(settingsStore.distanceUnits))

// ---- Speed override ----

const speedOverride     = ref('')
const speedUserModified = ref(false)

function formatSpeedInput(ms) {
  const units = settingsStore.distanceUnits
  if (units === 'nautical') return (ms * 1.94384).toFixed(1)
  if (units === 'statute')  return (ms * 2.23694).toFixed(1)
  return (ms * 3.6).toFixed(1)
}

// Pre-fill speed from track whenever friendly selection changes
watch(friendlyId, () => {
  speedUserModified.value = false
  const track = allTracks.value.find(t => t.id === friendlyId.value)
  if (!track?.hasSpeed || track.speedMs == null) {
    speedOverride.value = ''
    return
  }
  speedOverride.value = formatSpeedInput(track.speedMs)
})

// Keep the displayed speed in sync with live track updates unless user has overridden it
watch(() => friendlyTrack.value?.speedMs, (newMs) => {
  if (speedUserModified.value || newMs == null) return
  speedOverride.value = formatSpeedInput(newMs)
})

const effectiveSpeedMs = computed(() => {
  if (!speedOverride.value.trim()) return null
  return parseSpeedToMs(speedOverride.value, settingsStore.distanceUnits)
})

const speedSourceLabel = computed(() => {
  if (!friendlyTrack.value?.hasSpeed || friendlyTrack.value.speedMs == null) return null
  if (effectiveSpeedMs.value == null) return null
  if (Math.abs(effectiveSpeedMs.value - friendlyTrack.value.speedMs) < 0.1) return 'from track'
  return 'override'
})

// ---- Geometry inputs ----

const rangeInput   = ref('')
const bearingInput = ref('')

// ---- Result ----

const result = computed(() => {
  if (!hostileTrack.value || !friendlyTrack.value) return null

  if (hostileId.value === friendlyId.value) {
    return { error: 'Hostile and friendly cannot be the same track' }
  }

  if (effectiveSpeedMs.value == null || effectiveSpeedMs.value <= 0) {
    return { error: 'No friendly speed — enter a value above' }
  }

  if (!rangeInput.value.trim()) return null

  const bearingVal = parseFloat(bearingInput.value)
  if (isNaN(bearingVal)) return null

  const rangeM = parseDistanceToMeters(rangeInput.value, settingsStore.distanceUnits)
  if (rangeM == null) return null

  const bearing = ((bearingVal % 360) + 360) % 360

  return solveIntercept({
    fLon: friendlyTrack.value.lon,
    fLat: friendlyTrack.value.lat,
    fSpeedMs: effectiveSpeedMs.value,
    hLon: hostileTrack.value.lon,
    hLat: hostileTrack.value.lat,
    hSpeedMs: hostileTrack.value.speedMs ?? 0,
    hCourse: hostileTrack.value.hasCourse ? hostileTrack.value.course : 0,
    rangeM,
    bearing
  })
})

// Update map marker whenever result changes
watch(result, (r) => {
  if (r && !r.error) {
    setInterceptMarker?.(r.interceptLon, r.interceptLat)
  } else {
    clearInterceptMarker?.()
  }
})

function flyToIntercept() {
  if (!result.value || result.value.error) return
  flyToGeometry?.({
    type: 'Point',
    coordinates: [result.value.interceptLon, result.value.interceptLat]
  })
}

// ---- Formatters ----

function formatHdg(deg) {
  return String(((Math.round(deg) % 360) + 360) % 360).padStart(3, '0') + '°'
}

function formatTti(seconds) {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

// ---- Track meta display helpers ----

function trackCourseLabel(track) {
  if (!track.hasCourse) return null
  return `${Math.round(track.course)}°`
}

function trackSpeedLabel(track) {
  if (!track.hasSpeed || track.speedMs == null) return null
  return formatSpeed(track.speedMs, settingsStore.distanceUnits)
}

// ---- Lifecycle ----

onMounted(() => {
  pos.value     = { x: 12, y: 80 }
  positioned.value = true
})

onUnmounted(() => {
  clearInterceptMarker?.()
})
</script>

<template>
  <div
    class="intercept-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-target</v-icon>
      <span class="panel-title">Intercept</span>
      <v-spacer />
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
    <div class="panel-body">

      <!-- Hostile -->
      <div class="section-label">Hostile</div>
      <select
        v-model="hostileId"
        class="panel-select"
        @pointerdown.stop
      >
        <option value="">— select track —</option>
        <option
          v-for="t in allTracks"
          :key="t.id"
          :value="t.id"
        >{{ affilPrefix(t.affil) }} {{ t.callsign }}</option>
      </select>

      <div v-if="hostileTrack" class="track-meta">
        <template v-if="hostileTrack.hasCourse">
          <span>{{ trackCourseLabel(hostileTrack) }}</span>
        </template>
        <template v-else>
          <span class="meta-warn">No heading — N assumed</span>
        </template>
        <span class="meta-sep">·</span>
        <template v-if="hostileTrack.hasSpeed">
          <span>{{ trackSpeedLabel(hostileTrack) }}</span>
        </template>
        <template v-else>
          <span class="meta-dim">Stationary</span>
        </template>
      </div>

      <div class="divider" />

      <!-- Friendly -->
      <div class="section-label">Friendly</div>
      <select
        v-model="friendlyId"
        class="panel-select"
        @pointerdown.stop
      >
        <option value="">— select track —</option>
        <option
          v-for="t in allTracks"
          :key="t.id"
          :value="t.id"
        >{{ affilPrefix(t.affil) }} {{ t.callsign }}</option>
      </select>

      <div class="form-row">
        <span class="form-label">SPD</span>
        <input
          v-model="speedOverride"
          class="short-input"
          type="text"
          inputmode="decimal"
          placeholder="0"
          @input="speedUserModified = true"
          @pointerdown.stop
        />
        <span class="form-unit">{{ unitLabel }}</span>
        <span v-if="speedSourceLabel" class="source-badge">{{ speedSourceLabel }}</span>
      </div>

      <div class="divider" />

      <!-- Geometry -->
      <div class="section-label">Geometry</div>

      <div class="form-row">
        <span class="form-label">RNG</span>
        <input
          v-model="rangeInput"
          class="short-input"
          type="text"
          inputmode="decimal"
          placeholder="0"
          @pointerdown.stop
        />
        <span class="form-unit">{{ distUnitLabel }}</span>
      </div>

      <div class="form-row">
        <span class="form-label">BRG</span>
        <input
          v-model="bearingInput"
          class="short-input"
          type="text"
          inputmode="decimal"
          placeholder="0"
          @pointerdown.stop
        />
        <span class="form-unit">° rel</span>
      </div>

      <!-- Result -->
      <template v-if="result">
        <div class="divider" />

        <template v-if="!result.error">
          <div class="result-grid">
            <span class="result-key">HDG</span>
            <span class="result-hdg">{{ formatHdg(result.heading) }}</span>
            <span class="result-key">TTI</span>
            <span class="result-val">{{ formatTti(result.tti) }}</span>
          </div>
          <button class="fly-btn" @pointerdown.stop @click.stop="flyToIntercept">
            <v-icon size="12">mdi-crosshairs-gps</v-icon>
            fly to intercept
          </button>
        </template>

        <template v-else>
          <div class="result-error">
            <v-icon size="14">mdi-alert-circle-outline</v-icon>
            {{ result.error }}
          </div>
        </template>
      </template>

    </div>
  </div>
</template>

<style scoped>
.intercept-panel {
  position: absolute;
  width: 280px;
  background: rgba(var(--v-theme-surface), 0.95);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
}

/* ---- Header ---- */

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
}

.header-btn {
  flex-shrink: 0;
}

/* ---- Body ---- */

.panel-body {
  padding: 6px 8px 8px;
}

.section-label {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(var(--v-theme-on-surface), 0.38);
  margin-bottom: 4px;
}

/* ---- Track selector ---- */

.panel-select {
  width: 100%;
  font-size: 11px;
  background: rgba(var(--v-theme-surface-variant), 0.3);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 3px;
  color: rgb(var(--v-theme-on-surface));
  padding: 3px 4px;
  outline: none;
  margin-bottom: 5px;
  cursor: pointer;
}

.panel-select option {
  background: rgb(var(--v-theme-surface));
}

/* ---- Track meta ---- */

.track-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.55);
  margin-bottom: 4px;
}

.meta-dim {
  color: rgba(var(--v-theme-on-surface), 0.38);
}

.meta-warn {
  color: #ff9800;
  font-size: 10px;
}

.meta-sep {
  color: rgba(var(--v-theme-on-surface), 0.3);
}

/* ---- Divider ---- */

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 6px 0;
}

/* ---- Form rows ---- */

.form-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.form-label {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(var(--v-theme-on-surface), 0.45);
  width: 28px;
  flex-shrink: 0;
}

.short-input {
  width: 60px;
  font-size: 11px;
  font-family: monospace;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  color: rgb(var(--v-theme-on-surface));
  padding: 2px 4px;
  outline: none;
  /* Hide browser number spinners */
  -moz-appearance: textfield;
}

.short-input::-webkit-outer-spin-button,
.short-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
}

.form-unit {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  flex-shrink: 0;
}

.source-badge {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: rgba(var(--v-theme-on-surface), 0.35);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.2);
  border-radius: 2px;
  padding: 0 3px;
  line-height: 14px;
  flex-shrink: 0;
}

/* ---- Result ---- */

.result-grid {
  display: grid;
  grid-template-columns: 36px 1fr;
  column-gap: 8px;
  row-gap: 3px;
  margin-bottom: 6px;
}

.result-key {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(var(--v-theme-on-surface), 0.45);
  align-self: center;
}

.result-hdg {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: rgb(var(--v-theme-primary));
  line-height: 1.1;
}

.result-val {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.87);
  align-self: center;
}

.fly-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 0;
}

.fly-btn:hover {
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.result-error {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: rgb(var(--v-theme-error));
}
</style>
