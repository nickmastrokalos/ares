import { ref, watch, onUnmounted } from 'vue'
import {
  boxPolygon,
  rotatedBoxPolygon,
  circlePolygon,
  sectorPolygon,
  ellipsePolygon,
  destinationPoint,
  distanceBetween,
  bearingBetween,
  inverseRotateAroundCenter,
  geometryBounds,
  computeImageCorners,
  ringCentroid
} from '@/services/geometry'
import { pickAndReadImage } from '@/services/imageOverlay'
import { useFeaturesStore, DEFAULT_FEATURE_COLOR, DEFAULT_FEATURE_OPACITY } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'

const PREVIEW_SOURCE = 'draw-preview'
const FEATURES_SOURCE = 'draw-features'
const IMAGE_BOUNDS_SOURCE = 'draw-image-bounds'
const VERTEX_HANDLES_SOURCE = 'draw-vertex-handles'
const SELECTED_LAYER = 'draw-features-selected'
const LABELS_LAYER = 'draw-features-labels'
const VERTEX_HANDLES_LAYER = 'draw-vertex-handles-layer'

// Expressions resolving per-feature color / fill-opacity from properties,
// with shared defaults when unset. Data-driven so the attributes panel can
// mutate a single feature and MapLibre re-renders without a paint rebuild.
const featureColor = ['coalesce', ['get', 'color'], DEFAULT_FEATURE_COLOR]
const featureFillOpacity = ['coalesce', ['get', 'opacity'], DEFAULT_FEATURE_OPACITY]

const SHAPE_ICONS = {
  point:   'mdi-map-marker',
  line:    'mdi-vector-polyline',
  polygon: 'mdi-vector-polygon',
  circle:  'mdi-circle-outline',
  ellipse: 'mdi-ellipse-outline',
  sector:  'mdi-angle-acute',
  box:     'mdi-rectangle-outline',
  image:   'mdi-image-outline'
}

