<script setup>
import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { formatCoordinate } from '@/services/coordinates'

const props = defineProps({
  coord: { type: Object, default: null }
})

const settingsStore = useSettingsStore()
const appStore      = useAppStore()

const coordText = computed(() => {
  if (!props.coord) return null
  return formatCoordinate(props.coord.lng, props.coord.lat, settingsStore.coordinateFormat)
})
</script>

<template>
  <div class="map-footer">
    <span v-if="coordText" class="map-footer__coord">{{ coordText }}</span>
    <span v-else class="map-footer__coord map-footer__coord--placeholder" />

    <v-progress-circular
      v-if="appStore.loading"
      indeterminate
      size="14"
      width="2"
      class="map-footer__spinner"
    />
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
  justify-content: space-between;
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
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.map-footer__coord--placeholder {
  /* holds left-side space so the spinner doesn't jump to center */
  display: inline-block;
  width: 1px;
}

.map-footer__spinner {
  color: rgba(var(--v-theme-on-surface), 0.45);
  flex-shrink: 0;
}
</style>
