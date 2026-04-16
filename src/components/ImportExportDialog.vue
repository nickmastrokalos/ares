<script setup>
import { ref, computed, watch } from 'vue'
import { open } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import JSZip from 'jszip'
import { useFeaturesStore } from '@/stores/features'
import { importCotFeatures } from '@/services/cot'
import { importKml, exportKmlSubset } from '@/services/kml'
import { importGeoJson } from '@/services/geojson'
import { exportCotZip, exportTakDataPackage } from '@/services/cotPackage'

const props = defineProps({ modelValue: Boolean })
const emit  = defineEmits(['update:modelValue'])

const featuresStore = useFeaturesStore()

// ── State ─────────────────────────────────────────────────────────────────────

const mode           = ref('export')   // 'import' | 'export'
const step           = ref(1)
const selectedIds    = ref(new Set())
const selectedFormat = ref(null)
const exporting      = ref(false)
const importing      = ref(false)
const importError    = ref(null)
const filterQuery    = ref('')

// ── Constants ─────────────────────────────────────────────────────────────────

const EXPORTABLE_TYPES = new Set(['point', 'line', 'polygon', 'box', 'circle', 'sector', 'ellipse', 'route'])

const SHAPE_ICONS = {
  point:   'mdi-map-marker-outline',
  line:    'mdi-vector-line',
  polygon: 'mdi-vector-polygon',
  box:     'mdi-vector-square',
  circle:  'mdi-circle-outline',
  sector:  'mdi-chart-arc',
  ellipse: 'mdi-ellipse-outline',
  route:   'mdi-routes'
}

const EXPORT_SECTION_DEFS = [
  { label: 'Shapes', types: new Set(['point', 'line', 'polygon', 'box', 'circle', 'ellipse', 'sector']) },
  { label: 'Routes', types: new Set(['route']) },
]

const IMPORT_FORMATS = [
  {
    id:          'cot-xml',
    label:       'CoT XML',
    icon:        'mdi-xml',
    description: 'Cursor on Target XML (.xml)'
  },
  {
    id:          'tak-package',
    label:       'TAK Package',
    icon:        'mdi-package-variant-closed',
    description: 'ATAK / WinTAK data package (.zip)'
  },
  {
    id:          'kml',
    label:       'KML / KMZ',
    icon:        'mdi-earth',
    description: 'Google Earth / GIS format (.kml, .kmz)'
  },
  {
    id:          'geojson',
    label:       'GeoJSON',
    icon:        'mdi-code-json',
    description: 'Geographic JSON (.geojson, .json)'
  }
]

const EXPORT_FORMATS = [
  {
    id:          'kml',
    label:       'KML',
    icon:        'mdi-earth',
    description: 'Keyhole Markup Language — opens in Google Earth, QGIS, and most GIS tools.'
  },
  {
    id:          'cot-zip',
    label:       'CoT ZIP',
    icon:        'mdi-folder-zip-outline',
    description: 'One .cot XML file per feature, bundled into a ZIP archive.'
  },
  {
    id:          'tak-package',
    label:       'TAK Data Package',
    icon:        'mdi-package-variant-closed',
    description: 'ATAK / WinTAK data package with MANIFEST. Import directly into TAK clients.'
  }
]

// ── Derived ───────────────────────────────────────────────────────────────────

const exportableFeatures = computed(() =>
  featuresStore.featureCollection.features.filter(
    f => EXPORTABLE_TYPES.has(f.properties._type)
  )
)

const filteredExportable = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  if (!q) return exportableFeatures.value
  return exportableFeatures.value.filter(f => {
    const name = (f.properties.name || f.properties._type).toLowerCase()
    return name.includes(q) || f.properties._type.toLowerCase().includes(q)
  })
})

const exportSections = computed(() =>
  EXPORT_SECTION_DEFS
    .map(g => ({ label: g.label, items: filteredExportable.value.filter(f => g.types.has(f.properties._type)) }))
    .filter(g => g.items.length > 0)
)

const selectedCount = computed(() => selectedIds.value.size)

const allSelected = computed(
  () => exportableFeatures.value.length > 0 &&
        selectedCount.value === exportableFeatures.value.length
)

const selectedFeatures = computed(() =>
  exportableFeatures.value.filter(f => selectedIds.value.has(f.properties._dbId))
)

const canNext   = computed(() => selectedCount.value > 0)
const canExport = computed(() => !!selectedFormat.value && !exporting.value)

// ── Lifecycle ─────────────────────────────────────────────────────────────────

watch(() => props.modelValue, open => {
  if (!open) return
  mode.value           = 'export'
  step.value           = 1
  selectedFormat.value = null
  exporting.value      = false
  importing.value      = false
  importError.value    = null
  filterQuery.value    = ''
  selectedIds.value    = new Set(exportableFeatures.value.map(f => f.properties._dbId))
})

watch(mode, () => {
  step.value           = 1
  selectedFormat.value = null
  importError.value    = null
})

