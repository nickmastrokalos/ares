<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useGhostsStore } from '@/stores/ghosts'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable } from '@/composables/useDraggable'
import { useZIndex } from '@/composables/useZIndex'
import { formatSpeed, speedUnitLabel, parseSpeedToMs } from '@/services/geometry'

const emit = defineEmits(['close'])

const ghostsStore   = useGhostsStore()
const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()

const minimized  = ref(false)
const positioned = ref(false)
const { pos, onPointerDown } = useDraggable()
const { zIndex, bringToFront } = useZIndex()

// ---- Routes computed from features store ----

const routes = computed(() => {
  return featuresStore.features
    .filter(f => f.type === 'route')
    .map(f => {
      let coords = []
      try {
        const geom = JSON.parse(f.geometry)
        coords = geom?.coordinates ?? []
      } catch { /* ignore */ }

      let props = {}
      try {
        props = JSON.parse(f.properties)
      } catch { /* ignore */ }

      const waypointDefs = props.waypoints ?? []
      const total = coords.length

      const waypoints = coords.map((coord, i) => {
        const wp = waypointDefs[i] ?? {}
        let label
        if (wp.label) {
          label = wp.label
        } else if (i === 0) {
          label = 'SP'
        } else if (i === total - 1) {
          label = 'EP'
        } else {
          label = `WP ${i}`
        }
        return { index: i, label, coord }
      })

      return { id: f.id, name: props.name ?? `Route ${f.id}`, coords, waypoints }
    })
})

// ---- Display helpers ----

function ghostRouteName(ghost) {
  const route = routes.value.find(r => r.id === ghost.routeId)
  return route ? route.name : 'Route'
}

function ghostWaypointLabel(ghost) {
  const route = routes.value.find(r => r.id === ghost.routeId)
  if (!route) return ''
  return route.waypoints[ghost.startWaypointIndex]?.label ?? ''
}

function speedDisplayValue(ghost) {
  const units = settingsStore.distanceUnits
  if (units === 'nautical') return (ghost.speedMs * 1.94384).toFixed(1)
  if (units === 'statute') return (ghost.speedMs * 2.23694).toFixed(1)
  return (ghost.speedMs * 3.6).toFixed(1)
}

const unitLabel = computed(() => speedUnitLabel(settingsStore.distanceUnits))

// ---- Speed editing ----
// While a running ghost is being edited, the store ticks every
// 100 ms and mutates `ghost.speedMs` (well, replaces the ghost
// object). If we leave `:value` bound directly to the live ghost
// the rerender overwrites whatever the operator just typed,
// snapping their keystrokes back. We gate the displayed value on
// `editingSpeedId`: while focused, the bound value comes from
// `speedDraft` (changes only on `@input`); otherwise it tracks
// the ghost. `speedSnapshot` keeps the on-focus value for Esc.

const editingSpeedId = ref(null)
const speedDraft     = ref('')
const speedSnapshot  = ref('')

function speedInputValue(ghost) {
  return editingSpeedId.value === ghost.id
    ? speedDraft.value
    : speedDisplayValue(ghost)
}

function onSpeedFocus(event, ghost) {
  const current = speedDisplayValue(ghost)
  editingSpeedId.value = ghost.id
  speedDraft.value     = current
  speedSnapshot.value  = current
}

function onSpeedInput(event) {
  speedDraft.value = event.target.value
}

function onSpeedBlur(event, ghost) {
  if (editingSpeedId.value !== ghost.id) return
  const raw = speedDraft.value.trim()
  const ms = parseSpeedToMs(raw, settingsStore.distanceUnits)
  if (ms !== null && ms > 0) {
    ghostsStore.setSpeed(ghost.id, ms)
  }
  // Either way, drop edit state — the next render falls back to
  // the live ghost value (which is now the committed speed, or
  // unchanged if the input was invalid).
  editingSpeedId.value = null
  speedDraft.value     = ''
  speedSnapshot.value  = ''
}

function onSpeedEnter(event) {
  event.target.blur()
}

function onSpeedEscape(event, ghost) {
  // Cancel: restore the on-focus value and exit edit mode without
  // committing.
  speedDraft.value     = speedSnapshot.value
  editingSpeedId.value = null
  speedDraft.value     = ''
  speedSnapshot.value  = ''
  event.target.blur()
}

// ---- Toggle helper ----

function toggleGhost(ghost) {
  if (ghost.status === 'running') {
    ghostsStore.stopGhost(ghost.id)
  } else {
    ghostsStore.startGhost(ghost.id)
  }
}

// ---- Inline rename ----
// Click the ghost name to enter edit mode; Enter / blur commits,
// Escape cancels. Edits are kept in a per-row map keyed by id so
// switching focus between rows doesn't bleed drafts together.

