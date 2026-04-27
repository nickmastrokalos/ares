import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getStore } from '@/plugins/store'
import { useAppStore } from '@/stores/app'

// Single source of truth for which settings exist and their default values.
// Adding a new setting is: add a default here, add a matching `ref` below
// (and expose it from the store), and register it in the `refs` map.
const DEFAULTS = {
  showFeatureLabels: true,
  selectedBasemap: 'osm',
  // Inbound network connections — UDP / TCP listeners. Each entry has
  // an `ownerKind` of 'host' (Ares-owned, CoT-parsed protected core),
  // 'adhoc' (user-added CoT listener for additional TAK groups), or
  // 'plugin' (a plugin registered the kind via api.connections.registerKind
  // and parses bytes itself). See `PROTECTED_CONNECTIONS` below for the
  // three host-owned entries seeded on first run.
  connections: [],
  distanceUnits: 'metric',
  coordinateFormat: 'dd',
  trackBreadcrumbs: false,
  // Tail length is now a fixed map distance in meters, not a time window.
  // Same value applies to every track type (CoT history trails, AIS and
  // ADS-B synthetic backward projections), so a slow vessel and a fast
  // jet draw tails of identical visual length.
  trackBreadcrumbLength: 1000,  // meters
  milStdSymbology: false,
  basemapOpacity: 1.0,
  enabledPlugins: [],         // plugin ids the operator has opted into
  assistantProvider: 'anthropic',
  assistantModel: 'claude-sonnet-4-6',
  assistantApiKey: '',
  // Last app version the user dismissed the "what's new" overlay for.
  // null = never seen (i.e. fresh install) — see App.vue mount logic.
  lastSeenVersion: null,

  // ---- TAK identity ----
  // Callsign shown to peers in GeoChat and outbound CoT. `null` means the
  // operator has never set one — chat features gate on this and prompt the
  // user to pick a callsign before sending or announcing presence.
  selfCallsign: null,
  // Stable per-install UID. Generated on first load if missing — peers key
  // direct chat threads by this. Don't reuse across reinstalls.
  selfUid: null,
  // Operator's MIL-STD-2525 affiliation — `f` / `h` / `n` / `u`. Drives the
  // first attribute of `selfCotType` and is what `TrackTypePicker` uses to
  // colour preview icons. Defaults to friendly because that's the dominant
  // operator-self pattern in TAK.
  selfAffiliation: 'f',
  // Full CoT type string for the operator (e.g. `a-f-G-U-C-I` infantry).
  // `null` = "no type picked yet"; the announce broadcaster falls back to
  // the v1 placeholder `a-f-G-U-C` so behaviour doesn't regress.
  selfCotType: null,
  // Manual operator location, `{ lat, lon }` or `null`. `null` = "no
  // position set" → announce uses lat/lon (0, 0). When set, the announce
  // broadcasts these coordinates so peers see the operator on their map
  // at the right place.
  selfLocation: null,
  // TAK team color — drives the `<__group name>` value in outbound
  // announces. ATAK / WinTAK render the named color as a halo around
  // the operator's icon and use it for team-coordination grouping in
  // the chat panel. Defaults to Cyan, the historical ATAK default.
  selfTeam: 'Cyan',
  // TAK team role — drives the `<__group role>` value. Defaults to
  // Team Member; other valid values are Team Lead, HQ, Sniper, Medic,
  // Forward Observer, RTO, K9.
  selfRole: 'Team Member',
  // Master switch for TAK outbound. Defaults off — nothing emits until
  // the operator explicitly activates from the chat panel or
  // Settings → Network. Inbound listeners stay on regardless so peers'
  // broadcasts continue to populate the track list.
  takActive: false
}

// Three protected (host-owned) connections seeded on first run. They can be
// edited (e.g. point them at a custom group on a non-default network) or
// disabled, but not deleted — the chat store derives its outbound
// destination from the `tak-chat-messages` entry, so removing it would
// silently break chat. `parser: 'cot'` routes inbound bytes through the
// host's `parse_cot` pipeline.
const PROTECTED_CONNECTIONS = [
  {
    kind: 'tak-chat-messages',
    name: 'GeoChat Messages',
    address: '224.10.10.1',
    port: 17012,
    protocol: 'udp',
    enabled: true,
    protected: true,
    ownerKind: 'host',
    ownerPluginId: null,
    parser: 'cot'
  },
  {
    kind: 'tak-chat-announce',
    name: 'GeoChat Announce',
    address: '224.10.10.1',
    port: 18740,
    protocol: 'udp',
    enabled: true,
    protected: true,
    ownerKind: 'host',
    ownerPluginId: null,
    parser: 'cot'
  },
  {
    kind: 'tak-sa',
    name: 'SA Multicast',
    address: '239.2.3.1',
    port: 6969,
    protocol: 'udp',
    enabled: true,
    protected: true,
    ownerKind: 'host',
    ownerPluginId: null,
    parser: 'cot'
  }
]

const HOST_PROTECTED_KINDS = new Set(PROTECTED_CONNECTIONS.map(c => c.kind))

