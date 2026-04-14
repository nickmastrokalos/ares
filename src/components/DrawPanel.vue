<script setup>
import { ref, mergeProps } from 'vue'
import { IO_FORMATS } from '@/services/io'
import { useFeaturesStore } from '@/stores/features'
import { useDraggable } from '@/composables/useDraggable'
import OverlaysDialog from '@/components/OverlaysDialog.vue'

const emit = defineEmits(['tool-select'])
const featuresStore = useFeaturesStore()

const activeTool = ref(null)
const overlaysDialogOpen = ref(false)
const { pos, onPointerDown } = useDraggable({ x: 12, y: 12 })

const tools = [
  { id: 'line', icon: 'mdi-vector-line', tooltip: 'Line' },
  { id: 'polygon', icon: 'mdi-vector-polygon', tooltip: 'Polygon' },
  { id: 'box', icon: 'mdi-vector-square', tooltip: 'Box' },
  { id: 'circle', icon: 'mdi-circle-outline', tooltip: 'Circle' },
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

async function handleImport(format) {
  await format.importFn(featuresStore)
  emit('tool-select', null)
}

async function handleExport(format) {
  await format.exportFn(featuresStore)
}
</script>

<template>
  <div
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

      <v-divider class="my-1 w-75" />

      <v-menu location="end">
        <template #activator="{ props: menuProps }">
          <v-tooltip text="Import" location="right">
            <template #activator="{ props: tipProps }">
              <v-btn
                v-bind="mergeProps(menuProps, tipProps)"
                icon="mdi-import"
                size="small"
                class="text-medium-emphasis"
              />
            </template>
          </v-tooltip>
        </template>
        <v-list density="compact" bg-color="surface" class="format-menu">
          <v-list-item
            v-for="format in IO_FORMATS"
            :key="format.id"
            :title="format.label"
            @click="handleImport(format)"
          />
        </v-list>
      </v-menu>

      <v-menu location="end">
        <template #activator="{ props: menuProps }">
          <v-tooltip text="Export" location="right">
            <template #activator="{ props: tipProps }">
              <v-btn
                v-bind="mergeProps(menuProps, tipProps)"
                icon="mdi-export"
                size="small"
                class="text-medium-emphasis"
              />
            </template>
          </v-tooltip>
        </template>
        <v-list density="compact" bg-color="surface" class="format-menu">
          <v-list-item
            v-for="format in IO_FORMATS"
            :key="format.id"
            :title="format.label"
            @click="handleExport(format)"
          />
        </v-list>
      </v-menu>

      <v-tooltip text="Manage Overlays" location="right">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-shape-outline"
            size="small"
            class="text-medium-emphasis"
            @click="overlaysDialogOpen = true"
          />
        </template>
      </v-tooltip>
    </div>

    <OverlaysDialog v-model="overlaysDialogOpen" />
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

.format-menu {
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  min-width: 140px;
}
</style>
