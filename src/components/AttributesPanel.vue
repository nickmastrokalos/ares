<script setup>
import { ref, computed, watch, mergeProps, onMounted, nextTick, inject } from 'vue'
import {
  useFeaturesStore,
  DEFAULT_FEATURE_COLOR,
  DEFAULT_FEATURE_OPACITY
} from '@/stores/features'
import { useDraggable } from '@/composables/useDraggable'
import { useSettingsStore } from '@/stores/settings'
import { formatDistance, parseDistanceToMeters, distanceBetween, circlePolygon, sectorPolygon, boxPolygon } from '@/services/geometry'
import CoordInput from '@/components/CoordInput.vue'

// Shapes that actually render a fill layer. Opacity has no visible effect
// on lines/points, so the control stays hidden for those.
const FILLABLE_TYPES = new Set(['polygon', 'circle', 'sector'])

// Shapes that expose numeric geometry fields.
const GEOMETRY_FIELD_TYPES = new Set(['point', 'circle', 'sector', 'box', 'line', 'polygon'])

const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()
const moveFeature = inject('moveFeature', null)
const panelRef = ref(null)
const { pos, onPointerDown } = useDraggable()
const positioned = ref(false)

const name = ref('')
const color = ref(DEFAULT_FEATURE_COLOR)
const colorMenu = ref(false)
const opacity = ref(DEFAULT_FEATURE_OPACITY)
const opacityMenu = ref(false)
const widthMeters = ref(500)
const widthMenu = ref(false)

// Geometry editing — coordinate values stored as [lng, lat] arrays so
// CoordInput can split them into format-appropriate sub-fields.
const coordVal    = ref(null)  // point, circle center, sector center
const swVal       = ref(null)  // box SW corner
const neVal       = ref(null)  // box NE corner
const vertexVals  = ref([])    // line / polygon vertices

// Non-coordinate geometry values (radius, angles)
const radiusStr     = ref('')
const startAngleStr = ref('')
const endAngleStr   = ref('')

const isImage = computed(() => featuresStore.selectedFeature?.type === 'image')
const isFillable = computed(() =>
  FILLABLE_TYPES.has(featuresStore.selectedFeature?.type)
)
const widthLabel = computed(() =>
  formatDistance(widthMeters.value, settingsStore.distanceUnits)
)
const hasGeometryFields = computed(() =>
  GEOMETRY_FIELD_TYPES.has(featuresStore.selectedFeature?.type)
)

// Vertex count + total length for line/polygon header
const lineLengthLabel = computed(() => {
  const f = featuresStore.selectedFeature
  if (f?.type !== 'line') return ''
  const coords = f.geometry.coordinates
  let total = 0
  for (let i = 1; i < coords.length; i++) total += distanceBetween(coords[i - 1], coords[i])
  return formatDistance(total, settingsStore.distanceUnits)
})

// Functional palette — color is data here (how the user distinguishes
// features on the map), not decoration. Kept intentionally small.
const SWATCHES = [
  '#ffffff', '#f44336', '#ff9800', '#ffeb3b',
  '#4caf50', '#00bcd4', '#4a9ade', '#9c27b0',
  '#e91e63', '#795548', '#9e9e9e', '#616161'
]

// ---- Helpers ----

// Always display radius in the base unit (km / nm / mi) so that
// parseDistanceToMeters round-trips cleanly: "0.50 km" → 0.5 × 1000 = 500 m.
function fmtRadius(meters) {
  const units = settingsStore.distanceUnits
  if (units === 'nautical') return `${(meters / 1852).toFixed(2)} nm`
  if (units === 'statute')  return `${(meters / 1609.344).toFixed(2)} mi`
  return `${(meters / 1000).toFixed(2)} km`
}

