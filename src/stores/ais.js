import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getStore } from '@/plugins/store'
import { destinationPoint } from '@/services/geometry'

export const useAisStore = defineStore('ais', () => {
  // ---- Persisted config ----
  const feedUrl             = ref('https://aisfeed.com')
  const apiKey              = ref('')
  const enabled             = ref(false)
  const visible             = ref(true)
  const aisBreadcrumbs = ref(false)

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

  // Heading tail: a fixed-length line drawn behind each vessel in the
  // reverse direction of COG. Shows the track's direction at a glance
  // without accumulating history.
  const TAIL_LENGTH_M = 463  // 0.25 nm
  const breadcrumbCollection = computed(() => {
    if (!aisBreadcrumbs.value || !visible.value) {
      return { type: 'FeatureCollection', features: [] }
    }
    const features = []
    for (const v of vessels.value.values()) {
      if (v.COG == null || v.COG < 0) continue
      if ((v.SOG ?? 0) < 0.2) continue
      const reverseCog = (v.COG + 180) % 360
      const from = [v.longitude, v.latitude]
      const to   = destinationPoint(from, TAIL_LENGTH_M, reverseCog)
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [from, to] },
        properties: {}
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
      if (saved.feedUrl             != null) feedUrl.value             = saved.feedUrl
      if (saved.apiKey              != null) apiKey.value              = saved.apiKey
      if (saved.enabled             != null) enabled.value             = saved.enabled
      if (saved.visible             != null) visible.value             = saved.visible
      if (saved.aisBreadcrumbs != null) aisBreadcrumbs.value = saved.aisBreadcrumbs
    } catch { /* first run */ }
  }

  async function _save() {
    const store = await getStore()
    await store.set('aisConfig', {
      feedUrl:             feedUrl.value,
      apiKey:              apiKey.value,
      enabled:             enabled.value,
      visible:             visible.value,
      aisBreadcrumbs: aisBreadcrumbs.value
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

  async function setVisible(val)             { visible.value = val;             await _save() }
  async function setFeedUrl(val)             { feedUrl.value = val;             await _save() }
  async function setApiKey(val)              { apiKey.value  = val;             await _save() }
  async function setAisBreadcrumbs(val) { aisBreadcrumbs.value = val; await _save() }

  return {
    feedUrl, apiKey, enabled, visible,
    aisBreadcrumbs,
    vessels, lastFetch, fetchError, loading,
    vesselCollection, breadcrumbCollection, vesselCount,
    openPanelList, focusedMmsi,
    load, fetchVessels,
    setEnabled, setVisible, setFeedUrl, setApiKey,
    setAisBreadcrumbs,
    openPanel, closePanel
  }
})
