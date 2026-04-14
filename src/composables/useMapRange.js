import { ref, watch, computed, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import { distanceBetween, formatDistance } from '@/services/geometry'
import { useSettingsStore } from '@/stores/settings'
import { useTracksStore } from '@/stores/tracks'

const RANGE_SOURCE = 'range-line'
const RANGE_LAYER  = 'range-line-layer'

// Each committed range: { id, epA, epB, markerMid, markerA, markerB }
// Endpoint (ep): { type: 'point'|'track', coord: [lng, lat], uid?: string }
//
// Flow:
//   Click toolbar button → enter selecting (cursor = crosshair)
//     Click A, click B → range committed, automatically reset for next pair
//     Click A, click B → another range committed, still selecting
//     ...repeat as many times as needed
//   Click toolbar button again → exit selecting, all ranges stay visible
//   Escape while selecting → exit selecting, ranges stay
//   Escape while not selecting (ranges visible) → clear all ranges

export function useMapRange(getMap) {
  const settingsStore = useSettingsStore()
  const tracksStore   = useTracksStore()

  const isSelecting = ref(false)
  const rangeCount  = ref(0)  // kept for track-watcher lifecycle only

  // The button reflects selection mode only — not whether ranges are displayed.
  // Ranges remain on screen after the user exits selection; the button dims so
  // normal map interactions (click, draw, measure) are fully restored.
  const ranging = computed(() => isSelecting.value)

  const committed = []   // plain array — mutated directly, rangeCount.value is the reactive mirror
  let nextId     = 0
  let pendingEpA = null  // first endpoint for the in-progress pair

  let clickHandler   = null
  let keyHandler     = null
  let stopTrackWatch = null

  // ---- DOM helpers (match useMapMeasure label style) ----

  function makeLabelEl(text) {
    const el = document.createElement('div')
    el.style.cssText =
      'background:rgba(22,22,22,0.85);color:#e0e0e0;font-size:11px;' +
      'padding:2px 6px;border-radius:3px;white-space:nowrap;pointer-events:none;' +
      'font-family:sans-serif;line-height:1.4;'
    el.textContent = text
    return el
  }

  function makeDotEl() {
    const el = document.createElement('div')
    el.style.cssText =
      'width:8px;height:8px;background:#4a9ade;border:1px solid #000;' +
      'border-radius:50%;pointer-events:none;'
    return el
  }

  function placeMarker(lngLat, el) {
    const map = getMap()
    if (!map) return null
    return new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(map)
  }

  // ---- Source / layer (lazy, idempotent) ----

  function ensureSource() {
    const map = getMap()
    if (!map || map.getSource(RANGE_SOURCE)) return
    map.addSource(RANGE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: RANGE_LAYER,
      type: 'line',
      source: RANGE_SOURCE,
      paint: {
        'line-color': '#4a9ade',
        'line-width': 2,
        'line-dasharray': [5, 3]
      }
    })
  }

  // ---- Display ----

  function rebuildSource() {
    const map = getMap()
    if (!map) return
    const features = committed.map(r => ({
      type: 'Feature',
      properties: { id: r.id },
      geometry: { type: 'LineString', coordinates: [r.epA.coord, r.epB.coord] }
    }))
    map.getSource(RANGE_SOURCE)?.setData({ type: 'FeatureCollection', features })
  }

  function syncRangeMarkers(r) {
    const cA  = r.epA.coord
    const cB  = r.epB.coord
    const mid = [(cA[0] + cB[0]) / 2, (cA[1] + cB[1]) / 2]
    const label = formatDistance(distanceBetween(cA, cB), settingsStore.distanceUnits)

    if (r.markerMid) {
      r.markerMid.setLngLat(mid)
      r.markerMid.getElement().textContent = label
    } else {
      r.markerMid = placeMarker(mid, makeLabelEl(label))
    }

    if (r.markerA) { r.markerA.setLngLat(cA) }
    else           { r.markerA = placeMarker(cA, makeDotEl()) }

    if (r.markerB) { r.markerB.setLngLat(cB) }
    else           { r.markerB = placeMarker(cB, makeDotEl()) }
  }

  function updateAllDisplays() {
    rebuildSource()
    for (const r of committed) syncRangeMarkers(r)
  }

  function removeRangeMarkers(r) {
    if (r.markerMid) { r.markerMid.remove(); r.markerMid = null }
    if (r.markerA)   { r.markerA.remove();   r.markerA   = null }
    if (r.markerB)   { r.markerB.remove();   r.markerB   = null }
  }

  // ---- Track watcher — keeps dynamic endpoints live ----

  function ensureTrackWatch() {
    if (stopTrackWatch) return
    stopTrackWatch = watch(
      () => tracksStore.tracks,
      (tracks) => {
        let changed = false
        for (const r of committed) {
          if (r.epA.type === 'track') {
            const t = tracks.get(r.epA.uid)
            if (t) { r.epA.coord = [t.lon, t.lat]; changed = true }
          }
          if (r.epB.type === 'track') {
            const t = tracks.get(r.epB.uid)
            if (t) { r.epB.coord = [t.lon, t.lat]; changed = true }
          }
        }
        if (changed) updateAllDisplays()
      },
      { deep: false }
    )
  }

  function stopTrackWatcher() {
    if (stopTrackWatch) { stopTrackWatch(); stopTrackWatch = null }
  }

  // ---- Handler management ----

  function removeClickHandler() {
    const map = getMap()
    if (map && clickHandler) map.off('click', clickHandler)
    clickHandler = null
  }

  function removeKeyHandler() {
    if (keyHandler) window.removeEventListener('keydown', keyHandler)
    keyHandler = null
  }

  // ---- Selection ----

  // Exits selection mode, releases the click handler. Committed ranges are untouched.
  function exitSelecting() {
    removeClickHandler()
    pendingEpA = null
    isSelecting.value = false
    const map = getMap()
    if (map) map.getCanvasContainer().style.cursor = ''
  }

  // Clears all committed ranges and exits.
  function clearAllRanges() {
    exitSelecting()
    for (const r of committed) removeRangeMarkers(r)
    committed.length = 0
    rangeCount.value = 0
    stopTrackWatcher()
    const map = getMap()
    map?.getSource(RANGE_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
  }

  // Registers the map click handler and enters selecting state.
  // After each committed pair the handler resets pendingEpA and keeps running —
  // the user can place as many range lines as they want without re-clicking
  // the toolbar button.
  function startSelecting() {
    const map = getMap()
    if (!map) return

    pendingEpA = null
    isSelecting.value = true
    map.getCanvasContainer().style.cursor = 'crosshair'
    removeClickHandler()

    clickHandler = (e) => {
      // Prefer a CoT track under the click for a live-updating endpoint.
      const hits = map.queryRenderedFeatures(e.point, { layers: ['cot-tracks-points'] })
      let ep
      if (hits.length > 0) {
        const uid = hits[0].properties.uid
        const t   = tracksStore.tracks.get(uid)
        ep = t
          ? { type: 'track', uid, coord: [t.lon, t.lat] }
          : { type: 'point', coord: [e.lngLat.lng, e.lngLat.lat] }
      } else {
        ep = { type: 'point', coord: [e.lngLat.lng, e.lngLat.lat] }
      }

      if (!pendingEpA) {
        // First point captured — wait for second.
        pendingEpA = ep
      } else {
        // Both endpoints captured — commit and immediately reset for the next pair.
        const r = {
          id: nextId++,
          epA: pendingEpA,
          epB: ep,
          markerMid: null,
          markerA: null,
          markerB: null
        }
        committed.push(r)
        rangeCount.value = committed.length
        rebuildSource()
        syncRangeMarkers(r)
        ensureTrackWatch()

        // Auto-reset: stay in selecting mode so the next pair can start immediately.
        pendingEpA = null
      }
    }

    map.on('click', clickHandler)
  }

  function ensureKeyHandler() {
    if (keyHandler) return
    keyHandler = (e) => {
      if (e.key !== 'Escape') return
      clearAllRanges()
      removeKeyHandler()
    }
    window.addEventListener('keydown', keyHandler)
  }

  // ---- Public ----

  // Toolbar button:
  //   • not selecting → enter selecting (button lights, cursor = crosshair)
  //   • selecting     → exit selecting (button dims, cursor resets, ranges stay visible)
  // To clear all ranges: press Escape.
  function toggleRange() {
    ensureSource()
    if (!isSelecting.value) {
      ensureKeyHandler()
      startSelecting()
    } else {
      exitSelecting()
    }
  }

  onUnmounted(() => {
    removeClickHandler()
    removeKeyHandler()
    stopTrackWatcher()
    for (const r of committed) removeRangeMarkers(r)
    committed.length = 0
    const map = getMap()
    if (!map) return
    if (map.getLayer(RANGE_LAYER))   map.removeLayer(RANGE_LAYER)
    if (map.getSource(RANGE_SOURCE)) map.removeSource(RANGE_SOURCE)
  })

  return { ranging, toggleRange }
}
