<script setup>
import { ref, onMounted } from 'vue'
import { useAisStore } from '@/stores/ais'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'

const emit = defineEmits(['close'])

const aisStore = useAisStore()

const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

// Local draft inputs — committed on blur or save
const draftUrl    = ref('')
const draftApiKey = ref('')
const showApiKey  = ref(false)

onMounted(() => {
  draftUrl.value    = aisStore.feedUrl
  draftApiKey.value = aisStore.apiKey
  pos.value         = { x: 12, y: 80 }
  positioned.value  = true
})

function commitConfig() {
  const url = draftUrl.value.trim()
  const key = draftApiKey.value.trim()
  if (url !== aisStore.feedUrl)  aisStore.setFeedUrl(url)
  if (key !== aisStore.apiKey)   aisStore.setApiKey(key)
}

// ---- Status helpers ----

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
    class="ais-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-ferry</v-icon>
      <span class="panel-title">AIS Feed</span>
      <span v-if="aisStore.enabled" class="status-dot" :class="aisStore.loading ? 'status-dot--loading' : 'status-dot--active'" />
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

      <!-- Feed URL -->
      <div class="field-label">FEED URL</div>
      <input
        v-model="draftUrl"
        class="text-input"
        type="url"
        placeholder="https://aisfeed.com"
        spellcheck="false"
        autocomplete="off"
        @blur="commitConfig"
        @keydown.enter.prevent="commitConfig"
        @pointerdown.stop
      />

      <!-- API Key -->
      <div class="field-label mt">API KEY</div>
      <div class="key-row">
        <input
          v-model="draftApiKey"
          class="text-input key-input"
          :type="showApiKey ? 'text' : 'password'"
          placeholder="ais_..."
          spellcheck="false"
          autocomplete="off"
          @blur="commitConfig"
          @keydown.enter.prevent="commitConfig"
          @pointerdown.stop
        />
        <button
          class="eye-btn"
          :title="showApiKey ? 'Hide key' : 'Show key'"
          @pointerdown.stop
          @click.stop="showApiKey = !showApiKey"
        >
          <v-icon size="14">{{ showApiKey ? 'mdi-eye-off-outline' : 'mdi-eye-outline' }}</v-icon>
        </button>
      </div>

      <div class="divider" />

      <!-- Toggles -->
      <div class="toggle-row" @pointerdown.stop>
        <span class="toggle-label">Active</span>
        <button
          class="toggle-btn"
          :class="{ 'toggle-btn--on': aisStore.enabled }"
          @click="aisStore.setEnabled(!aisStore.enabled)"
        >
          <span class="toggle-knob" />
        </button>
      </div>

      <div class="toggle-row" @pointerdown.stop>
        <span class="toggle-label">Visible on map</span>
        <button
          class="toggle-btn"
          :class="{ 'toggle-btn--on': aisStore.visible }"
          @click="aisStore.setVisible(!aisStore.visible)"
        >
          <span class="toggle-knob" />
        </button>
      </div>

      <div class="toggle-row" @pointerdown.stop>
        <span class="toggle-label">Heading arrows</span>
        <button
          class="toggle-btn"
          :class="{ 'toggle-btn--on': aisStore.headingArrows }"
          @click="aisStore.setHeadingArrows(!aisStore.headingArrows)"
        >
          <span class="toggle-knob" />
        </button>
      </div>

      <!-- Status -->
      <template v-if="aisStore.enabled">
        <div class="divider" />

        <div v-if="aisStore.fetchError" class="status-error">
          <v-icon size="13">mdi-alert-circle-outline</v-icon>
          {{ aisStore.fetchError }}
        </div>

        <div v-else-if="aisStore.lastFetch" class="status-ok">
          <v-icon size="13" class="text-medium-emphasis">mdi-check-circle-outline</v-icon>
          {{ aisStore.vesselCount }} vessels · {{ formatLastFetch(aisStore.lastFetch) }}
        </div>

        <div v-else-if="aisStore.loading" class="status-loading">
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
.ais-panel {
  position: absolute;
  width: 260px;
  background: rgba(var(--v-theme-surface), 0.95);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
}

/* ---- Header ---- */

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

/* Active indicator dot in header */
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

/* ---- Body ---- */

.panel-body {
  padding: 6px 8px 8px;
}

/* ---- Field labels ---- */

.field-label {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(var(--v-theme-on-surface), 0.38);
  margin-bottom: 3px;
}

.field-label.mt {
  margin-top: 5px;
}

/* ---- Inputs ---- */

.text-input {
  width: 100%;
  font-size: 11px;
  font-family: monospace;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  color: rgb(var(--v-theme-on-surface));
  padding: 3px 6px;
  outline: none;
  box-sizing: border-box;
}

.text-input::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.3);
}

.key-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.key-input {
  flex: 1;
}

.eye-btn {
  background: none;
  border: none;
  padding: 2px;
  cursor: pointer;
  color: rgba(var(--v-theme-on-surface), 0.45);
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.eye-btn:hover {
  color: rgba(var(--v-theme-on-surface), 0.7);
}

/* ---- Divider ---- */

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 6px 0;
}

/* ---- Toggle rows ---- */

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

/* ---- Status ---- */

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
