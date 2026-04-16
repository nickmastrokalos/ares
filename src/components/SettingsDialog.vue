<script setup>
import { ref, computed } from 'vue'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useSettingsStore } from '@/stores/settings'
import { useTileserverStore } from '@/stores/tileserver'

const props = defineProps({
  modelValue: Boolean
})
const emit = defineEmits(['update:modelValue'])

const settingsStore   = useSettingsStore()
const tileserverStore = useTileserverStore()

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const TABS = [
  { id: 'display', label: 'Display', icon: 'mdi-monitor-eye' },
  { id: 'tracks',  label: 'Tracks',  icon: 'mdi-radar' },
  { id: 'maps',    label: 'Maps',    icon: 'mdi-map-outline' }
]
const activeTab = ref(TABS[0].id)

// ---- Display settings ----

const showFeatureLabels = computed({
  get: () => settingsStore.showFeatureLabels,
  set: (v) => settingsStore.setSetting('showFeatureLabels', v)
})

const DISTANCE_UNITS = [
  { title: 'Metric (m / km)',   value: 'metric' },
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
  { title: 'MGRS',            value: 'mgrs' }
]

const coordinateFormat = computed({
  get: () => settingsStore.coordinateFormat,
  set: (v) => settingsStore.setSetting('coordinateFormat', v)
})

const basemapOpacity = computed({
  get: () => settingsStore.basemapOpacity,
  set: (v) => settingsStore.setSetting('basemapOpacity', v)
})

function opacityLabel(v) {
  return `${Math.round(v * 100)}%`
}

// ---- Track settings ----

const trackBreadcrumbs = computed({
  get: () => settingsStore.trackBreadcrumbs,
  set: (v) => settingsStore.setSetting('trackBreadcrumbs', v)
})

const milStdSymbology = computed({
  get: () => settingsStore.milStdSymbology,
  set: (v) => settingsStore.setSetting('milStdSymbology', v)
})

const trackBreadcrumbLength = computed({
  get: () => settingsStore.trackBreadcrumbLength,
  set: (v) => settingsStore.setSetting('trackBreadcrumbLength', v)
})

function breadcrumbLengthLabel(secs) {
  return secs === 60 ? '1 min' : `${secs}s`
}

// ---- Offline maps ----

const addingPath = ref(false)

async function pickFolder() {
  addingPath.value = true
  try {
    const selected = await openDialog({ directory: true, multiple: false })
    if (selected) await tileserverStore.addPath(selected)
  } finally {
    addingPath.value = false
  }
}

// Group tilesets by their parent path for display
function tilesetsForPath(path) {
  return tileserverStore.tilesets.filter(ts => ts.path.startsWith(path))
}

function formatBadge(ts) {
  return ts.format.toUpperCase()
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

        <!-- ---- Display ---- -->
        <v-window-item value="display">
          <div class="pa-4">
            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">Show labels on map</div>
                <div class="text-caption text-medium-emphasis">
                  Render name labels for shapes, routes, tracks, and AIS vessels.
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

            <div>
              <div class="d-flex align-center mb-1">
                <div class="flex-grow-1">
                  <div class="text-body-2">Basemap dimming</div>
                  <div class="text-caption text-medium-emphasis">
                    Fade the basemap to make tracks and overlays stand out.
                  </div>
                </div>
                <span class="text-body-2 length-value">
                  {{ opacityLabel(basemapOpacity) }}
                </span>
              </div>
              <v-slider
                v-model="basemapOpacity"
                :min="0"
                :max="1"
                :step="0.05"
                density="compact"
                hide-details
                thumb-size="14"
                track-size="2"
                color="primary"
              />
              <div class="d-flex justify-space-between text-caption text-medium-emphasis mt-1">
                <span>Off</span>
                <span>Full</span>
              </div>
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

        <!-- ---- Tracks ---- -->
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

            <v-divider class="my-3" />

            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">MIL-STD-2525 symbology</div>
                <div class="text-caption text-medium-emphasis">
                  Replace track dots with military symbology icons based on CoT type.
                </div>
              </div>
              <v-switch
                v-model="milStdSymbology"
                color="primary"
                density="compact"
                hide-details
                inset
              />
            </div>
          </div>
        </v-window-item>

        <!-- ---- Maps ---- -->
        <v-window-item value="maps">
          <div class="pa-4">

            <div class="d-flex align-center justify-space-between mb-3">
              <div>
                <div class="text-body-2">Offline tile paths</div>
                <div class="text-caption text-medium-emphasis">
                  Folders containing .mbtiles files served on 127.0.0.1:3650.
                </div>
              </div>
              <v-btn
                size="small"
                variant="tonal"
                prepend-icon="mdi-folder-plus-outline"
                :loading="addingPath"
                @click="pickFolder"
              >
                Add folder
              </v-btn>
            </div>

            <!-- Empty state -->
            <div
              v-if="tileserverStore.paths.length === 0"
              class="empty-paths text-caption text-medium-emphasis"
            >
              No paths configured. Add a folder containing .mbtiles files.
            </div>

            <!-- Path list -->
            <div
              v-for="path in tileserverStore.paths"
              :key="path"
              class="path-block"
            >
              <div class="path-row">
                <v-icon size="14" class="text-medium-emphasis flex-shrink-0">mdi-folder-outline</v-icon>
                <span class="path-text text-caption">{{ path }}</span>
                <v-btn
                  icon="mdi-close"
                  size="x-small"
                  variant="text"
                  class="text-medium-emphasis flex-shrink-0"
                  @click="tileserverStore.removePath(path)"
                />
              </div>

              <!-- Tilesets found in this path -->
              <div class="tileset-list">
                <div
                  v-if="tilesetsForPath(path).length === 0"
                  class="text-caption text-disabled ps-5 pb-1"
                >
                  No .mbtiles files found
                </div>
                <div
                  v-for="ts in tilesetsForPath(path)"
                  :key="ts.name"
                  class="tileset-row"
                >
                  <v-icon size="12" class="text-medium-emphasis">mdi-map-outline</v-icon>
                  <span class="text-caption">{{ ts.display_name }}</span>
                  <span class="format-badge">{{ formatBadge(ts) }}</span>
                  <span class="text-caption text-disabled zoom-range">
                    z{{ ts.minzoom }}–{{ ts.maxzoom }}
                  </span>
                </div>
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

/* ---- Offline maps tab ---- */

.empty-paths {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.15);
  border-radius: 4px;
  padding: 16px;
  text-align: center;
}

.path-block {
  margin-bottom: 8px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
}

.path-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 8px;
  background: rgba(var(--v-theme-surface-variant), 0.3);
}

.path-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
  opacity: 0.7;
}

.tileset-list {
  padding: 4px 8px 6px 8px;
}

.tileset-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.format-badge {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: rgba(var(--v-theme-on-surface), 0.45);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.2);
  border-radius: 2px;
  padding: 0 3px;
  line-height: 14px;
}

.zoom-range {
  margin-left: auto;
}
</style>