// ── Actions ───────────────────────────────────────────────────────────────────

function close() {
  emit('update:modelValue', false)
}

function toggleAll() {
  selectedIds.value = allSelected.value
    ? new Set()
    : new Set(exportableFeatures.value.map(f => f.properties._dbId))
}

function toggleFeature(id) {
  const s = new Set(selectedIds.value)
  s.has(id) ? s.delete(id) : s.add(id)
  selectedIds.value = s
}

async function doImport(fmt) {
  if (importing.value) return
  importError.value = null

  // For CoT and TAK Package we own the file dialog; for kml/geojson the
  // service function handles it internally.
  let filePath = null
  if (fmt.id === 'cot-xml') {
    filePath = await open({ multiple: false, filters: [{ name: 'CoT XML', extensions: ['xml'] }] })
    if (!filePath) return
  } else if (fmt.id === 'tak-package') {
    filePath = await open({ multiple: false, filters: [{ name: 'TAK Data Package', extensions: ['zip'] }] })
    if (!filePath) return
  }

  importing.value = true
  try {
    if (fmt.id === 'cot-xml') {
      const bytes    = await readFile(filePath)
      const xml      = new TextDecoder().decode(bytes)
      const features = importCotFeatures(xml)
      for (const { type, geometry, properties } of features) {
        await featuresStore.addFeature(type, geometry, properties)
      }
    } else if (fmt.id === 'tak-package') {
      const bytes    = await readFile(filePath)
      const zip      = await JSZip.loadAsync(bytes)
      const cotFiles = Object.keys(zip.files).filter(
        n => n.endsWith('.cot') && !zip.files[n].dir
      )
      for (const name of cotFiles) {
        const xml      = await zip.files[name].async('string')
        const features = importCotFeatures(xml)
        for (const { type, geometry, properties } of features) {
          await featuresStore.addFeature(type, geometry, properties)
        }
      }
    } else if (fmt.id === 'kml') {
      await importKml(featuresStore)
    } else if (fmt.id === 'geojson') {
      await importGeoJson(featuresStore)
    }
    close()
  } catch (err) {
    console.error('Import failed:', err)
    importError.value = err.message ?? 'Import failed.'
  } finally {
    importing.value = false
  }
}

