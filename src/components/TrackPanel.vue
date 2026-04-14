<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useTracksStore } from '@/stores/tracks'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { formatCoordinate } from '@/services/coordinates'

const props = defineProps({
  uid: { type: String, required: true }
})

const tracksStore   = useTracksStore()
const settingsStore = useSettingsStore()

const panelRef   = ref(null)
const minimized  = ref(false)
const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()

// Tick counter to drive live "age" and stale countdown displays.
const now = ref(Date.now())
let ticker = null

// ---- Derived display values ----

const AFFILIATION_LABELS = { f: 'Friendly', h: 'Hostile', n: 'Neutral', u: 'Unknown' }
const AFFILIATION_COLORS = { f: '#4a9ade', h: '#f44336', n: '#4caf50', u: '#ffeb3b' }

const track = computed(() => tracksStore.tracks.get(props.uid) ?? null)

const affiliation = computed(() => {
  const char = track.value?.cotType?.[2] ?? 'u'
  return ['f', 'h', 'n', 'u'].includes(char) ? char : 'u'
})

const affiliationColor = computed(() => AFFILIATION_COLORS[affiliation.value])
const affiliationLabel = computed(() => AFFILIATION_LABELS[affiliation.value])

const position = computed(() => {
  if (!track.value) return '—'
  return formatCoordinate(track.value.lon, track.value.lat, settingsStore.coordinateFormat)
})

const speedKnots = computed(() => {
  if (!track.value) return '—'
  return `${(track.value.speed * 1.94384).toFixed(1)} kts`
})

const courseDisplay = computed(() => {
  if (!track.value) return '—'
  const deg = track.value.course
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  const compass = dirs[Math.round(deg / 22.5) % 16]
  return `${deg.toFixed(1)}°  ${compass}`
})

const haeDisplay = computed(() => {
  if (!track.value) return '—'
  return `${track.value.hae.toFixed(0)} m`
})

const ageDisplay = computed(() => {
  if (!track.value) return '—'
  const secs = Math.floor((now.value - track.value.updatedAt) / 1000)
  if (secs < 60) return `${secs}s ago`
  return `${Math.floor(secs / 60)}m ${secs % 60}s ago`
})

const staleDisplay = computed(() => {
  if (!track.value?.stale) return '—'
  const ms = new Date(track.value.stale) - now.value
  if (ms < 0) return 'EXPIRED'
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `in ${secs}s`
  return `in ${Math.floor(secs / 60)}m ${secs % 60}s`
})

// ---- Initial placement ----
// Cascade panels so multiple open panels don't perfectly overlap.

onMounted(async () => {
  await nextTick()
  const index = tracksStore.openPanelList.indexOf(props.uid)
  const offset = Math.max(0, index) * 24
  pos.value = { x: 12 + offset, y: 12 + offset }
  positioned.value = true
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => {
  clearInterval(ticker)
})

// Close the panel automatically if the track is pruned from the store.
watch(track, (t) => {
  if (!t) tracksStore.closePanel(props.uid)
})
</script>

<template>
  <div
    ref="panelRef"
    class="track-panel"
    :style="{
      left: pos.x + 'px',
      top: pos.y + 'px',
      visibility: positioned ? 'visible' : 'hidden'
    }"
  >
    <!-- Header — always visible -->
    <div class="panel-header" @pointerdown="onPointerDown">
      <span class="affil-dot" :style="{ backgroundColor: affiliationColor }" />
      <span class="callsign">{{ track?.callsign ?? '—' }}</span>
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
        @click.stop="tracksStore.closePanel(uid)"
      />
    </div>

    <!-- Body — hidden when minimized -->
    <div v-show="!minimized" class="panel-body">
      <div class="section-label">Identity</div>
      <div class="attr-grid">
        <span class="attr-key">UID</span>
        <span class="attr-val">{{ track?.uid ?? '—' }}</span>
        <span class="attr-key">TYPE</span>
        <span class="attr-val">{{ track?.cotType ?? '—' }}</span>
        <span class="attr-key">AFFIL</span>
        <span class="attr-val">
          <span class="affil-dot affil-dot--inline" :style="{ backgroundColor: affiliationColor }" />
          {{ affiliationLabel }}
        </span>
      </div>

      <div class="divider" />

      <div class="section-label">Position</div>
      <div class="attr-grid">
        <span class="attr-key">COORD</span>
        <span class="attr-val attr-val--mono">{{ position }}</span>
        <span class="attr-key">HAE</span>
        <span class="attr-val">{{ haeDisplay }}</span>
      </div>

      <div class="divider" />

      <div class="section-label">Telemetry</div>
      <div class="attr-grid">
        <span class="attr-key">COURSE</span>
        <span class="attr-val">{{ courseDisplay }}</span>
        <span class="attr-key">SPEED</span>
        <span class="attr-val">{{ speedKnots }}</span>
      </div>

      <div class="divider" />

      <div class="section-label">Status</div>
      <div class="attr-grid">
        <span class="attr-key">UPDATED</span>
        <span class="attr-val">{{ ageDisplay }}</span>
        <span class="attr-key">STALE</span>
        <span class="attr-val" :class="{ 'text-error': staleDisplay === 'EXPIRED' }">
          {{ staleDisplay }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.track-panel {
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

.callsign {
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
</style>
