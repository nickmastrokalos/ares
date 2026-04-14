<script setup>
import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { formatCoordinate } from '@/services/coordinates'

const props = defineProps({
  coord: { type: Object, default: null }
})

const settingsStore = useSettingsStore()

const text = computed(() => {
  if (!props.coord) return null
  return formatCoordinate(props.coord.lng, props.coord.lat, settingsStore.coordinateFormat)
})
</script>

<template>
  <div class="map-footer">
    <span v-if="text" class="map-footer__coord text-medium-emphasis">{{ text }}</span>
  </div>
</template>

<style scoped>
.map-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 22px;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 10px;
  background: rgba(var(--v-theme-surface), 0.92);
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  pointer-events: none;
  user-select: none;
}

.map-footer__coord {
  font-size: 11px;
  font-family: monospace;
  letter-spacing: 0.03em;
}
</style>
