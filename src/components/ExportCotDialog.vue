<script setup>
import { ref, computed, watch } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { exportKmlSubset } from '@/services/kml'
import { exportCotZip, exportTakDataPackage } from '@/services/cotPackage'

const props = defineProps({ modelValue: Boolean })
const emit  = defineEmits(['update:modelValue'])

const featuresStore = useFeaturesStore()

// ── State ─────────────────────────────────────────────────────────────────────

const step           = ref(1)
const selectedIds    = ref(new Set())
const selectedFormat = ref(null)
const exporting      = ref(false)

// ── Constants ─────────────────────────────────────────────────────────────────

const EXPORTABLE_TYPES = new Set(['point', 'line', 'polygon', 'box', 'circle', 'sector'])

const SHAPE_ICONS = {
  point:   'mdi-map-marker-outline',
  line:    'mdi-vector-line',
  polygon: 'mdi-vector-polygon',
  box:     'mdi-vector-square',
  circle:  'mdi-circle-outline',
  sector:  'mdi-chart-arc'
}

const FORMATS = [
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

// Reset to step 1 and pre-select all features each time the dialog opens.
watch(() => props.modelValue, open => {
  if (!open) return
  step.value           = 1
  selectedFormat.value = null
  exporting.value      = false
  selectedIds.value    = new Set(exportableFeatures.value.map(f => f.properties._dbId))
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
        <v-icon icon="mdi-export" size="18" class="me-2 text-medium-emphasis" />
        <span class="text-body-1">Export Drawings</span>
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

      <!-- Steps -->
      <v-window v-model="step">

        <!-- ── Step 1: Select features ───────────────────────────────────── -->
        <v-window-item :value="1">
          <div class="pa-3">

            <div class="d-flex align-center mb-2">
              <span class="text-body-2 text-medium-emphasis">Select features to export</span>
              <v-spacer />
              <v-btn
                size="x-small"
                variant="text"
                class="text-medium-emphasis"
                @click="toggleAll"
              >
                {{ allSelected ? 'None' : 'All' }}
              </v-btn>
            </div>

            <v-divider class="mb-1" />

            <div v-if="!exportableFeatures.length" class="py-6 text-center text-body-2 text-medium-emphasis">
              No exportable drawings in this mission.
            </div>

            <div v-else class="feature-list">
              <v-list density="compact" bg-color="transparent" class="pa-0">
                <v-list-item
                  v-for="f in exportableFeatures"
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
            </div>

            <div class="text-caption text-medium-emphasis mt-2">
              {{ selectedCount }} of {{ exportableFeatures.length }} selected
            </div>

          </div>
        </v-window-item>

        <!-- ── Step 2: Choose format ─────────────────────────────────────── -->
        <v-window-item :value="2">
          <div class="pa-3">

            <div class="text-body-2 text-medium-emphasis mb-3">
              Choose export format
            </div>

            <div class="d-flex ga-2">
              <div
                v-for="fmt in FORMATS"
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

      <!-- Actions -->
      <v-card-actions class="pa-3">
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
.feature-list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid rgba(var(--v-theme-surface-variant), 0.6);
  border-radius: 4px;
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
</style>
