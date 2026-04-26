<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useAdsbStore } from '@/stores/adsb'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { formatCoordinate } from '@/services/coordinates'

const props = defineProps({
  hex: { type: String, required: true }
})

const adsbStore     = useAdsbStore()
const settingsStore = useSettingsStore()

const minimized  = ref(false)
const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

// Cache last known data so the panel stays readable if the aircraft falls
// out of the current radius fetch.
const lastKnown = ref(null)

const aircraft = computed(() => {
  const a = adsbStore.aircraft.get(props.hex)
  if (a) lastKnown.value = a
  return lastKnown.value
})

function val(v) {
  return v != null && v !== '' ? v : '—'
}

const flightDisplay = computed(() => {
  const f = aircraft.value?.flight?.trim()
  return f || props.hex.toUpperCase()
})

const position = computed(() => {
  if (!aircraft.value) return '—'
  return formatCoordinate(aircraft.value.lon, aircraft.value.lat, settingsStore.coordinateFormat)
})

// alt_baro is either a number (feet) or the string "ground". Render flight
// levels (FL250) above 18,000 ft, plain feet below.
const altitudeDisplay = computed(() => {
  const alt = aircraft.value?.alt_baro
  if (alt == null) return '—'
  if (typeof alt === 'string') return alt === 'ground' ? 'Ground' : alt
  if (!Number.isFinite(alt)) return '—'
  if (alt >= 18000) return `FL${Math.round(alt / 100).toString().padStart(3, '0')}`
  return `${alt.toLocaleString()} ft`
})

const speedDisplay = computed(() => {
  const gs = aircraft.value?.gs
  if (!Number.isFinite(gs)) return '—'
  return `${gs.toFixed(0)} kts`
})

function bearingDisplay(deg) {
  if (!Number.isFinite(deg)) return '—'
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return `${deg.toFixed(0)}°  ${dirs[Math.round(deg / 22.5) % 16]}`
}

const trackDisplay   = computed(() => bearingDisplay(aircraft.value?.track))
const headingDisplay = computed(() => bearingDisplay(aircraft.value?.true_heading ?? aircraft.value?.mag_heading))

const verticalRateDisplay = computed(() => {
  const vr = aircraft.value?.baro_rate ?? aircraft.value?.geom_rate
  if (!Number.isFinite(vr)) return '—'
  const sign = vr > 0 ? '↑' : vr < 0 ? '↓' : ''
  return `${sign} ${Math.abs(vr).toLocaleString()} fpm`
})

const seenDisplay = computed(() => {
  const s = aircraft.value?.seen
  if (!Number.isFinite(s)) return '—'
  if (s < 1)  return 'just now'
  if (s < 60) return `${s.toFixed(0)} s ago`
  return `${(s / 60).toFixed(1)} min ago`
})

onMounted(async () => {
  await nextTick()
  const index  = adsbStore.openPanelList.indexOf(props.hex)
  const offset = Math.max(0, index) * 24
  pos.value    = { x: 12 + offset, y: 12 + offset }
  positioned.value = true
})

watch(() => adsbStore.focusedHex, (h) => {
  if (h === props.hex) bringToFront()
})
</script>

<template>
  <div
    class="adsb-panel"
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
      <span class="aircraft-dot" />
      <span class="aircraft-name">{{ flightDisplay }}</span>
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
        @click.stop="adsbStore.closePanel(hex)"
      />
    </div>

    <!-- Body -->
    <div v-show="!minimized" class="panel-body">

      <div class="section-label">Identity</div>
      <div class="attr-grid">
        <span class="attr-key">HEX</span>
        <span class="attr-val attr-val--mono">{{ hex.toUpperCase() }}</span>
        <span class="attr-key">FLIGHT</span>
        <span class="attr-val attr-val--mono">{{ val(aircraft?.flight?.trim()) }}</span>
        <span class="attr-key">REG</span>
        <span class="attr-val attr-val--mono">{{ val(aircraft?.r) }}</span>
        <span class="attr-key">TYPE</span>
        <span class="attr-val attr-val--mono">{{ val(aircraft?.t) }}</span>
        <span class="attr-key">SQUAWK</span>
        <span class="attr-val attr-val--mono">{{ val(aircraft?.squawk) }}</span>
      </div>

      <div class="divider" />

      <div class="section-label">Position</div>
      <div class="attr-grid">
        <span class="attr-key">COORD</span>
        <span class="attr-val attr-val--mono">{{ position }}</span>
        <span class="attr-key">ALT</span>
        <span class="attr-val">{{ altitudeDisplay }}</span>
        <span class="attr-key">SEEN</span>
        <span class="attr-val">{{ seenDisplay }}</span>
      </div>

      <div class="divider" />

      <div class="section-label">Telemetry</div>
      <div class="attr-grid">
        <span class="attr-key">GS</span>
        <span class="attr-val">{{ speedDisplay }}</span>
        <span class="attr-key">TRK</span>
        <span class="attr-val">{{ trackDisplay }}</span>
        <span class="attr-key">HDG</span>
        <span class="attr-val">{{ headingDisplay }}</span>
        <span class="attr-key">V/S</span>
        <span class="attr-val">{{ verticalRateDisplay }}</span>
      </div>

    </div>
  </div>
</template>

<style scoped>
.adsb-panel {
  position: absolute;
  z-index: 2;
  width: 260px;
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

.aircraft-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4dd0e1;
  border: 1px solid rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.aircraft-name {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  grid-template-columns: 52px 1fr;
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

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 5px 0;
}
</style>
