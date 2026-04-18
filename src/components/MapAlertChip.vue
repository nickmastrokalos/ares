<script setup>
import { ref, computed, watch, inject } from 'vue'

const props = defineProps({
  alerts: { type: Array, required: true }
})

const expanded = ref(false)
const flyToGeometry = inject('flyToGeometry', null)

function flyTo(coord) {
  if (!coord || !flyToGeometry) return
  flyToGeometry({ type: 'Point', coordinates: coord })
}

// The chip always shows the highest-severity alert as the summary line.
// Additional alerts become a +N badge and populate the expanded popover.
const primary = computed(() => props.alerts[0] ?? null)
const rest    = computed(() => props.alerts.slice(1))

function toggle() {
  if (!hasExpandable.value) return
  expanded.value = !expanded.value
}

const hasExpandable = computed(() => {
  if (rest.value.length > 0) return true
  return !!(primary.value?.details?.length)
})

// Auto-collapse when alerts clear out entirely, so re-open later starts
// from a clean state.
watch(() => props.alerts.length, (n) => { if (n === 0) expanded.value = false })
</script>

<template>
  <transition name="alert-chip">
    <div
      v-if="primary"
      class="alert-chip-root"
      :class="[`level-${primary.level}`, { expanded, 'has-more': hasExpandable }]"
    >
      <button
        type="button"
        class="alert-chip"
        :class="{ clickable: hasExpandable }"
        @click="toggle"
      >
        <v-icon size="14" class="alert-icon">mdi-alert</v-icon>
        <span class="alert-message">{{ primary.message }}</span>
        <span v-if="rest.length" class="alert-count">+{{ rest.length }}</span>
        <v-icon v-if="hasExpandable" size="14" class="alert-chevron">
          {{ expanded ? 'mdi-chevron-up' : 'mdi-chevron-down' }}
        </v-icon>
      </button>

      <transition name="alert-popover">
        <div v-if="expanded && hasExpandable" class="alert-popover">
          <div v-if="primary.details?.length" class="alert-group">
            <div class="alert-group-header">
              <v-icon size="12">mdi-alert</v-icon>
              <span>{{ primary.message }}</span>
            </div>
            <div
              v-for="(d, i) in primary.details"
              :key="`p-${i}`"
              class="alert-line"
            >
              <span class="alert-line-label">{{ d.label }}</span>
              <button
                v-if="d.coord"
                type="button"
                class="alert-line-flyto"
                title="Zoom to location"
                @click="flyTo(d.coord)"
              >
                <v-icon size="14">mdi-crosshairs-gps</v-icon>
              </button>
            </div>
          </div>

          <div
            v-for="a in rest"
            :key="a.id"
            class="alert-group"
            :class="`level-${a.level}`"
          >
            <div class="alert-group-header">
              <v-icon size="12">mdi-alert</v-icon>
              <span>{{ a.message }}</span>
            </div>
            <div
              v-for="(d, i) in (a.details || [])"
              :key="`${a.id}-${i}`"
              class="alert-line"
            >
              <span class="alert-line-label">{{ d.label }}</span>
              <button
                v-if="d.coord"
                type="button"
                class="alert-line-flyto"
                title="Zoom to location"
                @click="flyTo(d.coord)"
              >
                <v-icon size="14">mdi-crosshairs-gps</v-icon>
              </button>
            </div>
          </div>
        </div>
      </transition>
    </div>
  </transition>
</template>

<style scoped>
.alert-chip-root {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: min(560px, calc(100% - 32px));
}

.alert-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.82);
  border: 1px solid currentColor;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: inherit;
  max-width: 100%;
  cursor: default;
  animation: alert-pulse 1.4s ease-in-out infinite;
  font-family: inherit;
}

.alert-chip.clickable {
  cursor: pointer;
}

.alert-chip-root.level-warning  { color: #ffb300; }
.alert-chip-root.level-critical { color: #e53935; }

.alert-icon,
.alert-chevron {
  flex: 0 0 auto;
}

.alert-message {
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(255, 255, 255, 0.92);
  min-width: 0;
}

.alert-count {
  flex: 0 0 auto;
  padding: 0 6px;
  height: 16px;
  line-height: 16px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
}

.alert-chip-root.level-warning  .alert-count { background: #ffb300; color: #000; }
.alert-chip-root.level-critical .alert-count { background: #e53935; color: #fff; }

.alert-popover {
  margin-top: 4px;
  min-width: 240px;
  max-width: 100%;
  background: rgba(0, 0, 0, 0.92);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.alert-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #ffb300;
}

.alert-group.level-critical { color: #e53935; }
.alert-group.level-warning  { color: #ffb300; }

.alert-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.alert-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 18px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.78);
  line-height: 1.35;
}

.alert-line-label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: normal;
  word-break: break-word;
}

.alert-line-flyto {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
}

.alert-line-flyto:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.95);
}

@keyframes alert-pulse {
  0%, 100% { box-shadow: 0 0 0 0 currentColor; }
  50%      { box-shadow: 0 0 0 4px transparent; }
}

.alert-chip-enter-from,
.alert-chip-leave-to {
  opacity: 0;
  transform: translate(-50%, -6px);
}

.alert-chip-enter-active,
.alert-chip-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.alert-popover-enter-from,
.alert-popover-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.alert-popover-enter-active,
.alert-popover-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}
</style>
