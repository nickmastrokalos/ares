<script setup>
import { ref, computed, watch, inject, onMounted } from 'vue'
import { useTracksStore } from '@/stores/tracks'
import { useAisStore } from '@/stores/ais'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import {
  formatSpeed, speedUnitLabel, parseSpeedToMs,
  distanceUnitLabel, parseDistanceToMeters, formatDistance
} from '@/services/geometry'

const emit = defineEmits(['close'])

const tracksStore   = useTracksStore()
const aisStore      = useAisStore()
const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()

const interceptApi = inject('interceptApi', null)
const flyToGeometry = inject('flyToGeometry', null)

const minimized  = ref(false)
const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

// ---- Affiliation helpers ----

const AFFIL_PREFIX = { f: '[F]', h: '[H]', n: '[C]', u: '[U]' }
function affilPrefix(a) {
  return AFFIL_PREFIX[a] ?? '[?]'
}

const KIND_ICON = {
  cot:     'mdi-radio-tower',
  ais:     'mdi-ferry',
  feature: 'mdi-map-marker-outline'
}
function kindIcon(kind) {
  return KIND_ICON[kind] ?? 'mdi-map-marker-outline'
}

// ---- Unified track list (CoT + AIS + manual-track features) ----

const allTracks = computed(() => {
  const list = []

  for (const t of tracksStore.tracks.values()) {
    const cotType = t.cotType ?? ''
    const char = cotType[2] ?? 'u'
    const affil = ['f', 'h', 'n'].includes(char) ? char : 'u'
    list.push({
      id: `cot:${t.uid}`,
      kind: 'cot',
      refId: t.uid,
      callsign: t.callsign ?? t.uid,
      affil,
      lon: t.lon,
      lat: t.lat,
      course: t.course ?? null,
      speedMs: t.speed ?? null,
      hasCourse: t.course != null,
      hasSpeed: t.speed != null && t.speed > 0
    })
  }

  for (const v of aisStore.vessels.values()) {
    const speedMs = (v.SOG ?? 0) * (1852 / 3600)
    list.push({
      id: `ais:${v.mmsi}`,
      kind: 'ais',
      refId: String(v.mmsi),
      callsign: v.name ?? String(v.mmsi),
      affil: 'u',
      lon: v.longitude,
      lat: v.latitude,
      course: (v.COG >= 0) ? v.COG : null,
      speedMs,
      hasCourse: v.COG >= 0,
      hasSpeed: speedMs > 0
    })
  }

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
      kind: 'feature',
      refId: f.id,
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

// Friendly dropdown: only confirmed-friendly tracks. AIS has no affiliation
// field (always unknown) and therefore cannot be used as a friendly asset —
// a friendly must be something the operator actually controls or trusts.
const friendlyTracks = computed(() => allTracks.value.filter(t => t.affil === 'f'))

// ---- Add form state ----

const hostileId  = ref('')
const friendlyId = ref('')
const mode       = ref('direct')      // 'direct' | 'offset'
const rangeInput   = ref('')
const bearingInput = ref('')

const hostileTrack  = computed(() => allTracks.value.find(t => t.id === hostileId.value) ?? null)
const friendlyTrack = computed(() => friendlyTracks.value.find(t => t.id === friendlyId.value) ?? null)

// Unit labels
const unitLabel     = computed(() => speedUnitLabel(settingsStore.distanceUnits))
const distUnitLabel = computed(() => distanceUnitLabel(settingsStore.distanceUnits))

// ---- Friendly speed override ----

const speedOverride     = ref('')
const speedUserModified = ref(false)

function formatSpeedInput(ms) {
  const units = settingsStore.distanceUnits
  if (units === 'nautical') return (ms * 1.94384).toFixed(1)
  if (units === 'statute')  return (ms * 2.23694).toFixed(1)
  return (ms * 3.6).toFixed(1)
}

watch(friendlyId, () => {
  speedUserModified.value = false
  const track = allTracks.value.find(t => t.id === friendlyId.value)
  if (!track?.hasSpeed || track.speedMs == null) {
    speedOverride.value = ''
    return
  }
  speedOverride.value = formatSpeedInput(track.speedMs)
})

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

// ---- Aim-ring radius (shared, from composable) ----

const aimRingInput = ref(interceptApi?.aimRingRadius.value ?? 150)
function commitAimRingRadius() {
  const n = Number(aimRingInput.value)
  if (!Number.isFinite(n) || n <= 0) {
    aimRingInput.value = interceptApi?.aimRingRadius.value ?? 150
    return
  }
  interceptApi?.setAimRingRadius(n)
}

// ---- Add validity ----

const addError = computed(() => {
  if (!hostileTrack.value || !friendlyTrack.value) return null
  if (hostileId.value === friendlyId.value) return 'Hostile and friendly cannot be the same track'
  if (effectiveSpeedMs.value == null || effectiveSpeedMs.value <= 0) return 'No friendly speed'
  if (mode.value === 'offset') {
    if (!rangeInput.value.trim()) return 'Enter offset range'
    if (parseDistanceToMeters(rangeInput.value, settingsStore.distanceUnits) == null) return 'Invalid range'
    const b = parseFloat(bearingInput.value)
    if (!Number.isFinite(b)) return 'Enter offset bearing'
  }
  return null
})

const canAdd = computed(() =>
  interceptApi != null &&
  hostileTrack.value && friendlyTrack.value &&
  hostileId.value !== friendlyId.value &&
  effectiveSpeedMs.value != null && effectiveSpeedMs.value > 0 &&
  (mode.value !== 'offset' || (!!rangeInput.value.trim() && Number.isFinite(parseFloat(bearingInput.value))))
)

function commitAdd() {
  if (!canAdd.value) return

  const hostileEp = { kind: hostileTrack.value.kind }
  if (hostileEp.kind === 'cot')     hostileEp.uid       = hostileTrack.value.refId
  if (hostileEp.kind === 'ais')     hostileEp.mmsi      = hostileTrack.value.refId
  if (hostileEp.kind === 'feature') hostileEp.featureId = hostileTrack.value.refId

  const friendlyEp = { kind: friendlyTrack.value.kind, speedOverrideMs: effectiveSpeedMs.value }
  if (friendlyEp.kind === 'cot')     friendlyEp.uid       = friendlyTrack.value.refId
  if (friendlyEp.kind === 'ais')     friendlyEp.mmsi      = friendlyTrack.value.refId
  if (friendlyEp.kind === 'feature') friendlyEp.featureId = friendlyTrack.value.refId

  let offsetRange, offsetBearing
  if (mode.value === 'offset') {
    offsetRange = parseDistanceToMeters(rangeInput.value, settingsStore.distanceUnits)
    offsetBearing = ((parseFloat(bearingInput.value) % 360) + 360) % 360
  }

  interceptApi.addIntercept({
    hostile: hostileEp,
    friendly: friendlyEp,
    mode: mode.value,
    offsetRange,
    offsetBearing
  })

  // Keep the selections — easy to tweak and re-add with slight variations.
  // Clear offset inputs so they don't accidentally apply to a fresh direct add.
  if (mode.value === 'offset') {
    // leave them so user can iterate
  }
}

// ---- List + actions ----

const rows = computed(() => interceptApi?.intercepts.value ?? [])

function remove(id) {
  interceptApi?.removeIntercept(id)
}

function clearAll() {
  interceptApi?.clearAll()
}

function flyToAim(row) {
  const sol = row.solution
  if (!sol || sol.error) return
  flyToGeometry?.({ type: 'Point', coordinates: sol.aimCoord })
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

function trackCourseLabel(track) {
  if (!track.hasCourse) return null
  return `${Math.round(track.course)}°`
}

function trackSpeedLabel(track) {
  if (!track.hasSpeed || track.speedMs == null) return null
  return formatSpeed(track.speedMs, settingsStore.distanceUnits)
}

function closingLabel(closingMs) {
  if (closingMs == null) return null
  const closing = closingMs > 0
  const label = formatSpeed(Math.abs(closingMs), settingsStore.distanceUnits)
  return `${closing ? 'closing' : 'opening'} ${label}`
}

function missLabel(meters) {
  return formatDistance(meters, settingsStore.distanceUnits)
}

// ---- Lifecycle ----

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
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

      <!-- Aim-ring radius -->
      <div class="default-row">
        <span class="default-label">Aim ring</span>
        <input
          v-model.number="aimRingInput"
          type="number"
          min="1"
          step="50"
          class="radius-input"
          @change="commitAimRingRadius"
          @blur="commitAimRingRadius"
          @keydown.enter="commitAimRingRadius"
          @pointerdown.stop
        />
        <span class="unit">m</span>
      </div>

      <div class="divider" />

      <!-- Add form -->
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

      <div class="section-label" style="margin-top:6px">Friendly</div>
      <select
        v-model="friendlyId"
        class="panel-select"
        @pointerdown.stop
      >
        <option value="">— select track —</option>
        <option
          v-for="t in friendlyTracks"
          :key="t.id"
          :value="t.id"
        >{{ affilPrefix(t.affil) }} {{ t.callsign }}</option>
      </select>
      <div v-if="friendlyTracks.length === 0" class="hint-inline">
        No friendly-affiliation tracks available.
      </div>

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

      <!-- Mode toggle -->
      <div class="form-row mode-row">
        <span class="form-label">MODE</span>
        <div class="mode-segments">
          <button
            class="mode-btn"
            :class="{ active: mode === 'direct' }"
            @pointerdown.stop
            @click.stop="mode = 'direct'"
          >Direct</button>
          <button
            class="mode-btn"
            :class="{ active: mode === 'offset' }"
            @pointerdown.stop
            @click.stop="mode = 'offset'"
          >Offset</button>
        </div>
      </div>

      <!-- Offset inputs -->
      <template v-if="mode === 'offset'">
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
      </template>

      <!-- Add button -->
      <div class="form-row add-row">
        <v-btn
          size="small"
          variant="tonal"
          color="primary"
          :disabled="!canAdd"
          @pointerdown.stop
          @click.stop="commitAdd"
        >
          <v-icon size="14">mdi-plus</v-icon>
          <span class="add-label">Add intercept</span>
        </v-btn>
        <span v-if="addError" class="add-error">{{ addError }}</span>
      </div>

      <div class="divider" />

      <!-- Intercept list -->
      <div v-if="rows.length === 0" class="empty-hint">
        No intercepts yet. Pick a hostile + friendly above and click <em>Add</em>.
      </div>

      <div class="list-scroll">
        <div
          v-for="r in rows"
          :key="r.id"
          class="intercept-row"
        >
          <div class="row-body">
            <div class="pair-line">
              <v-icon size="12" class="owner-icon">{{ kindIcon(r.hostile.kind) }}</v-icon>
              <span class="owner-label" :title="r.hostile.label">{{ r.hostile.label }}</span>
              <v-icon size="10" class="arrow-icon">mdi-arrow-right</v-icon>
              <v-icon size="12" class="owner-icon">{{ kindIcon(r.friendly.kind) }}</v-icon>
              <span class="owner-label" :title="r.friendly.label">{{ r.friendly.label }}</span>
            </div>

            <template v-if="r.solution && !r.solution.error">
              <div class="result-line">
                <span
                  class="status-pill"
                  :class="r.solution.type === 'cpa' ? 'pill-cpa' : 'pill-intercept'"
                >{{ r.solution.type === 'cpa' ? 'CPA' : 'INTERCEPT' }}</span>
                <span class="hdg">{{ formatHdg(r.solution.heading) }}</span>
                <span class="tti">{{ formatTti(r.solution.tti) }}</span>
              </div>
              <div v-if="r.solution.type === 'cpa'" class="detail-line">
                miss {{ missLabel(r.solution.missDistance) }}
              </div>
              <div v-if="r.solution.closingSpeedMs != null" class="detail-line">
                {{ closingLabel(r.solution.closingSpeedMs) }}
              </div>
              <div v-if="r.mode === 'offset'" class="detail-line offset-detail">
                offset {{ missLabel(r.offsetRange) }} / {{ Math.round(r.offsetBearing) }}° rel
              </div>
            </template>
            <template v-else-if="r.solution?.error">
              <div class="detail-line error-line">
                <v-icon size="12">mdi-alert-circle-outline</v-icon>
                {{ r.solution.error }}
              </div>
            </template>
          </div>

          <div class="row-actions">
            <v-btn
              icon="mdi-crosshairs-gps"
              size="x-small"
              variant="text"
              class="text-medium-emphasis row-btn"
              :disabled="!r.solution || !!r.solution.error"
              @pointerdown.stop
              @click.stop="flyToAim(r)"
            />
            <v-btn
              icon="mdi-close"
              size="x-small"
              variant="text"
              class="text-medium-emphasis row-btn"
              @pointerdown.stop
              @click.stop="remove(r.id)"
            />
          </div>
        </div>
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
.intercept-panel {
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

/* Default / aim-ring row */
.default-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 2px;
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

.divider {
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  margin: 6px 0;
}

/* Section label */
.section-label {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(var(--v-theme-on-surface), 0.38);
  margin-bottom: 4px;
}

/* Track selector */
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

/* Track meta */
.track-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.55);
  margin-bottom: 4px;
}

.meta-dim { color: rgba(var(--v-theme-on-surface), 0.38); }

.hint-inline {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  font-style: italic;
  padding: 0 2px 4px;
}
.meta-warn { color: #ff9800; font-size: 10px; }
.meta-sep { color: rgba(var(--v-theme-on-surface), 0.3); }

/* Form rows */
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
  width: 32px;
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

/* Mode toggle */
.mode-row .mode-segments {
  display: inline-flex;
  gap: 1px;
}

.mode-btn {
  font-size: 10px;
  padding: 2px 8px;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  color: rgba(var(--v-theme-on-surface), 0.6);
  cursor: pointer;
  outline: none;
}

.mode-btn:first-child { border-top-left-radius: 3px; border-bottom-left-radius: 3px; }
.mode-btn:last-child  { border-top-right-radius: 3px; border-bottom-right-radius: 3px; }

.mode-btn.active {
  background: rgba(74, 154, 222, 0.25);
  color: #4a9ade;
  border-color: #4a9ade;
}

/* Add row */
.add-row {
  margin-top: 2px;
  gap: 8px;
}

.add-label {
  margin-left: 4px;
  font-size: 11px;
  text-transform: none;
  letter-spacing: 0;
}

.add-error {
  font-size: 10px;
  color: rgba(var(--v-theme-error), 0.8);
}

/* Empty state */
.empty-hint {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.5);
  line-height: 1.5;
  padding: 4px 2px;
}

/* List */
.list-scroll {
  max-height: 260px;
  overflow-y: auto;
}

.intercept-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 2px;
  border-top: 1px solid rgba(var(--v-theme-surface-variant), 0.6);
}

.intercept-row:first-child {
  border-top: none;
}

.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pair-line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 10px;
}

.owner-icon {
  color: rgba(var(--v-theme-on-surface), 0.6);
  flex-shrink: 0;
}

.arrow-icon {
  color: rgba(var(--v-theme-on-surface), 0.3);
  flex-shrink: 0;
}

.owner-label {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 80px;
}

.result-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.status-pill {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 1px 5px;
  border-radius: 2px;
  line-height: 1.4;
  flex-shrink: 0;
}

.pill-intercept {
  background: rgba(74, 154, 222, 0.15);
  color: #4a9ade;
  border: 1px solid rgba(74, 154, 222, 0.4);
}

.pill-cpa {
  background: rgba(255, 179, 0, 0.15);
  color: #ffb300;
  border: 1px solid rgba(255, 179, 0, 0.4);
}

.hdg {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: rgb(var(--v-theme-primary));
  font-family: monospace;
}

.tti {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-family: monospace;
}

.detail-line {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.55);
  display: flex;
  align-items: center;
  gap: 4px;
}

.offset-detail {
  color: rgba(var(--v-theme-on-surface), 0.45);
}

.error-line {
  color: rgb(var(--v-theme-error));
}

.row-actions {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex-shrink: 0;
}

.row-btn {
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
