<script setup>
import { ref, computed, watch, inject } from 'vue'
import { useFeaturesStore } from '@/stores/features'

const props = defineProps({
  modelValue: Boolean
})
const emit = defineEmits(['update:modelValue'])

const featuresStore = useFeaturesStore()
// Provided by MapView; missing if this dialog is ever mounted outside that
// tree, in which case we just hide the fly-to button.
const flyToGeometry = inject('flyToGeometry', null)

// Non-reactive copy of the features list taken on open. We intentionally
// don't react to mutations mid-session: selections would jump around as rows
// reshuffled. Reopening the dialog refreshes the snapshot.
const items = ref([])
const selected = ref([])
const deleting = ref(false)

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const allSelected = computed({
  get: () => items.value.length > 0 && selected.value.length === items.value.length,
  set: (v) => {
    selected.value = v ? items.value.map(i => i.id) : []
  }
})

const someSelected = computed(
  () => selected.value.length > 0 && !allSelected.value
)

// Refresh snapshot + clear selection whenever the dialog opens. The store's
// `features` is already scoped to the active mission so a shallow copy is
// all we need.
watch(open, (isOpen) => {
  if (!isOpen) return
  selected.value = []
  items.value = featuresStore.features.slice()
})

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
  // Close so the user can actually see the map they're flying to.
  open.value = false
}

// Row view-model helpers. Titles prefer the user-given name; subtitles show
// the geometry type as a secondary cue. Everything listed belongs to the
// active mission, so there's no need to label the mission per-row.
function displayName(row) {
  return parsedName(row) || typeLabel(row.type)
}

function displaySubtitle(row) {
  // If the title already fell back to the type, don't repeat it.
  return parsedName(row) ? typeLabel(row.type) : ''
}

function parsedName(row) {
  try {
    const props = JSON.parse(row.properties)
    const name = props?.name?.trim()
    return name || null
  } catch {
    return null
  }
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
        <div class="px-3 py-2 d-flex align-center">
          <v-checkbox-btn
            v-model="allSelected"
            :indeterminate="someSelected"
            density="compact"
            hide-details
          />
          <span class="text-caption text-medium-emphasis ms-1">Select all</span>
        </div>

        <v-divider />

        <v-list density="compact" bg-color="transparent" class="py-0 overlay-list">
          <v-list-item
            v-for="item in items"
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
</style>
