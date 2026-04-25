<script setup>
import { ref, computed, inject, onMounted } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { useTracksStore } from '@/stores/tracks'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'

const emit = defineEmits(['close'])

const featuresStore = useFeaturesStore()
const tracksStore   = useTracksStore()

const minimized  = ref(false)
const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const flyToGeometry        = inject('flyToGeometry')
const openManualTrackPanel = inject('openManualTrackPanel')

const AFFIL_COLORS  = { f: '#4a9ade', h: '#f44336', n: '#4caf50', u: '#ffeb3b' }
const AFFIL_LABELS  = { f: 'Friendly', h: 'Hostile',  n: 'Civilian', u: 'Unknown' }
const AFFIL_KEYS    = ['f', 'n', 'u', 'h']

// ---- Filter state ----

const filterKind   = ref('all')   // 'all' | 'cot' | 'manual'
const filterAffils = ref(new Set(AFFIL_KEYS))
const filterName   = ref('')
const sortDir      = ref('asc')

function setKind(kind) {
  filterKind.value = kind
}

function toggleAffil(key) {
  const next = new Set(filterAffils.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  filterAffils.value = next
}

const filtersActive = computed(() =>
  filterKind.value !== 'all' || filterAffils.value.size < AFFIL_KEYS.length || filterName.value.trim() !== ''
)

function toggleSort() {
  sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
}

// ---- Unified track list ----

const allTracks = computed(() => {
  const result = []

  for (const t of tracksStore.tracks.values()) {
    const char = t.cotType?.[2] ?? 'u'
    const affiliation = ['f', 'h', 'n', 'u'].includes(char) ? char : 'u'
    result.push({
      kind:        'cot',
      id:          t.uid,
      callsign:    t.callsign,
      affiliation,
      coord:       [t.lon, t.lat]
    })
  }

  for (const f of featuresStore.features) {
    if (f.type !== 'manual-track') continue
    const props = JSON.parse(f.properties)
    const geom  = JSON.parse(f.geometry)
    result.push({
      kind:        'manual',
      id:          f.id,
      callsign:    props.callsign,
      affiliation: props.affiliation ?? 'u',
      coord:       geom.coordinates
    })
  }

  return result.sort((a, b) => {
    const cmp = a.callsign.localeCompare(b.callsign)
    return sortDir.value === 'asc' ? cmp : -cmp
  })
})

const visibleTracks = computed(() => {
  const name = filterName.value.trim().toLowerCase()
  return allTracks.value.filter(t => {
    if (filterKind.value !== 'all' && t.kind !== filterKind.value) return false
    if (!filterAffils.value.has(t.affiliation)) return false
    if (name && !t.callsign.toLowerCase().includes(name)) return false
    return true
  })
})

// ---- Actions ----

function centerOnTrack(track) {
  flyToGeometry?.({ type: 'Point', coordinates: track.coord })
}

function openDetail(track) {
  if (track.kind === 'cot') {
    tracksStore.openPanel(track.id)
  } else {
    openManualTrackPanel?.(track.id)
  }
}

async function removeTrack(track) {
  if (track.kind === 'cot') {
    tracksStore.removeTrack(track.id)
  } else {
    await featuresStore.removeFeature(track.id)
  }
}

function isHidden(track) {
  return track.kind === 'cot'
    ? tracksStore.hiddenIds.has(track.id)
    : featuresStore.hiddenManualIds.has(track.id)
}

function toggleVisibility(track) {
  if (track.kind === 'cot') {
    tracksStore.toggleVisibility(track.id)
  } else {
    featuresStore.toggleManualVisibility(track.id)
  }
}

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
})
</script>

