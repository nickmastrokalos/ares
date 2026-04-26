import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getStore } from '@/plugins/store'
import { destinationPoint } from '@/services/geometry'

// Below this speed the backward heading-trail is suppressed: AIS COG
// values are noisy at near-zero speed and the tail would jitter
// directionally.
const AIS_MIN_MOVING_KTS = 0.2

// Fixed tail length for the heading breadcrumb. Kept short so vessels
// read as "currently heading X" without the trail dominating the map.
// Not user-adjustable — the AIS panel exposes only an on/off switch.
const AIS_BREADCRUMB_METERS = 500

export const useAisStore = defineStore('ais', () => {
  // ---- Persisted config ----
  const feedUrl       = ref('https://aisfeed.com')
  const apiKey        = ref('')
  const enabled       = ref(false)
  const visible       = ref(true)
  // True = vessel icons render as direction-aware arrows (rotated to COG).
  // False = vessel icons render as plain circles.
  const headingArrows = ref(false)
  // True = draw a short backward heading breadcrumb behind each moving
  // vessel. Independent of the global `trackBreadcrumbs` setting (which
  // now applies only to CoT history trails).
  const breadcrumbs   = ref(false)

  // ---- Runtime state ----
  const vessels    = ref(new Map())  // mmsi string → raw item
  const lastFetch  = ref(null)       // Date | null
  const fetchError = ref(null)       // string | null
  const loading    = ref(false)

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

  // Synthetic heading breadcrumb: a short line projected backward from
  // each vessel along the reverse of its COG. Toggled by the AIS-local
  // `breadcrumbs` switch (independent of the global CoT breadcrumb
  // setting). Length is fixed at `AIS_BREADCRUMB_METERS` — the panel
  // doesn't expose a slider since the trail is meant to be a small
  // direction cue, not a track-history visualization. Vessels below
  // `AIS_MIN_MOVING_KTS` or without a valid COG are suppressed.
  const breadcrumbCollection = computed(() => {
    if (!breadcrumbs.value || !visible.value) {
      return { type: 'FeatureCollection', features: [] }
    }
    const lengthMeters = AIS_BREADCRUMB_METERS
    const features = []
    for (const v of vessels.value.values()) {
      const sog = Number(v.SOG)
      if (!Number.isFinite(sog) || sog < AIS_MIN_MOVING_KTS) continue
      if (v.COG == null || v.COG < 0) continue
      const reverseCog = (v.COG + 180) % 360
      const from = [v.longitude, v.latitude]
      const to   = destinationPoint(from, lengthMeters, reverseCog)
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [from, to] },
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
      if (saved.breadcrumbs != null) breadcrumbs.value = saved.breadcrumbs
    } catch { /* first run */ }
  }

  async function _save() {
    const store = await getStore()
    await store.set('aisConfig', {
      feedUrl:       feedUrl.value,
      apiKey:        apiKey.value,
      enabled:       enabled.value,
      visible:       visible.value,
      headingArrows: headingArrows.value,
      breadcrumbs:   breadcrumbs.value
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

      const next = new Map()
      for (const item of data.items ?? []) {
        if (item.mmsi != null && item.latitude != null && item.longitude != null) {
          next.set(String(item.mmsi), item)
        }
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
  async function setBreadcrumbs(val)   { breadcrumbs.value   = val; await _save() }

  return {
    feedUrl, apiKey, enabled, visible,
    headingArrows, breadcrumbs,
    vessels, lastFetch, fetchError, loading,
    vesselCollection, breadcrumbCollection, vesselCount,
    openPanelList, focusedMmsi,
    load, fetchVessels,
    setEnabled, setVisible, setFeedUrl, setApiKey,
    setHeadingArrows, setBreadcrumbs,
    openPanel, closePanel
  }
})
