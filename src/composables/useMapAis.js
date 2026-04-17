import { watch, onUnmounted } from 'vue'
import { useAisStore } from '@/stores/ais'
import { useSettingsStore } from '@/stores/settings'

const AIS_CRUMBS      = 'ais-breadcrumbs'
const AIS_CRUMB_LAYER = 'ais-breadcrumbs-line'
const AIS_SOURCE      = 'ais-vessels'
const AIS_LAYER       = 'ais-vessels-points'
const AIS_LAYER_ARROWS = 'ais-vessels-arrows'
const AIS_LABELS      = 'ais-vessels-labels'

/**
 * Draw a north-pointing filled arrowhead onto an offscreen canvas and return
 * the pixel data in the format MapLibre's addImage() expects.
 *
 * The arrow defaults to pointing up (0° = north). The symbol layer applies
 * `icon-rotate: ['get', 'course']` to aim it at each vessel's COG.
 */
function createArrowImage() {
  const SIZE = 20
  const RATIO = 2
  const canvas = document.createElement('canvas')
  canvas.width  = SIZE * RATIO
  canvas.height = SIZE * RATIO
  const ctx = canvas.getContext('2d')
  ctx.scale(RATIO, RATIO)

  // Arrowhead pointing up: tip at top-center, notched base so it reads as
  // a proper directional chevron rather than a plain triangle.
  ctx.beginPath()
  ctx.moveTo(10,  2)   // tip
  ctx.lineTo(18, 18)   // bottom-right wing
  ctx.lineTo(10, 13)   // inner notch
  ctx.lineTo( 2, 18)   // bottom-left wing
  ctx.closePath()

  ctx.fillStyle = '#ffeb3b'
  ctx.fill()
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 1.2
  ctx.lineJoin = 'round'
  ctx.stroke()

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { width: canvas.width, height: canvas.height, data: imageData.data }
}

const DEBOUNCE_MS  = 600
const POLL_MS      = 30_000

