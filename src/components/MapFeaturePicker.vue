<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  x:     { type: Number, required: true },
  y:     { type: Number, required: true },
  items: { type: Array,  required: true }  // [{ text, subtitle, icon, ... }]
})

const emit = defineEmits(['select', 'close'])

const menuRef = ref(null)

function onPointerDown(e) {
  if (menuRef.value && !menuRef.value.contains(e.target)) {
    emit('close')
  }
}

function onKeyDown(e) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown, { capture: true })
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('pointerdown', onPointerDown, { capture: true })
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div
    ref="menuRef"
    class="map-feature-picker"
    :style="{ left: x + 'px', top: y + 'px' }"
  >
    <button
      v-for="(item, i) in items"
      :key="i"
      type="button"
      class="picker-row"
      @click.stop="$emit('select', item)"
    >
      <v-icon :icon="item.icon" size="15" class="picker-icon" />
      <div class="picker-text">
        <span class="picker-label">{{ item.text }}</span>
        <span class="picker-subtitle">{{ item.subtitle }}</span>
      </div>
    </button>
  </div>
</template>

<style scoped>
.map-feature-picker {
  position: absolute;
  z-index: 10;
  min-width: 200px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  user-select: none;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  cursor: pointer;
  color: rgb(var(--v-theme-on-surface));
  text-align: left;
}

.picker-row:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.picker-row:not(:last-child) {
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.picker-icon {
  flex-shrink: 0;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.picker-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.picker-label {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-subtitle {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.4);
}
</style>