// Extract geometry fields from the current feature into local refs.
function syncGeometryRefs(feature) {
  if (!feature) return
  const g = feature.geometry
  const p = feature.properties ?? {}
  switch (feature.type) {
    case 'point':
      coordVal.value = [...g.coordinates]
      break
    case 'circle':
      coordVal.value  = p.center ? [...p.center] : null
      radiusStr.value = fmtRadius(p.radius ?? 0)
      break
    case 'sector':
      coordVal.value      = p.center ? [...p.center] : null
      radiusStr.value     = fmtRadius(p.radius ?? 0)
      startAngleStr.value = String(p.startAngle ?? 0)
      endAngleStr.value   = String(p.endAngle ?? 90)
      break
    case 'box': {
      const ring = g.coordinates[0]
      const lngs = ring.map(c => c[0])
      const lats  = ring.map(c => c[1])
      swVal.value = [Math.min(...lngs), Math.min(...lats)]
      neVal.value = [Math.max(...lngs), Math.max(...lats)]
      break
    }
    case 'line':
      vertexVals.value = g.coordinates.map(c => [...c])
      break
    case 'polygon':
      // Exclude the closing vertex (ring repeats first point at end)
      vertexVals.value = g.coordinates[0].slice(0, -1).map(c => [...c])
      break
  }
}

watch(
  () => featuresStore.selectedFeature,
  (feature) => {
    if (!feature) return
    name.value = feature.properties?.name ?? ''
    color.value = feature.properties?.color ?? DEFAULT_FEATURE_COLOR
    opacity.value = feature.properties?.opacity ?? DEFAULT_FEATURE_OPACITY
    widthMeters.value = feature.properties?.widthMeters ?? 500
    syncGeometryRefs(feature)
  },
  { immediate: true }
)

// Re-format the radius display string when the user changes distance units.
// CoordInput handles coordinateFormat changes internally.
watch(
  () => settingsStore.distanceUnits,
  () => syncGeometryRefs(featuresStore.selectedFeature)
)

async function commitName() {
  const feature = featuresStore.selectedFeature
  if (!feature) return
  if (name.value === (feature.properties?.name ?? '')) return
  await featuresStore.updateFeatureProperties(feature.id, { name: name.value })
}

async function commitColor(value) {
  const feature = featuresStore.selectedFeature
  if (!feature) return
  color.value = value
  colorMenu.value = false
  await featuresStore.updateFeatureProperties(feature.id, { color: value })
}

// Persist opacity only when the user releases the slider. Committing on
// every step would hammer SQLite + trigger a full feature reload per drag
// frame. `v-slider`'s `@end` fires once per interaction.
async function commitOpacity() {
  const feature = featuresStore.selectedFeature
  if (!feature) return
  const current = feature.properties?.opacity ?? DEFAULT_FEATURE_OPACITY
  if (opacity.value === current) return
  await featuresStore.updateFeatureProperties(feature.id, { opacity: opacity.value })
}

// Same commit-on-release pattern. Updating widthMeters triggers featureCollection
// change → syncImages → setCoordinates, so the image resizes on the map.
async function commitWidthMeters() {
  const feature = featuresStore.selectedFeature
  if (!feature) return
  const current = feature.properties?.widthMeters ?? 500
  if (widthMeters.value === current) return
  await featuresStore.updateFeatureProperties(feature.id, { widthMeters: widthMeters.value })
}

async function handleDelete() {
  const feature = featuresStore.selectedFeature
  if (!feature) return
  await featuresStore.removeFeature(feature.id)
}

// ---- Geometry commit handlers ----
// All coord handlers receive [lng, lat] from CoordInput's 'commit' event.

async function commitPointCoord([lng, lat]) {
  const feature = featuresStore.selectedFeature
  if (feature?.type !== 'point') return
  await featuresStore.updateFeature(feature.id,
    { type: 'Point', coordinates: [lng, lat] },
    { ...feature.properties }
  )
}

async function commitCircleCenter([lng, lat]) {
  const feature = featuresStore.selectedFeature
  if (feature?.type !== 'circle') return
  const props = feature.properties
  await featuresStore.updateFeature(feature.id,
    circlePolygon([lng, lat], props.radius),
    { ...props, center: [lng, lat] }
  )
}