<template>
  <div
    class="track-list-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-format-list-bulleted</v-icon>
      <span class="panel-title">Track List</span>
      <span class="track-count" :class="{ 'track-count--filtered': filtersActive }">
        {{ filtersActive ? `${visibleTracks.length} / ${allTracks.length}` : allTracks.length }}
      </span>
      <v-tooltip :text="sortDir === 'asc' ? 'Sort Z→A' : 'Sort A→Z'" location="top">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            :icon="sortDir === 'asc' ? 'mdi-sort-ascending' : 'mdi-sort-descending'"
            size="x-small"
            variant="text"
            class="text-medium-emphasis header-btn"
            @pointerdown.stop
            @click.stop="toggleSort"
          />
        </template>
      </v-tooltip>
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

    <!-- Filters -->
    <div v-show="!minimized" class="filter-bar" @pointerdown.stop>
      <!-- Kind -->
      <div class="filter-row">
        <span class="filter-label">Type</span>
        <div class="filter-pills">
          <button
            v-for="opt in [{ value: 'all', label: 'All' }, { value: 'cot', label: 'COT' }, { value: 'manual', label: 'MAN' }]"
            :key="opt.value"
            class="pill"
            :class="{ 'pill--active': filterKind === opt.value }"
            @click="setKind(opt.value)"
          >{{ opt.label }}</button>
        </div>
      </div>

      <!-- Name search -->
      <div class="filter-row">
        <input
          v-model="filterName"
          class="name-search"
          placeholder="Search callsign…"
          @pointerdown.stop
        />
      </div>

      <!-- Affiliation -->
      <div class="filter-row">
        <span class="filter-label">Affil</span>
        <div class="filter-affils">
          <v-tooltip
            v-for="key in AFFIL_KEYS"
            :key="key"
            :text="AFFIL_LABELS[key]"
            location="top"
          >
            <template #activator="{ props }">
              <button
                v-bind="props"
                class="affil-toggle"
                :class="{ 'affil-toggle--off': !filterAffils.has(key) }"
                @click="toggleAffil(key)"
              >
                <span
                  class="affil-dot"
                  :style="{ backgroundColor: AFFIL_COLORS[key] }"
                />
              </button>
            </template>
          </v-tooltip>
        </div>
      </div>
    </div>

    <!-- List -->
    <div v-show="!minimized" class="panel-body">
      <div v-if="visibleTracks.length === 0" class="empty-state">
        {{ allTracks.length === 0 ? 'No tracks on map' : 'No tracks match filters' }}
      </div>

      <div
        v-for="track in visibleTracks"
        :key="`${track.kind}-${track.id}`"
        class="track-row"
      >
        <span
          class="affil-dot"
          :style="{ backgroundColor: AFFIL_COLORS[track.affiliation] ?? '#ffeb3b' }"
        />
        <span class="callsign">{{ track.callsign }}</span>
        <span class="kind-badge">{{ track.kind === 'cot' ? 'COT' : 'MAN' }}</span>

        <v-tooltip text="Center" location="top">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-crosshairs-gps"
              size="x-small"
              variant="text"
              class="text-medium-emphasis row-btn"
              @pointerdown.stop
              @click.stop="centerOnTrack(track)"
            />
          </template>
        </v-tooltip>

        <v-tooltip :text="isHidden(track) ? 'Show' : 'Hide'" location="top">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              :icon="isHidden(track) ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
              size="x-small"
              variant="text"
              class="text-medium-emphasis row-btn"
              @pointerdown.stop
              @click.stop="toggleVisibility(track)"
            />
          </template>
        </v-tooltip>

        <v-tooltip text="Details" location="top">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-information-outline"
              size="x-small"
              variant="text"
              class="text-medium-emphasis row-btn"
              @pointerdown.stop
              @click.stop="openDetail(track)"
            />
          </template>
        </v-tooltip>

        <v-tooltip :text="track.kind === 'cot' ? 'Dismiss' : 'Delete'" location="top">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-close"
              size="x-small"
              variant="text"
              class="text-medium-emphasis row-btn"
              @pointerdown.stop
              @click.stop="removeTrack(track)"
            />
          </template>
        </v-tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.track-list-panel {
  position: absolute;
  width: 300px;
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

.track-count {
  font-size: 10px;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.45);
  background: rgba(var(--v-theme-surface-variant), 0.8);
  border-radius: 8px;
  padding: 0 5px;
  line-height: 16px;
}

.track-count--filtered {
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
}

.header-btn {
  flex-shrink: 0;
}

/* ---- Filters ---- */

.filter-bar {
  padding: 5px 8px 6px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.38);
  width: 30px;
  flex-shrink: 0;
}

.filter-pills {
  display: flex;
  gap: 3px;
}

.pill {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 1px 7px;
  border-radius: 3px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: transparent;
  color: rgba(var(--v-theme-on-surface), 0.45);
  cursor: pointer;
  line-height: 16px;
}

.pill:hover {
  background: rgba(var(--v-theme-surface-variant), 0.5);
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.pill--active {
  background: rgba(var(--v-theme-primary), 0.15);
  border-color: rgba(var(--v-theme-primary), 0.5);
  color: rgb(var(--v-theme-primary));
}

.name-search {
  flex: 1;
  font-size: 11px;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 3px;
  color: rgba(var(--v-theme-on-surface), 0.87);
  padding: 2px 7px;
  line-height: 18px;
  outline: none;
  width: 100%;
}

.name-search::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.35);
}

.name-search:focus {
  border-color: rgba(var(--v-theme-primary), 0.5);
  background: rgba(var(--v-theme-surface-variant), 0.6);
}

.filter-affils {
  display: flex;
  gap: 6px;
}

.affil-toggle {
  background: none;
  border: none;
  padding: 2px;
  cursor: pointer;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
  transition: opacity 0.15s;
}

.affil-toggle--off {
  opacity: 0.2;
}

.affil-toggle:hover {
  opacity: 0.8;
}

.affil-toggle--off:hover {
  opacity: 0.5;
}

/* ---- List ---- */

.panel-body {
  max-height: 320px;
  overflow-y: auto;
  padding: 3px 0;
}

.empty-state {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.38);
  text-align: center;
  padding: 12px 8px;
}

.track-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 2px 8px;
}

.track-row:hover {
  background: rgba(var(--v-theme-surface-variant), 0.3);
}

.affil-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.callsign {
  flex: 1;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(var(--v-theme-on-surface), 0.87);
  min-width: 0;
}

.kind-badge {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: rgba(var(--v-theme-on-surface), 0.35);
  flex-shrink: 0;
}

.row-btn {
  flex-shrink: 0;
}
</style>
