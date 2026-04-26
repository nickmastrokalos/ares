<script setup>
// Generic floating panel that hosts a plugin-supplied DOM body.
//
// The plugin registers a panel with `api.registerPanel({ id, title, mount })`.
// `mount(containerEl)` is called once when the panel first opens; the plugin
// renders into the provided element with vanilla DOM (or any framework it
// bundles itself). The optional return value is a cleanup function called
// when the panel is closed.

import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'

const props = defineProps({
  panel: { type: Object, required: true }
})
const emit = defineEmits(['close'])

const positioned = ref(false)
const containerEl = ref(null)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

// The plugin's `mount(containerEl)` is invoked exactly once when the panel
// instance first appears in the DOM (panel registration, not panel-open).
// The DOM and any internal plugin state then persist across close/reopen
// cycles via v-show — no remount churn. Cleanup runs only when the panel
// is unregistered (plugin disabled / app shutdown).
let cleanupFn = null

onMounted(async () => {
  pos.value = props.panel.initialPosition ?? { x: 60, y: 80 }
  positioned.value = true
  await nextTick()
  if (!containerEl.value) return
  try {
    const result = props.panel.mount(containerEl.value)
    cleanupFn = typeof result === 'function' ? result : null
  } catch (err) {
    console.error(`[plugin-panel:${props.panel.id}] mount failed:`, err)
  }
})

onUnmounted(() => {
  if (cleanupFn) {
    try { cleanupFn() } catch (err) {
      console.warn(`[plugin-panel:${props.panel.id}] cleanup failed:`, err)
    }
    cleanupFn = null
  }
})

function handleClose() {
  emit('close')
}
</script>

<template>
  <div
    class="plugin-panel"
    :style="{
      left: pos.x + 'px',
      top:  pos.y + 'px',
      zIndex,
      visibility: positioned ? 'visible' : 'hidden'
    }"
    @pointerdown="bringToFront"
  >
    <div class="panel-header" @pointerdown="onPointerDown">
      <v-icon
        v-if="panel.icon"
        size="14"
        class="text-medium-emphasis"
        style="flex-shrink:0"
      >{{ panel.icon }}</v-icon>
      <span class="panel-title">{{ panel.title }}</span>
      <v-spacer />
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="handleClose"
      />
    </div>
    <div ref="containerEl" class="panel-body" @pointerdown.stop />
  </div>
</template>

<style scoped>
.plugin-panel {
  position: absolute;
  min-width: 220px;
  background: rgba(var(--v-theme-surface), 0.95);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px 4px 8px;
  cursor: grab;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.panel-header:active { cursor: grabbing; }

.panel-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.header-btn { flex-shrink: 0; }

.panel-body {
  padding: 8px;
  color: rgb(var(--v-theme-on-surface));
  font-size: 12px;
}
</style>