async function commitCircleRadius() {
  const feature = featuresStore.selectedFeature
  if (feature?.type !== 'circle') return
  const meters = parseDistanceToMeters(radiusStr.value, settingsStore.distanceUnits)
  if (meters == null || meters <= 0) { radiusStr.value = fmtRadius(feature.properties.radius); return }
  const props = feature.properties
  await featuresStore.updateFeature(feature.id,
    circlePolygon(props.center, meters),
    { ...props, radius: meters }
  )
}

async function commitSectorCenter([lng, lat]) {
  const feature = featuresStore.selectedFeature
  if (feature?.type !== 'sector') return
  const props = feature.properties
  await featuresStore.updateFeature(feature.id,
    sectorPolygon([lng, lat], props.radius, props.startAngle, props.endAngle),
    { ...props, center: [lng, lat] }
  )
}

async function commitSectorRadius() {
  const feature = featuresStore.selectedFeature
  if (feature?.type !== 'sector') return
  const meters = parseDistanceToMeters(radiusStr.value, settingsStore.distanceUnits)
  if (meters == null || meters <= 0) { radiusStr.value = fmtRadius(feature.properties.radius); return }
  const props = feature.properties
  await featuresStore.updateFeature(feature.id,
    sectorPolygon(props.center, meters, props.startAngle, props.endAngle),
    { ...props, radius: meters }
  )
}

async function commitSectorAngle(field) {
  const feature = featuresStore.selectedFeature
  if (feature?.type !== 'sector') return
  const raw = field === 'start' ? startAngleStr.value : endAngleStr.value
  const angle = parseFloat(raw)
  if (!isFinite(angle)) {
    if (field === 'start') startAngleStr.value = String(feature.properties.startAngle ?? 0)
    else endAngleStr.value = String(feature.properties.endAngle ?? 90)
    return
  }
  const clamped = ((angle % 360) + 360) % 360
  const props = feature.properties
  const newProps = field === 'start'
    ? { ...props, startAngle: clamped }
    : { ...props, endAngle:   clamped }
  await featuresStore.updateFeature(feature.id,
    sectorPolygon(props.center, props.radius, newProps.startAngle, newProps.endAngle),
    newProps
  )
}

async function commitSwCorner([lng, lat]) {
  const feature = featuresStore.selectedFeature
  if (feature?.type !== 'box') return
  const ne = neVal.value
  if (!ne) return
  await featuresStore.updateFeature(feature.id,
    boxPolygon([lng, lat], ne),
    { ...feature.properties }
  )
}

async function commitNeCorner([lng, lat]) {
  const feature = featuresStore.selectedFeature
  if (feature?.type !== 'box') return
  const sw = swVal.value
  if (!sw) return
  await featuresStore.updateFeature(feature.id,
    boxPolygon(sw, [lng, lat]),
    { ...feature.properties }
  )
}

async function commitVertex(index, [lng, lat]) {
  const feature = featuresStore.selectedFeature
  if (!['line', 'polygon'].includes(feature?.type)) return
  let newGeometry
  if (feature.type === 'line') {
    const coords = [...feature.geometry.coordinates]
    coords[index] = [lng, lat]
    newGeometry = { type: 'LineString', coordinates: coords }
  } else {
    const ring = [...feature.geometry.coordinates[0].slice(0, -1)]
    ring[index] = [lng, lat]
    ring.push(ring[0])  // re-close the polygon ring
    newGeometry = { type: 'Polygon', coordinates: [ring] }
  }
  await featuresStore.updateFeature(feature.id, newGeometry, { ...feature.properties })
}