const renamingId = ref(null)
const renameDraft = ref('')

function beginRename(ghost) {
  renamingId.value  = ghost.id
  renameDraft.value = ghost.name
  // Auto-select on next tick so the operator can immediately
  // overtype the existing name.
  nextTick(() => {
    const el = document.querySelector('.ghost-name-input--editing')
    if (el) { el.focus(); el.select() }
  })
}
function commitRename(ghost) {
  if (renamingId.value !== ghost.id) return
  const next = renameDraft.value.trim()
  if (next && next !== ghost.name) {
    ghostsStore.renameGhost(ghost.id, next)
  }
  renamingId.value = null
  renameDraft.value = ''
}
function cancelRename() {
  renamingId.value = null
  renameDraft.value = ''
}

// ---- Edit popover (waypoint + direction) ----
// Click the pencil to open; selectors update the ghost in place
// via the store. Disabled while the ghost is running.

function ghostRoute(ghost) {
  return routes.value.find(r => r.id === ghost.routeId) ?? null
}

function ghostWaypoints(ghost) {
  return ghostRoute(ghost)?.waypoints ?? []
}

function isAtStart(ghost) {
  return ghost.startWaypointIndex === 0
}

function isAtEnd(ghost) {
  const wps = ghostWaypoints(ghost)
  return wps.length > 0 && ghost.startWaypointIndex === wps.length - 1
}

function setEditWaypoint(ghost, idx) {
  ghostsStore.setStartWaypoint(ghost.id, Number(idx))
}

function setEditDirection(ghost, dir) {
  ghostsStore.setDirection(ghost.id, dir)
}

// ---- Creation form ----

const creating         = ref(false)
const newRouteId       = ref(null)
const newWaypointIndex = ref(0)
const newSpeedInput    = ref('')
const newDirection     = ref('forward')

const newRoute = computed(() => {
  if (!newRouteId.value) return null
  return routes.value.find(r => r.id === newRouteId.value) ?? null
})

const newWaypoints = computed(() => newRoute.value?.waypoints ?? [])

const showDirectionPicker = computed(() => {
  if (!newRoute.value) return false
  const total = newRoute.value.waypoints.length
  const idx   = newWaypointIndex.value
  return idx > 0 && idx < total - 1
})

watch(newRouteId, () => {
  newWaypointIndex.value = 0
  newDirection.value     = 'forward'
})

watch(
  () => newWaypointIndex.value,
  (idx) => {
    const total = newRoute.value?.waypoints.length ?? 0
    if (idx === 0) newDirection.value = 'forward'
    if (total > 0 && idx === total - 1) newDirection.value = 'backward'
  }
)

function openCreate() {
  creating.value = true
  if (routes.value.length > 0) newRouteId.value = routes.value[0].id
}

function cancelCreate() {
  creating.value    = false
  newRouteId.value  = null
  newWaypointIndex.value = 0
  newSpeedInput.value    = ''
  newDirection.value     = 'forward'
}

function confirmCreate() {
  if (!newRouteId.value || !newSpeedInput.value) return
  const ms = parseSpeedToMs(newSpeedInput.value, settingsStore.distanceUnits)
  if (ms === null || ms <= 0) return
  ghostsStore.createGhost({
    routeId:           newRouteId.value,
    startWaypointIndex: Number(newWaypointIndex.value),
    direction:         newDirection.value,
    speedMs:           ms
  })
  cancelCreate()
}

// ---- Lifecycle ----

onMounted(() => {
  pos.value     = { x: 12, y: 80 }
  positioned.value = true
})
</script>

