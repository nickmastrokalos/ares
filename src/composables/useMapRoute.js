import { ref, computed, watch, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { defaultFeatureName } from '@/services/featureNaming'

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

export function useMapRoute(getMap, dispatcher = null, suppress = { value: false }) {
  const featuresStore = useFeaturesStore()
  const settingsStore = useSettingsStore()

  // ---- State ----

  const routing           = ref(false)
  const appending         = ref(false)
  const appendingRouteId  = ref(null)
  const openRouteIds      = ref(new Set())

  // Per-frame broadcast of the in-flight waypoint drag — `{ routeId,
  // index, lng, lat }` while dragging, `null` otherwise. RoutePanel
  // injects this and overlays the live coord on its readout grid so the
  // user sees the position update as the cursor moves rather than only
  // on mouse release. Mirrors the `draggingTrack` pattern in
  // `useMapManualTracks`.
  const draggingWaypoint  = ref(null)

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
      paint: { 'line-color': ['coalesce', ['get', 'color'], ROUTE_COLOR], 'line-width': 2 }
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
        'circle-color': ['coalesce', ['get', 'color'], ROUTE_COLOR],
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
        'text-offset': [0, 0.8],
        'visibility': settingsStore.showFeatureLabels ? 'visible' : 'none'
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

      const color = properties.color ?? ROUTE_COLOR

      lineFeatures.push({
        type: 'Feature',
        properties: { _dbId: row.id, color },
        geometry
      })

      for (let i = 0; i < total; i++) {
        const wp = waypoints[i] ?? {}
        wpFeatures.push({
          type: 'Feature',
          properties: {
            _dbId: row.id,
            _index: i,
            color,
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

    const id = await featuresStore.addFeature('route', geometry, {
      name: defaultFeatureName('route', featuresStore),
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

    // Register with the central click dispatcher for overlap disambiguation.
    if (dispatcher) {
      dispatcher.register('routes', {
        layers: [LINE_LAYER, DOT_LAYER],
        action: (f) => openRoutePanel(f.properties._dbId),
        suppress: () => routing.value || appending.value || suppress.value,
        label: (f) => ({
          text: f.properties.name || 'Route',
          subtitle: 'Route',
          icon: 'mdi-routes'
        }),
        dedupeKey: (f) => f.properties._dbId
      })
    } else {
      routeClickHandler = (e) => {
        if (routing.value || appending.value) return
        const hits = map.queryRenderedFeatures(e.point, { layers: [LINE_LAYER, DOT_LAYER] })
        if (hits.length > 0) {
          const id = hits[0].properties._dbId
          openRoutePanel(id)
        }
      }
      map.on('click', routeClickHandler)
    }

    // Pointer cursor on hover.
    map.on('mouseenter', LINE_LAYER, () => {
      if (!routing.value && !appending.value) map.getCanvasContainer().style.cursor = 'pointer'
    })
    map.on('mouseleave', LINE_LAYER, () => {
      if (!routing.value && !appending.value) map.getCanvasContainer().style.cursor = ''
    })
    map.on('mouseenter', DOT_LAYER, (e) => {
      if (routing.value || appending.value) return
      const id = e.features?.[0]?.properties?._dbId
      // Show `grab` when the waypoint belongs to a route whose panel is
      // already open (the user has selected the route). Otherwise it's
      // just clickable to focus it.
      map.getCanvasContainer().style.cursor =
        (id != null && openRouteIds.value.has(id)) ? 'grab' : 'pointer'
    })
    map.on('mouseleave', DOT_LAYER, () => {
      if (!routing.value && !appending.value) map.getCanvasContainer().style.cursor = ''
    })

    setupWaypointDrag(map)
  }

  // Drag-to-move existing waypoints. Two-step "select then drag" matches
  // the manual-track and annotation flows: first click opens the route
  // panel (focuses the route), a subsequent mousedown on any of its
  // waypoints starts a drag. While dragging, the line + dots sources
  // are updated directly for live preview; the DB write happens once
  // on release. Escape cancels and reverts to the canonical state.
  function setupWaypointDrag(map) {
    const canvas = map.getCanvasContainer()

    function pushLivePreview(routeId, overrideCoords) {
      // Mirror syncSources but substitute the in-flight coords for the
      // route under drag. Cheaper than a full store round-trip.
      const routes = featuresStore.features.filter(f => f.type === 'route')
      const lineFeatures = []
      const wpFeatures = []
      for (const row of routes) {
        const geometry = JSON.parse(row.geometry)
        const properties = JSON.parse(row.properties)
        const coords = (row.id === routeId) ? overrideCoords : geometry.coordinates
        const total = coords.length
        const color = properties.color ?? ROUTE_COLOR
        const waypoints = properties.waypoints ?? []
        lineFeatures.push({
          type: 'Feature',
          properties: { _dbId: row.id, color },
          geometry: { type: 'LineString', coordinates: coords }
        })
        for (let i = 0; i < total; i++) {
          const wp = waypoints[i] ?? {}
          wpFeatures.push({
            type: 'Feature',
            properties: {
              _dbId: row.id,
              _index: i,
              color,
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

    function onDotMouseDown(e) {
      if (suppress.value || routing.value || appending.value) return
      if (e.originalEvent?.button !== 0) return
      const f = e.features?.[0]
      const id  = f?.properties?._dbId
      const idx = f?.properties?._index
      if (id == null || idx == null) return

      // Only the focused (panel-open) route accepts drags. First mousedown
      // on an unfocused route's waypoint falls through to the dispatcher's
      // click handler, which opens the panel.
      if (!openRouteIds.value.has(id)) return

      const row = featuresStore.features.find(r => r.id === id)
      if (!row) return
      const geom  = JSON.parse(row.geometry)
      const props = JSON.parse(row.properties)
      if (geom.type !== 'LineString' || idx >= geom.coordinates.length) return

      e.preventDefault()
      map.dragPan.disable()
      canvas.style.cursor = 'grabbing'

      let hasMoved = false
      let lastLngLat = null

      function onWindowMouseMove(me) {
        hasMoved = true
        const rect = canvas.getBoundingClientRect()
        lastLngLat = map.unproject([me.clientX - rect.left, me.clientY - rect.top])
        const newCoords = [...geom.coordinates]
        newCoords[idx] = [lastLngLat.lng, lastLngLat.lat]
        pushLivePreview(id, newCoords)
        draggingWaypoint.value = { routeId: id, index: idx, lng: lastLngLat.lng, lat: lastLngLat.lat }
      }

      function finish(commit) {
        window.removeEventListener('mousemove', onWindowMouseMove)
        window.removeEventListener('mouseup', onWindowMouseUp)
        window.removeEventListener('keydown', onWindowKeyDown)
        map.dragPan.enable()
        canvas.style.cursor = ''
        draggingWaypoint.value = null
        if (commit && hasMoved && lastLngLat) {
          const newCoords = [...geom.coordinates]
          newCoords[idx] = [lastLngLat.lng, lastLngLat.lat]
          featuresStore.updateFeature(
            id,
            { type: 'LineString', coordinates: newCoords },
            props
          )
        } else {
          syncSources()
        }
      }

      function onWindowMouseUp()  { finish(true) }
      function onWindowKeyDown(k) { if (k.key === 'Escape') finish(false) }

      window.addEventListener('mousemove', onWindowMouseMove)
      window.addEventListener('mouseup', onWindowMouseUp)
      window.addEventListener('keydown', onWindowKeyDown)
    }

    map.on('mousedown', DOT_LAYER, onDotMouseDown)
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

  // ---- Label visibility ----

  watch(
    () => settingsStore.showFeatureLabels,
    (show) => {
      const map = getMap()
      if (!map?.getLayer(LABEL_LAYER)) return
      map.setLayoutProperty(LABEL_LAYER, 'visibility', show ? 'visible' : 'none')
    }
  )

  // ---- Live color preview ----

  function previewRouteColor(routeId, color) {
    const map = getMap()
    if (!map) return

    const linesSrc = map.getSource(LINES_SOURCE)
    if (linesSrc) {
      const data = linesSrc._data ?? { type: 'FeatureCollection', features: [] }
      linesSrc.setData({
        ...data,
        features: data.features.map(f =>
          f.properties._dbId === routeId
            ? { ...f, properties: { ...f.properties, color } }
            : f
        )
      })
    }

    const wpSrc = map.getSource(WAYPOINTS_SOURCE)
    if (wpSrc) {
      const data = wpSrc._data ?? { type: 'FeatureCollection', features: [] }
      wpSrc.setData({
        ...data,
        features: data.features.map(f =>
          f.properties._dbId === routeId
            ? { ...f, properties: { ...f.properties, color } }
            : f
        )
      })
    }
  }

  // ---- Cleanup ----

  onUnmounted(() => {
    if (dispatcher) dispatcher.unregister('routes')
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
    initLayers,
    previewRouteColor,
    draggingWaypoint
  }
}
