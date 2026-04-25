import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getStore } from '@/plugins/store'
import { useSettingsStore } from '@/stores/settings'

export const useAisStore = defineStore('ais', () => {
  const settingsStore = useSettingsStore()

  // ---- Persisted config ----
  const feedUrl       = ref('https://aisfeed.com')
  const apiKey        = ref('')
  const enabled       = ref(false)
  const visible       = ref(true)
  // True = vessel icons render as direction-aware arrows (rotated to COG).
  // False = vessel icons render as plain circles. The breadcrumb trail
  // (history-based fading line behind each vessel) is now controlled by
  // the shared `settingsStore.trackBreadcrumbs` / `trackBreadcrumbLength`
  // pair, the same setting that drives CoT track trails.
  const headingArrows = ref(false)

  // ---- Runtime state ----
  const vessels    = ref(new Map())  // mmsi string → raw item (with `history`)
  const lastFetch  = ref(null)       // Date | null
  const fetchError = ref(null)       // string | null
  const loading    = ref(false)

  // Maximum history window kept in memory per vessel. The shared breadcrumb
  // length setting controls how much of this is *shown* — we keep more so
  // the user can extend the window without losing data. Mirrors the CoT
  // history strategy in `stores/tracks.js`.
  const MAX_HISTORY_MS = 30 * 60 * 1000

  // ---- Computed ----

  const vesselCollection = computed(() => ({
    type: 'FeatureCollection',
    features: visible.value
      ? Array.from(vessels.value.values()).map(v => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [v.longitude, v.latitude] },
          properties: {
            mmsi:       v.mmsi,
            name:       v.name ?? String(v.mmsi),
            speed:      v.SOG ?? 0,
            course:     (v.COG >= 0)     ? v.COG     : null,
            heading:    (v.heading >= 0) ? v.heading : null,
            navStatus:  v.navStatus  ?? '',
            vesselType: v.vesselType ?? ''
          }
        }))
      : []
  }))

  // Vessel position history rendered as fading polylines, gated by the
  // shared `trackBreadcrumbs` toggle and clipped to the shared
  // `trackBreadcrumbLength` (seconds). One feature per vessel with at
  // least two history points within the window.
  const breadcrumbCollection = computed(() => {
    if (!settingsStore.trackBreadcrumbs || !visible.value) {
      return { type: 'FeatureCollection', features: [] }
    }
    const cutoff = Date.now() - settingsStore.trackBreadcrumbLength * 1000
    const features = []
    for (const v of vessels.value.values()) {
      const coords = (v.history ?? [])
        .filter(h => h.t >= cutoff)
        .map(h => [h.lon, h.lat])
      if (coords.length < 2) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { mmsi: v.mmsi }
      })
    }
    return { type: 'FeatureCollection', features }
  })

  const vesselCount = computed(() => vessels.value.size)

  // ---- Panel management ----

  const openPanelList = ref([])
  const focusedMmsi   = ref(null)

  function openPanel(mmsi) {
    if (!openPanelList.value.includes(mmsi)) openPanelList.value.push(mmsi)
    focusedMmsi.value = mmsi
  }

  function closePanel(mmsi) {
    openPanelList.value = openPanelList.value.filter(m => m !== mmsi)
    if (focusedMmsi.value === mmsi) focusedMmsi.value = null
  }

  // ---- Persistence ----

  async function load() {
    try {
      const store = await getStore()
      const saved = await store.get('aisConfig')
      if (!saved) return
      if (saved.feedUrl != null) feedUrl.value = saved.feedUrl
      if (saved.apiKey  != null) apiKey.value  = saved.apiKey
      if (saved.enabled != null) enabled.value = saved.enabled
      if (saved.visible != null) visible.value = saved.visible
      // Honour the new `headingArrows` key, falling back to the legacy
      // `aisBreadcrumbs` key from before the icon-style / breadcrumb-trail
      // split. Both meant "use arrow icons" — the legacy name was just
      // ambiguous because the same flag also gated the old short tail-stub
      // rendering, which has now been replaced by the shared CoT-style
      // history trail.
      if (saved.headingArrows  != null) headingArrows.value = saved.headingArrows
      else if (saved.aisBreadcrumbs != null) headingArrows.value = saved.aisBreadcrumbs
    } catch { /* first run */ }
  }

  async function _save() {
    const store = await getStore()
    await store.set('aisConfig', {
      feedUrl:       feedUrl.value,
      apiKey:        apiKey.value,
      enabled:       enabled.value,
      visible:       visible.value,
      headingArrows: headingArrows.value
    })
  }

  // ---- Fetch ----

  async function fetchVessels({ minLat, maxLat, minLon, maxLon }) {
    if (!enabled.value || !feedUrl.value.trim() || !apiKey.value.trim()) return

    loading.value    = true
    fetchError.value = null

    try {
      const data = await invoke('fetch_ais_vessels', {
        url: feedUrl.value, apiKey: apiKey.value,
        minLat, maxLat, minLon, maxLon
      })

      const now = Date.now()
      const cutoff = now - MAX_HISTORY_MS
      const previous = vessels.value
      const next = new Map()
      for (const item of data.items ?? []) {
        if (item.mmsi == null || item.latitude == null || item.longitude == null) continue
        const mmsi = String(item.mmsi)
        // Carry forward any prior history for this vessel, append the
        // current position, prune anything older than MAX_HISTORY_MS. If
        // the vessel left the bbox between fetches its history is lost —
        // matches the CoT behaviour and is acceptable for now.
        const prior = previous.get(mmsi)
        const history = prior?.history ? [...prior.history] : []
        history.push({ lon: item.longitude, lat: item.latitude, t: now })
        while (history.length > 0 && history[0].t < cutoff) history.shift()
        next.set(mmsi, { ...item, history })
      }
      vessels.value   = next
      lastFetch.value = new Date()
    } catch (err) {
      fetchError.value = typeof err === 'string' ? err : (err?.message ?? 'Network error')
    } finally {
      loading.value = false
    }
  }

  // ---- Setters ----

  async function setEnabled(val) {
    enabled.value = val
    if (!val) vessels.value = new Map()
    await _save()
  }

  async function setVisible(val)       { visible.value       = val; await _save() }
  async function setFeedUrl(val)       { feedUrl.value       = val; await _save() }
  async function setApiKey(val)        { apiKey.value        = val; await _save() }
  async function setHeadingArrows(val) { headingArrows.value = val; await _save() }

  return {
    feedUrl, apiKey, enabled, visible,
    headingArrows,
    vessels, lastFetch, fetchError, loading,
    vesselCollection, breadcrumbCollection, vesselCount,
    openPanelList, focusedMmsi,
    load, fetchVessels,
    setEnabled, setVisible, setFeedUrl, setApiKey,
    setHeadingArrows,
    openPanel, closePanel
  }
})
