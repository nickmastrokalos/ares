<script setup>
import { ref, computed, inject, watch } from 'vue'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useSettingsStore } from '@/stores/settings'
import { useTileserverStore } from '@/stores/tileserver'
import TrackTypePicker from '@/components/TrackTypePicker.vue'

const props = defineProps({
  modelValue: Boolean
})
const emit = defineEmits(['update:modelValue'])

const settingsStore   = useSettingsStore()
const tileserverStore = useTileserverStore()

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const TABS = [
  { id: 'display', label: 'Display', icon: 'mdi-monitor-eye' },
  { id: 'tracks',  label: 'Tracks',  icon: 'mdi-radar' },
  { id: 'network', label: 'Network', icon: 'mdi-lan' },
  { id: 'maps',    label: 'Maps',    icon: 'mdi-map-outline' },
  { id: 'plugins', label: 'Plugins', icon: 'mdi-puzzle-outline' }
]

const pluginRegistry = inject('pluginRegistry', null)
const activeTab = ref(TABS[0].id)

// ---- Display settings ----

const showFeatureLabels = computed({
  get: () => settingsStore.showFeatureLabels,
  set: (v) => settingsStore.setSetting('showFeatureLabels', v)
})

const DISTANCE_UNITS = [
  { title: 'Metric (m / km)',   value: 'metric' },
  { title: 'Statute (ft / mi)', value: 'statute' },
  { title: 'Nautical (m / nm)', value: 'nautical' }
]

const distanceUnits = computed({
  get: () => settingsStore.distanceUnits,
  set: (v) => settingsStore.setSetting('distanceUnits', v)
})

const COORDINATE_FORMATS = [
  { title: 'Decimal degrees', value: 'dd' },
  { title: 'Deg / min / sec', value: 'dms' },
  { title: 'MGRS',            value: 'mgrs' }
]

const coordinateFormat = computed({
  get: () => settingsStore.coordinateFormat,
  set: (v) => settingsStore.setSetting('coordinateFormat', v)
})

const basemapOpacity = computed({
  get: () => settingsStore.basemapOpacity,
  set: (v) => settingsStore.setSetting('basemapOpacity', v)
})

function opacityLabel(v) {
  return `${Math.round(v * 100)}%`
}

// ---- Track settings ----

const trackBreadcrumbs = computed({
  get: () => settingsStore.trackBreadcrumbs,
  set: (v) => settingsStore.setSetting('trackBreadcrumbs', v)
})

const milStdSymbology = computed({
  get: () => settingsStore.milStdSymbology,
  set: (v) => settingsStore.setSetting('milStdSymbology', v)
})

const trackBreadcrumbLength = computed({
  get: () => settingsStore.trackBreadcrumbLength,
  set: (v) => settingsStore.setSetting('trackBreadcrumbLength', v)
})

function breadcrumbLengthLabel(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`
}

// ---- TAK identity ----
//
// Chat outbound destination is derived from the protected
// `tak-chat-messages` listener (configured in the Connections panel,
// not duplicated here) so there's only one place to point at the
// right multicast group.

// Callsign uses a local draft + commit-on-blur pattern so we don't write to
// the plugin store on every keystroke (which used to cause the next 60 s
// announce cycle to broadcast the partial string the user was typing).
const callsignDraft = ref(settingsStore.selfCallsign ?? '')
watch(() => settingsStore.selfCallsign, (val) => {
  if ((val ?? '') !== callsignDraft.value) callsignDraft.value = val ?? ''
})
function commitCallsign() {
  const trimmed = callsignDraft.value.trim()
  settingsStore.setSetting('selfCallsign', trimmed || null)
}

const takActive = computed({
  get: () => settingsStore.takActive,
  set: (v) => settingsStore.setSetting('takActive', v)
})

function regenerateSelfUid() {
  const uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `ares-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  settingsStore.setSetting('selfUid', uid)
}

// ---- Self type picker ----

const SELF_AFFILIATIONS = [
  { title: 'Friendly',  value: 'f' },
  { title: 'Hostile',   value: 'h' },
  { title: 'Neutral',   value: 'n' },
  { title: 'Unknown',   value: 'u' }
]

