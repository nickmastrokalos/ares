<script setup>
import { ref, computed, watch, mergeProps, onMounted, nextTick, inject } from 'vue'
import {
  useFeaturesStore,
  DEFAULT_FEATURE_COLOR,
  DEFAULT_FEATURE_OPACITY
} from '@/stores/features'
import { useDraggable } from '@/composables/useDraggable'
import { useSettingsStore } from '@/stores/settings'
import { formatDistance } from '@/services/geometry'

// Shapes that actually render a fill layer. Opacity has no visible effect
// on lines/points, so the control stays hidden for those.
const FILLABLE_TYPES = new Set(['polygon', 'circle', 'sector'])

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

const isImage = computed(() => featuresStore.selectedFeature?.type === 'image')
const isFillable = computed(() =>
  FILLABLE_TYPES.has(featuresStore.selectedFeature?.type)
)
const widthLabel = computed(() =>
  formatDistance(widthMeters.value, settingsStore.distanceUnits)
)

// Functional palette — color is data here (how the user distinguishes
// features on the map), not decoration. Kept intentionally small.
const SWATCHES = [
  '#ffffff', '#f44336', '#ff9800', '#ffeb3b',
  '#4caf50', '#00bcd4', '#4a9ade', '#9c27b0',
  '#e91e63', '#795548', '#9e9e9e', '#616161'
]

watch(
  () => featuresStore.selectedFeature,
  (feature) => {
    if (!feature) return
    name.value = feature.properties?.name ?? ''
    color.value = feature.properties?.color ?? DEFAULT_FEATURE_COLOR
    opacity.value = feature.properties?.opacity ?? DEFAULT_FEATURE_OPACITY
    widthMeters.value = feature.properties?.widthMeters ?? 500
  },
  { immediate: true }
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
    x: Math.max(12, Math.round((parentWidth - panelWidth) / 2)),
    y: Math.max(12, parentHeight - panelHeight - 34)
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
</template>

<style scoped>
.attributes-panel {
  position: absolute;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 4px 4px;
  background: rgba(var(--v-theme-surface), 0.92);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  user-select: none;
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
</style>
