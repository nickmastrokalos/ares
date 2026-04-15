<script setup>
import { ref, computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps({
  modelValue: Boolean
})
const emit = defineEmits(['update:modelValue'])

const settingsStore = useSettingsStore()

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

// Active tab. Keyed list so new sections can be added by dropping a new
// entry here plus a matching `<v-window-item>` below — no router or
// external config involved.
const TABS = [
  { id: 'display', label: 'Display', icon: 'mdi-monitor-eye' },
  { id: 'tracks',  label: 'Tracks',  icon: 'mdi-radar' }
]
const activeTab = ref(TABS[0].id)

// Two-way binding that writes through to the persistent store on every
// change. Toggles are cheap; no need to debounce or batch.
const showFeatureLabels = computed({
  get: () => settingsStore.showFeatureLabels,
  set: (v) => settingsStore.setSetting('showFeatureLabels', v)
})

const DISTANCE_UNITS = [
  { title: 'Metric (m / km)', value: 'metric' },
  { title: 'Statute (ft / mi)', value: 'statute' },
  { title: 'Nautical (m / nm)', value: 'nautical' }
]

const distanceUnits = computed({
  get: () => settingsStore.distanceUnits,
  set: (v) => settingsStore.setSetting('distanceUnits', v)
})

const COORDINATE_FORMATS = [
  { title: 'Decimal degrees', value: 'dd' },
  { title: 'Deg / min / sec', value: 'dms' },
  { title: 'MGRS', value: 'mgrs' }
]

const coordinateFormat = computed({
  get: () => settingsStore.coordinateFormat,
  set: (v) => settingsStore.setSetting('coordinateFormat', v)
})

const trackBreadcrumbs = computed({
  get: () => settingsStore.trackBreadcrumbs,
  set: (v) => settingsStore.setSetting('trackBreadcrumbs', v)
})

const trackBreadcrumbLength = computed({
  get: () => settingsStore.trackBreadcrumbLength,
  set: (v) => settingsStore.setSetting('trackBreadcrumbLength', v)
})

function breadcrumbLengthLabel(secs) {
  return secs === 60 ? '1 min' : `${secs}s`
}

</script>

<template>
  <v-dialog v-model="open" max-width="560">
    <v-card color="surface" rounded="sm" flat>
      <v-card-title class="d-flex align-center pa-3">
        <v-icon icon="mdi-cog-outline" size="20" class="me-2 text-medium-emphasis" />
        <span class="text-body-1">Settings</span>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          class="text-medium-emphasis"
          @click="open = false"
        />
      </v-card-title>

      <v-divider />

      <v-tabs
        v-model="activeTab"
        density="compact"
        color="primary"
        slider-color="primary"
        class="settings-tabs"
      >
        <v-tab
          v-for="tab in TABS"
          :key="tab.id"
          :value="tab.id"
          :prepend-icon="tab.icon"
          class="text-body-2"
        >
          {{ tab.label }}
        </v-tab>
      </v-tabs>

      <v-divider />

      <v-window v-model="activeTab">
        <v-window-item value="display">
          <div class="pa-4">
            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">Show feature names on map</div>
                <div class="text-caption text-medium-emphasis">
                  Render each drawing's name as a label on the map.
                </div>
              </div>
              <v-switch
                v-model="showFeatureLabels"
                color="primary"
                density="compact"
                hide-details
                inset
              />
            </div>

            <v-divider class="my-3" />

            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">Distance units</div>
                <div class="text-caption text-medium-emphasis">
                  Units used for measurements and distance readouts.
                </div>
              </div>
              <v-select
                v-model="distanceUnits"
                :items="DISTANCE_UNITS"
                density="compact"
                variant="outlined"
                rounded="sm"
                hide-details
                style="max-width: 180px"
              />
            </div>

            <v-divider class="my-3" />

            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">Coordinate format</div>
                <div class="text-caption text-medium-emphasis">
                  Format used for coordinates in the map footer.
                </div>
              </div>
              <v-select
                v-model="coordinateFormat"
                :items="COORDINATE_FORMATS"
                density="compact"
                variant="outlined"
                rounded="sm"
                hide-details
                style="max-width: 180px"
              />
            </div>
          </div>
        </v-window-item>
        <v-window-item value="tracks">
          <div class="pa-4">
            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">Track breadcrumbs</div>
                <div class="text-caption text-medium-emphasis">
                  Show a trail of past positions behind each track.
                </div>
              </div>
              <v-switch
                v-model="trackBreadcrumbs"
                color="primary"
                density="compact"
                hide-details
                inset
              />
            </div>

            <v-divider class="my-3" />

            <div :class="{ 'text-disabled': !trackBreadcrumbs }">
              <div class="d-flex align-center mb-1">
                <div class="flex-grow-1">
                  <div class="text-body-2">Breadcrumb length</div>
                  <div class="text-caption text-medium-emphasis">
                    How far back the trail extends.
                  </div>
                </div>
                <span class="text-body-2 length-value">
                  {{ breadcrumbLengthLabel(trackBreadcrumbLength) }}
                </span>
              </div>
              <v-slider
                v-model="trackBreadcrumbLength"
                :min="5"
                :max="60"
                :step="5"
                :disabled="!trackBreadcrumbs"
                density="compact"
                hide-details
                thumb-size="14"
                track-size="2"
                color="primary"
              />
              <div class="d-flex justify-space-between text-caption text-medium-emphasis mt-1">
                <span>5s</span>
                <span>1 min</span>
              </div>
            </div>

          </div>
        </v-window-item>
      </v-window>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.settings-tabs {
  min-height: 40px;
}

.length-value {
  min-width: 48px;
  text-align: right;
}
</style>
