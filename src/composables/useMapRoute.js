import { ref, computed, watch, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import { useFeaturesStore } from '@/stores/features'

const PREVIEW_SOURCE  = 'route-preview'
const PREVIEW_LAYER   = 'route-preview-line'
const PREVIEW_LIVE    = 'route-preview-live'
const LINES_SOURCE    = 'route-lines'
const WAYPOINTS_SOURCE = 'route-waypoints'
const LINE_LAYER      = 'route-line'
const DOT_LAYER       = 'route-dot'
const LABEL_LAYER     = 'route-label'

const ROUTE_COLOR = '#ffffff'
const COLOR_SP    = '#ffffff'
const COLOR_WP    = '#ffffff'
const COLOR_EP    = '#ffffff'

// Returns 'SP' | 'EP' | 'WP n' (1-based) for a given index and total count.
function wpLabel(index, total) {
  if (index === 0) return 'SP'
  if (index === total - 1) return 'EP'
  return `WP ${index}`
}

export function useMapRoute(getMap) {
  const featuresStore = useFeaturesStore()

  // ---- State ----

  const routing           = ref(false)
  const appending         = ref(false)
  const appendingRouteId  = ref(null)
  const openRouteIds      = ref(new Set())

  const openRouteList = computed(() => [...openRouteIds.value])

  // ---- Build state (module-level mutable) ----

  let buildPoints  = []   // [[lng, lat], ...]
  let buildMarkers = []   // maplibregl.Marker per point

  // ---- Click / key handlers (kept so we can remove them) ----

  let clickHandler    = null
  let moveHandler     = null
  let dblClickHandler = null
  let keyHandler      = null

  // ---- Click handler for existing route layers ----

  let routeClickHandler = null

  // ---- DOM helpers ----

  function makeWpLabelEl(label, color) {
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;pointer-events:none;'

    const dot = document.createElement('div')
    dot.style.cssText =
      `width:10px;height:10px;background:${color};border:1px solid rgba(0,0,0,0.5);` +
      'border-radius:50%;'

    const text = document.createElement('div')
    text.style.cssText =
      'background:rgba(22,22,22,0.85);color:#e0e0e0;font-size:10px;' +
      'padding:1px 5px;border-radius:3px;white-space:nowrap;margin-top:3px;' +
      'font-family:sans-serif;line-height:1.4;'
    text.textContent = label

    wrapper.appendChild(dot)
    wrapper.appendChild(text)
    return wrapper
  }

  function placeMarker(lngLat, el) {
    const map = getMap()
    if (!map) return null
    return new maplibregl.Marker({ element: el, anchor: 'top' })
      .setLngLat(lngLat)
      .addTo(map)
  }

  // ---- Source / layer setup ----

  function ensurePreviewSource(map) {
    if (map.getSource(PREVIEW_SOURCE)) return
    map.addSource(PREVIEW_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: PREVIEW_LAYER,
      type: 'line',
      source: PREVIEW_SOURCE,
      filter: ['==', ['get', 'kind'], 'solid'],
      paint: { 'line-color': ROUTE_COLOR, 'line-width': 2 }
    })
    map.addLayer({
      id: PREVIEW_LIVE,
      type: 'line',
      source: PREVIEW_SOURCE,
      filter: ['==', ['get', 'kind'], 'live'],
      paint: { 'line-color': ROUTE_COLOR, 'line-width': 2, 'line-dasharray': [4, 3] }
    })
  }

  function ensureRouteSource(map) {
    if (map.getSource(LINES_SOURCE)) return
    map.addSource(LINES_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: LINE_LAYER,
      type: 'line',
      source: LINES_SOURCE,
      paint: { 'line-color': ROUTE_COLOR, 'line-width': 2 }
    })

    map.addSource(WAYPOINTS_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: DOT_LAYER,
      type: 'circle',
      source: WAYPOINTS_SOURCE,
      paint: {
        'circle-radius': 5,
        'circle-color': ROUTE_COLOR,
        'circle-stroke-color': 'rgba(0,0,0,0.5)',
        'circle-stroke-width': 1
      }
    })
    map.addLayer({
      id: LABEL_LAYER,
      type: 'symbol',
      source: WAYPOINTS_SOURCE,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': 10,
        'text-anchor': 'top',
        'text-offset': [0, 0.8]
      },
      paint: {
        'text-color': '#e0e0e0',
        'text-halo-color': '#0d0d0d',
        'text-halo-width': 1.5
      }
    })
  }

  // ---- Preview source updates ----

  function updatePreview(extraCoord) {
    const map = getMap()
    if (!map) return
    const features = []
    if (buildPoints.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { kind: 'solid' },
        geometry: { type: 'LineString', coordinates: [...buildPoints] }
      })
    }
    if (extraCoord && buildPoints.length >= 1) {
      features.push({
        type: 'Feature',
        properties: { kind: 'live' },
        geometry: {
          type: 'LineString',
          coordinates: [buildPoints[buildPoints.length - 1], extraCoord]
        }
      })
    }
    map.getSource(PREVIEW_SOURCE)?.setData({ type: 'FeatureCollection', features })
  }

  function clearPreview() {
    const map = getMap()
    if (!map) return
    map.getSource(PREVIEW_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
  }

  // ---- Build markers ----

  function rebuildBuildMarkers() {
    const total = buildPoints.length
    for (let i = 0; i < buildMarkers.length; i++) {
      buildMarkers[i].remove()
    }
    buildMarkers = []
    for (let i = 0; i < total; i++) {
      const label = wpLabel(i, total)
      const color = label === 'SP' ? COLOR_SP : label === 'EP' ? COLOR_EP : COLOR_WP
      const el = makeWpLabelEl(label, color)
      const m = placeMarker(buildPoints[i], el)
      if (m) buildMarkers.push(m)
    }
  }

  function addBuildMarker(lngLat) {
    // Before adding: relabel previous last marker to WP if needed (no longer EP)
    // Easiest to just rebuild all markers since counts are small.
    buildPoints.push(lngLat)
    rebuildBuildMarkers()
  }

  function removeBuildMarkers() {
    for (const m of buildMarkers) m.remove()
    buildMarkers = []
  }

  // ---- Persisted route sources ----

  function syncSources() {
    const map = getMap()
    if (!map) return

    const routes = featuresStore.features.filter(f => f.type === 'route')

    const lineFeatures = []
    const wpFeatures   = []

    for (const row of routes) {
      const geometry   = JSON.parse(row.geometry)
      const properties = JSON.parse(row.properties)
      const coords     = geometry.coordinates
      const waypoints  = properties.waypoints ?? []
      const total      = coords.length

      lineFeatures.push({
        type: 'Feature',
        properties: { _dbId: row.id },
        geometry
      })

      for (let i = 0; i < total; i++) {
        const wp = waypoints[i] ?? {}
        wpFeatures.push({
          type: 'Feature',
          properties: {
            _dbId: row.id,
            label: wp.label ?? wpLabel(i, total),
            role:  wp.role  ?? (i === 0 ? 'SP' : i === total - 1 ? 'EP' : 'WP')
          },
          geometry: { type: 'Point', coordinates: coords[i] }
        })
      }
    }

    map.getSource(LINES_SOURCE)?.setData({ type: 'FeatureCollection', features: lineFeatures })
    map.getSource(WAYPOINTS_SOURCE)?.setData({ type: 'FeatureCollection', features: wpFeatures })
  }

  // ---- Interaction handler management ----

  function removeHandlers() {
    const map = getMap()
    if (map) {
      if (clickHandler)    map.off('click', clickHandler)
      if (moveHandler)     map.off('mousemove', moveHandler)
      if (dblClickHandler) map.off('dblclick', dblClickHandler)
    }
    if (keyHandler) window.removeEventListener('keydown', keyHandler)
    clickHandler    = null
    moveHandler     = null
    dblClickHandler = null
    keyHandler      = null
  }

  // ---- Build mode ----

  function startBuilding() {
    const map = getMap()
    if (!map) return

    routing.value = true
    buildPoints = []
    removeBuildMarkers()
    clearPreview()

    map.getCanvasContainer().style.cursor = 'crosshair'
    map.doubleClickZoom.disable()

    clickHandler = (e) => {
      const coord = [e.lngLat.lng, e.lngLat.lat]
      addBuildMarker(coord)
      updatePreview(null)
    }

    moveHandler = (e) => {
      if (buildPoints.length === 0) return
      updatePreview([e.lngLat.lng, e.lngLat.lat])
    }

    dblClickHandler = (e) => {
      e.preventDefault()
      // MapLibre fires click→click→dblclick; pop the duplicate from the second click.
      if (buildPoints.length > 0) {
        buildPoints.pop()
        rebuildBuildMarkers()
      }
      finalize(true)
    }

    keyHandler = (e) => {
      if (e.key === 'Escape') cancelBuilding()
      if (e.key === 'Enter')  finalize(false)
    }

    map.on('click', clickHandler)
    map.on('mousemove', moveHandler)
    map.on('dblclick', dblClickHandler)
    window.addEventListener('keydown', keyHandler)
  }

  async function finalize(fromDblClick) {
    if (buildPoints.length < 2) {
      cancelBuilding()
      return
    }

    removeHandlers()

    const total = buildPoints.length
    const waypoints = buildPoints.map((coord, i) => {
      const label = wpLabel(i, total)
      return { label, role: label === 'SP' ? 'SP' : label === 'EP' ? 'EP' : 'WP' }
    })

    // Update last build marker to show EP before cleanup.
    if (buildMarkers.length > 0) {
      const lastIdx = buildMarkers.length - 1
      buildMarkers[lastIdx].remove()
      const epEl = makeWpLabelEl('EP', COLOR_EP)
      const epMarker = placeMarker(buildPoints[total - 1], epEl)
      if (epMarker) buildMarkers[lastIdx] = epMarker
    }

    const geometry = { type: 'LineString', coordinates: [...buildPoints] }

    // Count existing routes to pick a default name.
    const existingCount = featuresStore.features.filter(f => f.type === 'route').length
    const name = `Route ${existingCount + 1}`

    const id = await featuresStore.addFeature('route', geometry, {
      name,
      color: ROUTE_COLOR,
      waypoints
    })

    // Cleanup build state.
    removeBuildMarkers()
    clearPreview()
    buildPoints = []

    const map = getMap()
    if (map) {
      map.getCanvasContainer().style.cursor = ''
      map.doubleClickZoom.enable()
    }

    routing.value = false

    if (id != null) openRoutePanel(id)
  }

  function cancelBuilding() {
    removeHandlers()
    removeBuildMarkers()
    clearPreview()
    buildPoints = []

    const map = getMap()
    if (map) {
      map.getCanvasContainer().style.cursor = ''
      map.doubleClickZoom.enable()
    }

    routing.value = false
  }

  // ---- Append mode ----

  let appendClickHandler = null
  let appendKeyHandler   = null

  function cancelAppend() {
    const map = getMap()
    if (map) {
      if (appendClickHandler) map.off('click', appendClickHandler)
      map.getCanvasContainer().style.cursor = ''
    }
    if (appendKeyHandler) window.removeEventListener('keydown', appendKeyHandler)
    appendClickHandler = null
    appendKeyHandler   = null
    appending.value    = false
    appendingRouteId.value = null
  }

  function startAppendMode(routeId) {
    const map = getMap()
    if (!map) return

    cancelAppend()

    appending.value        = true
    appendingRouteId.value = routeId
    map.getCanvasContainer().style.cursor = 'crosshair'

    appendClickHandler = async (e) => {
      const coord = [e.lngLat.lng, e.lngLat.lat]
      cancelAppend()

      const row = featuresStore.features.find(f => f.id === routeId)
      if (!row) return

      const geometry   = JSON.parse(row.geometry)
      const properties = JSON.parse(row.properties)
      const coords     = [...geometry.coordinates, coord]
      const total      = coords.length
      const waypoints  = coords.map((c, i) => {
        const label = wpLabel(i, total)
        return { label, role: label === 'SP' ? 'SP' : label === 'EP' ? 'EP' : 'WP' }
      })

      await featuresStore.updateFeature(
        routeId,
        { type: 'LineString', coordinates: coords },
        { ...properties, waypoints }
      )
    }

    appendKeyHandler = (e) => {
      if (e.key === 'Escape') cancelAppend()
    }

    map.on('click', appendClickHandler)
    window.addEventListener('keydown', appendKeyHandler)
  }

  // ---- Panel open/close ----

  function openRoutePanel(id) {
    openRouteIds.value = new Set([...openRouteIds.value, id])
  }

  function closeRoutePanel(id) {
    const next = new Set(openRouteIds.value)
    next.delete(id)
    openRouteIds.value = next
  }

  // ---- Toolbar toggle ----

  function toggleRoute() {
    if (routing.value) {
      cancelBuilding()
    } else {
      startBuilding()
    }
  }

  // ---- Map layer init ----

  function initLayers() {
    const map = getMap()
    if (!map) return

    ensurePreviewSource(map)
    ensureRouteSource(map)
    syncSources()

    // Click on route line or waypoint dot → open panel.
    routeClickHandler = (e) => {
      if (routing.value || appending.value) return
      const hits = map.queryRenderedFeatures(e.point, { layers: [LINE_LAYER, DOT_LAYER] })
      if (hits.length > 0) {
        const id = hits[0].properties._dbId
        openRoutePanel(id)
      }
    }
    map.on('click', routeClickHandler)

    // Pointer cursor on hover.
    map.on('mouseenter', LINE_LAYER, () => {
      if (!routing.value && !appending.value) map.getCanvasContainer().style.cursor = 'pointer'
    })
    map.on('mouseleave', LINE_LAYER, () => {
      if (!routing.value && !appending.value) map.getCanvasContainer().style.cursor = ''
    })
    map.on('mouseenter', DOT_LAYER, () => {
      if (!routing.value && !appending.value) map.getCanvasContainer().style.cursor = 'pointer'
    })
    map.on('mouseleave', DOT_LAYER, () => {
      if (!routing.value && !appending.value) map.getCanvasContainer().style.cursor = ''
    })
  }

  // ---- Watch store for sync ----

  watch(
    () => featuresStore.features,
    () => syncSources()
  )

  // Close panels for routes that no longer exist.
  watch(
    () => featuresStore.features,
    (features) => {
      const existingIds = new Set(features.filter(f => f.type === 'route').map(f => f.id))
      const next = new Set([...openRouteIds.value].filter(id => existingIds.has(id)))
      if (next.size !== openRouteIds.value.size) openRouteIds.value = next
    }
  )

  // ---- Cleanup ----

  onUnmounted(() => {
    removeHandlers()
    cancelAppend()
    removeBuildMarkers()

    const map = getMap()
    if (!map) return

    if (routeClickHandler) map.off('click', routeClickHandler)

    const layers  = [PREVIEW_LAYER, PREVIEW_LIVE, LINE_LAYER, DOT_LAYER, LABEL_LAYER]
    const sources = [PREVIEW_SOURCE, LINES_SOURCE, WAYPOINTS_SOURCE]

    for (const l of layers)  { if (map.getLayer(l))   map.removeLayer(l) }
    for (const s of sources) { if (map.getSource(s)) map.removeSource(s) }

    map.getCanvasContainer().style.cursor = ''
    map.doubleClickZoom.enable()
  })

  return {
    routing,
    appending,
    appendingRouteId,
    openRouteList,
    openRoutePanel,
    closeRoutePanel,
    startAppendMode,
    toggleRoute,
    initLayers
  }
}
