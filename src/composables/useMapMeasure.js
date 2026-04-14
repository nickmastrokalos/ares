import { ref, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import { distanceBetween, formatDistance } from '@/services/geometry'
import { useSettingsStore } from '@/stores/settings'

const MEASURE_SOURCE = 'measure-preview'

export function useMapMeasure(getMap) {
  const measuring = ref(false)
  const settingsStore = useSettingsStore()

  let points = []
  let totalDistance = 0
  let markers = []
  let totalMarker = null
  let liveMarker = null
  let finalized = false

  let clickHandler = null
  let moveHandler = null
  let dblClickHandler = null
  let keyHandler = null
  let restartHandler = null

  function createLabelElement(text) {
    const el = document.createElement('div')
    el.style.cssText =
      'background:rgba(22,22,22,0.85);color:#e0e0e0;font-size:11px;' +
      'padding:2px 6px;border-radius:3px;white-space:nowrap;pointer-events:none;' +
      'font-family:sans-serif;line-height:1.4;'
    el.textContent = text
    return el
  }

  function createMarker(lngLat, text) {
    const map = getMap()
    if (!map) return null
    const el = createLabelElement(text)
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(map)
    return marker
  }

  function midpoint(a, b) {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  }

  function setupSource(map) {
    if (map.getSource(MEASURE_SOURCE)) return

    map.addSource(MEASURE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: 'measure-line',
      type: 'line',
      source: MEASURE_SOURCE,
      filter: ['==', ['get', 'kind'], 'solid'],
      paint: { 'line-color': '#4a9ade', 'line-width': 3 }
    })
    map.addLayer({
      id: 'measure-line-live',
      type: 'line',
      source: MEASURE_SOURCE,
      filter: ['==', ['get', 'kind'], 'live'],
      paint: { 'line-color': '#4a9ade', 'line-width': 3, 'line-dasharray': [4, 3] }
    })
    map.addLayer({
      id: 'measure-points',
      type: 'circle',
      source: MEASURE_SOURCE,
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-color': '#4a9ade', 'circle-radius': 4 }
    })
  }

  function updateSource(extraCoord) {
    const map = getMap()
    if (!map) return

    const features = []

    // Solid line through all committed points
    if (points.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { kind: 'solid' },
        geometry: { type: 'LineString', coordinates: [...points] }
      })
    }

    // Rubber-band from last point to cursor
    if (extraCoord && points.length >= 1) {
      features.push({
        type: 'Feature',
        properties: { kind: 'live' },
        geometry: { type: 'LineString', coordinates: [points[points.length - 1], extraCoord] }
      })
    }

    // Vertex dots
    for (const pt of points) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: pt }
      })
    }

    map.getSource(MEASURE_SOURCE)?.setData({ type: 'FeatureCollection', features })
  }

  function removeMarkers() {
    for (const m of markers) m.remove()
    markers = []
    if (totalMarker) { totalMarker.remove(); totalMarker = null }
    if (liveMarker) { liveMarker.remove(); liveMarker = null }
  }

  function clearSource() {
    const map = getMap()
    if (!map) return
    map.getSource(MEASURE_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
  }

  function removeHandlers() {
    const map = getMap()
    if (!map) return
    if (clickHandler) map.off('click', clickHandler)
    if (moveHandler) map.off('mousemove', moveHandler)
    if (dblClickHandler) map.off('dblclick', dblClickHandler)
    if (restartHandler) map.off('click', restartHandler)
    if (keyHandler) window.removeEventListener('keydown', keyHandler)
    clickHandler = null
    moveHandler = null
    dblClickHandler = null
    restartHandler = null
    keyHandler = null
  }

  function finalize() {
    if (points.length < 2) { cancelMeasure(); return }
    removeHandlers()
    if (liveMarker) { liveMarker.remove(); liveMarker = null }
    updateSource(null)
    finalized = true

    const map = getMap()
    if (!map) return
    // Keep crosshair — signals to the user that clicking restarts the tool.
    map.getCanvasContainer().style.cursor = 'crosshair'
    map.doubleClickZoom.enable()

    // Next map click starts a fresh measurement and treats that click as point #1,
    // so the user never needs to re-click the toolbar button.
    restartHandler = (e) => {
      // Do NOT null restartHandler here — removeHandlers() inside startMeasure()
      // needs the reference intact to call map.off('click', restartHandler).
      // Nulling it early makes that call a no-op, leaving the closure registered
      // on MapLibre and firing on every subsequent click, resetting the measurement.
      startMeasure()
      // startMeasure registers a new clickHandler; invoke it immediately so this
      // click also becomes the first measurement point.
      if (clickHandler) clickHandler(e)
    }
    map.on('click', restartHandler)

    // Keep Escape active while the result is displayed.
    keyHandler = (e) => {
      if (e.key === 'Escape') cancelMeasure()
    }
    window.addEventListener('keydown', keyHandler)
  }

  function startMeasure() {
    const map = getMap()
    if (!map) return

    // Always start clean — handles both a fresh activation and a restart after
    // finalization (where restartHandler/keyHandler are still registered).
    removeHandlers()
    removeMarkers()
    clearSource()

    points = []
    totalDistance = 0
    finalized = false
    measuring.value = true

    setupSource(map)
    map.getCanvasContainer().style.cursor = 'crosshair'
    map.doubleClickZoom.disable()

    clickHandler = (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat]
      points.push(pt)

      if (points.length >= 2) {
        const prev = points[points.length - 2]
        const segDist = distanceBetween(prev, pt)
        totalDistance += segDist

        // Segment label at midpoint
        const mid = midpoint(prev, pt)
        const segMarker = createMarker(mid, formatDistance(segDist, settingsStore.distanceUnits))
        if (segMarker) markers.push(segMarker)

        // Total label at latest point (remove previous one if exists)
        if (totalMarker) { totalMarker.remove(); totalMarker = null }
        totalMarker = createMarker(pt, `Total: ${formatDistance(totalDistance, settingsStore.distanceUnits)}`)
      }

      updateSource(null)
    }

    moveHandler = (e) => {
      if (points.length === 0) return
      const cursor = [e.lngLat.lng, e.lngLat.lat]
      updateSource(cursor)

      // Live distance label
      const last = points[points.length - 1]
      const dist = distanceBetween(last, cursor)
      const mid = midpoint(last, cursor)

      if (liveMarker) {
        liveMarker.setLngLat(mid)
        liveMarker.getElement().textContent = formatDistance(dist, settingsStore.distanceUnits)
      } else {
        liveMarker = createMarker(mid, formatDistance(dist, settingsStore.distanceUnits))
      }
    }

    dblClickHandler = (e) => {
      e.preventDefault()
      finalize()
    }

    keyHandler = (e) => {
      if (e.key === 'Escape') cancelMeasure()
      if (e.key === 'Enter') finalize()
    }

    map.on('click', clickHandler)
    map.on('mousemove', moveHandler)
    map.on('dblclick', dblClickHandler)
    window.addEventListener('keydown', keyHandler)
  }

  function cancelMeasure() {
    removeHandlers()
    removeMarkers()
    clearSource()
    points = []
    totalDistance = 0
    finalized = false
    measuring.value = false

    const map = getMap()
    if (map) {
      map.getCanvasContainer().style.cursor = ''
      map.doubleClickZoom.enable()
    }
  }

  onUnmounted(() => cancelMeasure())

  return { measuring, startMeasure, cancelMeasure }
}
