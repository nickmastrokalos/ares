<script setup>
import { ref, onMounted } from 'vue'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'

const props = defineProps({
  placing: { type: String, default: null }
})

const emit = defineEmits(['close', 'set-placing'])

const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const AFFILIATIONS = [
  { key: 'f', label: 'Friendly', color: '#4a9ade' },
  { key: 'n', label: 'Civilian', color: '#4caf50' },
  { key: 'u', label: 'Unknown',  color: '#ffeb3b' },
  { key: 'h', label: 'Hostile',  color: '#f44336' }
]

onMounted(() => {
  pos.value = { x: 12, y: 80 }
  positioned.value = true
})
</script>

<template>
  <div
    class="track-drop-panel"
    :style="{
      left: pos.x + 'px',
      top: pos.y + 'px',
      zIndex,
      visibility: positioned ? 'visible' : 'hidden'
    }"
    @pointerdown="bringToFront"
  >
    <!-- Header -->
    <div class="panel-header" @pointerdown="onPointerDown">
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-map-marker-account</v-icon>
      <span class="panel-title">Track Drop</span>
      <v-spacer />
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="emit('close')"
      />
    </div>

    <!-- Affiliation list -->
    <div class="panel-body">
      <div
        v-for="affil in AFFILIATIONS"
        :key="affil.key"
        class="affil-row"
        :class="{ 'affil-row--active': placing === affil.key }"
        @click="emit('set-placing', affil.key)"
      >
        <span class="affil-dot" :style="{ backgroundColor: affil.color }" />
        <span class="affil-label">{{ affil.label }}</span>
      </div>

      <div v-if="placing" class="hint">Click map to place…</div>
    </div>
  </div>
</template>

<style scoped>
.track-drop-panel {
  position: absolute;
  width: 180px;
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

.panel-header:active {
  cursor: grabbing;
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.header-btn {
  flex-shrink: 0;
}

.panel-body {
  padding: 4px 0;
}

.affil-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
}

.affil-row:hover {
  background: rgba(var(--v-theme-surface-variant), 0.5);
}

.affil-row--active {
  background: rgba(var(--v-theme-primary), 0.12);
}

.affil-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.affil-label {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.87);
}

.hint {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  padding: 2px 10px 4px;
  letter-spacing: 0.02em;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  margin-top: 2px;
}
</style>
