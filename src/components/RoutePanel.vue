<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { formatCoordinate } from '@/services/coordinates'
import { distanceBetween, formatDistance } from '@/services/geometry'

const props = defineProps({
  routeId:   { type: Number, required: true },
  appending: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'append-waypoint'])

const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()

const minimized  = ref(false)
const positioned = ref(false)
const editingName = ref(false)
const nameInput   = ref('')

const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

// ---- Derived data ----

const routeRow = computed(() =>
  featuresStore.features.find(f => f.id === props.routeId) ?? null
)

const routeProps = computed(() => {
  if (!routeRow.value) return null
  return JSON.parse(routeRow.value.properties)
})

const routeGeometry = computed(() => {
  if (!routeRow.value) return null
  return JSON.parse(routeRow.value.geometry)
})

const routeName = computed(() => routeProps.value?.name ?? 'Route')

const waypoints = computed(() => {
  const geometry = routeGeometry.value
  const props    = routeProps.value
  if (!geometry || !props) return []
  const coords = geometry.coordinates
  const wps    = props.waypoints ?? []
  const total  = coords.length
  return coords.map((coord, i) => {
    const wp = wps[i] ?? {}
    const label = wp.label ?? (i === 0 ? 'SP' : i === total - 1 ? 'EP' : `WP ${i}`)
    const role  = wp.role  ?? (i === 0 ? 'SP' : i === total - 1 ? 'EP' : 'WP')
    return { index: i, label, role, coord }
  })
})

const totalDistance = computed(() => {
  const coords = routeGeometry.value?.coordinates
  if (!coords || coords.length < 2) return 0
  let d = 0
  for (let i = 1; i < coords.length; i++) {
    d += distanceBetween(coords[i - 1], coords[i])
  }
  return d
})

const totalDistanceLabel = computed(() =>
  formatDistance(totalDistance.value, settingsStore.distanceUnits)
)

const canDelete = computed(() => waypoints.value.length > 2)

// ---- Role dot color ----

function roleColor() {
  return '#ffffff'
}

// ---- Coord format ----

function coordLabel(coord) {
  return formatCoordinate(coord[0], coord[1], settingsStore.coordinateFormat)
}

// ---- Name editing ----

function startEditName() {
  nameInput.value = routeName.value
  editingName.value = true
}

async function saveName() {
  editingName.value = false
  const trimmed = nameInput.value.trim()
  if (!trimmed || trimmed === routeName.value) return
  if (!routeRow.value) return
  await featuresStore.updateFeature(
    routeRow.value.id,
    routeGeometry.value,
    { ...routeProps.value, name: trimmed }
  )
}

// ---- Delete route ----

async function deleteRoute() {
  if (!routeRow.value) return
  await featuresStore.removeFeature(routeRow.value.id)
}

// ---- Delete waypoint ----

async function deleteWaypoint(index) {
  if (!canDelete.value) return
  const geometry   = routeGeometry.value
  const properties = routeProps.value
  if (!geometry || !properties) return

  const coords = [...geometry.coordinates]
  coords.splice(index, 1)

  const total = coords.length
  const newWps = coords.map((c, i) => {
    const label = i === 0 ? 'SP' : i === total - 1 ? 'EP' : `WP ${i}`
    const role  = i === 0 ? 'SP' : i === total - 1 ? 'EP' : 'WP'
    return { label, role }
  })

  await featuresStore.updateFeature(
    routeRow.value.id,
    { type: 'LineString', coordinates: coords },
    { ...properties, waypoints: newWps }
  )
}

// ---- Placement ----

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
})

// ---- Watch for deletion ----

watch(routeRow, (row) => {
  if (!row) emit('close')
})
</script>

<template>
  <div
    class="route-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-routes</v-icon>

      <!-- Inline name edit -->
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
          class="route-name"
          title="Click to rename"
          @pointerdown.stop
          @click.stop="startEditName"
        >{{ routeName }}</span>
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
      <div class="section-label">Waypoints</div>

      <div v-for="wp in waypoints" :key="wp.index" class="wp-row">
        <span
          class="role-dot"
          :style="{ backgroundColor: roleColor(wp.role) }"
        />
        <div class="wp-info">
          <span class="wp-label">{{ wp.label }}</span>
          <span class="wp-coord">{{ coordLabel(wp.coord) }}</span>
        </div>
        <v-btn
          icon="mdi-close"
          size="x-small"
          variant="text"
          :disabled="!canDelete"
          class="text-medium-emphasis wp-delete-btn"
          @pointerdown.stop
          @click.stop="deleteWaypoint(wp.index)"
        />
      </div>

      <!-- Append waypoint button -->
      <div class="append-row">
        <v-btn
          size="x-small"
          :variant="appending ? 'tonal' : 'text'"
          :color="appending ? 'primary' : undefined"
          :class="appending ? '' : 'text-medium-emphasis'"
          @pointerdown.stop
          @click.stop="emit('append-waypoint')"
        >
          <v-icon size="14">mdi-map-marker-plus</v-icon>
          <span class="append-label">{{ appending ? 'Click map…' : 'Add waypoint' }}</span>
        </v-btn>
      </div>

      <div class="divider" />

      <!-- Total distance -->
      <div class="attr-grid">
        <span class="attr-key">DISTANCE</span>
        <span class="attr-val">{{ totalDistanceLabel }}</span>
      </div>

      <div class="divider" />

      <v-btn
        size="x-small"
        variant="text"
        color="error"
        class="delete-btn"
        @pointerdown.stop
        @click.stop="deleteRoute"
      >
        <v-icon size="14">mdi-delete-outline</v-icon>
        <span class="delete-label">Delete route</span>
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.route-panel {
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

.route-name {
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

.wp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.role-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.wp-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.wp-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.87);
  line-height: 1.3;
}

.wp-coord {
  font-size: 9px;
  font-family: monospace;
  color: rgba(var(--v-theme-on-surface), 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.wp-delete-btn {
  flex-shrink: 0;
}

.append-row {
  margin-top: 4px;
  display: flex;
  align-items: center;
}

.append-label {
  font-size: 11px;
  margin-left: 4px;
  letter-spacing: 0.02em;
}

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 5px 0;
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