/**
 * Normalize a saved connection row to the new schema. Pre-1.1.6 rows
 * only had `kind`/`name`/`address`/`port`/`protocol`/`enabled`/`protected`
 * — the rest is inferred:
 *   - kinds matching the protected core → ownerKind 'host', parser 'cot'
 *   - everything else → ownerKind 'adhoc', parser 'cot'
 *
 * Plugin-owned rows are persisted with their full schema once they're
 * created via `api.connections.registerKind`, so on a clean upgrade we
 * never see a row with a plugin kind that's missing ownerKind.
 */
function normalizeConnection(row, freshUuid) {
  const isHost = HOST_PROTECTED_KINDS.has(row.kind)
  return {
    kind:          row.kind ?? (isHost ? row.kind : `cot-adhoc-${freshUuid()}`),
    name:          row.name ?? row.kind ?? 'Listener',
    address:       row.address,
    port:          row.port,
    protocol:      row.protocol ?? 'udp',
    enabled:       row.enabled !== false,
    protected:     row.protected ?? isHost,
    ownerKind:     row.ownerKind ?? (isHost ? 'host' : 'adhoc'),
    ownerPluginId: row.ownerPluginId ?? null,
    parser:        row.parser ?? 'cot'
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const appStore = useAppStore()

  const showFeatureLabels = ref(DEFAULTS.showFeatureLabels)
  const selectedBasemap = ref(DEFAULTS.selectedBasemap)
  const connections = ref([...DEFAULTS.connections])
  const distanceUnits = ref(DEFAULTS.distanceUnits)
  const coordinateFormat = ref(DEFAULTS.coordinateFormat)
  const trackBreadcrumbs = ref(DEFAULTS.trackBreadcrumbs)
  const trackBreadcrumbLength = ref(DEFAULTS.trackBreadcrumbLength)
  const milStdSymbology = ref(DEFAULTS.milStdSymbology)
  const basemapOpacity = ref(DEFAULTS.basemapOpacity)
  const enabledPlugins = ref([...DEFAULTS.enabledPlugins])
  const assistantProvider = ref(DEFAULTS.assistantProvider)
  const assistantModel = ref(DEFAULTS.assistantModel)
  const assistantApiKey = ref(DEFAULTS.assistantApiKey)
  const lastSeenVersion = ref(DEFAULTS.lastSeenVersion)
  const selfCallsign    = ref(DEFAULTS.selfCallsign)
  const selfUid         = ref(DEFAULTS.selfUid)
  const selfAffiliation = ref(DEFAULTS.selfAffiliation)
  const selfCotType     = ref(DEFAULTS.selfCotType)
  const selfLocation    = ref(DEFAULTS.selfLocation)
  const selfTeam        = ref(DEFAULTS.selfTeam)
  const selfRole        = ref(DEFAULTS.selfRole)
  const takActive       = ref(DEFAULTS.takActive)

  // Keyed lookup so `setSetting(key, value)` can update the right ref
  // without a growing switch statement as we add more settings.
  const refs = {
    showFeatureLabels,
    selectedBasemap,
    connections,
    distanceUnits,
    coordinateFormat,
    trackBreadcrumbs,
    trackBreadcrumbLength,
    milStdSymbology,
    basemapOpacity,
    enabledPlugins,
    assistantProvider,
    assistantModel,
    assistantApiKey,
    lastSeenVersion,
    selfCallsign,
    selfUid,
    selfAffiliation,
    selfCotType,
    selfLocation,
    selfTeam,
    selfRole,
    takActive
  }

  // Promise cache: `load()` may be called from multiple places during boot
  // (App.vue on mount, MapView.vue before initializing map layers). Both
  // callers share the same in-flight read.
  let loadPromise = null

  // Settings that intentionally don't persist across restarts. The user
  // has to opt back in each session; saved values from prior runs are
  // ignored on load and writes are no-ops on disk (the ref value still
  // updates so in-session UI works normally). `takActive` is in here
  // because outbound CoT (presence announces + GeoChat send) should be
  // an explicit per-session opt-in, not a stale flag that quietly
  // re-enables the radio across restarts.
  const SESSION_ONLY = new Set(['enabledPlugins', 'takActive'])

  async function load() {
    if (loadPromise) return loadPromise
    appStore.beginLoad()
    loadPromise = (async () => {
      try {
        const store = await getStore()
        for (const key of Object.keys(refs)) {
          if (SESSION_ONLY.has(key)) continue
          const stored = await store.get(key)
          // Only override the default when the user has actually set a value —
          // `null`/`undefined` mean "never written" and should stay as default.
          if (stored !== undefined && stored !== null) {
            refs[key].value = stored
          }
        }
        // One-time migration: trackBreadcrumbLength was previously stored
        // in seconds (range 5..60) and is now stored in meters (range
        // 100..5000). Any persisted value at or below the old maximum is
        // a leftover from the old unit and would render as an invisibly
        // short tail — bump it to the new default.
        if (trackBreadcrumbLength.value <= 60) {
          trackBreadcrumbLength.value = DEFAULTS.trackBreadcrumbLength
          await store.set('trackBreadcrumbLength', trackBreadcrumbLength.value)
        }
        // Generate a stable selfUid on first run. Persists from then on,
        // so direct chat threads keyed by this UID stay consistent.
        if (!selfUid.value) {
          selfUid.value = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `ares-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
          await store.set('selfUid', selfUid.value)
        }

        // One-time migration: pre-1.1.6 stored connections under the
        // `cotListeners` key without owner / parser metadata. If we see
        // that key and `connections` is empty, copy the rows over and
        // delete the legacy key. Each row is normalized through
        // `normalizeConnection` to gain ownerKind / parser / protected
        // defaults.
        const legacy = await store.get('cotListeners')
        if (Array.isArray(legacy) && !connections.value.length) {
          const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
          connections.value = legacy.map(row => normalizeConnection(row, newId))
          await store.set('connections', connections.value)
          await store.delete('cotListeners')
        }

        // Re-normalize any rows that came back from the new key but
        // lack the new fields (defensive — a downgrade-then-upgrade
        // cycle could leave partial schema).
        let connectionsChanged = false
        for (let i = 0; i < connections.value.length; i++) {
          const row = connections.value[i]
          if (!row.ownerKind || !row.parser) {
            connections.value[i] = normalizeConnection(row, () => crypto.randomUUID?.() ?? Date.now().toString(36))
            connectionsChanged = true
          }
        }

        // Seed protected (host-owned) connections. Match by `kind` so
        // a user who happens to have an entry on the same address /
        // port doesn't get a duplicate. Existing rows are untouched.
        for (const seed of PROTECTED_CONNECTIONS) {
          const exists = connections.value.some(c => c.kind === seed.kind)
          if (!exists) {
            connections.value.push({ ...seed })
            connectionsChanged = true
          }
        }
        if (connectionsChanged) {
          await store.set('connections', connections.value)
        }
      } finally {
        appStore.endLoad()
      }
    })()
    return loadPromise
  }

  async function setSetting(key, value) {
    if (!(key in refs)) return
    refs[key].value = value
    if (SESSION_ONLY.has(key)) return    // intentional: don't persist
    const store = await getStore()
    await store.set(key, value)
  }

  async function saveConnections() {
    const store = await getStore()
    await store.set('connections', connections.value)
  }

  /**
   * Add a user-owned ad-hoc CoT listener. The new row is fully editable
   * and deletable (`ownerKind: 'adhoc'`, `parser: 'cot'`). Used by the
   * "Add CoT Listener" wizard for additional TAK groups beyond the
   * three protected core entries.
   */
  async function addAdhocCotConnection({ name, address, port, protocol = 'udp' }) {
    const newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
    connections.value.push({
      kind:          `cot-adhoc-${newId}`,
      name:          name || 'CoT Listener',
      address,
      port,
      protocol,
      enabled:       true,
      protected:     false,
      ownerKind:     'adhoc',
      ownerPluginId: null,
      parser:        'cot'
    })
    await saveConnections()
  }

  /**
   * Add or refresh a plugin-owned connection. Called by
   * `api.connections.registerKind` from the plugin host registry. If
   * a row with this `kind` already exists, only the metadata fields
   * (name / ownerPluginId) are touched — the user's persisted
   * address / port / protocol / enabled values stay so plugin
   * reinstalls don't blow away their config.
   */
  async function upsertPluginConnection({
    kind, name, ownerPluginId,
    defaultAddress, defaultPort, defaultProtocol = 'udp'
  }) {
    const existing = connections.value.find(c => c.kind === kind)
    if (existing) {
      existing.name          = name
      existing.ownerKind     = 'plugin'
      existing.ownerPluginId = ownerPluginId
      existing.parser        = 'plugin'
      existing.protected     = true
      await saveConnections()
      return existing
    }
    const fresh = {
      kind,
      name,
      address:       defaultAddress,
      port:          defaultPort,
      protocol:      defaultProtocol,
      enabled:       false,            // user opts in
      protected:     true,
      ownerKind:     'plugin',
      ownerPluginId,
      parser:        'plugin'
    }
    connections.value.push(fresh)
    await saveConnections()
    return fresh
  }

  async function updateConnection(index, patch) {
    Object.assign(connections.value[index], patch)
    await saveConnections()
  }

  async function removeConnection(index) {
    connections.value.splice(index, 1)
    await saveConnections()
  }

  async function toggleConnection(index) {
    connections.value[index].enabled = !connections.value[index].enabled
    await saveConnections()
  }

  return {
    showFeatureLabels,
    selectedBasemap,
    connections,
    distanceUnits,
    coordinateFormat,
    trackBreadcrumbs,
    trackBreadcrumbLength,
    milStdSymbology,
    basemapOpacity,
    enabledPlugins,
    assistantProvider,
    assistantModel,
    assistantApiKey,
    lastSeenVersion,
    selfCallsign,
    selfUid,
    selfAffiliation,
    selfCotType,
    selfLocation,
    selfTeam,
    selfRole,
    takActive,
    load,
    setSetting,
    addAdhocCotConnection,
    upsertPluginConnection,
    updateConnection,
    removeConnection,
    toggleConnection
  }
})
