<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useScenesStore } from '@/stores/scenes'
import { useAssistantTools } from '@/composables/useAssistantTools'
import { scenesTools } from '@/services/assistant/tools/scenes'

const router = useRouter()
const scenesStore = useScenesStore()
useAssistantTools(() => scenesTools({ scenesStore }), 'Scenes assistant')

const newSceneDialog = ref(false)
const newSceneLabel = ref('')
const creating = ref(false)

onMounted(() => scenesStore.loadScenes())

async function openScene(id) {
  router.push({ name: 'scene', params: { sceneId: id } })
}

async function createScene() {
  const label = newSceneLabel.value.trim()
  if (!label) return
  creating.value = true
  try {
    await scenesStore.createScene({ label })
    newSceneDialog.value = false
    newSceneLabel.value = ''
  } finally {
    creating.value = false
  }
}

function cancelCreate() {
  newSceneDialog.value = false
  newSceneLabel.value = ''
}
</script>

<template>
  <div class="scenes-view">

    <!-- Header -->
    <div class="scenes-header">
      <div class="d-flex align-center ga-2">
        <v-icon size="20" class="text-medium-emphasis">mdi-view-dashboard-outline</v-icon>
        <span class="text-body-2 font-weight-medium">My Scenes</span>
      </div>
      <v-btn
        size="small"
        variant="tonal"
        color="primary"
        prepend-icon="mdi-plus"
        @click="newSceneDialog = true"
      >
        New scene
      </v-btn>
    </div>

    <!-- Scene list -->
    <div class="scenes-list">
      <div
        v-for="scene in scenesStore.scenes"
        :key="scene.id"
        class="scene-row"
        @click="openScene(scene.id)"
      >
        <v-icon size="18" class="text-medium-emphasis flex-shrink-0">
          {{ scene.icon || 'mdi-view-dashboard-outline' }}
        </v-icon>
        <div class="scene-row__label">{{ scene.label }}</div>
        <v-icon size="16" class="text-disabled">mdi-chevron-right</v-icon>
      </div>

      <!-- Empty state -->
      <div v-if="!scenesStore.scenes.length" class="scenes-empty">
        <v-icon size="36" class="text-disabled mb-2">mdi-view-dashboard-outline</v-icon>
        <div class="text-body-2 text-medium-emphasis">No scenes yet</div>
        <div class="text-caption text-disabled mt-1">Create a scene to compose a custom dashboard.</div>
      </div>
    </div>

    <!-- New scene dialog -->
    <v-dialog v-model="newSceneDialog" max-width="360" @keydown.esc="cancelCreate">
      <v-card>
        <v-card-title class="text-body-1 font-weight-medium pa-4 pb-2">New scene</v-card-title>
        <v-card-text class="pa-4 pt-0">
          <v-text-field
            v-model="newSceneLabel"
            label="Scene name"
            variant="outlined"
            density="compact"
            autofocus
            hide-details
            @keydown.enter="createScene"
          />
        </v-card-text>
        <v-card-actions class="pa-4 pt-0 ga-2">
          <v-spacer />
          <v-btn variant="text" size="small" :disabled="creating" @click="cancelCreate">Cancel</v-btn>
          <v-btn
            variant="tonal"
            color="primary"
            size="small"
            :loading="creating"
            :disabled="!newSceneLabel.trim()"
            @click="createScene"
          >
            Create
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

  </div>
</template>

<style scoped>
.scenes-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgb(var(--v-theme-background));
}

.scenes-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  flex-shrink: 0;
}

.scenes-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.scene-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.15s;
}

.scene-row:hover {
  background: rgba(var(--v-theme-on-surface), 0.05);
}

.scene-row__label {
  flex: 1;
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scenes-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  text-align: center;
  padding: 32px;
}
</style>