export function useMapAis(getMap, dispatcher = null, suppress = { value: false }) {
  const aisStore      = useAisStore()
  const settingsStore = useSettingsStore()
  let initialized   = false
  let debounceTimer = null
  let pollTimer     = null

  function getBounds() {
    const map = getMap()
    if (!map) return null
    const b = map.getBounds()
    return {
      minLat: b.getSouth(),
      maxLat: b.getNorth(),
      minLon: b.getWest(),
      maxLon: b.getEast()
    }
  }

  function scheduleRefetch() {
    if (!aisStore.enabled) return
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const bounds = getBounds()
      if (bounds) aisStore.fetchVessels(bounds)
    }, DEBOUNCE_MS)
  }

  function onVesselClick(e) {
    if (suppress.value) return
    const feature = e.features?.[0]
    if (!feature) return
    aisStore.openPanel(String(feature.properties.mmsi))
  }

  function onMouseEnter() {
    getMap().getCanvas().style.cursor = 'pointer'
  }

  function onMouseLeave() {
    getMap().getCanvas().style.cursor = ''
  }

  function initLayers() {
    const map = getMap()
    if (!map || initialized) return

    // Breadcrumb trails — added first so they render below the vessel dots
    map.addSource(AIS_CRUMBS, {
      type: 'geojson',
      data: aisStore.breadcrumbCollection
    })

    map.addLayer({
      id: AIS_CRUMB_LAYER,
      type: 'line',
      source: AIS_CRUMBS,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffeb3b',
        'line-width': 1.5,
        'line-opacity': 0.5
      }
    })

    map.addSource(AIS_SOURCE, {
      type: 'geojson',
      data: aisStore.vesselCollection
    })

    // Circle layer — shown when breadcrumbs/tails are off.
    map.addLayer({
      id: AIS_LAYER,
      type: 'circle',
      source: AIS_SOURCE,
      layout: {
        'visibility': aisStore.aisBreadcrumbs ? 'none' : 'visible'
      },
      paint: {
        'circle-radius': 5,
        'circle-color': '#ffeb3b',
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000'
      }
    })

    // Arrow layer — shown when breadcrumbs/tails are on.
    // Each arrow rotates to match the vessel's COG (course over ground).
    map.addImage('ais-arrow', createArrowImage(), { pixelRatio: 2 })
    map.addLayer({
      id: AIS_LAYER_ARROWS,
      type: 'symbol',
      source: AIS_SOURCE,
      layout: {
        'icon-image': 'ais-arrow',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
        'icon-rotate': ['coalesce', ['get', 'course'], 0],
        'visibility': aisStore.aisBreadcrumbs ? 'visible' : 'none'
      }
    })

    map.addLayer({
      id: AIS_LABELS,
      type: 'symbol',
      source: AIS_SOURCE,
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 10,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'visibility': settingsStore.showFeatureLabels ? 'visible' : 'none'
      },
      paint: {
        'text-color': '#ffeb3b',
        'text-halo-color': '#000000',
        'text-halo-width': 1
      }
    })

    map.on('moveend', scheduleRefetch)
    map.on('zoomend', scheduleRefetch)

    if (dispatcher) {
      dispatcher.register('ais-vessels', {
        layers: [AIS_LAYER, AIS_LAYER_ARROWS],
        action: (f) => aisStore.openPanel(String(f.properties.mmsi)),
        suppress: () => suppress.value,
        label: (f) => ({
          text: f.properties.name || String(f.properties.mmsi),
          subtitle: 'AIS Vessel',
          icon: 'mdi-ferry'
        }),
        dedupeKey: (f) => String(f.properties.mmsi)
      })
    } else {
      map.on('click', AIS_LAYER, onVesselClick)
      map.on('click', AIS_LAYER_ARROWS, onVesselClick)
    }
    map.on('mouseenter', AIS_LAYER,        onMouseEnter)
    map.on('mouseleave', AIS_LAYER,        onMouseLeave)
    map.on('mouseenter', AIS_LAYER_ARROWS, onMouseEnter)
    map.on('mouseleave', AIS_LAYER_ARROWS, onMouseLeave)

    initialized = true

    // Trigger an immediate fetch if already enabled, then poll every 30s
    if (aisStore.enabled) {
      scheduleRefetch()
      pollTimer = setInterval(scheduleRefetch, POLL_MS)
    }
  }

  // Push vessel dot updates to the map source
  const stopDataWatch = watch(
    () => aisStore.vesselCollection,
    (collection) => {
      getMap()?.getSource(AIS_SOURCE)?.setData(collection)
    },
    { deep: false }
  )

  // Push breadcrumb trail updates
  const stopCrumbWatch = watch(
    () => aisStore.breadcrumbCollection,
    (collection) => {
      getMap()?.getSource(AIS_CRUMBS)?.setData(collection)
    },
    { deep: false }
  )

  // When enabled mid-session, kick off an immediate fetch and start polling.
  // When disabled, cancel the poll.
  const stopEnabledWatch = watch(
    () => aisStore.enabled,
    (val) => {
      if (val) {
        scheduleRefetch()
        if (!pollTimer) pollTimer = setInterval(scheduleRefetch, POLL_MS)
      } else {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  )

  watch(
    () => settingsStore.showFeatureLabels,
    (show) => {
      const map = getMap()
      if (!map?.getLayer(AIS_LABELS)) return
      map.setLayoutProperty(AIS_LABELS, 'visibility', show ? 'visible' : 'none')
    }
  )

  // When heading tails are toggled, swap between circle and arrow icon layers.
  watch(
    () => aisStore.aisBreadcrumbs,
    (tails) => {
      const map = getMap()
      if (!map?.getLayer(AIS_LAYER)) return
      map.setLayoutProperty(AIS_LAYER,        'visibility', tails ? 'none'    : 'visible')
      map.setLayoutProperty(AIS_LAYER_ARROWS, 'visibility', tails ? 'visible' : 'none')
    }
  )

  onUnmounted(() => {
    if (dispatcher) dispatcher.unregister('ais-vessels')
    stopDataWatch()
    stopCrumbWatch()
    stopEnabledWatch()
    clearTimeout(debounceTimer)
    clearInterval(pollTimer)
    const map = getMap()
    if (!map) return
    map.off('moveend', scheduleRefetch)
    map.off('zoomend', scheduleRefetch)
    map.off('click',      AIS_LAYER,        onVesselClick)
    map.off('click',      AIS_LAYER_ARROWS, onVesselClick)
    map.off('mouseenter', AIS_LAYER,        onMouseEnter)
    map.off('mouseleave', AIS_LAYER,        onMouseLeave)
    map.off('mouseenter', AIS_LAYER_ARROWS, onMouseEnter)
    map.off('mouseleave', AIS_LAYER_ARROWS, onMouseLeave)
    if (map.getLayer(AIS_LABELS))      map.removeLayer(AIS_LABELS)
    if (map.getLayer(AIS_LAYER_ARROWS)) map.removeLayer(AIS_LAYER_ARROWS)
    if (map.getLayer(AIS_LAYER))       map.removeLayer(AIS_LAYER)
    if (map.getLayer(AIS_CRUMB_LAYER)) map.removeLayer(AIS_CRUMB_LAYER)
    if (map.getSource(AIS_SOURCE))     map.removeSource(AIS_SOURCE)
    if (map.getSource(AIS_CRUMBS))     map.removeSource(AIS_CRUMBS)
    initialized = false
  })

  return { initLayers }
}