async function doExport() {
  if (!canExport.value) return
  exporting.value = true

  const missionName = (featuresStore.activeMission?.name ?? 'mission')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
  const displayName = featuresStore.activeMission?.name ?? 'Mission'

  try {
    if (selectedFormat.value === 'kml') {
      await exportKmlSubset(selectedFeatures.value, displayName)
    } else if (selectedFormat.value === 'cot-zip') {
      await exportCotZip(selectedFeatures.value, missionName)
    } else if (selectedFormat.value === 'tak-package') {
      await exportTakDataPackage(selectedFeatures.value, missionName)
    }
    close()
  } catch (err) {
    console.error('Export failed:', err)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    width="520"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card color="surface" rounded="sm" flat>

      <!-- Header -->
      <v-card-title class="d-flex align-center pa-3">
        <v-icon icon="mdi-swap-vertical" size="18" class="me-2 text-medium-emphasis" />
        <span class="text-body-1">Import / Export</span>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          class="text-medium-emphasis"
          @click="close"
        />
      </v-card-title>

      <v-divider />

      <!-- Mode toggle -->
      <div class="mode-toggle px-3 py-2">
        <v-btn-toggle
          v-model="mode"
          density="compact"
          variant="outlined"
          color="primary"
          mandatory
        >
          <v-btn value="import" size="small">Import</v-btn>
          <v-btn value="export" size="small">Export</v-btn>
        </v-btn-toggle>
      </div>

      <v-divider />

      <!-- ── Import ──────────────────────────────────────────────────────────── -->
      <div v-if="mode === 'import'" class="pa-3">

        <div class="text-body-2 text-medium-emphasis mb-3">
          Choose a format to import
        </div>

        <div class="import-grid">
          <div
            v-for="fmt in IMPORT_FORMATS"
            :key="fmt.id"
            class="format-card"
            :class="{ 'format-card--loading': importing }"
            @click="doImport(fmt)"
          >
            <v-icon
              :icon="fmt.icon"
              size="28"
              class="mb-2 text-medium-emphasis"
            />
            <div class="text-body-2 font-weight-medium mb-1">{{ fmt.label }}</div>
            <div class="text-caption text-medium-emphasis">{{ fmt.description }}</div>
          </div>
        </div>

        <div v-if="importError" class="mt-3 text-caption text-error">
          {{ importError }}
        </div>

      </div>

      <!-- ── Export ─────────────────────────────────────────────────────────── -->
      <v-window v-else v-model="step">

        <!-- Step 1: Select features -->
        <v-window-item :value="1">
          <div class="pa-3">

            <div v-if="!exportableFeatures.length" class="py-6 text-center text-body-2 text-medium-emphasis">
              No exportable drawings in this mission.
            </div>

            <template v-else>
              <!-- Filter + All/None -->
              <div class="d-flex align-center ga-2 mb-2">
                <v-text-field
                  v-model="filterQuery"
                  density="compact"
                  variant="outlined"
                  placeholder="Filter…"
                  prepend-inner-icon="mdi-magnify"
                  clearable
                  hide-details
                  class="filter-field"
                />
                <v-btn
                  size="x-small"
                  variant="text"
                  class="text-medium-emphasis flex-shrink-0"
                  @click="toggleAll"
                >
                  {{ allSelected ? 'None' : 'All' }}
                </v-btn>
              </div>

              <div class="feature-list">
                <template v-if="exportSections.length">
                  <template v-for="(section, si) in exportSections" :key="section.label">
                    <div :class="['section-header', { 'section-header--first': si === 0 }]">
                      {{ section.label }}
                    </div>
                    <v-list density="compact" bg-color="transparent" class="pa-0">
                      <v-list-item
                        v-for="f in section.items"
                        :key="f.properties._dbId"
                        :prepend-icon="SHAPE_ICONS[f.properties._type] ?? 'mdi-shape-outline'"
                        class="feature-row px-2"
                        @click="toggleFeature(f.properties._dbId)"
                      >
                        <v-list-item-title class="text-body-2">
                          {{ f.properties.name || f.properties._type }}
                        </v-list-item-title>
                        <v-list-item-subtitle class="text-caption">
                          {{ f.properties._type }}
                        </v-list-item-subtitle>
                        <template #append>
                          <v-checkbox-btn
                            :model-value="selectedIds.has(f.properties._dbId)"
                            density="compact"
                            @click.stop="toggleFeature(f.properties._dbId)"
                          />
                        </template>
                      </v-list-item>
                    </v-list>
                  </template>
                </template>

                <div v-else class="py-4 text-center text-caption text-medium-emphasis">
                  No results.
                </div>
              </div>

              <div class="text-caption text-medium-emphasis mt-2">
                {{ selectedCount }} of {{ exportableFeatures.length }} selected
              </div>
            </template>

          </div>
        </v-window-item>

        <!-- Step 2: Choose format -->
        <v-window-item :value="2">
          <div class="pa-3">

            <div class="text-body-2 text-medium-emphasis mb-3">
              Choose export format
            </div>

            <div class="d-flex ga-2">
              <div
                v-for="fmt in EXPORT_FORMATS"
                :key="fmt.id"
                class="format-card flex-1"
                :class="{ 'format-card--selected': selectedFormat === fmt.id }"
                @click="selectedFormat = fmt.id"
              >
                <v-icon
                  :icon="fmt.icon"
                  size="28"
                  class="mb-2"
                  :color="selectedFormat === fmt.id ? 'primary' : undefined"
                />
                <div class="text-body-2 font-weight-medium mb-1">{{ fmt.label }}</div>
                <div class="text-caption text-medium-emphasis">{{ fmt.description }}</div>
              </div>
            </div>

          </div>
        </v-window-item>

      </v-window>

      <v-divider />

      <!-- Actions (export only) -->
      <v-card-actions v-if="mode === 'export'" class="pa-3">
        <v-btn
          v-if="step === 2"
          variant="text"
          size="small"
          class="text-medium-emphasis"
          prepend-icon="mdi-arrow-left"
          @click="step = 1"
        >
          Back
        </v-btn>

        <v-spacer />

        <v-btn
          v-if="step === 1"
          variant="text"
          size="small"
          :disabled="!canNext"
          append-icon="mdi-arrow-right"
          @click="step = 2"
        >
          Next
        </v-btn>

        <v-btn
          v-else
          variant="text"
          size="small"
          :disabled="!canExport"
          :loading="exporting"
          append-icon="mdi-export"
          @click="doExport"
        >
          Export
        </v-btn>
      </v-card-actions>

    </v-card>
  </v-dialog>
</template>

<style scoped>
.mode-toggle {
  display: flex;
  align-items: center;
}

.import-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.filter-field {
  flex: 1;
}

.feature-list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid rgba(var(--v-theme-surface-variant), 0.6);
  border-radius: 4px;
}

.section-header {
  padding: 6px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.45);
  border-top: 1px solid rgba(var(--v-theme-surface-variant), 0.5);
}

.section-header--first {
  border-top: none;
}

.feature-row {
  cursor: pointer;
  border-bottom: 1px solid rgba(var(--v-theme-surface-variant), 0.3);
}

.feature-row:last-child {
  border-bottom: none;
}

.format-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 16px 12px;
  border: 1px solid rgba(var(--v-theme-surface-variant), 0.6);
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s;
}

.format-card:hover {
  background: rgba(var(--v-theme-surface-variant), 0.2);
}

.format-card--selected {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.08);
}

.format-card--loading {
  opacity: 0.6;
  pointer-events: none;
}
</style>