// Initial placement: centered along the bottom of the map container. Once
// the user drags, the composable takes over via pos.
onMounted(async () => {
  await nextTick()
  const parent = panelRef.value?.parentElement
  if (!parent || !panelRef.value) {
    positioned.value = true
    return
  }
  const parentWidth = parent.clientWidth
  const parentHeight = parent.clientHeight
  const panelWidth = panelRef.value.offsetWidth
  const panelHeight = panelRef.value.offsetHeight
  pos.value = {
    x: Math.max(12, parentWidth - panelWidth - 12),
    y: Math.max(12, Math.round((parentHeight - panelHeight) / 2))
  }
  positioned.value = true
})
</script>

<template>
  <div
    ref="panelRef"
    class="attributes-panel"
    :style="{
      left: pos.x + 'px',
      top: pos.y + 'px',
      visibility: positioned ? 'visible' : 'hidden'
    }"
  >
    <!-- ---- Toolbar row ---- -->
    <div class="panel-row toolbar-row">
      <div class="drag-handle" @pointerdown="onPointerDown">
        <v-icon icon="mdi-drag-vertical" size="16" class="text-medium-emphasis" />
      </div>

      <v-text-field
        v-model="name"
        placeholder="Name"
        density="compact"
        variant="plain"
        hide-details
        single-line
        class="name-field"
        @blur="commitName"
        @keydown.enter="commitName"
      />

      <v-menu
        v-if="!isImage"
        v-model="colorMenu"
        :close-on-content-click="false"
        location="top"
        offset="8"
      >
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            size="small"
            icon
            variant="text"
          >
            <span class="swatch-dot" :style="{ backgroundColor: color }" />
          </v-btn>
        </template>

        <v-card class="pa-2">
          <div class="swatch-grid">
            <button
              v-for="swatch in SWATCHES"
              :key="swatch"
              type="button"
              class="swatch-option"
              :class="{ selected: swatch.toLowerCase() === color.toLowerCase() }"
              :style="{ backgroundColor: swatch }"
              @click="commitColor(swatch)"
            />
          </div>
        </v-card>
      </v-menu>

      <v-menu
        v-if="isFillable"
        v-model="opacityMenu"
        :close-on-content-click="false"
        location="top"
        offset="8"
      >
        <template #activator="{ props: menuProps }">
          <v-tooltip text="Opacity" location="top">
            <template #activator="{ props: tipProps }">
              <v-btn
                v-bind="mergeProps(menuProps, tipProps)"
                icon="mdi-opacity"
                size="small"
                variant="text"
                class="text-medium-emphasis"
              />
            </template>
          </v-tooltip>
        </template>

        <v-card class="pa-3 opacity-popover">
          <div class="d-flex align-center ga-2">
            <v-slider
              v-model="opacity"
              :min="0"
              :max="1"
              :step="0.05"
              density="compact"
              hide-details
              thumb-size="14"
              track-size="2"
              class="opacity-slider"
              @end="commitOpacity"
            />
            <span class="text-caption text-medium-emphasis opacity-value">
              {{ Math.round(opacity * 100) }}%
            </span>
          </div>
        </v-card>
      </v-menu>

      <v-menu
        v-if="isImage"
        v-model="widthMenu"
        :close-on-content-click="false"
        location="top"
        offset="8"
      >
        <template #activator="{ props: menuProps }">
          <v-tooltip text="Scale" location="top">
            <template #activator="{ props: tipProps }">
              <v-btn
                v-bind="mergeProps(menuProps, tipProps)"
                icon="mdi-resize"
                size="small"
                variant="text"
                class="text-medium-emphasis"
              />
            </template>
          </v-tooltip>
        </template>

        <v-card class="pa-3 width-popover">
          <div class="d-flex align-center ga-2">
            <v-slider
              v-model="widthMeters"
              :min="50"
              :max="50000"
              :step="50"
              density="compact"
              hide-details
              thumb-size="14"
              track-size="2"
              class="width-slider"
              @end="commitWidthMeters"
            />
            <span class="text-caption text-medium-emphasis width-value">
              {{ widthLabel }}
            </span>
          </div>
        </v-card>
      </v-menu>

      <v-tooltip text="Move" location="top">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-cursor-move"
            size="small"
            variant="text"
            class="text-medium-emphasis"
            @click="moveFeature(featuresStore.selectedFeature.id)"
          />
        </template>
      </v-tooltip>

      <v-tooltip text="Delete" location="top">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-trash-can-outline"
            size="small"
            variant="text"
            class="text-medium-emphasis"
            @click="handleDelete"
          />
        </template>
      </v-tooltip>
    </div>

    <!-- ---- Geometry fields row ---- -->
    <div v-if="hasGeometryFields" class="geometry-row">

      <!-- Point -->
      <template v-if="featuresStore.selectedFeature?.type === 'point'">
        <div class="geo-field">
          <span class="geo-label">Coord</span>
          <CoordInput :model-value="coordVal" @commit="commitPointCoord" />
        </div>
      </template>

      <!-- Circle -->
      <template v-else-if="featuresStore.selectedFeature?.type === 'circle'">
        <div class="geo-field">
          <span class="geo-label">Center</span>
          <CoordInput :model-value="coordVal" @commit="commitCircleCenter" />
        </div>
        <div class="geo-field">
          <span class="geo-label">Radius</span>
          <v-text-field
            v-model="radiusStr"
            density="compact"
            variant="outlined"
            rounded="sm"
            hide-details
            single-line
            class="geo-input geo-input--short"
            @blur="commitCircleRadius"
            @keydown.enter="commitCircleRadius"
          />
        </div>
      </template>

      <!-- Sector -->
      <template v-else-if="featuresStore.selectedFeature?.type === 'sector'">
        <div class="geo-field">
          <span class="geo-label">Center</span>
          <CoordInput :model-value="coordVal" @commit="commitSectorCenter" />
        </div>
        <div class="geo-field">
          <span class="geo-label">Radius</span>
          <v-text-field
            v-model="radiusStr"
            density="compact"
            variant="outlined"
            rounded="sm"
            hide-details
            single-line
            class="geo-input geo-input--short"
            @blur="commitSectorRadius"
            @keydown.enter="commitSectorRadius"
          />
        </div>
        <div class="geo-field">
          <span class="geo-label">Start°</span>
          <v-text-field
            v-model="startAngleStr"
            density="compact"
            variant="outlined"
            rounded="sm"
            hide-details
            single-line
            class="geo-input geo-input--angle"
            @blur="commitSectorAngle('start')"
            @keydown.enter="commitSectorAngle('start')"
          />
        </div>
        <div class="geo-field">
          <span class="geo-label">End°</span>
          <v-text-field
            v-model="endAngleStr"
            density="compact"
            variant="outlined"
            rounded="sm"
            hide-details
            single-line
            class="geo-input geo-input--angle"
            @blur="commitSectorAngle('end')"
            @keydown.enter="commitSectorAngle('end')"
          />
        </div>
      </template>

      <!-- Box -->
      <template v-else-if="featuresStore.selectedFeature?.type === 'box'">
        <div class="geo-field">
          <span class="geo-label">SW</span>
          <CoordInput :model-value="swVal" @commit="commitSwCorner" />
        </div>
        <div class="geo-field">
          <span class="geo-label">NE</span>
          <CoordInput :model-value="neVal" @commit="commitNeCorner" />
        </div>
      </template>

      <!-- Line -->
      <template v-else-if="featuresStore.selectedFeature?.type === 'line'">
        <div class="vertex-header text-caption text-medium-emphasis">
          {{ vertexVals.length }} pts · {{ lineLengthLabel }}
        </div>
        <div class="vertex-list">
          <div v-for="(val, i) in vertexVals" :key="i" class="geo-field">
            <span class="geo-label vertex-label">P{{ i + 1 }}</span>
            <CoordInput :model-value="val" @commit="(lngLat) => commitVertex(i, lngLat)" />
          </div>
        </div>
      </template>

      <!-- Polygon -->
      <template v-else-if="featuresStore.selectedFeature?.type === 'polygon'">
        <div class="vertex-header text-caption text-medium-emphasis">
          {{ vertexVals.length }} vertices
        </div>
        <div class="vertex-list">
          <div v-for="(val, i) in vertexVals" :key="i" class="geo-field">
            <span class="geo-label vertex-label">P{{ i + 1 }}</span>
            <CoordInput :model-value="val" @commit="(lngLat) => commitVertex(i, lngLat)" />
          </div>
        </div>
      </template>

    </div>
  </div>
