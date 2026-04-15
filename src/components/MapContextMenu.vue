<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { formatCoordinate } from '@/services/coordinates'

const props = defineProps({
  x:      { type: Number, required: true },
  y:      { type: Number, required: true },
  lngLat: { type: Object, required: true }  // { lng, lat }
})

const emit = defineEmits(['close'])

const menuRef = ref(null)

const FORMATS = [
  { id: 'mgrs', label: 'MGRS' },
  { id: 'dms',  label: 'DMS'  },
  { id: 'dd',   label: 'DD'   }
]

// Per-format copied state — briefly shows a checkmark after copying.
const copied = ref(null)

function formatted(formatId) {
  return formatCoordinate(props.lngLat.lng, props.lngLat.lat, formatId)
}

async function copy(formatId) {
  const text = formatted(formatId)
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Fallback for environments where clipboard API isn't available.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copied.value = formatId
  setTimeout(() => {
    copied.value = null
    emit('close')
  }, 800)
}

// Dismiss on any pointer-down outside the menu.
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
    class="map-context-menu"
    :style="{ left: x + 'px', top: y + 'px' }"
  >
    <button
      v-for="fmt in FORMATS"
      :key="fmt.id"
      type="button"
      class="menu-row"
      @click.stop="copy(fmt.id)"
    >
      <span class="format-label">{{ fmt.label }}</span>
      <span class="coord-value">{{ formatted(fmt.id) }}</span>
      <v-icon
        :icon="copied === fmt.id ? 'mdi-check' : 'mdi-content-copy'"
        size="13"
        class="copy-icon"
        :class="{ 'text-success': copied === fmt.id }"
      />
    </button>
  </div>
</template>

<style scoped>
.map-context-menu {
  position: absolute;
  z-index: 10;
  min-width: 240px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  user-select: none;
}

.menu-row {
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

.menu-row:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

.menu-row:not(:last-child) {
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.format-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.45);
  min-width: 34px;
  flex-shrink: 0;
}

.coord-value {
  flex: 1;
  font-size: 11px;
  font-family: monospace;
  letter-spacing: 0.03em;
}

.copy-icon {
  flex-shrink: 0;
  color: rgba(var(--v-theme-on-surface), 0.35);
}
</style>
