import { ref, watch, onUnmounted } from 'vue'
import {
  boxPolygon,
  circlePolygon,
  sectorPolygon,
  distanceBetween,
  bearingBetween,
  geometryBounds,
  computeImageCorners
} from '@/services/geometry'
import { pickAndReadImage } from '@/services/imageOverlay'
import { useFeaturesStore, DEFAULT_FEATURE_COLOR, DEFAULT_FEATURE_OPACITY } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'

const PREVIEW_SOURCE = 'draw-preview'
const FEATURES_SOURCE = 'draw-features'
const IMAGE_BOUNDS_SOURCE = 'draw-image-bounds'
const SELECTED_LAYER = 'draw-features-selected'
const LABELS_LAYER = 'draw-features-labels'

// Expressions resolving per-feature color / fill-opacity from properties,
// with shared defaults when unset. Data-driven so the attributes panel can
// mutate a single feature and MapLibre re-renders without a paint rebuild.
const featureColor = ['coalesce', ['get', 'color'], DEFAULT_FEATURE_COLOR]
const featureFillOpacity = ['coalesce', ['get', 'opacity'], DEFAULT_FEATURE_OPACITY]

export function useMapDraw(getMap) {
  const activeTool = ref(null)
  const featuresStore = useFeaturesStore()
  const settingsStore = useSettingsStore()

  let points = []
  let clickHandler = null
  let moveHandler = null
  let dblClickHandler = null
  let keyHandler = null
  let selectionClickHandler = null
  let hoverEnter = null
  let hoverLeave = null
  // Set to true while the user is dragging a feature to a new location.
  // Suppresses the selection click handler so the drag doesn't simultaneously
  // deselect the feature being moved.
  let isMovingFeature = false

  const SELECTABLE_LAYERS = [
    'draw-features-fill',
    'draw-features-line',
    'draw-features-points',
    'draw-image-bounds-fill'
  ]

  // Tracks raster image sources/layers added to MapLibre per image feature.
  // Keyed by dbId so syncImages() can diff against current features.
  const imageLayers = new Map()

  function setupMapSources(map) {
    if (!map.getSource(FEATURES_SOURCE)) {
      map.addSource(FEATURES_SOURCE, {
        type: 'geojson',
        data: featuresStore.featureCollection
      })
      map.addLayer({
        id: 'draw-features-fill',
        type: 'fill',
        source: FEATURES_SOURCE,
        filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': featureColor, 'fill-opacity': featureFillOpacity }
      })
      map.addLayer({
        id: 'draw-features-line',
        type: 'line',
        source: FEATURES_SOURCE,
        filter: ['!=', '_type', 'route'],
        paint: { 'line-color': featureColor, 'line-width': 2 }
      })
      map.addLayer({
        id: 'draw-features-points',
        type: 'circle',
        source: FEATURES_SOURCE,
        filter: ['all', ['==', '$type', 'Point'], ['!=', '_type', 'image'], ['!=', '_type', 'manual-track']],
        paint: {
          'circle-color': featureColor,
          'circle-radius': 4
        }
      })
      // Selection highlight: sits on top, filter is swapped when the
      // selected feature changes.
      map.addLayer({
        id: SELECTED_LAYER,
        type: 'line',
        source: FEATURES_SOURCE,
        filter: ['==', '_dbId', -1],
        paint: {
          'line-color': '#4a9ade',
          'line-width': 3,
          'line-opacity': 0.9
        }
      })
      // Feature name labels: single symbol layer over the same source. For
      // polygons MapLibre places the label at an interior point; for lines
      // it picks the midpoint; for points it uses the point itself — good
      // enough across all our shape types without splitting layers by type.
      // Filtered to features that have a `name` so unnamed ones stay silent.
      // Visibility is driven by the `showFeatureLabels` user setting.
      map.addLayer({
        id: LABELS_LAYER,
        type: 'symbol',
        source: FEATURES_SOURCE,
        filter: ['all', ['has', 'name'], ['!=', '_type', 'route']],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-size': 12,
          'text-anchor': 'top',
          'text-offset': [0, 0.6],
          'text-padding': 2,
          'symbol-placement': 'point',
          'visibility': settingsStore.showFeatureLabels ? 'visible' : 'none'
        },
        paint: {
          'text-color': '#e0e0e0',
          'text-halo-color': '#0d0d0d',
          'text-halo-width': 1.5
        }
      })
    }

    if (!map.getSource(PREVIEW_SOURCE)) {
      map.addSource(PREVIEW_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: 'draw-preview-fill',
        type: 'fill',
        source: PREVIEW_SOURCE,
        filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': '#4a9ade', 'fill-opacity': 0.2 }
      })
      map.addLayer({
        id: 'draw-preview-line',
        type: 'line',
        source: PREVIEW_SOURCE,
        paint: { 'line-color': '#4a9ade', 'line-width': 2, 'line-dasharray': [3, 2] }
      })
      map.addLayer({
        id: 'draw-preview-points',
        type: 'circle',
        source: PREVIEW_SOURCE,
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-color': '#4a9ade', 'circle-radius': 5 }
      })
    }

    if (!map.getSource(IMAGE_BOUNDS_SOURCE)) {
      map.addSource(IMAGE_BOUNDS_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      // Invisible fill used exclusively for queryRenderedFeatures hit-testing.
      // Fill layers test polygon containment geometrically, so the user can
      // click anywhere within the image bounds to select it.
      map.addLayer({
        id: 'draw-image-bounds-fill',
        type: 'fill',
        source: IMAGE_BOUNDS_SOURCE,
        paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': 0 }
      })
    }
  }

  function updatePreview(geojson) {
    const map = getMap()
    if (!map) return
    const data = geojson
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geojson, properties: {} }] }
      : { type: 'FeatureCollection', features: [] }
    map.getSource(PREVIEW_SOURCE)?.setData(data)
  }

  function syncFeatures() {
    const map = getMap()
    if (!map) return
    map.getSource(FEATURES_SOURCE)?.setData(featuresStore.featureCollection)
  }

  function cleanup() {
    const map = getMap()
    if (!map) return
    if (clickHandler) map.off('click', clickHandler)
    if (moveHandler) map.off('mousemove', moveHandler)
    if (dblClickHandler) map.off('dblclick', dblClickHandler)
    if (keyHandler) window.removeEventListener('keydown', keyHandler)
    clickHandler = null
    moveHandler = null
    dblClickHandler = null
    keyHandler = null
    points = []
    updatePreview(null)
    map.getCanvasContainer().style.cursor = ''
    map.doubleClickZoom.enable()
  }

  function cancel() {
    cleanup()
    activeTool.value = null
  }

  function startLine() {
    const map = getMap()
    points = []
    map.getCanvasContainer().style.cursor = 'crosshair'

    clickHandler = (e) => {
      points.push([e.lngLat.lng, e.lngLat.lat])
    }

    moveHandler = (e) => {
      if (points.length === 0) return
      const coords = [...points, [e.lngLat.lng, e.lngLat.lat]]
      updatePreview({ type: 'LineString', coordinates: coords })
    }

    dblClickHandler = async (e) => {
      e.preventDefault()
      // A double-click fires two 'click' events before 'dblclick', so the
      // last point in the array is a duplicate of the finish position. Pop it.
      points.pop()
      if (points.length < 2) return
      const geometry = { type: 'LineString', coordinates: [...points] }
      await featuresStore.addFeature('line', geometry, { name: 'Line' })
      cleanup()
      startLine()
    }

    keyHandler = (e) => { if (e.key === 'Escape') cancel() }

    map.on('click', clickHandler)
    map.on('mousemove', moveHandler)
    map.on('dblclick', dblClickHandler)
    window.addEventListener('keydown', keyHandler)
  }

  function startPolygon() {
    const map = getMap()
    points = []
    map.getCanvasContainer().style.cursor = 'crosshair'

    clickHandler = (e) => {
      points.push([e.lngLat.lng, e.lngLat.lat])
    }

    moveHandler = (e) => {
      if (points.length === 0) return
      const coords = [...points, [e.lngLat.lng, e.lngLat.lat], points[0]]
      updatePreview({ type: 'Polygon', coordinates: [coords] })
    }

    dblClickHandler = async (e) => {
      e.preventDefault()
      // Same double-click deduplication as the line handler.
      points.pop()
      if (points.length < 3) return
      const coords = [...points, points[0]]
      const geometry = { type: 'Polygon', coordinates: [coords] }
      await featuresStore.addFeature('polygon', geometry, { name: 'Polygon' })
      cleanup()
      startPolygon()
    }

    keyHandler = (e) => { if (e.key === 'Escape') cancel() }

    map.on('click', clickHandler)
    map.on('mousemove', moveHandler)
    map.on('dblclick', dblClickHandler)
    window.addEventListener('keydown', keyHandler)
  }

  function startCircle() {
    const map = getMap()
    points = []
    map.getCanvasContainer().style.cursor = 'crosshair'

    clickHandler = (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat]
      if (points.length === 0) {
        points.push(pt)
      } else {
        const center = points[0]
        const radius = distanceBetween(center, pt)
        const geometry = circlePolygon(center, radius)
        featuresStore.addFeature('circle', geometry, { name: 'Circle', center, radius })
        cleanup()
        startCircle()
      }
    }

    moveHandler = (e) => {
      if (points.length === 0) return
      const center = points[0]
      const cursor = [e.lngLat.lng, e.lngLat.lat]
      const radius = distanceBetween(center, cursor)
      updatePreview(circlePolygon(center, radius))
    }

    keyHandler = (e) => { if (e.key === 'Escape') cancel() }

    map.on('click', clickHandler)
    map.on('mousemove', moveHandler)
    window.addEventListener('keydown', keyHandler)
  }

  function startSector() {
    const map = getMap()
    points = []
    let radius = 0
    let startAngle = 0
    map.getCanvasContainer().style.cursor = 'crosshair'

    clickHandler = (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat]
      if (points.length === 0) {
        // Set center
        points.push(pt)
      } else if (points.length === 1) {
        // Set radius and start angle
        radius = distanceBetween(points[0], pt)
        startAngle = bearingBetween(points[0], pt)
        points.push(pt)
      } else {
        // Set end angle and finish
        const endAngle = bearingBetween(points[0], pt)
        const geometry = sectorPolygon(points[0], radius, startAngle, endAngle)
        featuresStore.addFeature('sector', geometry, {
          name: 'Sector',
          center: points[0],
          radius,
          startAngle,
          endAngle
        })
        cleanup()
        startSector()
      }
    }

    moveHandler = (e) => {
      const cursor = [e.lngLat.lng, e.lngLat.lat]
      if (points.length === 0) return
      if (points.length === 1) {
        const r = distanceBetween(points[0], cursor)
        updatePreview(circlePolygon(points[0], r))
      } else {
        const endAngle = bearingBetween(points[0], cursor)
        updatePreview(sectorPolygon(points[0], radius, startAngle, endAngle))
      }
    }

    keyHandler = (e) => { if (e.key === 'Escape') cancel() }

    map.on('click', clickHandler)
    map.on('mousemove', moveHandler)
    window.addEventListener('keydown', keyHandler)
  }

  function startBox() {
    const map = getMap()
    points = []
    map.getCanvasContainer().style.cursor = 'crosshair'

    clickHandler = (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat]
      if (points.length === 0) {
        points.push(pt)
      } else {
        const geometry = boxPolygon(points[0], pt)
        featuresStore.addFeature('box', geometry, { name: 'Box' })
        cleanup()
        startBox()
      }
    }

    moveHandler = (e) => {
      if (points.length === 0) return
      const cursor = [e.lngLat.lng, e.lngLat.lat]
      updatePreview(boxPolygon(points[0], cursor))
    }

    keyHandler = (e) => { if (e.key === 'Escape') cancel() }

    map.on('click', clickHandler)
    map.on('mousemove', moveHandler)
    window.addEventListener('keydown', keyHandler)
  }

  async function startImage() {
    const map = getMap()
    if (!map) return

    const imageData = await pickAndReadImage()

    // Guard: tool may have been cancelled while the file dialog was open.
    if (activeTool.value !== 'image') return
    if (!imageData) { cancel(); return }

    const { src, naturalWidth, naturalHeight } = imageData

    map.getCanvasContainer().style.cursor = 'crosshair'

    clickHandler = async (e) => {
      cleanup()
      await featuresStore.addFeature(
        'image',
        { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] },
        { name: 'Image', src, widthMeters: 500, naturalWidth, naturalHeight }
      )
    }

    keyHandler = (e) => { if (e.key === 'Escape') cancel() }

    map.on('click', clickHandler)
    window.addEventListener('keydown', keyHandler)
  }

  // Keeps the set of MapLibre raster image sources/layers in sync with the
  // image features in the store. Called after every featureCollection change
  // and on initLayers. Adds sources for new image features, updates corner
  // coordinates when widthMeters changes, and removes sources for deleted ones.
  async function syncImages(featureCollection) {
    const map = getMap()
    if (!map) return

    const activeIds = new Set()

    for (const feature of featureCollection.features) {
      if (feature.properties._type !== 'image') continue
      const { _dbId: dbId, src, widthMeters, naturalWidth, naturalHeight } = feature.properties
      if (!src || !widthMeters || !naturalWidth || !naturalHeight) continue

      activeIds.add(dbId)
      const aspectRatio = naturalWidth / naturalHeight
      const corners = computeImageCorners(feature.geometry.coordinates, widthMeters, aspectRatio)

      if (imageLayers.has(dbId)) {
        // Already registered — update corners in case widthMeters changed.
        const { sourceId } = imageLayers.get(dbId)
        map.getSource(sourceId)?.setCoordinates(corners)
      } else {
        // New image — add a raster source + layer below the draw features.
        const sourceId = `img_source_${dbId}`
        const layerId = `img_layer_${dbId}`
        if (map.getSource(sourceId)) continue  // safety: already exists

        map.addSource(sourceId, { type: 'image', url: src, coordinates: corners })

        // Insert below draw-features-fill so drawings remain on top.
        const beforeLayer = map.getLayer('draw-features-fill') ? 'draw-features-fill' : undefined
        map.addLayer({ id: layerId, type: 'raster', source: sourceId }, beforeLayer)

        imageLayers.set(dbId, { sourceId, layerId })
      }
    }

    // Remove sources/layers for features that no longer exist.
    for (const [dbId, { sourceId, layerId }] of imageLayers) {
      if (activeIds.has(dbId)) continue
      if (map.getLayer(layerId)) map.removeLayer(layerId)
      if (map.getSource(sourceId)) map.removeSource(sourceId)
      imageLayers.delete(dbId)
    }

    // Keep the image-bounds hit-test source in sync with active images so
    // the user can click anywhere within the image to select it.
    const boundsFeatures = []
    for (const feature of featureCollection.features) {
      if (feature.properties._type !== 'image') continue
      const { _dbId, widthMeters, naturalWidth, naturalHeight } = feature.properties
      if (!widthMeters || !naturalWidth || !naturalHeight) continue
      const aspectRatio = naturalWidth / naturalHeight
      const corners = computeImageCorners(
        feature.geometry.coordinates,
        widthMeters,
        aspectRatio
      )
      boundsFeatures.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]]] },
        properties: { _dbId, _type: 'image' }
      })
    }
    map.getSource(IMAGE_BOUNDS_SOURCE)?.setData({
      type: 'FeatureCollection',
      features: boundsFeatures
    })
  }

  // Recursively shifts all coordinate pairs in a GeoJSON geometry by a
  // lng/lat delta. Returns a new geometry object; the original is unchanged.
  function translateGeometry(geometry, deltaLng, deltaLat) {
    function shift(coords) {
      if (typeof coords[0] === 'number') return [coords[0] + deltaLng, coords[1] + deltaLat]
      return coords.map(shift)
    }
    return { ...geometry, coordinates: shift(geometry.coordinates) }
  }

  // Drag-to-move for image overlays. Disables map pan, tracks mousedown →
  // mousemove → mouseup. Live preview updates the raster source coordinates
  // directly; the DB commit happens only on mouseup.
  function startMoveImage(featureId) {
    const map = getMap()
    if (!map) return

    const row = featuresStore.features.find(f => f.id === featureId)
    if (!row) return
    const props = JSON.parse(row.properties)

    isMovingFeature = true
    map.dragPan.disable()
    map.getCanvasContainer().style.cursor = 'crosshair'

    let hoverHandler = null
    let placeHandler = null
    let keyHandler = null

    function done() {
      isMovingFeature = false
      map.dragPan.enable()
      map.getCanvasContainer().style.cursor = ''
      updatePreview(null)
      if (hoverHandler) { map.off('mousemove', hoverHandler); hoverHandler = null }
      if (placeHandler) { map.off('click', placeHandler); placeHandler = null }
      if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null }
    }

    // Show the image bounding box following the cursor in real-time so the
    // user knows exactly where the image will land before committing.
    hoverHandler = (e) => {
      const center = [e.lngLat.lng, e.lngLat.lat]
      const widthMeters = props.widthMeters ?? 500
      const aspectRatio = (props.naturalWidth ?? 1) / (props.naturalHeight ?? 1)
      const corners = computeImageCorners(center, widthMeters, aspectRatio)
      updatePreview({ type: 'Polygon', coordinates: [[...corners, corners[0]]] })
    }

    // Single click commits the new position.
    placeHandler = async (e) => {
      const finalCenter = [e.lngLat.lng, e.lngLat.lat]
      done()
      await featuresStore.updateFeature(
        featureId,
        { type: 'Point', coordinates: finalCenter },
        props
      )
    }

    keyHandler = (e) => {
      if (e.key === 'Escape') {
        done()
        syncImages(featuresStore.featureCollection)
      }
    }

    map.on('mousemove', hoverHandler)
    map.on('click', placeHandler)
    window.addEventListener('keydown', keyHandler)
  }

  // Returns the center coordinate of a geometry used as the translation
  // anchor when hover-moving a feature. Point → coordinates; everything
  // else → bounding-box center.
  function geometryCenter(geometry) {
    if (geometry.type === 'Point') return geometry.coordinates
    const bounds = geometryBounds(geometry)
    if (!bounds) return geometry.coordinates[0][0]
    return [
      (bounds[0][0] + bounds[1][0]) / 2,
      (bounds[0][1] + bounds[1][1]) / 2
    ]
  }

  // Hover-to-move for all non-image features. The cursor position becomes
  // the new center of the feature in real-time via FEATURES_SOURCE.setData;
  // a single click commits the position. Same interaction pattern as
  // startMoveImage so behaviour is consistent across all feature types.
  function startMoveFeature(featureId) {
    const map = getMap()
    if (!map) return

    const row = featuresStore.features.find(f => f.id === featureId)
    if (!row) return
    const props = JSON.parse(row.properties)
    const originalGeometry = JSON.parse(row.geometry)
    const anchor = geometryCenter(originalGeometry)

    isMovingFeature = true
    map.dragPan.disable()
    map.getCanvasContainer().style.cursor = 'crosshair'

    let hoverHandler = null
    let placeHandler = null
    let keyHandler = null

    function done() {
      isMovingFeature = false
      map.dragPan.enable()
      map.getCanvasContainer().style.cursor = ''
      if (hoverHandler) { map.off('mousemove', hoverHandler); hoverHandler = null }
      if (placeHandler) { map.off('click', placeHandler); placeHandler = null }
      if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null }
    }

    hoverHandler = (e) => {
      const moved = translateGeometry(
        originalGeometry,
        e.lngLat.lng - anchor[0],
        e.lngLat.lat - anchor[1]
      )
      const fc = featuresStore.featureCollection
      map.getSource(FEATURES_SOURCE)?.setData({
        ...fc,
        features: fc.features.map(f =>
          f.properties._dbId === featureId ? { ...f, geometry: moved } : f
        )
      })
    }

    placeHandler = async (e) => {
      const finalGeometry = translateGeometry(
        originalGeometry,
        e.lngLat.lng - anchor[0],
        e.lngLat.lat - anchor[1]
      )
      done()
      await featuresStore.updateFeature(featureId, finalGeometry, props)
    }

    keyHandler = (e) => {
      if (e.key === 'Escape') {
        done()
        map.getSource(FEATURES_SOURCE)?.setData(featuresStore.featureCollection)
      }
    }

    map.on('mousemove', hoverHandler)
    map.on('click', placeHandler)
    window.addEventListener('keydown', keyHandler)
  }

  // Public entry point: dispatches to the appropriate move handler based on
  // the feature's _type property.
  function moveFeature(featureId) {
    const row = featuresStore.features.find(f => f.id === featureId)
    if (!row) return
    if (row.type === 'image') {
      startMoveImage(featureId)
    } else {
      startMoveFeature(featureId)
    }
  }

  function startPoint() {
    const map = getMap()
    map.getCanvasContainer().style.cursor = 'crosshair'

    moveHandler = (e) => {
      updatePreview({ type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] })
    }

    clickHandler = async (e) => {
      const geometry = { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] }
      await featuresStore.addFeature('point', geometry, { name: 'Point' })
      cleanup()
      startPoint()
    }

    keyHandler = (e) => { if (e.key === 'Escape') cancel() }

    map.on('click', clickHandler)
    map.on('mousemove', moveHandler)
    window.addEventListener('keydown', keyHandler)
  }

  function setTool(toolId) {
    cleanup()
    activeTool.value = toolId
    if (!toolId) return

    const map = getMap()
    if (!map) return

    // Entering draw mode clears selection so the highlight doesn't linger.
    featuresStore.selectFeature(null)

    setupMapSources(map)
    map.doubleClickZoom.disable()

    const starters = {
      point: startPoint,
      line: startLine,
      polygon: startPolygon,
      box: startBox,
      circle: startCircle,
      sector: startSector,
      image: startImage
    }
    starters[toolId]?.()
  }

  function setupSelection(map) {
    if (selectionClickHandler) return

    selectionClickHandler = (e) => {
      if (activeTool.value || isMovingFeature) return
      const hits = map.queryRenderedFeatures(e.point, { layers: SELECTABLE_LAYERS })
      featuresStore.selectFeature(hits.length ? hits[0].properties._dbId : null)
    }
    map.on('click', selectionClickHandler)

    // Pointer cursor feedback when hovering a selectable feature, but only
    // while no drawing tool is active.
    hoverEnter = () => {
      if (activeTool.value) return
      map.getCanvasContainer().style.cursor = 'pointer'
    }
    hoverLeave = () => {
      if (activeTool.value) return
      map.getCanvasContainer().style.cursor = ''
    }
    for (const layer of SELECTABLE_LAYERS) {
      map.on('mouseenter', layer, hoverEnter)
      map.on('mouseleave', layer, hoverLeave)
    }
  }

  function applySelectionFilter(map) {
    if (!map.getLayer(SELECTED_LAYER)) return
    const id = featuresStore.selectedFeatureId ?? -1
    map.setFilter(SELECTED_LAYER, ['==', '_dbId', id])
  }

  watch(
    () => featuresStore.selectedFeatureId,
    () => {
      const map = getMap()
      if (map) applySelectionFilter(map)
    }
  )

  // Push any store mutation (add / update / delete) into the map source so
  // edits from the attributes panel render without each caller having to
  // remember to sync.
  watch(
    () => featuresStore.featureCollection,
    (fc) => {
      syncFeatures()
      syncImages(fc)
    }
  )

  // Toggle the labels layer when the user flips the setting. The initial
  // state is set on layer creation, so this only covers runtime changes.
  watch(
    () => settingsStore.showFeatureLabels,
    (show) => {
      const map = getMap()
      if (!map?.getLayer(LABELS_LAYER)) return
      map.setLayoutProperty(LABELS_LAYER, 'visibility', show ? 'visible' : 'none')
    }
  )

  function initLayers() {
    const map = getMap()
    if (!map) return
    setupMapSources(map)
    setupSelection(map)
    applySelectionFilter(map)
    syncFeatures()
    syncImages(featuresStore.featureCollection)
  }

  // Pan/zoom the map to encompass a given geometry. Points get a fly-to
  // (zoomed in if the user was far out); everything else uses fitBounds
  // with a capped max zoom so single-segment lines / tiny polygons don't
  // snap to the deepest zoom level.
  function flyToGeometry(geometry) {
    const map = getMap()
    if (!map || !geometry) return
    if (geometry.type === 'Point') {
      map.flyTo({
        center: geometry.coordinates,
        zoom: Math.max(map.getZoom(), 14),
        duration: 800
      })
      return
    }
    const bounds = geometryBounds(geometry)
    if (!bounds) return
    map.fitBounds(bounds, { padding: 80, duration: 800, maxZoom: 16 })
  }

  onUnmounted(() => cleanup())

  return { activeTool, setTool, cancel, syncFeatures, initLayers, flyToGeometry, moveFeature }
}
