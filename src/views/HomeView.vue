<script setup>
import { ref, computed, nextTick, onMounted, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import { useFeaturesStore } from '@/stores/features'
import aresIcon from '@/assets/ares-icon.png'

const router = useRouter()
const featuresStore = useFeaturesStore()

const creating = ref(false)
const newName = ref('')
const busy = ref(false)
const featureCounts = ref({})
const editingId = ref(null)
const editName = ref('')
const confirmDeleteId = ref(null)
const sortBy = ref([{ key: 'updated_at', order: 'desc' }])

const newNameFieldRef = useTemplateRef('newNameField')
const editFieldRef = useTemplateRef('editField')

// Beyond this many rows, cap the table with internal scroll instead of
// letting the card grow unbounded. Tuned so 8 rows fit comfortably without
// looking sparse at low counts — at row 9 the header pins and the body
// scrolls. Bump these if we ever add denser rows or a taller card.
const ROWS_BEFORE_SCROLL = 8
const TABLE_SCROLL_HEIGHT = 380

// Column definitions live at the top so future fields (status, last
// location, linked artifacts, etc.) have an obvious place to slot in.
// `sortRaw` keeps the sort comparisons against the underlying row values
// rather than the rendered (computed) cell contents.
const headers = [
  { key: 'name', title: 'Name', sortable: true, minWidth: 160 },
  {
    key: 'overlays',
    title: 'Overlays',
    align: 'end',
    width: 100,
    sortable: true,
    sortRaw: (a, b) => featureCount(a) - featureCount(b)
  },
  { key: 'updated_at', title: 'Updated', align: 'end', width: 140, sortable: true },
  { key: 'actions', title: '', align: 'end', width: 100, sortable: false }
]

const missions = computed(() =>
  featuresStore.missions.map(m => ({
    ...m,
    overlays: featureCount(m)
  }))
)

onMounted(async () => {
  try {
    await featuresStore.loadMissions()
    featureCounts.value = await featuresStore.missionFeatureCounts()
  } catch (err) {
    console.error('Failed to load missions:', err)
  }
})

async function startCreate() {
  creating.value = true
  newName.value = ''
  await nextTick()
  newNameFieldRef.value?.focus()
}

function cancelCreate() {
  creating.value = false
  newName.value = ''
}

async function confirmCreate() {
  const name = newName.value.trim()
  if (!name || busy.value) return
  busy.value = true
  try {
    const id = await featuresStore.createMission(name)
    creating.value = false
    newName.value = ''
    router.push({ name: 'map', params: { missionId: id } })
  } catch (err) {
    console.error('Failed to create mission:', err)
  } finally {
    busy.value = false
  }
}

async function startEdit(mission) {
  editingId.value = mission.id
  editName.value = mission.name
  confirmDeleteId.value = null
  await nextTick()
  editFieldRef.value?.focus()
  editFieldRef.value?.select?.()
}

function cancelEdit() {
  editingId.value = null
  editName.value = ''
}

async function confirmEdit() {
  const id = editingId.value
  const name = editName.value.trim()
  if (!id || !name || busy.value) return
  busy.value = true
  try {
    await featuresStore.renameMission(id, name)
  } catch (err) {
    console.error('Failed to rename mission:', err)
  } finally {
    busy.value = false
    editingId.value = null
    editName.value = ''
  }
}

function askDelete(mission) {
  confirmDeleteId.value = mission.id
  editingId.value = null
}

function cancelDelete() {
  confirmDeleteId.value = null
}

async function confirmDelete() {
  const id = confirmDeleteId.value
  if (!id || busy.value) return
  busy.value = true
  try {
    await featuresStore.deleteMission(id)
    featureCounts.value = await featuresStore.missionFeatureCounts()
  } catch (err) {
    console.error('Failed to delete mission:', err)
  } finally {
    busy.value = false
    confirmDeleteId.value = null
  }
}

// Row click → open mission, but only when we're not mid-edit or mid-delete
// on that row. The inline controls stop propagation themselves; this guard
// catches any stray clicks on the row's non-interactive cells.
function onRowClick(_event, { item }) {
  if (editingId.value === item.id) return
  if (confirmDeleteId.value === item.id) return
  router.push({ name: 'map', params: { missionId: item.id } })
}

function featureCount(mission) {
  return featureCounts.value[mission.id] || 0
}

// Short, ambient timestamp for the Updated column — "Apr 12, 2026".
function formatDate(value) {
  if (!value) return ''
  const parsed = new Date(value.replace(' ', 'T') + 'Z')
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}
</script>

<template>
  <div class="home-wrapper">
    <!-- Large faded Ares mark behind everything. The PNG ships with a
         transparent background so simple opacity is all we need to make it
         read as ambient texture. Pointer events disabled so it can never
         eat clicks from the card above. -->
    <img
      :src="aresIcon"
      alt=""
      class="home-watermark"
      aria-hidden="true"
    />

    <v-container class="d-flex flex-column align-center justify-center fill-height home-content">
      <img :src="aresIcon" alt="Ares" class="home-logo mb-3" />
      <h1 class="text-h5 font-weight-light mb-6 text-medium-emphasis">ARES</h1>

      <v-card width="640" color="surface" flat rounded="sm" class="mission-card">
        <v-card-title class="d-flex align-center pa-3">
          <v-icon icon="mdi-flag-outline" size="20" class="me-2 text-medium-emphasis" />
          <span class="text-body-1">Missions</span>
          <v-spacer />
          <v-tooltip text="New mission" location="left">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                icon="mdi-plus"
                size="small"
                variant="text"
                class="text-medium-emphasis"
                :disabled="creating"
                @click="startCreate"
              />
            </template>
          </v-tooltip>
        </v-card-title>

        <v-divider />

        <div v-if="creating" class="pa-3 d-flex align-center ga-2 create-row">
          <v-text-field
            ref="newNameField"
            v-model="newName"
            density="compact"
            hide-details
            placeholder="Mission name"
            variant="outlined"
            @keyup.enter="confirmCreate"
            @keyup.escape="cancelCreate"
          />
          <v-btn
            icon="mdi-check"
            size="small"
            variant="text"
            class="text-medium-emphasis"
            :disabled="!newName.trim() || busy"
            @click="confirmCreate"
          />
          <v-btn
            icon="mdi-close"
            size="small"
            variant="text"
            class="text-medium-emphasis"
            :disabled="busy"
            @click="cancelCreate"
          />
        </div>

        <div
          v-if="!missions.length && !creating"
          class="pa-6 text-center text-medium-emphasis text-body-2"
        >
          No missions yet. Create one to get started.
        </div>

        <v-data-table
          v-else-if="missions.length"
          v-model:sort-by="sortBy"
          :headers="headers"
          :items="missions"
          :items-per-page="-1"
          :height="missions.length > ROWS_BEFORE_SCROLL ? TABLE_SCROLL_HEIGHT : undefined"
          fixed-header
          density="compact"
          hide-default-footer
          hover
          class="mission-table"
          @click:row="onRowClick"
        >
          <template #item.name="{ item }">
            <v-text-field
              v-if="editingId === item.id"
              ref="editField"
              v-model="editName"
              density="compact"
              hide-details
              variant="outlined"
              class="edit-field"
              @keyup.enter="confirmEdit"
              @keyup.escape="cancelEdit"
              @click.stop
            />
            <span v-else class="text-body-2">{{ item.name }}</span>
          </template>

          <template #item.overlays="{ item }">
            <span class="text-caption text-medium-emphasis">
              {{ featureCount(item) }}
            </span>
          </template>

          <template #item.updated_at="{ item }">
            <span class="text-caption text-medium-emphasis">
              {{ formatDate(item.updated_at) }}
            </span>
          </template>

          <template #item.actions="{ item }">
            <div
              v-if="editingId === item.id"
              class="d-flex justify-end ga-1"
            >
              <v-btn
                icon="mdi-check"
                size="small"
                variant="text"
                class="text-medium-emphasis"
                :disabled="!editName.trim() || busy"
                @click.stop="confirmEdit"
              />
              <v-btn
                icon="mdi-close"
                size="small"
                variant="text"
                class="text-medium-emphasis"
                :disabled="busy"
                @click.stop="cancelEdit"
              />
            </div>

            <div
              v-else-if="confirmDeleteId === item.id"
              class="d-flex justify-end ga-1"
            >
              <v-btn
                icon="mdi-check"
                size="small"
                variant="text"
                color="error"
                :disabled="busy"
                @click.stop="confirmDelete"
              />
              <v-btn
                icon="mdi-close"
                size="small"
                variant="text"
                class="text-medium-emphasis"
                :disabled="busy"
                @click.stop="cancelDelete"
              />
            </div>

            <div v-else class="d-flex justify-end ga-1">
              <v-tooltip text="Rename" location="left">
                <template #activator="{ props: tProps }">
                  <v-btn
                    v-bind="tProps"
                    icon="mdi-pencil-outline"
                    size="small"
                    variant="text"
                    class="text-medium-emphasis"
                    @click.stop="startEdit(item)"
                  />
                </template>
              </v-tooltip>
              <v-tooltip text="Delete" location="left">
                <template #activator="{ props: tProps }">
                  <v-btn
                    v-bind="tProps"
                    icon="mdi-trash-can-outline"
                    size="small"
                    variant="text"
                    class="text-medium-emphasis"
                    @click.stop="askDelete(item)"
                  />
                </template>
              </v-tooltip>
            </div>
          </template>
        </v-data-table>
      </v-card>
    </v-container>
  </div>
</template>

<style scoped>
.home-wrapper {
  position: relative;
  height: 100%;
  overflow: hidden;
}

/* Oversized Ares mark sitting behind the content. Large enough to bleed
   past the viewport so it reads as ambient texture, faint enough to stay
   on the right side of subtle. */
.home-watermark {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 720px;
  height: 720px;
  transform: translate(-50%, -50%);
  opacity: 0.08;
  pointer-events: none;
  user-select: none;
  object-fit: contain;
  z-index: 0;
}

/* Small Ares logo above the ARES wordmark. */
.home-logo {
  width: 64px;
  height: 64px;
  object-fit: contain;
}

.home-content {
  position: relative;
  z-index: 1;
}

.mission-card {
  border: 1px solid rgb(var(--v-theme-surface-variant));
}

.create-row {
  background: rgba(var(--v-theme-surface-variant), 0.2);
}

/* v-data-table injects its own surface color; force it transparent so the
   card background shows through and the surrounding styling stays coherent. */
.mission-table :deep(.v-table) {
  background: transparent;
}

.mission-table :deep(.v-data-table__td),
.mission-table :deep(.v-data-table__th) {
  border-bottom: 1px solid rgba(var(--v-theme-surface-variant), 0.5);
}

.mission-table :deep(tbody tr) {
  cursor: pointer;
}

/* Tight-fit rename field inside the cell — the default min-height on
   outlined text fields pushes the row height up noticeably. */
.edit-field :deep(.v-field) {
  min-height: 32px;
}
.edit-field :deep(.v-field__input) {
  min-height: 32px;
  padding-top: 0;
  padding-bottom: 0;
}
</style>
