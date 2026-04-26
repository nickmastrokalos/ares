import { watch, onUnmounted } from 'vue'
import { useAdsbStore } from '@/stores/adsb'
import { useSettingsStore } from '@/stores/settings'
import { distanceBetween } from '@/services/geometry'

const ADSB_CRUMBS       = 'adsb-breadcrumbs'
const ADSB_CRUMB_LAYER  = 'adsb-breadcrumbs-line'
const ADSB_SOURCE       = 'adsb-aircraft'
const ADSB_LAYER        = 'adsb-aircraft-points'
const ADSB_LAYER_ARROWS = 'adsb-aircraft-arrows'
const ADSB_LABELS       = 'adsb-aircraft-labels'

const ADSB_COLOR = '#4dd0e1'  // Material cyan 300 — distinct from AIS yellow.

/**
 * Draw a north-pointing filled chevron onto an offscreen canvas in cyan.
 * The symbol layer applies `icon-rotate: ['get', 'track']` to aim it at each
 * aircraft's true track over ground.
 */
function createArrowImage() {
  const SIZE = 20
  const RATIO = 2
  const canvas = document.createElement('canvas')
  canvas.width  = SIZE * RATIO
  canvas.height = SIZE * RATIO
  const ctx = canvas.getContext('2d')
  ctx.scale(RATIO, RATIO)

  ctx.beginPath()
  ctx.moveTo(10,  2)
  ctx.lineTo(18, 18)
  ctx.lineTo(10, 13)
  ctx.lineTo( 2, 18)
  ctx.closePath()

  ctx.fillStyle = ADSB_COLOR
  ctx.fill()
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 1.2
  ctx.lineJoin = 'round'
  ctx.stroke()

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { width: canvas.width, height: canvas.height, data: imageData.data }
}

const DEBOUNCE_MS = 600
// Aircraft move much faster than vessels, so poll more often. The
// airplanes.live rate limit is 1 req/sec — 10 s leaves plenty of headroom.
const POLL_MS     = 10_000

const METERS_PER_NM = 1852
const MAX_RADIUS_NM = 250  // airplanes.live's hard cap on /point/ queries