</template>

<style scoped>
.attributes-panel {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  background: rgba(var(--v-theme-surface), 0.92);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  user-select: none;
}

/* ---- Toolbar row ---- */

.panel-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 4px 4px;
}

.drag-handle {
  display: flex;
  align-items: center;
  padding: 0 2px;
  cursor: grab;
}

.drag-handle:active {
  cursor: grabbing;
}

.name-field {
  width: 180px;
}

/* Vuetify reserves padding-top on the field for a floating label. With
   variant="plain" that label never appears, so the padding just pushes the
   input below center. Zero it out and let the flex parent center the input. */
.name-field :deep(.v-field__input) {
  padding-top: 0;
  padding-bottom: 0;
  min-height: 32px;
}

.name-field :deep(.v-field__field) {
  align-items: center;
}

.swatch-dot {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.25);
}

.swatch-grid {
  display: grid;
  grid-template-columns: repeat(4, 24px);
  gap: 6px;
}

.swatch-option {
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
  background-clip: padding-box;
}

.swatch-option.selected {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.opacity-popover {
  min-width: 200px;
}

.opacity-slider {
  flex: 1;
  min-width: 140px;
}

/* Vuetify's default slider styling is too low-contrast against the dark
   popover: the inactive track nearly vanishes, and the thumb/active fill
   render as mid-grey rather than the `primary` token. Force all three to
   use `on-surface` so the control is clearly legible. */
.opacity-slider :deep(.v-slider-track__background) {
  background: rgba(var(--v-theme-on-surface), 0.28);
  opacity: 1;
}

.opacity-slider :deep(.v-slider-track__fill) {
  background: rgb(var(--v-theme-on-surface));
}

.opacity-slider :deep(.v-slider-thumb__surface) {
  background: rgb(var(--v-theme-on-surface));
}

.opacity-value {
  min-width: 32px;
  text-align: right;
}

.width-popover {
  min-width: 220px;
}

.width-slider {
  flex: 1;
  min-width: 140px;
}

.width-slider :deep(.v-slider-track__background) {
  background: rgba(var(--v-theme-on-surface), 0.28);
  opacity: 1;
}

.width-slider :deep(.v-slider-track__fill) {
  background: rgb(var(--v-theme-on-surface));
}

.width-slider :deep(.v-slider-thumb__surface) {
  background: rgb(var(--v-theme-on-surface));
}

.width-value {
  min-width: 48px;
  text-align: right;
}

/* ---- Geometry fields row ---- */

.geometry-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px 8px 8px;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
}

.geo-field {
  display: flex;
  align-items: center;
  gap: 4px;
}

.geo-label {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.55);
  white-space: nowrap;
  min-width: 36px;
}

.geo-input {
  width: 190px;
}

.geo-input--short {
  width: 100px;
}

.geo-input--angle {
  width: 68px;
}

/* Strip Vuetify's top padding from compact outlined fields */
.geo-input :deep(.v-field__input) {
  padding-top: 0;
  padding-bottom: 0;
  min-height: 28px;
  font-size: 12px;
}

.geo-input :deep(.v-field__field) {
  align-items: center;
}

/* ---- Vertex list (line / polygon) ---- */

.vertex-header {
  width: 100%;
  padding-bottom: 2px;
}

.vertex-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
  width: 100%;
  padding-right: 2px;
}

.vertex-label {
  min-width: 28px;
  text-align: right;
  padding-right: 2px;
}
</style>
