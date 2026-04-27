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
  cotListeners: [],
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

// Three protected listeners are seeded on first run so the standard TAK
// multicast groups are always present in the listeners list. They can be
// edited (e.g. point them at a custom group on a non-default network) or
// disabled, but not deleted — the chat store derives its outbound
// destination from the `tak-chat-messages` listener, so removing it would
// silently break chat.
const PROTECTED_LISTENERS = [
  {
    kind: 'tak-chat-messages',
    name: 'GeoChat Messages',
    address: '224.10.10.1',
    port: 17012,
    protocol: 'udp',
    enabled: true,
    protected: true
  },
  {
    kind: 'tak-chat-announce',
    name: 'GeoChat Announce',
    address: '224.10.10.1',
    port: 18740,
    protocol: 'udp',
    enabled: true,
    protected: true
  },
  {
    kind: 'tak-sa',
    name: 'SA Multicast',
    address: '239.2.3.1',
    port: 6969,
    protocol: 'udp',
    enabled: true,
    protected: true
  }
]

export const useSettingsStore = defineStore('settings', () => {
  const appStore = useAppStore()

  const showFeatureLabels = ref(DEFAULTS.showFeatureLabels)
  const selectedBasemap = ref(DEFAULTS.selectedBasemap)
  const cotListeners = ref([...DEFAULTS.cotListeners])
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
    cotListeners,
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

        // Seed protected listeners (TAK chat + SA multicast) if they're
        // not already in the saved list. Match by `kind` so a user who
        // happens to have a listener at the same address/port doesn't
        // get a duplicate. Existing user-added entries are untouched.
        let listenersChanged = false
        for (const seed of PROTECTED_LISTENERS) {
          const exists = cotListeners.value.some(l => l.kind === seed.kind)
          if (!exists) {
            cotListeners.value.push({ ...seed })
            listenersChanged = true
          }
        }
        if (listenersChanged) {
          await store.set('cotListeners', cotListeners.value)
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

  async function saveCotListeners() {
    const store = await getStore()
    await store.set('cotListeners', cotListeners.value)
  }

  async function addCotListener({ name, address, port, protocol }) {
    cotListeners.value.push({ name, address, port, protocol, enabled: true })
    await saveCotListeners()
  }

  async function updateCotListener(index, patch) {
    Object.assign(cotListeners.value[index], patch)
    await saveCotListeners()
  }

  async function removeCotListener(index) {
    cotListeners.value.splice(index, 1)
    await saveCotListeners()
  }

  async function toggleCotListener(index) {
    cotListeners.value[index].enabled = !cotListeners.value[index].enabled
    await saveCotListeners()
  }

  return {
    showFeatureLabels,
    selectedBasemap,
    cotListeners,
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
    addCotListener,
    updateCotListener,
    removeCotListener,
    toggleCotListener
  }
})
