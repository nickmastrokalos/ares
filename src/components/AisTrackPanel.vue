<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useAisStore } from '@/stores/ais'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { formatCoordinate } from '@/services/coordinates'

const props = defineProps({
  mmsi: { type: String, required: true }
})

const aisStore      = useAisStore()
const settingsStore = useSettingsStore()

const minimized  = ref(false)
const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

// Cache last known data so the panel stays readable if the vessel falls out
// of the current viewport fetch.
const lastKnown = ref(null)

const vessel = computed(() => {
  const v = aisStore.vessels.get(props.mmsi)
  if (v) lastKnown.value = v
  return lastKnown.value
})

// Strip leading "N-" numeric code from API enum strings e.g. "5-Moored" → "Moored"
function stripCode(val) {
  if (!val) return '—'
  return val.replace(/^\d+-/, '')
}

function val(v) {
  return v != null && v !== '' ? v : '—'
}

const nameDisplay = computed(() => vessel.value?.name || props.mmsi)

const position = computed(() => {
  if (!vessel.value) return '—'
  return formatCoordinate(vessel.value.longitude, vessel.value.latitude, settingsStore.coordinateFormat)
})

const timeOfFixDisplay = computed(() => {
  const t = vessel.value?.timeOfFix
  if (!t) return '—'
  return new Date(t * 1000).toUTCString().replace(' GMT', 'Z')
})

const sogDisplay = computed(() => {
  const sog = vessel.value?.SOG
  if (sog == null) return '—'
  return `${sog.toFixed(1)} kts`
})

function bearingDisplay(deg) {
  if (deg == null || deg < 0) return '—'
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return `${deg.toFixed(1)}°  ${dirs[Math.round(deg / 22.5) % 16]}`
}

const cogDisplay     = computed(() => bearingDisplay(vessel.value?.COG))
const headingDisplay = computed(() => bearingDisplay(vessel.value?.heading))

onMounted(async () => {
  await nextTick()
  const index  = aisStore.openPanelList.indexOf(props.mmsi)
  const offset = Math.max(0, index) * 24
  pos.value    = { x: 12 + offset, y: 12 + offset }
  positioned.value = true
})

watch(() => aisStore.focusedMmsi, (mmsi) => {
  if (mmsi === props.mmsi) bringToFront()
})
</script>

<template>
  <div
    class="ais-panel"
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
      <span class="vessel-dot" />
      <span class="vessel-name">{{ nameDisplay }}</span>
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
        @click.stop="aisStore.closePanel(mmsi)"
      />
    </div>

    <!-- Body -->
    <div v-show="!minimized" class="panel-body">

      <div class="section-label">Identity</div>
      <div class="attr-grid">
        <span class="attr-key">MMSI</span>
        <span class="attr-val attr-val--mono">{{ mmsi }}</span>
        <span class="attr-key">IMO</span>
        <span class="attr-val attr-val--mono">{{ val(vessel?.imoNumber) }}</span>
        <span class="attr-key">CALLSIGN</span>
        <span class="attr-val attr-val--mono">{{ val(vessel?.callSign) }}</span>
        <span class="attr-key">TYPE</span>
        <span class="attr-val">{{ stripCode(vessel?.vesselType) }}</span>
        <span class="attr-key">CARGO</span>
        <span class="attr-val">{{ stripCode(vessel?.cargo) }}</span>
      </div>

      <div class="divider" />

      <div class="section-label">Position</div>
      <div class="attr-grid">
        <span class="attr-key">COORD</span>
        <span class="attr-val attr-val--mono">{{ position }}</span>
        <span class="attr-key">FIX</span>
        <span class="attr-val attr-val--mono fix-time">{{ timeOfFixDisplay }}</span>
      </div>

      <div class="divider" />

      <div class="section-label">Telemetry</div>
      <div class="attr-grid">
        <span class="attr-key">SOG</span>
        <span class="attr-val">{{ sogDisplay }}</span>
        <span class="attr-key">COG</span>
        <span class="attr-val">{{ cogDisplay }}</span>
        <span class="attr-key">HDG</span>
        <span class="attr-val">{{ headingDisplay }}</span>
        <span class="attr-key">STATUS</span>
        <span class="attr-val">{{ stripCode(vessel?.navStatus) }}</span>
      </div>

      <div class="divider" />

      <div class="section-label">Dimensions</div>
      <div class="attr-grid">
        <span class="attr-key">LENGTH</span>
        <span class="attr-val">{{ vessel?.length != null ? `${vessel.length} m` : '—' }}</span>
        <span class="attr-key">BEAM</span>
        <span class="attr-val">{{ vessel?.beam != null ? `${vessel.beam} m` : '—' }}</span>
        <span class="attr-key">DRAFT</span>
        <span class="attr-val">{{ vessel?.draft != null ? `${vessel.draft} m` : '—' }}</span>
      </div>

    </div>
  </div>
</template>

<style scoped>
.ais-panel {
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

.vessel-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffeb3b;
  border: 1px solid rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.vessel-name {
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

.fix-time {
  font-size: 9px;
}

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 5px 0;
}
</style>
