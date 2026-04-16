<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { useDraggable } from '@/composables/useDraggable'

const emit = defineEmits(['tool-select'])

const activeTool = ref(null)
const panelRef = ref(null)
const { pos, onPointerDown } = useDraggable({ x: 12, y: 12 })

onMounted(async () => {
  await nextTick()
  const parent = panelRef.value?.parentElement
  if (!parent || !panelRef.value) return
  const panelHeight = panelRef.value.offsetHeight
  const parentHeight = parent.clientHeight
  pos.value = {
    x: 12,
    y: Math.max(12, Math.round((parentHeight - panelHeight) / 2))
  }
})

const tools = [
  { id: 'point', icon: 'mdi-map-marker-outline', tooltip: 'Point' },
  { id: 'line', icon: 'mdi-vector-line', tooltip: 'Line' },
  { id: 'polygon', icon: 'mdi-vector-polygon', tooltip: 'Polygon' },
  { id: 'box', icon: 'mdi-vector-square', tooltip: 'Box' },
  { id: 'circle', icon: 'mdi-circle-outline', tooltip: 'Circle' },
  { id: 'ellipse', icon: 'mdi-ellipse-outline', tooltip: 'Ellipse' },
  { id: 'sector', icon: 'mdi-chart-arc', tooltip: 'Sector' },
  { id: 'image', icon: 'mdi-image-outline', tooltip: 'Image Overlay' }
]

function selectTool(toolId) {
  activeTool.value = activeTool.value === toolId ? null : toolId
  emit('tool-select', activeTool.value)
}

// Explicit exit from any drawing tool. Previously the only way to leave
// drawing mode was to click the active tool again, which was easy to miss.
// This control doubles as a visual indicator: when no drawing tool is
// active the pointer button is highlighted, so "what am I about to do on
// click" is always visible at a glance.
function exitDrawing() {
  activeTool.value = null
  emit('tool-select', null)
}

</script>

<template>
  <div
    ref="panelRef"
    class="draw-panel"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
  >
    <div class="drag-handle" @pointerdown="onPointerDown">
      <v-icon icon="mdi-drag-horizontal" size="16" class="text-medium-emphasis" />
    </div>

    <div class="d-flex flex-column align-center ga-1 pb-2">
      <v-tooltip text="Select" location="right">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-cursor-default-outline"
            size="small"
            :color="!activeTool ? 'primary' : undefined"
            :class="{ 'text-medium-emphasis': activeTool }"
            @click="exitDrawing"
          />
        </template>
      </v-tooltip>

      <v-divider class="my-1 w-75" />

      <v-tooltip v-for="tool in tools" :key="tool.id" :text="tool.tooltip" location="right">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            :icon="tool.icon"
            size="small"
            :color="activeTool === tool.id ? 'primary' : undefined"
            :class="{ 'text-medium-emphasis': activeTool !== tool.id }"
            @click="selectTool(tool.id)"
          />
        </template>
      </v-tooltip>

    </div>
  </div>
</template>

<style scoped>
.draw-panel {
  position: absolute;
  z-index: 1;
  width: 52px;
  background: rgba(var(--v-theme-surface), 0.92);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  user-select: none;
}

.drag-handle {
  display: flex;
  justify-content: center;
  padding: 4px 0 2px;
  cursor: grab;
}

.drag-handle:active {
  cursor: grabbing;
}
</style>
