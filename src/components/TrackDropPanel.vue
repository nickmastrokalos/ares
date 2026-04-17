<script setup>
import { ref, watch, onMounted } from 'vue'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import TrackTypePicker from './TrackTypePicker.vue'

const props = defineProps({
  placing: { default: null }
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

const selectedAffil   = ref(null)
const selectedCotType = ref(null)

// Reset local state when placement is cancelled externally (e.g. Escape key).
watch(() => props.placing, (val) => {
  if (!val) {
    selectedAffil.value   = null
    selectedCotType.value = null
  }
})

function selectAffil(key) {
  if (selectedAffil.value !== key) {
    // Switching affiliation cancels any active placement.
    if (props.placing) emit('set-placing', null)
    selectedCotType.value = null
  }
  selectedAffil.value = key
}

function onTypeSelected(cotType) {
  selectedCotType.value = cotType
  emit('set-placing', { affiliation: selectedAffil.value, cotType })
}

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
      <div class="section-label">Affiliation</div>

      <div
        v-for="affil in AFFILIATIONS"
        :key="affil.key"
        class="affil-row"
        :class="{ 'affil-row--active': selectedAffil === affil.key }"
        @click="selectAffil(affil.key)"
      >
        <span class="affil-dot" :style="{ backgroundColor: affil.color }" />
        <span class="affil-label">{{ affil.label }}</span>
      </div>

      <div class="divider" />

      <!-- Type picker -->
      <div class="section-label">
        Type
        <span v-if="!selectedAffil" class="section-hint">— select affiliation first</span>
      </div>

      <TrackTypePicker
        :affiliation="selectedAffil ?? 'u'"
        :model-value="selectedCotType"
        :disabled="!selectedAffil"
        @update:model-value="onTypeSelected"
        @pointerdown.stop
      />

      <div v-if="placing" class="hint">Click map to place…</div>
    </div>
  </div>
</template>

<style scoped>
.track-drop-panel {
  position: absolute;
  width: 240px;
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
  padding: 6px 8px 8px;
}

.section-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.38);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.section-hint {
  font-size: 8px;
  text-transform: none;
  letter-spacing: 0.02em;
  color: rgba(var(--v-theme-on-surface), 0.28);
}

.affil-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 3px;
  cursor: pointer;
  margin-bottom: 2px;
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

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 6px 0;
}

.hint {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  padding: 5px 0 0;
  letter-spacing: 0.02em;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  margin-top: 6px;
}
</style>