<template>
  <div
    class="ghost-panel"
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
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-ghost</v-icon>
      <span class="panel-title">Ghosts</span>
      <span class="ghost-count">{{ ghostsStore.ghosts.length }}</span>
      <v-spacer />
      <v-btn
        icon="mdi-plus"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        :disabled="creating"
        @pointerdown.stop
        @click.stop="openCreate"
      />
      <v-btn
        :icon="minimized ? 'mdi-chevron-down' : 'mdi-chevron-up'"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="minimized = !minimized"
      />
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="emit('close')"
      />
    </div>

    <!-- Ghost list -->
    <div v-show="!minimized" class="ghost-list">
      <div v-if="ghostsStore.ghosts.length === 0" class="empty-state">
        No ghosts — click + to create one
      </div>

      <div
        v-for="ghost in ghostsStore.ghosts"
        :key="ghost.id"
        class="ghost-item"
      >
        <!-- Item header row -->
        <div class="ghost-item-header">
          <span class="ghost-dot" />
          <input
            v-if="renamingId === ghost.id"
            v-model="renameDraft"
            class="ghost-name ghost-name--input ghost-name-input--editing"
            :class="{ 'ghost-name--running': ghost.status === 'running' }"
            type="text"
            @keydown.enter.prevent="commitRename(ghost)"
            @keydown.escape.prevent="cancelRename"
            @blur="commitRename(ghost)"
            @pointerdown.stop
            @click.stop
          />
          <span
            v-else
            class="ghost-name"
            :class="{ 'ghost-name--running': ghost.status === 'running' }"
            title="Click to rename"
            @pointerdown.stop
            @click.stop="beginRename(ghost)"
          >
            {{ ghost.name }}
          </span>
          <v-spacer />

          <v-menu
            :close-on-content-click="false"
            location="bottom"
            offset="2"
          >
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                icon="mdi-pencil-outline"
                size="x-small"
                variant="text"
                class="text-medium-emphasis"
                :title="ghost.status === 'running' ? 'Stop the ghost first to edit' : 'Edit waypoint / direction'"
                :disabled="ghost.status === 'running'"
                @pointerdown.stop
                @click.stop
              />
            </template>
            <div class="edit-popover" @pointerdown.stop>
              <div class="section-label">EDIT GHOST</div>
              <div class="form-row">
                <span class="form-label">WP</span>
                <select
                  :value="ghost.startWaypointIndex"
                  class="panel-select"
                  @change="setEditWaypoint(ghost, $event.target.value)"
                >
                  <option
                    v-for="wp in ghostWaypoints(ghost)"
                    :key="wp.index"
                    :value="wp.index"
                  >{{ wp.label }}</option>
                </select>
              </div>
              <div class="form-row">
                <span class="form-label">DIR</span>
                <div class="dir-pills">
                  <button
                    class="pill"
                    :class="{ 'pill--active': ghost.direction === 'backward' }"
                    :disabled="isAtStart(ghost)"
                    @click="setEditDirection(ghost, 'backward')"
                  >← BWD</button>
                  <button
                    class="pill"
                    :class="{ 'pill--active': ghost.direction === 'forward' }"
                    :disabled="isAtEnd(ghost)"
                    @click="setEditDirection(ghost, 'forward')"
                  >FWD →</button>
                </div>
              </div>
            </div>
          </v-menu>

          <v-tooltip :text="ghost.status === 'running' ? 'Stop' : 'Start'" location="top">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                :icon="ghost.status === 'running' ? 'mdi-stop' : 'mdi-play'"
                size="x-small"
                variant="text"
                :color="ghost.status === 'running' ? 'error' : 'primary'"
                @pointerdown.stop
                @click.stop="toggleGhost(ghost)"
              />
            </template>
          </v-tooltip>

          <v-tooltip text="Reset" location="top">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                icon="mdi-restore"
                size="x-small"
                variant="text"
                class="text-medium-emphasis"
                @pointerdown.stop
                @click.stop="ghostsStore.resetGhost(ghost.id)"
              />
            </template>
          </v-tooltip>

          <v-tooltip text="Delete" location="top">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                icon="mdi-close"
                size="x-small"
                variant="text"
                class="text-medium-emphasis"
                @pointerdown.stop
                @click.stop="ghostsStore.deleteGhost(ghost.id)"
              />
            </template>
          </v-tooltip>
        </div>

        <!-- Item detail row -->
        <div class="ghost-item-detail">
          <span class="ghost-meta">
            {{ ghostRouteName(ghost) }} · {{ ghostWaypointLabel(ghost) }} · {{ ghost.direction === 'forward' ? '→' : '←' }}
          </span>
          <div class="ghost-speed-row">
            <input
              class="speed-input"
              type="text"
              inputmode="decimal"
              :value="speedInputValue(ghost)"
              @input="onSpeedInput($event)"
              @focus="onSpeedFocus($event, ghost)"
              @blur="onSpeedBlur($event, ghost)"
              @keydown.enter="onSpeedEnter($event)"
              @keydown.escape="onSpeedEscape($event, ghost)"
              @pointerdown.stop
            />
            <span class="speed-unit">{{ unitLabel }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Create form -->
    <div v-show="!minimized && creating" class="create-form" @pointerdown.stop>
      <div class="divider" />
      <div class="section-label">NEW GHOST</div>

      <!-- Route selector -->
      <div class="form-row">
        <span class="form-label">ROUTE</span>
        <select v-model="newRouteId" class="panel-select">
          <option v-for="r in routes" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
      </div>

      <!-- Waypoint selector -->
      <div class="form-row">
        <span class="form-label">WP</span>
        <select
          v-model.number="newWaypointIndex"
          class="panel-select"
        >
          <option
            v-for="wp in newWaypoints"
            :key="wp.index"
            :value="wp.index"
          >{{ wp.label }}</option>
        </select>
      </div>

      <!-- Speed input -->
      <div class="form-row">
        <span class="form-label">SPEED</span>
        <input
          v-model="newSpeedInput"
          class="speed-input"
          type="text"
          inputmode="decimal"
          placeholder="0"
        />
        <span class="speed-unit">{{ unitLabel }}</span>
      </div>

      <!-- Direction picker (only shown for mid-route waypoints) -->
      <div v-if="showDirectionPicker" class="form-row">
        <span class="form-label">DIR</span>
        <div class="dir-pills">
          <button
            class="pill"
            :class="{ 'pill--active': newDirection === 'backward' }"
            @click="newDirection = 'backward'"
          >← BWD</button>
          <button
            class="pill"
            :class="{ 'pill--active': newDirection === 'forward' }"
            @click="newDirection = 'forward'"
          >FWD →</button>
        </div>
      </div>

      <!-- Actions -->
      <div class="form-actions">
        <v-btn
          size="x-small"
          variant="text"
          class="text-medium-emphasis"
          @click="cancelCreate"
        >Cancel</v-btn>
        <v-btn
          size="x-small"
          variant="tonal"
          color="primary"
          :disabled="!newRouteId || !newSpeedInput"
          @click="confirmCreate"
        >Create</v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ghost-panel {
  position: absolute;
  width: 300px;
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

.ghost-count {
  font-size: 10px;
  font-weight: 600;
  color: rgba(var(--v-theme-on-surface), 0.45);
  background: rgba(var(--v-theme-surface-variant), 0.8);
  border-radius: 8px;
  padding: 0 5px;
  line-height: 16px;
}

.header-btn {
  flex-shrink: 0;
}

/* ---- Ghost list ---- */

.ghost-list {
  max-height: 320px;
  overflow-y: auto;
}

.empty-state {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.38);
  text-align: center;
  padding: 12px 8px;
}

/* ---- Ghost item ---- */

.ghost-item {
  padding: 4px 8px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.ghost-item-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 3px;
}

.ghost-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #ff9800;
  border: 1px solid rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}

