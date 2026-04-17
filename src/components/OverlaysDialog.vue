<script setup>
import { ref, computed, watch, inject } from 'vue'
import { useFeaturesStore } from '@/stores/features'

const props = defineProps({
  modelValue: Boolean
})
const emit = defineEmits(['update:modelValue'])

const featuresStore = useFeaturesStore()
const flyToGeometry = inject('flyToGeometry', null)

const items       = ref([])
const selected    = ref([])
const deleting    = ref(false)
const filterQuery = ref('')

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

// ── Sections ──────────────────────────────────────────────────────────────────

const SECTION_DEFS = [
  { label: 'Shapes', types: new Set(['point', 'line', 'polygon', 'box', 'circle', 'ellipse', 'sector', 'image']) },
  { label: 'Routes', types: new Set(['route']) },
]

const filteredItems = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter(item => {
    const name = displayName(item).toLowerCase()
    return name.includes(q) || item.type.toLowerCase().includes(q)
  })
})

const sections = computed(() =>
  SECTION_DEFS
    .map(g => ({ label: g.label, items: filteredItems.value.filter(i => g.types.has(i.type)) }))
    .filter(g => g.items.length > 0)
)

// ── Selection ─────────────────────────────────────────────────────────────────

const allSelected = computed({
  get: () => items.value.length > 0 && selected.value.length === items.value.length,
  set: (v) => { selected.value = v ? items.value.map(i => i.id) : [] }
})

const someSelected = computed(
  () => selected.value.length > 0 && !allSelected.value
)

// ── Lifecycle ─────────────────────────────────────────────────────────────────

watch(open, (isOpen) => {
  if (!isOpen) return
  selected.value    = []
  filterQuery.value = ''
  // Pre-parse properties once on open so display helpers don't re-parse
  // on every render / filter keystroke. Manual tracks are managed via the
  // dedicated track list, not this overlay manager.
  items.value = featuresStore.features
    .filter(row => row.type !== 'manual-track')
    .map(row => {
      let parsedProps = {}
      try { parsedProps = JSON.parse(row.properties) } catch {}
      return { ...row, parsedProps }
    })
})

// ── Actions ───────────────────────────────────────────────────────────────────

async function handleDelete() {
  if (!selected.value.length) return
  deleting.value = true
  try {
    await featuresStore.removeFeatures(selected.value)
  } finally {
    deleting.value = false
  }
  open.value = false
}

function handleFlyTo(item) {
  if (!flyToGeometry || !item.geometry) return
  try {
    flyToGeometry(JSON.parse(item.geometry))
  } catch (err) {
    console.error('Failed to fly to overlay:', err)
    return
  }
  open.value = false
}

// ── Display helpers ───────────────────────────────────────────────────────────

function displayName(row) {
  return parsedName(row) || typeLabel(row.type)
}

function displaySubtitle(row) {
  return parsedName(row) ? typeLabel(row.type) : ''
}

function parsedName(row) {
  const name = row.parsedProps?.name?.trim()
  return name || null
}

function typeLabel(type) {
  if (!type) return 'Overlay'
  return type.charAt(0).toUpperCase() + type.slice(1)
}
</script>

<template>
  <v-dialog v-model="open" max-width="520">
    <v-card color="surface" rounded="sm" flat>
      <v-card-title class="d-flex align-center pa-3">
        <v-icon icon="mdi-shape-outline" size="20" class="me-2 text-medium-emphasis" />
        <span class="text-body-1">Manage Overlays</span>
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

      <div v-if="!items.length" class="pa-4 text-center text-medium-emphasis">
        No overlays yet.
      </div>

      <template v-else>
        <!-- Filter + select-all row -->
        <div class="px-3 pt-2 pb-1 d-flex align-center ga-2">
          <v-checkbox-btn
            v-model="allSelected"
            :indeterminate="someSelected"
            density="compact"
            hide-details
          />
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
        </div>

        <v-divider />

        <div class="overlay-list">
          <template v-if="sections.length">
            <template v-for="(section, si) in sections" :key="section.label">
              <div :class="['section-header', { 'section-header--first': si === 0 }]">
                {{ section.label }}
              </div>
              <v-list density="compact" bg-color="transparent" class="py-0">
                <v-list-item
                  v-for="item in section.items"
                  :key="item.id"
                  class="px-3"
                >
                  <template #prepend>
                    <v-checkbox-btn
                      v-model="selected"
                      :value="item.id"
                      density="compact"
                      hide-details
                    />
                  </template>
                  <v-list-item-title class="text-body-2">
                    {{ displayName(item) }}
                  </v-list-item-title>
                  <v-list-item-subtitle v-if="displaySubtitle(item)" class="text-caption">
                    {{ displaySubtitle(item) }}
                  </v-list-item-subtitle>
                  <template v-if="flyToGeometry" #append>
                    <v-tooltip text="Fly to" location="left">
                      <template #activator="{ props: tProps }">
                        <v-btn
                          v-bind="tProps"
                          icon="mdi-crosshairs-gps"
                          size="small"
                          variant="text"
                          class="text-medium-emphasis"
                          @click.stop="handleFlyTo(item)"
                        />
                      </template>
                    </v-tooltip>
                  </template>
                </v-list-item>
              </v-list>
            </template>
          </template>

          <div v-else class="py-4 text-center text-caption text-medium-emphasis">
            No results.
          </div>
        </div>
      </template>

      <v-divider />

      <v-card-actions class="pa-2">
        <v-spacer />
        <v-btn
          variant="text"
          size="small"
          class="text-medium-emphasis"
          @click="open = false"
        >Cancel</v-btn>
        <v-btn
          variant="text"
          size="small"
          color="error"
          :disabled="!selected.length || deleting"
          :loading="deleting"
          prepend-icon="mdi-trash-can-outline"
          @click="handleDelete"
        >
          Delete<span v-if="selected.length"> ({{ selected.length }})</span>
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.overlay-list {
  max-height: 360px;
  overflow-y: auto;
}

.filter-field {
  flex: 1;
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
</style>
