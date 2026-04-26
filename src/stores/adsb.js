import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getStore } from '@/plugins/store'
import { destinationPoint } from '@/services/geometry'

// Below this ground speed the synthetic backward heading-trail is suppressed:
// stationary or near-stationary aircraft (e.g. parked on a ramp) have noisy
// `track` values and the tail would jitter. Higher threshold than AIS
// because aircraft "moving slowly" on the ground are still typically
// taxiing at several knots.
const ADSB_MIN_MOVING_KTS = 5

// Fixed tail length for the heading breadcrumb. Kept short so aircraft
// read as "currently heading X" without the trail dominating the map.
// Not user-adjustable — the ADS-B panel exposes only an on/off switch.
const ADSB_BREADCRUMB_METERS = 1500

export const useAdsbStore = defineStore('adsb', () => {
  // ---- Persisted config ----
  const enabled       = ref(false)
  const visible       = ref(true)
  // True = aircraft icons render as direction-aware arrows (rotated to track).
  // False = aircraft icons render as plain circles.
  const headingArrows = ref(true)
  // True = draw a short backward heading breadcrumb behind each moving
  // aircraft. Independent of the global `trackBreadcrumbs` setting
  // (which now applies only to CoT history trails).
  const breadcrumbs   = ref(false)

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
              type:      a.t ?? '',
              // airplanes.live encodes a military flag in bit 0 of dbFlags.
              // (Bits 1-3 carry interesting / pia / ladd flags — currently
              // unused by the renderer.)
              military:  Number.isFinite(a.dbFlags) ? Boolean(a.dbFlags & 1) : false
            }
          }))
      : []
  }))

  // Synthetic heading breadcrumb: a short line projected backward from
  // each aircraft along the reverse of its `track`. Toggled by the
  // ADS-B-local `breadcrumbs` switch (independent of the global CoT
  // breadcrumb setting). Length is fixed at `ADSB_BREADCRUMB_METERS`.
  // Aircraft below `ADSB_MIN_MOVING_KTS` or without a valid track are
  // suppressed.
  const breadcrumbCollection = computed(() => {
    if (!breadcrumbs.value || !visible.value) {
      return { type: 'FeatureCollection', features: [] }
    }
    const lengthMeters = ADSB_BREADCRUMB_METERS
    const features = []
    for (const a of aircraft.value.values()) {
      const gs = Number(a.gs)
      if (!Number.isFinite(gs) || gs < ADSB_MIN_MOVING_KTS) continue
      if (!Number.isFinite(a.track)) continue
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
      if (saved.breadcrumbs   != null) breadcrumbs.value   = saved.breadcrumbs
    } catch { /* first run */ }
  }

  async function _save() {
    const store = await getStore()
    await store.set('adsbConfig', {
      enabled:       enabled.value,
      visible:       visible.value,
      headingArrows: headingArrows.value,
      breadcrumbs:   breadcrumbs.value
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

      // airplanes.live returns the aircraft array under `ac` (field-description
      // page documents `aircraft`, but the live response uses `ac` — keep the
      // fallback in case they ever align). Aircraft with `alt_baro: "ground"`
      // are dropped at fetch time so parked / taxiing flights don't clutter
      // the map or appear in `adsb_list_aircraft` / `adsb_aircraft_near`.
      const list = data?.ac ?? data?.aircraft ?? []
      const next = new Map()
      for (const item of list) {
        if (item.alt_baro === 'ground') continue
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
  async function setBreadcrumbs(val)   { breadcrumbs.value   = val; await _save() }

  return {
    enabled, visible, headingArrows, breadcrumbs,
    aircraft, lastFetch, fetchError, loading,
    aircraftCollection, breadcrumbCollection, aircraftCount,
    openPanelList, focusedHex,
    load, fetchAircraft,
    setEnabled, setVisible, setHeadingArrows, setBreadcrumbs,
    openPanel, closePanel
  }
})