const selfAffiliation = computed({
  get: () => settingsStore.selfAffiliation ?? 'f',
  set: (v) => {
    settingsStore.setSetting('selfAffiliation', v)
    // Re-issue the cotType under the new affiliation so e.g. picking
    // "Hostile" while infantry is selected becomes `a-h-G-U-C-I` rather
    // than leaving the type stuck on the old prefix.
    const ct = settingsStore.selfCotType
    if (typeof ct === 'string' && ct.length >= 4) {
      settingsStore.setSetting('selfCotType', `a-${v}-${ct.slice(4)}`)
    }
  }
})

const selfCotType = computed({
  get: () => settingsStore.selfCotType,
  set: (v) => settingsStore.setSetting('selfCotType', v)
})

// ---- Self team + role ----
//
// 14 standard TAK team colors. The `name` is what goes on the wire
// in `<__group name>`; `hex` is purely for the swatch rendering in
// the picker. Values match the canonical ATAK/WinTAK palette.
const TAK_TEAM_COLORS = [
  { name: 'White',      hex: '#FFFFFF' },
  { name: 'Yellow',     hex: '#FFFF00' },
  { name: 'Orange',     hex: '#FF8C00' },
  { name: 'Magenta',    hex: '#FF00FF' },
  { name: 'Red',        hex: '#FF0000' },
  { name: 'Maroon',     hex: '#800000' },
  { name: 'Purple',     hex: '#800080' },
  { name: 'Dark Blue',  hex: '#000080' },
  { name: 'Blue',       hex: '#0000FF' },
  { name: 'Cyan',       hex: '#00FFFF' },
  { name: 'Teal',       hex: '#008080' },
  { name: 'Green',      hex: '#00FF00' },
  { name: 'Dark Green', hex: '#008000' },
  { name: 'Brown',      hex: '#A52A2A' }
]

const TAK_TEAM_ROLES = [
  'Team Member', 'Team Lead', 'HQ', 'Sniper',
  'Medic', 'Forward Observer', 'RTO', 'K9'
]

const selfTeam = computed({
  get: () => settingsStore.selfTeam ?? 'Cyan',
  set: (v) => settingsStore.setSetting('selfTeam', v)
})

const selfRole = computed({
  get: () => settingsStore.selfRole ?? 'Team Member',
  set: (v) => settingsStore.setSetting('selfRole', v)
})

function clearSelfCotType() {
  settingsStore.setSetting('selfCotType', null)
}

// ---- Self location ----

// Drafts so the user can type negative numbers / decimals without each
// keystroke being normalized + persisted. Commit on blur or via the
// "Use map center" shortcut.
const locationLatDraft = ref(
  settingsStore.selfLocation?.lat != null ? String(settingsStore.selfLocation.lat) : ''
)
const locationLonDraft = ref(
  settingsStore.selfLocation?.lon != null ? String(settingsStore.selfLocation.lon) : ''
)
watch(() => settingsStore.selfLocation, (loc) => {
  locationLatDraft.value = loc?.lat != null ? String(loc.lat) : ''
  locationLonDraft.value = loc?.lon != null ? String(loc.lon) : ''
})

function commitSelfLocation() {
  const latStr = locationLatDraft.value.trim()
  const lonStr = locationLonDraft.value.trim()
  // Both empty → clear (back to placeholder mode).
  if (!latStr && !lonStr) {
    settingsStore.setSetting('selfLocation', null)
    return
  }
  const lat = Number(latStr)
  const lon = Number(lonStr)
  if (!Number.isFinite(lat) || lat < -90  || lat > 90)  return
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return
  settingsStore.setSetting('selfLocation', { lat, lon })
}

// Map-side helpers, injected at setup time (calling inject() inside an
// event handler triggers Vue's "inject() can only be used inside setup()"
// warning and returns undefined, which is why the buttons silently
// no-op'd before).
const pickSelfLocationOnMap = inject('pickSelfLocation', null)
// Reactive flag that flips true while the map is in self-location-pick
// mode, then back to false when the operator clicks (or hits Escape).
// We close the dialog on entry and reopen when the flag goes false so
// the operator returns to the same Network tab they came from.
const selfLocationPicking = inject('selfLocationPicking', ref(false))