export function useMapDraw(getMap, dispatcher = null, suppress = { value: false }) {
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
  // Non-null while a vertex handle drag is in progress.
  let dragState = null
  let vertexHandlesSetup = false
  // Exposes the transient feature state during a handle drag so the
  // AttributesPanel can sync its fields in real-time without a DB round-trip.
  const draggingFeature = ref(null)

  // Returns the next default name for a new feature of `type`, numbered so it
  // is unique within the active mission (e.g. "Polygon 1", "Polygon 2", …).
  // Mirrors the scan-and-increment strategy used by useMapManualTracks so the
  // UX is consistent across draw features and manual tracks.
  const FEATURE_LABELS = {
    line: 'Line', polygon: 'Polygon', circle: 'Circle', sector: 'Sector',
    ellipse: 'Ellipse', box: 'Box', image: 'Image', point: 'Point'
  }
  function nextFeatureName(type) {
    const base = FEATURE_LABELS[type] ?? type
    const re = new RegExp(`^${base}\\s+(\\d+)$`)
    let max = 0
    for (const f of featuresStore.features) {
      if (f.type !== type) continue
      try {
        const props = JSON.parse(f.properties)
        const m = String(props.name ?? '').match(re)
        if (m) {
          const n = parseInt(m[1])
          if (!isNaN(n) && n > max) max = n
        }
      } catch { /* skip malformed row */ }
    }
    return `${base} ${max + 1}`
  }

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

    if (!map.getSource(VERTEX_HANDLES_SOURCE)) {
      map.addSource(VERTEX_HANDLES_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: VERTEX_HANDLES_LAYER,
        type: 'circle',
        source: VERTEX_HANDLES_SOURCE,
        paint: {
          'circle-radius': 6,
          // Rotation handles paint amber so the operator distinguishes them
          // from resize / translate handles at a glance.
          'circle-color': [
            'match', ['get', 'kind'],
            'rotation', '#ffb84a',
            '#ffffff'
          ],
          'circle-stroke-color': [
            'match', ['get', 'kind'],
            'rotation', '#b37a1f',
            '#4a9ade'
          ],
          'circle-stroke-width': 2
        }
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
      await featuresStore.addFeature('line', geometry, { name: nextFeatureName('line') })
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
      const cursor = [e.lngLat.lng, e.lngLat.lat]
      // With only one point a closed polygon ring would be degenerate (3
      // positions, two of them identical) and MapLibre won't render it.
      // Show a simple line segment instead so the user gets immediate feedback.
      if (points.length === 1) {
        updatePreview({ type: 'LineString', coordinates: [points[0], cursor] })
        return
      }
      updatePreview({ type: 'Polygon', coordinates: [[...points, cursor, points[0]]] })
    }

    dblClickHandler = async (e) => {
      e.preventDefault()
      // Same double-click deduplication as the line handler.
      points.pop()
      if (points.length < 3) return
      const coords = [...points, points[0]]
      const geometry = { type: 'Polygon', coordinates: [coords] }
      await featuresStore.addFeature('polygon', geometry, { name: nextFeatureName('polygon') })
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
        featuresStore.addFeature('circle', geometry, { name: nextFeatureName('circle'), center, radius })
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
          name: nextFeatureName('sector'),
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

  function startEllipse() {
    const map = getMap()
    points = []
    let radiusMajor = 0
    let rotation    = 0
    map.getCanvasContainer().style.cursor = 'crosshair'

    clickHandler = (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat]
      if (points.length === 0) {
        points.push(pt)
      } else if (points.length === 1) {
        radiusMajor = distanceBetween(points[0], pt)
        rotation    = bearingBetween(points[0], pt)
        points.push(pt)
      } else {
        const radiusMinor = distanceBetween(points[0], pt)
        const geometry = ellipsePolygon(points[0], radiusMajor, radiusMinor, rotation)
        featuresStore.addFeature('ellipse', geometry, {
          name: nextFeatureName('ellipse'),
          center: points[0],
          radiusMajor,
          radiusMinor,
          rotation
        })
        cleanup()
        startEllipse()
      }
    }

    moveHandler = (e) => {
      const cursor = [e.lngLat.lng, e.lngLat.lat]
      if (points.length === 0) return
      if (points.length === 1) {
        const r = distanceBetween(points[0], cursor)
        updatePreview(circlePolygon(points[0], r))
      } else {
        const radiusMinor = distanceBetween(points[0], cursor)
        updatePreview(ellipsePolygon(points[0], radiusMajor, radiusMinor, rotation))
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
        const sw = [Math.min(points[0][0], pt[0]), Math.min(points[0][1], pt[1])]
        const ne = [Math.max(points[0][0], pt[0]), Math.max(points[0][1], pt[1])]
        featuresStore.addFeature('box', boxPolygon(sw, ne), { name: nextFeatureName('box'), sw, ne, rotationDeg: 0 })
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
        { name: nextFeatureName('image'), src, widthMeters: 500, naturalWidth, naturalHeight }
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
      await featuresStore.addFeature('point', geometry, { name: nextFeatureName('point') })
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
      ellipse: startEllipse,
      sector: startSector,
      image: startImage
    }
    starters[toolId]?.()
  }

  function setupSelection(map) {
    if (dispatcher) {
      // Register with the central click dispatcher for overlap disambiguation.
      dispatcher.register('draw-features', {
        layers: SELECTABLE_LAYERS,
        action: (f) => featuresStore.selectFeature(f.properties._dbId),
        suppress: () => Boolean(activeTool.value) || isMovingFeature || suppress.value,
        label: (f) => {
          const type = f.properties._type
          return {
            text: f.properties.name || (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Shape'),
            subtitle: type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Shape',
            icon: SHAPE_ICONS[type] || 'mdi-shape-outline'
          }
        },
        dedupeKey: (f) => f.properties._dbId,
        onMiss: () => featuresStore.selectFeature(null)
      })
    } else {
      if (selectionClickHandler) return
      selectionClickHandler = (e) => {
        if (activeTool.value || isMovingFeature) return
        const hits = map.queryRenderedFeatures(e.point, { layers: SELECTABLE_LAYERS })
        featuresStore.selectFeature(hits.length ? hits[0].properties._dbId : null)
      }
      map.on('click', selectionClickHandler)
    }

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

  // Returns a GeoJSON FeatureCollection of draggable handle Points for the
  // selected feature. Each Point carries `kind` and `index` properties that
  // applyVertexDrag uses to identify which parameter to update on drag.
  function computeHandles(feature) {
    if (!feature || activeTool.value) return { type: 'FeatureCollection', features: [] }
    const { type, geometry: geom, properties: props } = feature
    const handles = []

    if (type === 'point') {
      handles.push({ lng: geom.coordinates[0], lat: geom.coordinates[1], kind: 'vertex', index: 0 })
    } else if (type === 'line') {
      geom.coordinates.forEach(([lng, lat], i) =>
        handles.push({ lng, lat, kind: 'vertex', index: i })
      )
    } else if (type === 'polygon') {
      const ring = geom.coordinates[0]
      // Exclude the closing duplicate (last === first).
      for (let i = 0; i < ring.length - 1; i++) {
        handles.push({ lng: ring[i][0], lat: ring[i][1], kind: 'vertex', index: i })
      }
      // Center handle lets the user translate the whole polygon.
      const [clon, clat] = ringCentroid(ring)
      handles.push({ lng: clon, lat: clat, kind: 'center', index: ring.length })
    } else if (type === 'circle') {
      const { center, radius } = props
      handles.push({ lng: center[0], lat: center[1], kind: 'center', index: 0 })
      const [rlng, rlat] = destinationPoint(center, radius, 90)
      handles.push({ lng: rlng, lat: rlat, kind: 'radius', index: 1 })
    } else if (type === 'sector') {
      const { center, radius, startAngle, endAngle } = props
      let sweep = endAngle - startAngle
      if (sweep <= 0) sweep += 360
      const bisector = startAngle + sweep / 2
      handles.push({ lng: center[0], lat: center[1], kind: 'center', index: 0 })
      const [rlng, rlat] = destinationPoint(center, radius, bisector)
      handles.push({ lng: rlng, lat: rlat, kind: 'radius', index: 1 })
      const [slng, slat] = destinationPoint(center, radius, startAngle)
      handles.push({ lng: slng, lat: slat, kind: 'startAngle', index: 2 })
      const [elng, elat] = destinationPoint(center, radius, endAngle)
      handles.push({ lng: elng, lat: elat, kind: 'endAngle', index: 3 })
    } else if (type === 'ellipse') {
      const { center, radiusMajor, radiusMinor, rotation = 0 } = props
      handles.push({ lng: center[0], lat: center[1], kind: 'center', index: 0 })
      const [mlng, mlat] = destinationPoint(center, radiusMajor, rotation)
      handles.push({ lng: mlng, lat: mlat, kind: 'majorTip', index: 1 })
      const [nlng, nlat] = destinationPoint(center, radiusMinor, (rotation + 90) % 360)
      handles.push({ lng: nlng, lat: nlat, kind: 'minorTip', index: 2 })
    } else if (type === 'box') {
      const { sw, ne, rotationDeg = 0 } = props
      const corners = sw && ne
        ? rotatedBoxPolygon(sw, ne, rotationDeg).coordinates[0]
        : geom.coordinates[0]
      for (let i = 0; i < 4; i++) {
        handles.push({ lng: corners[i][0], lat: corners[i][1], kind: 'corner', index: i })
      }
      // Center handle lets the user translate the whole box.
      const bSw = sw ?? [Math.min(...geom.coordinates[0].map(c => c[0])), Math.min(...geom.coordinates[0].map(c => c[1]))]
      const bNe = ne ?? [Math.max(...geom.coordinates[0].map(c => c[0])), Math.max(...geom.coordinates[0].map(c => c[1]))]
      const cx = (bSw[0] + bNe[0]) / 2
      const cy = (bSw[1] + bNe[1]) / 2
      handles.push({ lng: cx, lat: cy, kind: 'center', index: 4 })
      // Rotation handle: placed outside the box along the bearing equal to the
      // current rotationDeg, so bearingBetween(center, handle) round-trips back
      // to rotationDeg on drag. 1.3× half-diagonal keeps it clear of the corners.
      const halfDiagonal = distanceBetween([cx, cy], bNe)
      const [rlng, rlat] = destinationPoint([cx, cy], halfDiagonal * 1.3, rotationDeg)
      handles.push({ lng: rlng, lat: rlat, kind: 'rotation', index: 5 })
    } else if (type === 'image') {
      handles.push({ lng: geom.coordinates[0], lat: geom.coordinates[1], kind: 'anchor', index: 0 })
    }

    return {
      type: 'FeatureCollection',
      features: handles.map(h => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [h.lng, h.lat] },
        properties: { kind: h.kind, index: h.index }
      }))
    }
  }

  // Pure function: given a feature snapshot and the dragged handle's new
  // position, returns the updated { geometry, properties } pair. For literal
  // shapes it splices coordinates directly; for parametric shapes it
  // back-computes properties and regenerates via the existing builders.
  function applyVertexDrag(feature, kind, index, [lng, lat]) {
    const props = { ...feature.properties }
    const geom = feature.geometry

    if (feature.type === 'point') {
      return { geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props }
    }

    if (feature.type === 'line') {
      const coords = geom.coordinates.map((c, i) => i === index ? [lng, lat] : c)
      return { geometry: { type: 'LineString', coordinates: coords }, properties: props }
    }

    if (feature.type === 'polygon') {
      if (kind === 'center') {
        const ring = geom.coordinates[0]
        const [clon, clat] = ringCentroid(ring)
        const dLng = lng - clon
        const dLat = lat - clat
        const newRing = ring.map(([lo, la]) => [lo + dLng, la + dLat])
        return { geometry: { type: 'Polygon', coordinates: [newRing] }, properties: props }
      }
      const ring = [...geom.coordinates[0]]
      ring[index] = [lng, lat]
      // Keep the closing duplicate in sync with vertex 0.
      if (index === 0) ring[ring.length - 1] = [lng, lat]
      return { geometry: { type: 'Polygon', coordinates: [ring] }, properties: props }
    }

    if (feature.type === 'circle') {
      const center = kind === 'center' ? [lng, lat] : [...props.center]
      const radius = kind === 'radius'
        ? distanceBetween(props.center, [lng, lat])
        : props.radius
      return { geometry: circlePolygon(center, radius), properties: { ...props, center, radius } }
    }

    if (feature.type === 'sector') {
      let center = [...props.center]
      let { radius, startAngle, endAngle } = props
      if (kind === 'center') center = [lng, lat]
      else if (kind === 'radius') radius = distanceBetween(props.center, [lng, lat])
      else if (kind === 'startAngle') startAngle = bearingBetween(props.center, [lng, lat])
      else if (kind === 'endAngle') endAngle = bearingBetween(props.center, [lng, lat])
      return {
        geometry: sectorPolygon(center, radius, startAngle, endAngle),
        properties: { ...props, center, radius, startAngle, endAngle }
      }
    }

    if (feature.type === 'ellipse') {
      let center = [...props.center]
      let { radiusMajor, radiusMinor, rotation = 0 } = props
      if (kind === 'center') center = [lng, lat]
      else if (kind === 'majorTip') {
        radiusMajor = distanceBetween(props.center, [lng, lat])
        rotation    = bearingBetween(props.center, [lng, lat])
      } else if (kind === 'minorTip') {
        radiusMinor = distanceBetween(props.center, [lng, lat])
      }
      return {
        geometry: ellipsePolygon(center, radiusMajor, radiusMinor, rotation),
        properties: { ...props, center, radiusMajor, radiusMinor, rotation }
      }
    }

    if (feature.type === 'box') {
      let sw = props.sw ? [...props.sw] : null
      let ne = props.ne ? [...props.ne] : null
      const rotationDeg = props.rotationDeg ?? 0
      if (!sw || !ne) {
        // Legacy box without stored sw/ne: derive from geometry bounds.
        const coords = geom.coordinates[0]
        sw = [Math.min(...coords.map(c => c[0])), Math.min(...coords.map(c => c[1]))]
        ne = [Math.max(...coords.map(c => c[0])), Math.max(...coords.map(c => c[1]))]
      }
      if (kind === 'center') {
        // Translate the whole box by the delta from old center to drag point.
        const cx = (sw[0] + ne[0]) / 2
        const cy = (sw[1] + ne[1]) / 2
        const dLng = lng - cx
        const dLat = lat - cy
        const newSw = [sw[0] + dLng, sw[1] + dLat]
        const newNe = [ne[0] + dLng, ne[1] + dLat]
        return {
          geometry: rotatedBoxPolygon(newSw, newNe, rotationDeg),
          properties: { ...props, sw: newSw, ne: newNe, rotationDeg }
        }
      }
      if (kind === 'rotation') {
        // Bearing from center to drag point becomes the new rotationDeg.
        const cx = (sw[0] + ne[0]) / 2
        const cy = (sw[1] + ne[1]) / 2
        const newRotation = ((bearingBetween([cx, cy], [lng, lat]) % 360) + 360) % 360
        return {
          geometry: rotatedBoxPolygon(sw, ne, newRotation),
          properties: { ...props, sw, ne, rotationDeg: newRotation }
        }
      }
      // Reverse-rotate the drag point into the box's unrotated frame so sw/ne
      // can be updated in plain axis-aligned space.
      const cx = (sw[0] + ne[0]) / 2
      const cy = (sw[1] + ne[1]) / 2
      const [ulng, ulat] = inverseRotateAroundCenter([lng, lat], [cx, cy], rotationDeg)
      // Corner order matches rotatedBoxPolygon: 0=SW, 1=SE, 2=NE, 3=NW.
      if (index === 0) { sw[0] = ulng; sw[1] = ulat }
      else if (index === 1) { ne[0] = ulng; sw[1] = ulat }
      else if (index === 2) { ne[0] = ulng; ne[1] = ulat }
      else if (index === 3) { sw[0] = ulng; ne[1] = ulat }
      return {
        geometry: rotatedBoxPolygon(sw, ne, rotationDeg),
        properties: { ...props, sw, ne, rotationDeg }
      }
    }

    if (feature.type === 'image') {
      return { geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props }
    }

    return { geometry: geom, properties: props }
  }

  // Wire cursor and drag handlers on the vertex handles layer. Called once
  // from initLayers; subsequent calls are no-ops.
  function setupVertexHandles(map) {
    if (vertexHandlesSetup) return
    vertexHandlesSetup = true
    const canvas = map.getCanvasContainer()

    map.on('mouseenter', VERTEX_HANDLES_LAYER, () => {
      if (activeTool.value) return
      canvas.style.cursor = 'grab'
    })

    map.on('mouseleave', VERTEX_HANDLES_LAYER, () => {
      if (activeTool.value || dragState) return
      canvas.style.cursor = ''
    })

    map.on('mousedown', VERTEX_HANDLES_LAYER, (e) => {
      if (activeTool.value || isMovingFeature) return
      e.preventDefault()

      const handle = e.features[0].properties
      const feature = featuresStore.selectedFeature
      if (!feature) return

      dragState = {
        featureId: feature.id,
        kind: handle.kind,
        index: Number(handle.index),
        // Deep clone so the original snapshot is never mutated mid-drag.
        originalFeature: JSON.parse(JSON.stringify(feature))
      }
      isMovingFeature = true
      map.dragPan.disable()
      canvas.style.cursor = 'grabbing'

      let hasMoved = false
      let lastLngLat = null

      function onWindowMouseMove(me) {
        hasMoved = true
        if (!dragState) return
        const rect = canvas.getBoundingClientRect()
        lastLngLat = map.unproject([me.clientX - rect.left, me.clientY - rect.top])
        const { geometry, properties } = applyVertexDrag(
          dragState.originalFeature, dragState.kind, dragState.index,
          [lastLngLat.lng, lastLngLat.lat]
        )
        // Live preview: patch FEATURES_SOURCE directly — no DB write per frame.
        const fc = featuresStore.featureCollection
        map.getSource(FEATURES_SOURCE)?.setData({
          ...fc,
          features: fc.features.map(f =>
            f.properties._dbId === dragState.featureId
              ? { ...f, geometry, properties: { ...f.properties, ...properties } }
              : f
          )
        })
        // Move handles alongside the shape in real-time.
        map.getSource(VERTEX_HANDLES_SOURCE)?.setData(
          computeHandles({ ...dragState.originalFeature, geometry, properties })
        )
        // Broadcast live state to the AttributesPanel without a store write.
        draggingFeature.value = { ...dragState.originalFeature, geometry, properties }
      }

      function finish(commit) {
        window.removeEventListener('mousemove', onWindowMouseMove)
        window.removeEventListener('mouseup', onWindowMouseUp)
        window.removeEventListener('keydown', onWindowKeyDown)
        if (!dragState) return
        const savedState = dragState
        dragState = null
        isMovingFeature = false
        map.dragPan.enable()
        canvas.style.cursor = ''

        draggingFeature.value = null

        if (commit && hasMoved && lastLngLat) {
          // Single DB write on release using the final drag position.
          const { geometry, properties } = applyVertexDrag(
            savedState.originalFeature, savedState.kind, savedState.index,
            [lastLngLat.lng, lastLngLat.lat]
          )
          featuresStore.updateFeature(savedState.featureId, geometry, properties)
        } else {
          // Escape or zero-movement click: revert the live preview.
          map.getSource(FEATURES_SOURCE)?.setData(featuresStore.featureCollection)
          map.getSource(VERTEX_HANDLES_SOURCE)?.setData(computeHandles(featuresStore.selectedFeature))
        }
      }

      function onWindowMouseUp() { finish(true) }
      function onWindowKeyDown(ke) { if (ke.key === 'Escape') finish(false) }

      window.addEventListener('mousemove', onWindowMouseMove)
      window.addEventListener('mouseup', onWindowMouseUp)
      window.addEventListener('keydown', onWindowKeyDown)
    })
  }

  watch(
    () => featuresStore.selectedFeatureId,
    () => {
      const map = getMap()
      if (map) applySelectionFilter(map)
    }
  )

  // Refresh vertex handles whenever the selected feature changes (e.g. after
  // an attribute panel edit or a DB commit from a drag). Skip while a drag is
  // in progress — the drag loop manages the handles directly in that case.
  watch(
    () => featuresStore.selectedFeature,
    (f) => {
      if (dragState) return
      const map = getMap()
      const src = map?.getSource(VERTEX_HANDLES_SOURCE)
      if (src) src.setData(computeHandles(f))
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
    setupVertexHandles(map)
    applySelectionFilter(map)
    syncFeatures()
    syncImages(featuresStore.featureCollection)
  }

  // Patches the FEATURES_SOURCE color for a single feature without a DB write.
  // Used by AttributesPanel to give live map feedback while the color picker
  // is open. The DB write happens separately when the picker closes.
  function previewFeatureColor(featureId, color) {
    const map = getMap()
    if (!map) return
    const fc = featuresStore.featureCollection
    map.getSource(FEATURES_SOURCE)?.setData({
      ...fc,
      features: fc.features.map(f =>
        f.properties._dbId === featureId
          ? { ...f, properties: { ...f.properties, color } }
          : f
      )
    })
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

  onUnmounted(() => {
    if (dispatcher) dispatcher.unregister('draw-features')
    cleanup()
    const map = getMap()
    if (!map) return
    if (selectionClickHandler) map.off('click', selectionClickHandler)
    if (hoverEnter) {
      for (const layer of SELECTABLE_LAYERS) {
        map.off('mouseenter', layer, hoverEnter)
        map.off('mouseleave', layer, hoverLeave)
      }
    }
  })

  return { activeTool, draggingFeature, setTool, cancel, syncFeatures, initLayers, flyToGeometry, moveFeature, previewFeatureColor }
}