.ghost-name {
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
  cursor: text;
}

.ghost-name--running {
  color: rgb(var(--v-theme-primary));
}

/* Inline-rename input: borrows the same metrics as `.ghost-name`
   so the name doesn't shift when entering / leaving edit mode. */
.ghost-name--input {
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgba(var(--v-theme-primary), 0.6);
  border-radius: 2px;
  color: rgb(var(--v-theme-on-surface));
  outline: none;
  padding: 0 4px;
  margin: -1px 0;
}

.ghost-item-detail {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ghost-meta {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.55);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.ghost-speed-row {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

/* ---- Speed input ---- */

.speed-input {
  font-size: 11px;
  width: 52px;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  color: rgb(var(--v-theme-on-surface));
  padding: 1px 4px;
  outline: none;
  font-family: monospace;
  /* Hide browser number spinners */
  -moz-appearance: textfield;
}

.speed-input::-webkit-outer-spin-button,
.speed-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
}

.speed-unit {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  margin-left: 3px;
}

/* ---- Create form ---- */

.create-form {
  padding: 6px 8px 8px;
}

.divider {
  height: 1px;
  background: rgb(var(--v-theme-surface-variant));
  margin: 5px 0;
}

.section-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.38);
  margin-bottom: 3px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.form-label {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(var(--v-theme-on-surface), 0.45);
  width: 36px;
  flex-shrink: 0;
}

.panel-select {
  flex: 1;
  font-size: 11px;
  background: rgba(var(--v-theme-surface-variant), 0.3);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 3px;
  color: rgb(var(--v-theme-on-surface));
  padding: 2px 4px;
  outline: none;
  cursor: pointer;
}

.panel-select option {
  background: rgb(var(--v-theme-surface));
}

/* ---- Direction pills ---- */

.dir-pills {
  display: flex;
  gap: 3px;
}

.pill {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 1px 7px;
  border-radius: 3px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: transparent;
  color: rgba(var(--v-theme-on-surface), 0.45);
  cursor: pointer;
  line-height: 16px;
}

.pill:hover {
  background: rgba(var(--v-theme-surface-variant), 0.5);
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.pill--active {
  background: rgba(var(--v-theme-primary), 0.15);
  border-color: rgba(var(--v-theme-primary), 0.5);
  color: rgb(var(--v-theme-primary));
}

.pill:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---- Edit popover (v-menu content) ---- */
/* Reuses the same form vocabulary as the create form so the
   inline edit feels consistent. v-menu renders the content in
   an overlay layer; we wrap it in a fixed-width card. */
.edit-popover {
  width: 220px;
  background: rgba(var(--v-theme-surface), 0.97);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  padding: 6px 8px 8px;
}

/* ---- Form actions ---- */

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
</style>