function pickOnMap() {
  // Close the settings dialog so the operator can click the map directly,
  // then ask MapView to enter "picking self location" mode for one click.
  if (typeof pickSelfLocationOnMap !== 'function') return
  emit('update:modelValue', false)
  pickSelfLocationOnMap()
}

// When the picker disarms (after a click commit OR Escape cancel),
// reopen the settings dialog so the operator can verify / continue
// without manually re-navigating.
watch(selfLocationPicking, (picking, prev) => {
  if (prev && !picking) emit('update:modelValue', true)
})

const chatMessagesEndpoint = computed(() => {
  const l = settingsStore.connections.find(x => x.kind === 'tak-chat-messages')
  if (!l) return '— not configured —'
  return `${(l.protocol || 'udp').toUpperCase()} ${l.address}:${l.port}`
})

// ---- Offline maps ----

const addingPath = ref(false)

async function pickFolder() {
  addingPath.value = true
  try {
    const selected = await openDialog({ directory: true, multiple: false })
    if (selected) await tileserverStore.addPath(selected)
  } finally {
    addingPath.value = false
  }
}

// Group tilesets by their parent path for display
function tilesetsForPath(path) {
  return tileserverStore.tilesets.filter(ts => ts.path.startsWith(path))
}

function formatBadge(ts) {
  return ts.format.toUpperCase()
}
</script>

