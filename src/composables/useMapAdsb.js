import { ref, computed, watch, onUnmounted } from 'vue'
import { useAdsbStore } from '@/stores/adsb'
import { useSettingsStore } from '@/stores/settings'
import { distanceBetween } from '@/services/geometry'

const ADSB_CRUMBS       = 'adsb-breadcrumbs'
const ADSB_CRUMB_LAYER  = 'adsb-breadcrumbs-line'
const ADSB_SOURCE       = 'adsb-aircraft'
const ADSB_LAYER        = 'adsb-aircraft-points'
const ADSB_LAYER_ARROWS = 'adsb-aircraft-arrows'
const ADSB_LABELS       = 'adsb-aircraft-labels'

const ADSB_COLOR = '#ff4081'  // Material pink A200 — outside the MIL-STD-2525 affiliation palette (cyan/red/green/yellow).

/**
 * Draw a north-pointing filled chevron onto an offscreen canvas in magenta.
 * The symbol layer applies `icon-rotate: ['get', 'track']` to aim it at each
 * aircraft's true track over ground. Military variants use a thicker white
 * stroke + halo so they pop against any basemap.
 */
function createArrowImage({ military } = { military: false }) {
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

  if (military) {
    // White outer halo for at-a-glance distinction, then the standard
    // magenta fill, then a crisp inner black edge so the chevron stays
    // legible on light basemaps.
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth   = 3
    ctx.lineJoin    = 'round'
    ctx.stroke()
    ctx.fillStyle = ADSB_COLOR
    ctx.fill()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth   = 1
    ctx.stroke()
  } else {
    ctx.fillStyle = ADSB_COLOR
    ctx.fill()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth   = 1.2
    ctx.lineJoin    = 'round'
    ctx.stroke()
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { width: canvas.width, height: canvas.height, data: imageData.data }
}

/**
 * Filled circle icon (used by the heading-arrows-off layer). Same fill
 * colour as the chevron; military variants get a thicker white stroke so
 * they stay visually distinct.
 */
function createCircleImage({ military } = { military: false }) {
  const SIZE = 14
  const RATIO = 2
  const canvas = document.createElement('canvas')
  canvas.width  = SIZE * RATIO
  canvas.height = SIZE * RATIO
  const ctx = canvas.getContext('2d')
  ctx.scale(RATIO, RATIO)

  const cx = SIZE / 2, cy = SIZE / 2
  const r  = military ? 4.5 : 4

  if (military) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = ADSB_COLOR
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth   = 2
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = ADSB_COLOR
    ctx.fill()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth   = 1
    ctx.stroke()
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { width: canvas.width, height: canvas.height, data: imageData.data }
}

// Pixels of upward screen-space offset per foot of altitude, at full pitch.
// FL370 (37,000 ft) at full tilt → ~74 px above its ground projection,
// which reads as clear elevation on a tilted map. Pitch < 25° applies
// no offset — the effect would just look like position drift when the
// map is roughly top-down.
const ALTITUDE_OFFSET_PX_PER_FT = 0.002
const PITCH_FLOOR_DEG           = 25

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

  // Map pitch in degrees, refreshed on every map `pitch` event. Drives the
  // altitude → screen-space-offset translation so aircraft visually float
  // above the map when the camera is tilted.
  const pitchDeg = ref(0)

  // Wraps adsbStore.aircraftCollection with per-feature `iconOffset`
  // (pixels) and `textOffset` (ems, ~10 px per em at our 10 px text
  // size) derived from altitude × current pitch. The label sits 1.4 em
  // below the icon at ground level, so we add that to the elevation
  // term so labels track their icons up the screen when the map tilts.
  const renderedCollection = computed(() => {
    const base = adsbStore.aircraftCollection
    const pitch = pitchDeg.value
    const factor = pitch <= PITCH_FLOOR_DEG
      ? 0
      : Math.sin((pitch - PITCH_FLOOR_DEG) * Math.PI / 180)
    return {
      type: 'FeatureCollection',
      features: base.features.map(f => {
        const altRaw = f.properties.altitude
        const altFt  = typeof altRaw === 'number' ? altRaw : 0
        const offsetY = -altFt * ALTITUDE_OFFSET_PX_PER_FT * factor
        return {
          ...f,
          properties: {
            ...f.properties,
            iconOffset: [0, offsetY],
            textOffset: [0, offsetY / 10 + 1.4]
          }
        }
      })
    }
  })

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
      data: renderedCollection.value
    })

    // Both icon variants are symbol layers so each can carry a per-feature
    // `icon-offset` driven by altitude — circles need this too, otherwise
    // they'd stay flat on the ground while arrows float above it.
    map.addImage('adsb-arrow',      createArrowImage({  military: false }), { pixelRatio: 2 })
    map.addImage('adsb-arrow-mil',  createArrowImage({  military: true  }), { pixelRatio: 2 })
    map.addImage('adsb-circle',     createCircleImage({ military: false }), { pixelRatio: 2 })
    map.addImage('adsb-circle-mil', createCircleImage({ military: true  }), { pixelRatio: 2 })

    // Per-feature icon offset in pixels. The store puts a 2-element array
    // on each feature; coerce it for the style validator.
    const iconOffsetExpr = ['array', 'number', 2, ['get', 'iconOffset']]

    // Circle layer (heading-arrows off).
    map.addLayer({
      id: ADSB_LAYER,
      type: 'symbol',
      source: ADSB_SOURCE,
      layout: {
        'icon-image': ['case', ['get', 'military'], 'adsb-circle-mil', 'adsb-circle'],
        'icon-allow-overlap':      true,
        'icon-ignore-placement':   true,
        'icon-rotation-alignment': 'map',
        'icon-offset':             iconOffsetExpr,
        'visibility': adsbStore.headingArrows ? 'none' : 'visible'
      }
    })

    // Arrow layer (heading-arrows on) — chevron rotates to true track.
    map.addLayer({
      id: ADSB_LAYER_ARROWS,
      type: 'symbol',
      source: ADSB_SOURCE,
      layout: {
        'icon-image': ['case', ['get', 'military'], 'adsb-arrow-mil', 'adsb-arrow'],
        'icon-allow-overlap':      true,
        'icon-ignore-placement':   true,
        'icon-rotation-alignment': 'map',
        'icon-rotate':             ['coalesce', ['get', 'track'], 0],
        'icon-offset':             iconOffsetExpr,
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
        'text-offset': ['array', 'number', 2, ['get', 'textOffset']],
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
    // Initial pitch sync, then live updates as the user tilts.
    pitchDeg.value = map.getPitch()
    map.on('pitch',    onPitch)
    map.on('pitchend', onPitch)

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

  // `renderedCollection` already depends on both the store data AND the
  // current pitch, so a single watch covers both "new aircraft arrived"
  // and "user is tilting the map".
  const stopDataWatch = watch(
    () => renderedCollection.value,
    (collection) => {
      getMap()?.getSource(ADSB_SOURCE)?.setData(collection)
    },
    { deep: false }
  )

  function onPitch() {
    const map = getMap()
    if (map) pitchDeg.value = map.getPitch()
  }

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
    map.off('pitch',    onPitch)
    map.off('pitchend', onPitch)
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
