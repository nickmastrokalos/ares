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
const minimized   = ref(false)
const containerEl = ref(null)
// Hover state for the optional `panel.infoHtml` legend popover.
// The button sits in the title bar between the title and the
// chevron / close so plugins don't have to spend a content row
// describing their own colour scheme. The popover itself is
// rendered with `position: fixed` and coordinates computed from
// the icon's bounding rect — anchoring inside the panel hits
// `.plugin-panel { overflow: hidden }` (which is needed for the
// rounded-corner body clip) and the popover's right edge gets
// chopped against the panel boundary.
const infoOpen   = ref(false)
const infoIconEl = ref(null)
const infoStyle  = ref({})

function openInfo() {
  if (!infoIconEl.value) { infoOpen.value = true; return }
  const rect = infoIconEl.value.getBoundingClientRect()
  // Anchor below-left of the icon by default; if the popover would
  // run off the right edge of the viewport the browser clamps via
  // the popover's own max-width — but the typical case is plenty
  // of room to the right, so prefer that.
  infoStyle.value = {
    top:  `${rect.bottom + 6}px`,
    left: `${rect.left}px`
  }
  infoOpen.value = true
}
function closeInfo() {
  infoOpen.value = false
}
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
      // Width pinned on the container so collapsing the body
      // doesn't shrink the panel to the header's natural width.
      // Plugins opt in via `registerPanel({ width: 340, ... })`;
      // omitting it falls back to the host's default min-width.
      width: panel.width ? `${panel.width}px` : undefined,
      // Cap the panel so it never extends below the viewport — body
      // scrolls when content exceeds the available height. The 24 px
      // gives a little breathing room above the OS taskbar / bottom
      // edge. Recomputes whenever the user drags the panel.
      maxHeight: `calc(100vh - ${Math.max(0, pos.y) + 24}px)`,
      zIndex,
      visibility: positioned ? 'visible' : 'hidden'
    }"
    @pointerdown="bringToFront"
  >
    <div class="panel-header" @pointerdown="onPointerDown">
      <span
        v-if="panel.iconSvg"
        class="panel-svg-icon text-medium-emphasis"
        v-html="panel.iconSvg"
      />
      <v-icon
        v-else-if="panel.icon"
        size="14"
        class="text-medium-emphasis"
        style="flex-shrink:0"
      >{{ panel.icon }}</v-icon>
      <span class="panel-title">{{ panel.title }}</span>
      <span
        v-if="panel.infoHtml"
        ref="infoIconEl"
        class="panel-info-wrap"
        @mouseenter="openInfo"
        @mouseleave="closeInfo"
        @pointerdown.stop
      >
        <v-icon
          size="14"
          class="text-medium-emphasis panel-info-icon"
          aria-label="Legend"
        >mdi-information-outline</v-icon>
      </span>
      <Teleport to="body">
        <div
          v-if="panel.infoHtml && infoOpen"
          class="panel-info-popover"
          :style="infoStyle"
          v-html="panel.infoHtml"
        />
      </Teleport>
      <v-spacer />
      <v-btn
        :icon="minimized ? 'mdi-chevron-down' : 'mdi-chevron-up'"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        :title="minimized ? 'Expand' : 'Collapse'"
        @pointerdown.stop
        @click.stop="minimized = !minimized"
      />
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="handleClose"
      />
    </div>
    <div v-show="!minimized" ref="containerEl" class="panel-body" @pointerdown.stop />
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
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px 4px 8px;
  cursor: grab;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  flex-shrink: 0;
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
  overflow-y: auto;
  min-height: 0;
}

/* Plugin-supplied inline SVG icon in the header. Same 14 px
   footprint as the MDI v-icon it replaces. The plugin's SVG can
   reference `currentColor` to inherit the header's text colour. */
.panel-svg-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: inherit;
}
.panel-svg-icon :deep(svg) {
  width: 100%;
  height: 100%;
}

/* Optional info-legend rendered via `panel.infoHtml`. The wrapper
   in the title bar is the hover target; the popover itself is
   teleported to <body> (see template) so it can render past the
   panel's `overflow: hidden` clip. */
.panel-info-wrap {
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
  flex-shrink: 0;
  cursor: help;
}
.panel-info-icon { line-height: 1; }
</style>

<!-- Popover lives at <body> via Teleport; scoped styles wouldn't
     apply across the teleport boundary. Keep the visual treatment
     here, unscoped, so the popover renders identically regardless
     of which panel triggered it. -->
<style>
.panel-info-popover {
  position: fixed;
  z-index: 10000;
  background: rgba(20, 20, 24, 0.96);
  color: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 11px;
  line-height: 1.5;
  font-weight: 400;
  letter-spacing: normal;
  pointer-events: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  white-space: normal;
  width: max-content;
  max-width: 280px;
}
</style>