<template>
  <v-dialog v-model="open" max-width="640">
    <v-card color="surface" rounded="sm" flat>
      <v-card-title class="d-flex align-center pa-3">
        <v-icon icon="mdi-cog-outline" size="20" class="me-2 text-medium-emphasis" />
        <span class="text-body-1">Settings</span>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          class="text-medium-emphasis"
          @click="open = false"
        />
      </v-card-title>

      <v-divider />

      <v-tabs
        v-model="activeTab"
        density="compact"
        color="primary"
        slider-color="primary"
        class="settings-tabs"
      >
        <v-tab
          v-for="tab in TABS"
          :key="tab.id"
          :value="tab.id"
          :prepend-icon="tab.icon"
          class="text-body-2"
        >
          {{ tab.label }}
        </v-tab>
      </v-tabs>

      <v-divider />

      <v-window v-model="activeTab" class="settings-window">

        <!-- ---- Display ---- -->
        <v-window-item value="display">
          <div class="pa-4">
            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">Show labels on map</div>
                <div class="text-caption text-medium-emphasis">
                  Render name labels for shapes, routes, tracks, and AIS vessels.
                </div>
              </div>
              <v-switch
                v-model="showFeatureLabels"
                color="primary"
                density="compact"
                hide-details
                inset
              />
            </div>

            <v-divider class="my-3" />

            <div>
              <div class="d-flex align-center mb-1">
                <div class="flex-grow-1">
                  <div class="text-body-2">Basemap dimming</div>
                  <div class="text-caption text-medium-emphasis">
                    Fade the basemap to make tracks and overlays stand out.
                  </div>
                </div>
                <span class="text-body-2 length-value">
                  {{ opacityLabel(basemapOpacity) }}
                </span>
              </div>
              <v-slider
                v-model="basemapOpacity"
                :min="0"
                :max="1"
                :step="0.05"
                density="compact"
                hide-details
                thumb-size="14"
                track-size="2"
                color="primary"
              />
              <div class="d-flex justify-space-between text-caption text-medium-emphasis mt-1">
                <span>Off</span>
                <span>Full</span>
              </div>
            </div>

            <v-divider class="my-3" />

            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">Distance units</div>
                <div class="text-caption text-medium-emphasis">
                  Units used for measurements and distance readouts.
                </div>
              </div>
              <v-select
                v-model="distanceUnits"
                :items="DISTANCE_UNITS"
                density="compact"
                variant="outlined"
                rounded="sm"
                hide-details
                style="max-width: 180px"
              />
            </div>

            <v-divider class="my-3" />

            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">Coordinate format</div>
                <div class="text-caption text-medium-emphasis">
                  Format used for coordinates in the map footer.
                </div>
              </div>
              <v-select
                v-model="coordinateFormat"
                :items="COORDINATE_FORMATS"
                density="compact"
                variant="outlined"
                rounded="sm"
                hide-details
                style="max-width: 180px"
              />
            </div>
          </div>
        </v-window-item>

        <!-- ---- Tracks ---- -->
        <v-window-item value="tracks">
          <div class="pa-4">
            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">CoT track breadcrumbs</div>
                <div class="text-caption text-medium-emphasis">
                  Show a trail of past positions behind each CoT track. AIS and ADS-B have their own toggles in their feed panels.
                </div>
              </div>
              <v-switch
                v-model="trackBreadcrumbs"
                color="primary"
                density="compact"
                hide-details
                inset
              />
            </div>

            <v-divider class="my-3" />

            <div :class="{ 'text-disabled': !trackBreadcrumbs }">
              <div class="d-flex align-center mb-1">
                <div class="flex-grow-1">
                  <div class="text-body-2">Breadcrumb length</div>
                  <div class="text-caption text-medium-emphasis">
                    Fixed map distance — same visual length for every track type, regardless of speed.
                  </div>
                </div>
                <span class="text-body-2 length-value">
                  {{ breadcrumbLengthLabel(trackBreadcrumbLength) }}
                </span>
              </div>
              <v-slider
                v-model="trackBreadcrumbLength"
                :min="100"
                :max="5000"
                :step="100"
                :disabled="!trackBreadcrumbs"
                density="compact"
                hide-details
                thumb-size="14"
                track-size="2"
                color="primary"
              />
              <div class="d-flex justify-space-between text-caption text-medium-emphasis mt-1">
                <span>5s</span>
                <span>1 min</span>
              </div>
            </div>

            <v-divider class="my-3" />

            <div class="d-flex align-center">
              <div class="flex-grow-1">
                <div class="text-body-2">MIL-STD-2525 symbology</div>
                <div class="text-caption text-medium-emphasis">
                  Replace track dots with military symbology icons based on CoT type.
                </div>
              </div>
              <v-switch
                v-model="milStdSymbology"
                color="primary"
                density="compact"
                hide-details
                inset
              />
            </div>
          </div>
        </v-window-item>

        <!-- ---- Network (TAK identity + chat) ---- -->
        <v-window-item value="network">
          <div class="pa-4">

            <div class="d-flex align-center mb-1">
              <div class="text-body-2 flex-grow-1">TAK comms active</div>
              <v-switch
                v-model="takActive"
                color="primary"
                density="compact"
                hide-details
                inset
                class="flex-shrink-0 ma-0"
              />
            </div>
            <div class="text-caption text-medium-emphasis mb-3">
              Master switch for outbound traffic. When off, Ares does not
              emit presence announces or chat messages. Inbound listeners
              stay running so peer broadcasts still populate the track
              list.
            </div>

            <v-divider class="my-3" />

            <div class="text-overline mb-1">TAK Identity</div>
            <div class="text-caption text-medium-emphasis mb-3">
              Callsign and UID peers see when you send chat or other CoT.
              The UID is generated on first run and persists across sessions.
            </div>

            <v-text-field
              v-model="callsignDraft"
              label="Callsign"
              density="compact"
              hide-details
              variant="outlined"
              spellcheck="false"
              autocomplete="off"
              class="mb-3"
              @blur="commitCallsign"
              @keydown.enter.prevent="commitCallsign"
            />

            <div class="d-flex align-center ga-2 mb-4">
              <v-text-field
                :model-value="settingsStore.selfUid ?? ''"
                label="UID"
                density="compact"
                hide-details
                variant="outlined"
                readonly
                class="flex-grow-1"
                style="font-family: monospace;"
              />
              <v-btn
                size="small"
                variant="tonal"
                @click="regenerateSelfUid"
              >
                Regenerate
              </v-btn>
            </div>

            <v-divider class="my-3" />

            <div class="text-overline mb-1">Type</div>
            <div class="text-caption text-medium-emphasis mb-3">
              MIL-STD-2525 affiliation and type peers see for the operator.
              Same picker the manual-track flow uses.
            </div>

            <div class="d-flex align-center ga-2 mb-3">
              <v-select
                v-model="selfAffiliation"
                :items="SELF_AFFILIATIONS"
                label="Affiliation"
                density="compact"
                hide-details
                variant="outlined"
                style="width: 160px;"
              />
              <v-btn
                v-if="selfCotType"
                size="small"
                variant="text"
                @click="clearSelfCotType"
              >
                Clear type
              </v-btn>
            </div>

            <TrackTypePicker
              :affiliation="selfAffiliation"
              :model-value="selfCotType"
              @update:model-value="(v) => selfCotType = v"
            />

            <v-divider class="my-3" />

            <div class="text-overline mb-1">Team</div>
            <div class="text-caption text-medium-emphasis mb-3">
              Color and role peers see in their contact list and chat
              roster. Color drives the halo around your icon on other
              clients' maps.
            </div>

            <div class="d-flex align-center ga-2 mb-3">
              <v-select
                v-model="selfTeam"
                :items="TAK_TEAM_COLORS"
                item-title="name"
                item-value="name"
                label="Team color"
                density="compact"
                hide-details
                variant="outlined"
                style="flex: 1;"
              >
                <template #selection="{ item }">
                  <div class="d-flex align-center ga-2">
                    <span class="self-team-swatch" :style="{ background: item.raw.hex }" />
                    <span>{{ item.raw.name }}</span>
                  </div>
                </template>
                <template #item="{ props: itemProps, item }">
                  <v-list-item v-bind="itemProps" :title="''">
                    <template #prepend>
                      <span class="self-team-swatch" :style="{ background: item.raw.hex }" />
                    </template>
                    <v-list-item-title>{{ item.raw.name }}</v-list-item-title>
                  </v-list-item>
                </template>
              </v-select>
              <v-select
                v-model="selfRole"
                :items="TAK_TEAM_ROLES"
                label="Role"
                density="compact"
                hide-details
                variant="outlined"
                style="flex: 1;"
              />
            </div>

            <v-divider class="my-3" />

            <div class="text-overline mb-1">Location</div>
            <div class="text-caption text-medium-emphasis mb-3">
              Manually-set operator position broadcast on the presence
              announce. Empty = no manual position; the announce broadcasts
              at lat/lon (0, 0) as a presence-only beacon.
            </div>

            <div class="d-flex align-center ga-2 mb-4">
              <v-text-field
                v-model="locationLatDraft"
                label="Latitude"
                type="number"
                density="compact"
                hide-details
                variant="outlined"
                style="width: 140px; font-family: monospace;"
                @blur="commitSelfLocation"
                @keydown.enter.prevent="commitSelfLocation"
              />
              <v-text-field
                v-model="locationLonDraft"
                label="Longitude"
                type="number"
                density="compact"
                hide-details
                variant="outlined"
                style="width: 140px; font-family: monospace;"
                @blur="commitSelfLocation"
                @keydown.enter.prevent="commitSelfLocation"
              />
              <v-btn
                size="small"
                variant="tonal"
                @click="pickOnMap"
              >
                Pick on map
              </v-btn>
            </div>

            <v-divider class="my-3" />

            <div class="text-overline mb-1">Network groups</div>
            <div class="text-caption text-medium-emphasis">
              GeoChat outbound is sent to whatever address is configured for
              the <strong>GeoChat Messages</strong> listener (currently
              <code>{{ chatMessagesEndpoint }}</code>). Edit it from the
              Connections panel if your network uses a different multicast
              group. The seeded TAK groups (Messages, Announce, SA Multicast)
              can be retargeted or disabled but not deleted.
            </div>

          </div>
        </v-window-item>

        <!-- ---- Maps ---- -->
        <v-window-item value="maps">
          <div class="pa-4">

            <div class="d-flex align-center justify-space-between mb-3">
              <div>
                <div class="text-body-2">Offline tile paths</div>
                <div class="text-caption text-medium-emphasis">
                  Folders containing .mbtiles files served on 127.0.0.1:3650.
                </div>
              </div>
              <v-btn
                size="small"
                variant="tonal"
                prepend-icon="mdi-folder-plus-outline"
                :loading="addingPath"
                @click="pickFolder"
              >
                Add folder
              </v-btn>
            </div>

            <!-- Empty state -->
            <div
              v-if="tileserverStore.paths.length === 0"
              class="empty-paths text-caption text-medium-emphasis"
            >
              No paths configured. Add a folder containing .mbtiles files.
            </div>

            <!-- Path list -->
            <div
              v-for="path in tileserverStore.paths"
              :key="path"
              class="path-block"
            >
              <div class="path-row">
                <v-icon size="14" class="text-medium-emphasis flex-shrink-0">mdi-folder-outline</v-icon>
                <span class="path-text text-caption">{{ path }}</span>
                <v-btn
                  icon="mdi-close"
                  size="x-small"
                  variant="text"
                  class="text-medium-emphasis flex-shrink-0"
                  @click="tileserverStore.removePath(path)"
                />
              </div>

              <!-- Tilesets found in this path -->
              <div class="tileset-list">
                <div
                  v-if="tilesetsForPath(path).length === 0"
                  class="text-caption text-disabled ps-5 pb-1"
                >
                  No .mbtiles files found
                </div>
                <div
                  v-for="ts in tilesetsForPath(path)"
                  :key="ts.name"
                  class="tileset-row"
                >
                  <v-icon size="12" class="text-medium-emphasis">mdi-map-outline</v-icon>
                  <span class="text-caption">{{ ts.display_name }}</span>
                  <span class="format-badge">{{ formatBadge(ts) }}</span>
                  <span class="text-caption text-disabled zoom-range">
                    z{{ ts.minzoom }}–{{ ts.maxzoom }}
                  </span>
                </div>
              </div>
            </div>

          </div>
        </v-window-item>

        <!-- ---- Plugins ---- -->
        <v-window-item value="plugins">
          <div class="pa-4">

            <div class="d-flex align-center ga-2 mb-3">
              <v-icon size="14" class="text-medium-emphasis">mdi-alert-outline</v-icon>
              <span class="text-caption text-medium-emphasis">
                Only enable plugins from sources you trust. Plugins run with full app permissions.
              </span>
            </div>

            <div v-if="!pluginRegistry || pluginRegistry.discoveredPlugins.value.length === 0" class="empty-paths text-caption text-medium-emphasis">
              No plugins found. Drop <code>.js</code> files into the plugins folder in your app data directory, then restart.
            </div>

            <div
              v-for="plugin in pluginRegistry?.discoveredPlugins.value ?? []"
              :key="plugin.id"
              class="plugin-row"
            >
              <div class="plugin-info">
                <span class="plugin-name text-body-2">{{ plugin.name }}</span>
                <span class="plugin-version text-caption text-medium-emphasis">v{{ plugin.version }}</span>
                <span v-if="plugin.error" class="plugin-error text-caption">{{ plugin.error }}</span>
              </div>
              <v-switch
                :model-value="plugin.active"
                :disabled="plugin.incompatible"
                color="primary"
                density="compact"
                hide-details
                inset
                @update:model-value="(v) => v ? pluginRegistry.enablePlugin(plugin.id) : pluginRegistry.disablePlugin(plugin.id)"
              />
            </div>

          </div>
        </v-window-item>

      </v-window>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.settings-tabs {
  min-height: 40px;
}

