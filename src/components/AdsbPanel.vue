<script setup>
import { ref, onMounted } from 'vue'
import { useAdsbStore } from '@/stores/adsb'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'

const emit = defineEmits(['close'])

const adsbStore = useAdsbStore()

const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

onMounted(() => {
  pos.value        = { x: 12, y: 80 }
  positioned.value = true
})

function formatLastFetch(date) {
  if (!date) return null
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}
</script>

<template>
  <div
    class="adsb-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-airplane</v-icon>
      <span class="panel-title">ADS-B Feed</span>
      <span v-if="adsbStore.enabled" class="status-dot" :class="adsbStore.loading ? 'status-dot--loading' : 'status-dot--active'" />
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

    <!-- Body -->
    <div class="panel-body">

      <div class="hint">
        Free, key-less feed from
        <a href="https://airplanes.live" target="_blank" rel="noopener">airplanes.live</a>.
        Polled at most once per 10 s; viewport radius is capped at 250 nm.
      </div>

      <div class="divider" />

      <!-- Toggles -->
      <div class="toggle-row" @pointerdown.stop>
        <span class="toggle-label">Active</span>
        <button
          class="toggle-btn"
          :class="{ 'toggle-btn--on': adsbStore.enabled }"
          @click="adsbStore.setEnabled(!adsbStore.enabled)"
        >
          <span class="toggle-knob" />
        </button>
      </div>

      <div class="toggle-row" @pointerdown.stop>
        <span class="toggle-label">Visible on map</span>
        <button
          class="toggle-btn"
          :class="{ 'toggle-btn--on': adsbStore.visible }"
          @click="adsbStore.setVisible(!adsbStore.visible)"
        >
          <span class="toggle-knob" />
        </button>
      </div>

      <div class="toggle-row" @pointerdown.stop>
        <span class="toggle-label">Heading arrows</span>
        <button
          class="toggle-btn"
          :class="{ 'toggle-btn--on': adsbStore.headingArrows }"
          @click="adsbStore.setHeadingArrows(!adsbStore.headingArrows)"
        >
          <span class="toggle-knob" />
        </button>
      </div>

      <!-- Status -->
      <template v-if="adsbStore.enabled">
        <div class="divider" />

        <div v-if="adsbStore.fetchError" class="status-error">
          <v-icon size="13">mdi-alert-circle-outline</v-icon>
          {{ adsbStore.fetchError }}
        </div>

        <div v-else-if="adsbStore.lastFetch" class="status-ok">
          <v-icon size="13" class="text-medium-emphasis">mdi-check-circle-outline</v-icon>
          {{ adsbStore.aircraftCount }} aircraft · {{ formatLastFetch(adsbStore.lastFetch) }}
        </div>

        <div v-else-if="adsbStore.loading" class="status-loading">
          <v-progress-circular indeterminate size="12" width="1" color="primary" />
          Fetching…
        </div>

        <div v-else class="status-idle">
          Waiting for map move…
        </div>
      </template>

    </div>
  </div>
</template>

<style scoped>
.adsb-panel {
  position: absolute;
  width: 260px;
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

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot--active {
  background: rgb(var(--v-theme-primary));
}

.status-dot--loading {
  background: #ff9800;
  animation: pulse 0.8s ease-in-out infinite alternate;
}

@keyframes pulse {
  from { opacity: 0.4; }
  to   { opacity: 1; }
}

.panel-body {
  padding: 6px 8px 8px;
}

.hint {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.55);
  line-height: 1.4;
}

.hint a {
  color: rgba(var(--v-theme-on-surface), 0.75);
  text-decoration: underline;
}

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 6px 0;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
}

.toggle-label {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.toggle-btn {
  position: relative;
  width: 32px;
  height: 18px;
  border-radius: 9px;
  border: none;
  background: rgba(var(--v-theme-on-surface), 0.2);
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}

.toggle-btn--on {
  background: rgb(var(--v-theme-primary));
}

.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ffffff;
  transition: left 0.2s;
}

.toggle-btn--on .toggle-knob {
  left: 17px;
}

.status-ok,
.status-error,
.status-loading,
.status-idle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
}

.status-ok {
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.status-error {
  color: rgb(var(--v-theme-error));
}

.status-loading {
  color: rgba(var(--v-theme-on-surface), 0.5);
}

.status-idle {
  color: rgba(var(--v-theme-on-surface), 0.35);
  font-style: italic;
}
</style>
