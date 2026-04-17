<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useScenesStore } from '@/stores/scenes'
import { useSceneDataStore } from '@/stores/sceneData'
import SceneCanvas from '@/components/scenes/SceneCanvas.vue'
import ScenePicker from '@/components/scenes/ScenePicker.vue'
import { useAssistantTools } from '@/composables/useAssistantTools'
import { scenesTools } from '@/services/assistant/tools/scenes'

const props = defineProps({
  sceneId: { type: String, required: true },
})

const router = useRouter()
const scenesStore = useScenesStore()
const sceneDataStore = useSceneDataStore()
useAssistantTools(() => scenesTools({ scenesStore }), 'Scenes assistant')

const canvasRef = ref(null)
const pickerOpen = ref(false)
const editingTitle = ref(false)
const titleInput = ref('')
const deleteDialog = ref(false)
const deleting = ref(false)

const scene = computed(() => scenesStore.getById(props.sceneId))
const cards = computed(() => scene.value?.cards ?? [])

onMounted(async () => {
  if (!scenesStore.scenes.length) await scenesStore.loadScenes()
  await sceneDataStore.init()
})

onUnmounted(() => {
  // Don't teardown the store globally — other editor instances may be active.
  // Teardown is only safe when there are no subscribers, which the store
  // manages internally via the poll timer.
})

function onCardsUpdate(next) {
  if (!scene.value) return
  const idx = scenesStore.scenes.findIndex(s => s.id === props.sceneId)
  if (idx !== -1) scenesStore.scenes[idx] = { ...scenesStore.scenes[idx], cards: next }
}

function onCommit() {
  if (!scene.value) return
  scenesStore.saveSceneCards(props.sceneId, scene.value.cards)
}

function startEditTitle() {
  titleInput.value = scene.value?.label ?? ''
  editingTitle.value = true
}

async function saveTitle() {
  const label = titleInput.value.trim()
  if (label && label !== scene.value?.label) {
    await scenesStore.updateScene(props.sceneId, { label })
  }
  editingTitle.value = false
}

function cancelEditTitle() {
  editingTitle.value = false
}

async function confirmDelete() {
  deleting.value = true
  try {
    await scenesStore.deleteScene(props.sceneId)
    router.push({ name: 'scenes' })
  } finally {
    deleting.value = false
    deleteDialog.value = false
  }
}

function onCardPicked(cardType) {
  canvasRef.value?.addCard(cardType)
}
</script>

<template>
  <div class="scene-editor">

    <!-- Toolbar -->
    <div class="scene-editor__toolbar">
      <v-btn
        icon="mdi-arrow-left"
        size="small"
        variant="text"
        class="text-medium-emphasis"
        :to="{ name: 'scenes' }"
      />

      <!-- Title -->
      <div class="scene-editor__title-area">
        <template v-if="editingTitle">
          <v-text-field
            v-model="titleInput"
            density="compact"
            variant="outlined"
            hide-details
            autofocus
            class="scene-editor__title-input"
            @blur="saveTitle"
            @keydown.enter="saveTitle"
            @keydown.esc="cancelEditTitle"
          />
        </template>
        <template v-else>
          <span
            class="scene-editor__title-text"
            :title="scene?.label"
            @click="startEditTitle"
          >{{ scene?.label || 'Untitled scene' }}</span>
        </template>
      </div>

      <!-- Add card -->
      <v-menu v-model="pickerOpen" location="bottom end" :close-on-content-click="false">
        <template #activator="{ props: menuProps }">
          <v-btn
            v-bind="menuProps"
            size="small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-plus"
          >
            Add card
          </v-btn>
        </template>
        <ScenePicker @pick="onCardPicked" @close="pickerOpen = false" />
      </v-menu>

      <!-- Delete -->
      <v-btn
        icon="mdi-delete-outline"
        size="small"
        variant="text"
        class="text-medium-emphasis"
        @click="deleteDialog = true"
      />
    </div>

    <!-- Canvas area -->
    <div class="scene-editor__canvas-area">
      <div v-if="!scene" class="scene-editor__not-found">
        <v-icon size="36" class="text-disabled mb-2">mdi-alert-circle-outline</v-icon>
        <div class="text-body-2 text-medium-emphasis">Scene not found</div>
      </div>
      <SceneCanvas
        v-else
        ref="canvasRef"
        :cards="cards"
        @update:cards="onCardsUpdate"
        @commit="onCommit"
      />
    </div>

    <!-- Delete confirmation -->
    <v-dialog v-model="deleteDialog" max-width="320">
      <v-card>
        <v-card-title class="text-body-1 font-weight-medium pa-4 pb-2">Delete scene?</v-card-title>
        <v-card-text class="pa-4 pt-0 text-body-2 text-medium-emphasis">
          "{{ scene?.label }}" and all its cards will be permanently removed.
        </v-card-text>
        <v-card-actions class="pa-4 pt-0 ga-2">
          <v-spacer />
          <v-btn variant="text" size="small" :disabled="deleting" @click="deleteDialog = false">Cancel</v-btn>
          <v-btn variant="tonal" color="error" size="small" :loading="deleting" @click="confirmDelete">Delete</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

  </div>
</template>

<style scoped>
.scene-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgb(var(--v-theme-background));
}

.scene-editor__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  flex-shrink: 0;
}

.scene-editor__title-area {
  flex: 1;
  min-width: 0;
}

.scene-editor__title-text {
  font-size: 0.875rem;
  font-weight: 500;
  cursor: text;
  padding: 2px 4px;
  border-radius: 4px;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scene-editor__title-text:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.scene-editor__title-input {
  max-width: 280px;
}

.scene-editor__canvas-area {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px;
}

.scene-editor__not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
}
</style>