.length-value {
  min-width: 48px;
  text-align: right;
}

/* TAK team-color swatch in the Network → Team picker. Inline-block
   so it sits next to the color name in both the selection chip and
   the dropdown rows. */
.self-team-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  flex-shrink: 0;
}

/* ---- Offline maps tab ---- */

.empty-paths {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.15);
  border-radius: 4px;
  padding: 16px;
  text-align: center;
}

.path-block {
  margin-bottom: 8px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
}

.path-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 8px;
  background: rgba(var(--v-theme-surface-variant), 0.3);
}

.path-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
  opacity: 0.7;
}

.tileset-list {
  padding: 4px 8px 6px 8px;
}

.tileset-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.format-badge {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: rgba(var(--v-theme-on-surface), 0.45);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.2);
  border-radius: 2px;
  padding: 0 3px;
  line-height: 14px;
}

.zoom-range {
  margin-left: auto;
}

/* ---- Plugins tab ---- */

.plugin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
}

.plugin-row:last-child {
  border-bottom: none;
}

.plugin-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.plugin-name {
  font-weight: 500;
}

.plugin-version {
  font-family: monospace;
  font-size: 10px;
}

.plugin-error {
  color: rgb(var(--v-theme-error));
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Cap the tab body so the dialog never overflows the app window. The
   header + tab strip together are roughly 96 px; leaving 80vh for the
   whole dialog gives a comfortable scrolling area for tall tabs like
   Network. */
.settings-window {
  max-height: calc(80vh - 96px);
  overflow-y: auto;
}
</style>