export function useMapAdsb(getMap, dispatcher = null, suppress = { value: false }) {
  const adsbStore     = useAdsbStore()
  const settingsStore = useSettingsStore()
  let initialized   = false
  let debounceTimer = null
  let pollTimer     = null

  // Compute a center + radius (in nm) covering the current viewport, clamped
  // to the airplanes.live cap. For very wide viewports the cap means we'll
  // miss aircraft near the corners — acceptable for v1.
  function getQueryParams() {
    const map = getMap()
    if (!map) return null
    const center = map.getCenter()
    const b      = map.getBounds()
    const ne     = b.getNorthEast()
    const sw     = b.getSouthWest()
    const dNeMeters = distanceBetween([center.lng, center.lat], [ne.lng, ne.lat])
    const dSwMeters = distanceBetween([center.lng, center.lat], [sw.lng, sw.lat])
    const radiusNm  = Math.min(MAX_RADIUS_NM, Math.max(dNeMeters, dSwMeters) / METERS_PER_NM)
    return { lat: center.lat, lon: center.lng, radiusNm }
  }

  function scheduleRefetch() {
    if (!adsbStore.enabled) return
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const params = getQueryParams()
      if (params) adsbStore.fetchAircraft(params)
    }, DEBOUNCE_MS)
  }

  function onAircraftClick(e) {
    if (suppress.value) return
    const feature = e.features?.[0]
    if (!feature) return
    adsbStore.openPanel(String(feature.properties.hex))
  }

  function onMouseEnter() {
    if (suppress.value) return
    getMap().getCanvas().style.cursor = 'pointer'
  }

  function onMouseLeave() {
    if (suppress.value) return
    getMap().getCanvas().style.cursor = ''
  }

  function initLayers() {
    const map = getMap()
    if (!map || initialized) return

    // Breadcrumb trails — added first so they render below the aircraft icons.
    map.addSource(ADSB_CRUMBS, {
      type: 'geojson',
      data: adsbStore.breadcrumbCollection
    })

    map.addLayer({
      id: ADSB_CRUMB_LAYER,
      type: 'line',
      source: ADSB_CRUMBS,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ADSB_COLOR,
        'line-width': 1.5,
        'line-opacity': 0.5
      }
    })

    map.addSource(ADSB_SOURCE, {
      type: 'geojson',
      data: adsbStore.aircraftCollection
    })

    // Circle layer — shown when heading-arrows are off.
    map.addLayer({
      id: ADSB_LAYER,
      type: 'circle',
      source: ADSB_SOURCE,
      layout: {
        'visibility': adsbStore.headingArrows ? 'none' : 'visible'
      },
      paint: {
        'circle-radius': 4,
        'circle-color': ADSB_COLOR,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000'
      }
    })

    // Arrow layer — rotates each chevron to the aircraft's true track.
    map.addImage('adsb-arrow', createArrowImage(), { pixelRatio: 2 })
    map.addLayer({
      id: ADSB_LAYER_ARROWS,
      type: 'symbol',
      source: ADSB_SOURCE,
      layout: {
        'icon-image': 'adsb-arrow',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
        'icon-rotate': ['coalesce', ['get', 'track'], 0],
        'visibility': adsbStore.headingArrows ? 'visible' : 'none'
      }
    })

    map.addLayer({
      id: ADSB_LABELS,
      type: 'symbol',
      source: ADSB_SOURCE,
      layout: {
        'text-field': ['get', 'flight'],
        'text-size': 10,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'visibility': settingsStore.showFeatureLabels ? 'visible' : 'none'
      },
      paint: {
        'text-color': ADSB_COLOR,
        'text-halo-color': '#000000',
        'text-halo-width': 1
      }
    })

    map.on('moveend', scheduleRefetch)
    map.on('zoomend', scheduleRefetch)

    if (dispatcher) {
      dispatcher.register('adsb-aircraft', {
        layers: [ADSB_LAYER, ADSB_LAYER_ARROWS],
        action: (f) => adsbStore.openPanel(String(f.properties.hex)),
        suppress: () => suppress.value,
        label: (f) => ({
          text: f.properties.flight || String(f.properties.hex),
          subtitle: 'ADS-B Aircraft',
          icon: 'mdi-airplane'
        }),
        dedupeKey: (f) => String(f.properties.hex)
      })
    } else {
      map.on('click', ADSB_LAYER,        onAircraftClick)
      map.on('click', ADSB_LAYER_ARROWS, onAircraftClick)
    }
    map.on('mouseenter', ADSB_LAYER,        onMouseEnter)
    map.on('mouseleave', ADSB_LAYER,        onMouseLeave)
    map.on('mouseenter', ADSB_LAYER_ARROWS, onMouseEnter)
    map.on('mouseleave', ADSB_LAYER_ARROWS, onMouseLeave)

    initialized = true

    if (adsbStore.enabled) {
      scheduleRefetch()
      pollTimer = setInterval(scheduleRefetch, POLL_MS)
    }
  }

  const stopDataWatch = watch(
    () => adsbStore.aircraftCollection,
    (collection) => {
      getMap()?.getSource(ADSB_SOURCE)?.setData(collection)
    },
    { deep: false }
  )

  const stopCrumbWatch = watch(
    () => adsbStore.breadcrumbCollection,
    (collection) => {
      getMap()?.getSource(ADSB_CRUMBS)?.setData(collection)
    },
    { deep: false }
  )

  const stopEnabledWatch = watch(
    () => adsbStore.enabled,
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
      if (!map?.getLayer(ADSB_LABELS)) return
      map.setLayoutProperty(ADSB_LABELS, 'visibility', show ? 'visible' : 'none')
    }
  )

  watch(
    () => adsbStore.headingArrows,
    (arrows) => {
      const map = getMap()
      if (!map?.getLayer(ADSB_LAYER)) return
      map.setLayoutProperty(ADSB_LAYER,        'visibility', arrows ? 'none'    : 'visible')
      map.setLayoutProperty(ADSB_LAYER_ARROWS, 'visibility', arrows ? 'visible' : 'none')
    }
  )

  onUnmounted(() => {
    if (dispatcher) dispatcher.unregister('adsb-aircraft')
    stopDataWatch()
    stopCrumbWatch()
    stopEnabledWatch()
    clearTimeout(debounceTimer)
    clearInterval(pollTimer)
    const map = getMap()
    if (!map) return
    map.off('moveend', scheduleRefetch)
    map.off('zoomend', scheduleRefetch)
    map.off('click',      ADSB_LAYER,        onAircraftClick)
    map.off('click',      ADSB_LAYER_ARROWS, onAircraftClick)
    map.off('mouseenter', ADSB_LAYER,        onMouseEnter)
    map.off('mouseleave', ADSB_LAYER,        onMouseLeave)
    map.off('mouseenter', ADSB_LAYER_ARROWS, onMouseEnter)
    map.off('mouseleave', ADSB_LAYER_ARROWS, onMouseLeave)
    if (map.getLayer(ADSB_LABELS))       map.removeLayer(ADSB_LABELS)
    if (map.getLayer(ADSB_LAYER_ARROWS)) map.removeLayer(ADSB_LAYER_ARROWS)
    if (map.getLayer(ADSB_LAYER))        map.removeLayer(ADSB_LAYER)
    if (map.getLayer(ADSB_CRUMB_LAYER))  map.removeLayer(ADSB_CRUMB_LAYER)
    if (map.getSource(ADSB_SOURCE))      map.removeSource(ADSB_SOURCE)
    if (map.getSource(ADSB_CRUMBS))      map.removeSource(ADSB_CRUMBS)
    initialized = false
  })

  return { initLayers }
}
