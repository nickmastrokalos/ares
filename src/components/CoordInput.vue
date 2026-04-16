<script setup>
/**
 * Multi-field coordinate input that renders sub-fields matching the active
 * coordinate format (DD / DMS / MGRS). Accepts a [lng, lat] model value and
 * emits 'commit' with a new [lng, lat] when the user confirms (Enter or focus
 * leaving the entire group). Invalid input reverts to the current model value.
 */
import { reactive, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { forward as toMgrs, toPoint as fromMgrs } from 'mgrs'

const props = defineProps({
  modelValue: { type: Array, default: null }  // [lng, lat] | null
})
const emit = defineEmits(['commit'])

const settingsStore = useSettingsStore()

// All possible sub-fields in one reactive object; which ones are active
// depends on the current coordinate format.
const f = reactive({
  // Decimal degrees
  lat: '', lng: '',
  // DMS (degrees carry the sign; minutes/seconds are unsigned)
  latD: '', latM: '', latS: '',
  lngD: '', lngM: '', lngS: '',
  // MGRS
  zone: '', square: '', east: '', north: ''
})

// ---- Splitting [lng, lat] into sub-fields ----

function toDmsParts(decimal) {
  const negative = decimal < 0
  const abs = Math.abs(decimal)
  const d = Math.floor(abs)
  const mFull = (abs - d) * 60
  const m = Math.floor(mFull)
  const s = parseFloat(((mFull - m) * 60).toFixed(1))
  // Use "-0" when d=0 and value is negative so the sign is preserved in the
  // string; Math.sign(0) === 0, so a plain "0" would lose the hemisphere.
  const dStr = negative ? (d === 0 ? '-0' : String(-d)) : String(d)
  return { d: dStr, m: String(m), s: String(s) }
}

function splitMgrs(lng, lat) {
  try {
    const raw = toMgrs([lng, lat], 5)
    const m = raw.match(/^(\d{1,2}[A-Z])([A-Z]{2})(\d+)$/)
    if (!m) return { zone: raw, square: '', east: '', north: '' }
    const half = m[3].length / 2
    return { zone: m[1], square: m[2], east: m[3].slice(0, half), north: m[3].slice(half) }
  } catch {
    return { zone: '', square: '', east: '', north: '' }
  }
}

function updateFields(lngLat) {
  if (!lngLat || lngLat.length < 2) return
  const [lng, lat] = lngLat
  const fmt = settingsStore.coordinateFormat
  if (fmt === 'dd') {
    f.lat = lat.toFixed(5)
    f.lng = lng.toFixed(5)
  } else if (fmt === 'dms') {
    const lp = toDmsParts(lat)
    const np = toDmsParts(lng)
    f.latD = lp.d; f.latM = lp.m; f.latS = lp.s
    f.lngD = np.d; f.lngM = np.m; f.lngS = np.s
  } else {
    const p = splitMgrs(lng, lat)
    f.zone = p.zone; f.square = p.square; f.east = p.east; f.north = p.north
  }
}

// ---- Parsing sub-fields back to [lng, lat] ----

function parseDmsAxis(dStr, mStr, sStr) {
  const negative = String(dStr).trim().startsWith('-')
  const d = Math.abs(parseFloat(dStr))
  const m = parseFloat(mStr)
  const s = parseFloat(sStr)
  if (!isFinite(d) || !isFinite(m) || !isFinite(s)) return null
  if (m < 0 || m >= 60 || s < 0 || s >= 60) return null
  const abs = d + m / 60 + s / 3600
  return negative ? -abs : abs
}

function parseFields() {
  const fmt = settingsStore.coordinateFormat
  if (fmt === 'dd') {
    const lat = parseFloat(f.lat)
    const lng = parseFloat(f.lng)
    if (!isFinite(lat) || !isFinite(lng)) return null
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return [lng, lat]
  }
  if (fmt === 'dms') {
    const lat = parseDmsAxis(f.latD, f.latM, f.latS)
    const lng = parseDmsAxis(f.lngD, f.lngM, f.lngS)
    if (lat == null || lng == null) return null
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return [lng, lat]
  }
  // mgrs
  try {
    const full = (f.zone + f.square + f.east + f.north).replace(/\s+/g, '')
    if (!full) return null
    const result = fromMgrs(full)
    if (!result || !isFinite(result[0]) || !isFinite(result[1])) return null
    const [lng, lat] = result
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return [lng, lat]
  } catch {
    return null
  }
}

// ---- Commit / revert ----

function tryCommit() {
  const result = parseFields()
  if (result) {
    emit('commit', result)
  } else {
    // Revert all sub-fields to the current model value
    updateFields(props.modelValue)
  }
}

// Focus leaving the component (but not moving to a sibling sub-field)
// triggers a commit attempt.
function onFocusOut(e) {
  if (e.currentTarget.contains(e.relatedTarget)) return
  tryCommit()
}

function onEnter() {
  tryCommit()
}

// Re-populate when the parent changes the value (new feature selected,
// or after a successful commit that comes back through props).
watch(
  () => props.modelValue,
  (val) => { if (val) updateFields(val) },
  { immediate: true }
)

// Re-format when the user changes the coordinate format in Settings.
watch(
  () => settingsStore.coordinateFormat,
  () => { if (props.modelValue) updateFields(props.modelValue) }
)
</script>

<template>
  <div class="coord-input" @focusout="onFocusOut">

    <!-- ---- Decimal Degrees ---- -->
    <template v-if="settingsStore.coordinateFormat === 'dd'">
      <div class="ci-row">
        <span class="ci-sublabel">Lat</span>
        <input
          v-model="f.lat"
          class="ci-field ci-field--dd"
          inputmode="decimal"
          @keydown.enter.prevent="onEnter"
        />
        <span class="ci-sublabel ci-sublabel--gap">Lng</span>
        <input
          v-model="f.lng"
          class="ci-field ci-field--dd"
          inputmode="decimal"
          @keydown.enter.prevent="onEnter"
        />
      </div>
    </template>

    <!-- ---- Degrees / Minutes / Seconds ---- -->
    <template v-else-if="settingsStore.coordinateFormat === 'dms'">
      <div class="ci-row">
        <span class="ci-sublabel">Lat</span>
        <input v-model="f.latD" class="ci-field ci-field--dms-d" inputmode="decimal"  @keydown.enter.prevent="onEnter" />
        <span class="ci-unit">°</span>
        <input v-model="f.latM" class="ci-field ci-field--dms-m" inputmode="numeric"  @keydown.enter.prevent="onEnter" />
        <span class="ci-unit">'</span>
        <input v-model="f.latS" class="ci-field ci-field--dms-s" inputmode="decimal"  @keydown.enter.prevent="onEnter" />
        <span class="ci-unit">"</span>
      </div>
      <div class="ci-row ci-row--dms2">
        <span class="ci-sublabel">Lng</span>
        <input v-model="f.lngD" class="ci-field ci-field--dms-d" inputmode="decimal"  @keydown.enter.prevent="onEnter" />
        <span class="ci-unit">°</span>
        <input v-model="f.lngM" class="ci-field ci-field--dms-m" inputmode="numeric"  @keydown.enter.prevent="onEnter" />
        <span class="ci-unit">'</span>
        <input v-model="f.lngS" class="ci-field ci-field--dms-s" inputmode="decimal"  @keydown.enter.prevent="onEnter" />
        <span class="ci-unit">"</span>
      </div>
    </template>

    <!-- ---- MGRS ---- -->
    <template v-else>
      <div class="ci-row">
        <input v-model="f.zone"   class="ci-field ci-field--mgrs-zone"   placeholder="33U"   @keydown.enter.prevent="onEnter" />
        <input v-model="f.square" class="ci-field ci-field--mgrs-sq"     placeholder="XP"    @keydown.enter.prevent="onEnter" />
        <input v-model="f.east"   class="ci-field ci-field--mgrs-digits" placeholder="00848" inputmode="numeric" @keydown.enter.prevent="onEnter" />
        <input v-model="f.north"  class="ci-field ci-field--mgrs-digits" placeholder="00848" inputmode="numeric" @keydown.enter.prevent="onEnter" />
      </div>
    </template>

  </div>
</template>

<style scoped>
.coord-input {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ci-row {
  display: flex;
  align-items: center;
  gap: 3px;
}

.ci-row--dms2 {
  /* second DMS row (Lng) sits directly below the first (Lat) */
}

.ci-sublabel {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  min-width: 20px;
  text-align: right;
  flex-shrink: 0;
}

.ci-sublabel--gap {
  margin-left: 4px;
}

.ci-unit {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  flex-shrink: 0;
  margin: 0 1px;
}

.ci-field {
  background: transparent;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.2);
  border-radius: 3px;
  color: inherit;
  font-size: 12px;
  font-family: inherit;
  padding: 2px 5px;
  height: 26px;
  outline: none;
  min-width: 0;
}

.ci-field:focus {
  border-color: rgb(var(--v-theme-primary));
}

/* Decimal degrees */
.ci-field--dd {
  width: 90px;
}

/* DMS */
.ci-field--dms-d { width: 44px; }
.ci-field--dms-m { width: 30px; }
.ci-field--dms-s { width: 42px; }

/* MGRS */
.ci-field--mgrs-zone   { width: 38px; text-transform: uppercase; }
.ci-field--mgrs-sq     { width: 34px; text-transform: uppercase; }
.ci-field--mgrs-digits { width: 50px; }
</style>
