import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getStore } from '@/plugins/store'
import { destinationPoint } from '@/services/geometry'
import { useSettingsStore } from '@/stores/settings'

// Knots → metres per second.
const KTS_TO_MPS = 1852 / 3600

// Below this ground speed the synthetic backward heading-trail is suppressed:
// stationary or near-stationary aircraft (e.g. parked on a ramp) have noisy
// `track` values and the tail would jitter. Mirrors the AIS 0.2 kts floor but
// at a higher threshold because aircraft "moving slowly" on the ground are
// still typically taxiing at several knots.
const ADSB_MIN_MOVING_KTS = 5

export const useAdsbStore = defineStore('adsb', () => {
  const settingsStore = useSettingsStore()

  // ---- Persisted config ----
  const enabled       = ref(false)
  const visible       = ref(true)
  // True = aircraft icons render as direction-aware arrows (rotated to track).
  // False = aircraft icons render as plain circles.
  const headingArrows = ref(true)

  // ---- Runtime state ----
  const aircraft   = ref(new Map())  // hex string → raw item
  const lastFetch  = ref(null)       // Date | null
  const fetchError = ref(null)       // string | null
  const loading    = ref(false)

  // ---- Computed ----

  const aircraftCollection = computed(() => ({
    type: 'FeatureCollection',
    features: visible.value
      ? Array.from(aircraft.value.values())
          .filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon))
          .map(a => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
            properties: {
              hex:       a.hex,
              flight:    (a.flight ?? '').trim() || a.hex,
              speed:     Number.isFinite(a.gs) ? a.gs : 0,
              track:     Number.isFinite(a.track) ? a.track : 0,
              altitude:  a.alt_baro,
              squawk:    a.squawk ?? '',
              type:      a.t ?? ''
            }
          }))
      : []
  }))

  // Synthetic heading breadcrumb: a line projected backward from each
  // aircraft's current position along the reverse of its `track`. Visual
  // length is `gs * trackBreadcrumbLength`, so faster aircraft get
  // proportionally longer trails. Aircraft below `ADSB_MIN_MOVING_KTS` or
  // without a valid track are suppressed.
  const breadcrumbCollection = computed(() => {
    if (!settingsStore.trackBreadcrumbs || !visible.value) {
      return { type: 'FeatureCollection', features: [] }
    }
    const seconds = Math.max(0, settingsStore.trackBreadcrumbLength)
    if (seconds <= 0) return { type: 'FeatureCollection', features: [] }
    const features = []
    for (const a of aircraft.value.values()) {
      const gs = Number(a.gs)
      if (!Number.isFinite(gs) || gs < ADSB_MIN_MOVING_KTS) continue
      if (!Number.isFinite(a.track)) continue
      const lengthMeters = gs * KTS_TO_MPS * seconds
      if (lengthMeters <= 0) continue
      const reverseTrack = (a.track + 180) % 360
      const from = [a.lon, a.lat]
      const to   = destinationPoint(from, lengthMeters, reverseTrack)
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [from, to] },
        properties: { hex: a.hex }
      })
    }
    return { type: 'FeatureCollection', features }
  })

  const aircraftCount = computed(() => aircraft.value.size)

  // ---- Panel management ----

  const openPanelList = ref([])
  const focusedHex    = ref(null)

  function openPanel(hex) {
    if (!openPanelList.value.includes(hex)) openPanelList.value.push(hex)
    focusedHex.value = hex
  }

  function closePanel(hex) {
    openPanelList.value = openPanelList.value.filter(h => h !== hex)
    if (focusedHex.value === hex) focusedHex.value = null
  }

  // ---- Persistence ----

  async function load() {
    try {
      const store = await getStore()
      const saved = await store.get('adsbConfig')
      if (!saved) return
      if (saved.enabled       != null) enabled.value       = saved.enabled
      if (saved.visible       != null) visible.value       = saved.visible
      if (saved.headingArrows != null) headingArrows.value = saved.headingArrows
    } catch { /* first run */ }
  }

  async function _save() {
    const store = await getStore()
    await store.set('adsbConfig', {
      enabled:       enabled.value,
      visible:       visible.value,
      headingArrows: headingArrows.value
    })
  }

  // ---- Fetch ----

  async function fetchAircraft({ lat, lon, radiusNm }) {
    if (!enabled.value) return
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusNm)) return

    loading.value    = true
    fetchError.value = null

    try {
      const data = await invoke('fetch_adsb_aircraft', {
        lat, lon, radiusNm
      })

      const next = new Map()
      for (const item of data?.aircraft ?? []) {
        if (item.hex && Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
          next.set(String(item.hex), item)
        }
      }
      aircraft.value  = next
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
    if (!val) aircraft.value = new Map()
    await _save()
  }

  async function setVisible(val)       { visible.value       = val; await _save() }
  async function setHeadingArrows(val) { headingArrows.value = val; await _save() }

  return {
    enabled, visible, headingArrows,
    aircraft, lastFetch, fetchError, loading,
    aircraftCollection, breadcrumbCollection, aircraftCount,
    openPanelList, focusedHex,
    load, fetchAircraft,
    setEnabled, setVisible, setHeadingArrows,
    openPanel, closePanel
  }
})
