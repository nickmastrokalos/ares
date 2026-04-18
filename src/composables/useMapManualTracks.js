import { ref, computed, watch, onUnmounted } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { cotTypeToSidc, getOrCreateIcon } from '@/services/sidc'

const MANUAL_TRACKS_SOURCE  = 'manual-tracks'
const MANUAL_TRACKS_LAYER   = 'manual-tracks-points'
const MANUAL_TRACKS_SYMBOLS = 'manual-tracks-symbols'
const MANUAL_TRACKS_LABELS  = 'manual-tracks-labels'

export const AFFIL_CONFIG = {
  f: { label: 'Friendly', color: '#4a9ade', prefix: 'FRND' },
  n: { label: 'Civilian', color: '#4caf50', prefix: 'CIV' },
  u: { label: 'Unknown',  color: '#ffeb3b', prefix: 'UNKN' },
  h: { label: 'Hostile',  color: '#f44336', prefix: 'HSTL' }
}

const AFFIL_MATCH = [
  'match', ['get', 'affiliation'],
  'f', '#4a9ade',
  'h', '#f44336',
  'n', '#4caf50',
  'u', '#ffeb3b',
  '#ffeb3b'
]

// Filter expressions keyed by milStd mode.
const FILTER_CIRCLE_MILSTD = ['==', ['get', 'sidc'], '']   // only untyped tracks
const FILTER_SYMBOL_MILSTD = ['!=', ['get', 'sidc'], '']   // only typed tracks

export function useMapManualTracks(getMap, suppress = { value: false }, dispatcher = null) {
  const featuresStore = useFeaturesStore()
  const settingsStore = useSettingsStore()

  // placing: null | { affiliation: string, cotType: string|null }
  const placing      = ref(null)
  const openPanelIds = ref(new Set())
  const focusedId    = ref(null)

  let placeClickHandler = null
  let keyHandler        = null
  // Guards the post-drag click that the map fires on mouseup: without it the
  // dispatcher would open the panel every time we drag a track.
  let suppressNextClick = false

  // ---- Derived data ----

  const manualTrackCollection = computed(() => ({
    type: 'FeatureCollection',
    features: featuresStore.features
      .filter(f => f.type === 'manual-track')
      .map(f => {
        const props = JSON.parse(f.properties)
        const cotType = props.cotType ?? null
        const sidc    = cotType ? cotTypeToSidc(cotType) : ''
        return {
          type: 'Feature',
          geometry: JSON.parse(f.geometry),
          properties: {
            _dbId:       f.id,
            callsign:    props.callsign,
            affiliation: props.affiliation,
            cotType,
            sidc
          }
        }
      })
  }))

  const openPanelList = computed(() => [...openPanelIds.value])

  // ---- Panel management ----

  function openPanel(id) {
    focusedId.value = id
    openPanelIds.value = new Set([...openPanelIds.value, id])
  }

  function closePanel(id) {
    const next = new Set(openPanelIds.value)
    next.delete(id)
    openPanelIds.value = next
  }

  // ---- Auto-naming ----

  function nextName(affiliation) {
    const { prefix } = AFFIL_CONFIG[affiliation]
    let max = 0
    for (const f of featuresStore.features) {
      if (f.type !== 'manual-track') continue
      const props = JSON.parse(f.properties)
      if (props.callsign?.startsWith(prefix + '-')) {
        const n = parseInt(props.callsign.slice(prefix.length + 1))
        if (!isNaN(n) && n > max) max = n
      }
    }
    return `${prefix}-${max + 1}`
  }

  // ---- MIL-STD-2525 icon registration ----

  function ensureMilStdIcons(map, features) {
    for (const f of features) {
      const sidc = f.properties.sidc
      if (!sidc) continue
      if (!map.hasImage(sidc)) {
        const { image } = getOrCreateIcon(sidc)
        map.addImage(sidc, image, { pixelRatio: 2 })
      }
    }
  }

  // ---- Placement handlers ----

  function removePlaceHandlers() {
    const map = getMap()
    if (placeClickHandler) { map?.off('click', placeClickHandler); placeClickHandler = null }
    if (keyHandler)        { window.removeEventListener('keydown', keyHandler); keyHandler = null }
    const canvas = getMap()?.getCanvasContainer()
    if (canvas) canvas.style.cursor = ''
  }

  function activatePlacement() {
    const map = getMap()
    if (!map) return
    map.getCanvasContainer().style.cursor = 'crosshair'

    placeClickHandler = async (e) => {
      const { affiliation, cotType } = placing.value ?? {}
      if (!affiliation) return
      const callsign = nextName(affiliation)
      await featuresStore.addFeature(
        'manual-track',
        { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] },
        { callsign, affiliation, cotType: cotType ?? null }
      )
      // Stay in placing mode — allows rapid sequential drops.
    }

    keyHandler = (e) => {
      if (e.key === 'Escape') setPlacing(null)
    }

    map.on('click', placeClickHandler)
    window.addEventListener('keydown', keyHandler)
  }

  function setPlacing(payload) {  // null | { affiliation, cotType }
    removePlaceHandlers()
    placing.value = payload ?? null
    if (placing.value) activatePlacement()
  }

  // ---- Map layers ----

  function initLayers() {
    const map = getMap()
    if (!map || map.getSource(MANUAL_TRACKS_SOURCE)) return

    const use2525 = settingsStore.milStdSymbology

    // Register icons for any manual tracks that already exist when the layer
    // is (re)initialized. Without this, re-entering the map view renders
    // labels but no symbols until the feature list next changes.
    if (use2525) ensureMilStdIcons(map, manualTrackCollection.value.features)

    map.addSource(MANUAL_TRACKS_SOURCE, {
      type: 'geojson',
      data: manualTrackCollection.value
    })

    // Circle layer — shown for all tracks when milStd off; only untyped tracks when milStd on.
    const circleSpec = {
      id:     MANUAL_TRACKS_LAYER,
      type:   'circle',
      source: MANUAL_TRACKS_SOURCE,
      paint: {
        'circle-radius': 6,
        'circle-color': AFFIL_MATCH,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000'
      }
    }
    if (use2525) circleSpec.filter = FILTER_CIRCLE_MILSTD
    map.addLayer(circleSpec)

    // Symbol layer — only visible when milStd is on, only for typed tracks.
    map.addLayer({
      id:     MANUAL_TRACKS_SYMBOLS,
      type:   'symbol',
      source: MANUAL_TRACKS_SOURCE,
      filter: FILTER_SYMBOL_MILSTD,
      layout: {
        'icon-image':            ['get', 'sidc'],
        'icon-allow-overlap':    true,
        'icon-ignore-placement': true,
        'visibility':            use2525 ? 'visible' : 'none'
      }
    })

    map.addLayer({
      id:     MANUAL_TRACKS_LABELS,
      type:   'symbol',
      source: MANUAL_TRACKS_SOURCE,
      layout: {
        'text-field':          ['get', 'callsign'],
        'text-size':           11,
        'text-offset':         use2525 ? [0, 2.5] : [0, 1.5],
        'text-anchor':         'top',
        'text-allow-overlap':  false
      },
      paint: {
        'text-color':       '#ffffff',
        'text-halo-color':  '#000000',
        'text-halo-width':  1
      }
    })

    const clickLayers = [MANUAL_TRACKS_LAYER, MANUAL_TRACKS_SYMBOLS]

    if (dispatcher) {
      dispatcher.register('manual-tracks', {
        layers:     clickLayers,
        action:     (f) => { const id = f.properties._dbId; if (id != null) openPanel(id) },
        suppress:   () => suppress.value || Boolean(placing.value) || suppressNextClick,
        label:      (f) => ({
          text:     f.properties.callsign || 'Manual Track',
          subtitle: 'Manual Track',
          icon:     'mdi-map-marker-account'
        }),
        dedupeKey:  (f) => f.properties._dbId
      })
    } else {
      map.on('click', MANUAL_TRACKS_LAYER, (e) => {
        if (suppress.value || placing.value || suppressNextClick) return
        const id = e.features?.[0]?.properties?._dbId
        if (id != null) openPanel(id)
      })
      map.on('click', MANUAL_TRACKS_SYMBOLS, (e) => {
        if (suppress.value || placing.value || suppressNextClick) return
        const id = e.features?.[0]?.properties?._dbId
        if (id != null) openPanel(id)
      })
    }

    const onEnter = () => { if (!placing.value) map.getCanvasContainer().style.cursor = 'grab' }
    const onLeave = () => { if (!placing.value) map.getCanvasContainer().style.cursor = '' }
    for (const layer of clickLayers) {
      map.on('mouseenter', layer, onEnter)
      map.on('mouseleave', layer, onLeave)
    }

    setupTrackDrag(map, clickLayers)
  }

  // ---- Drag-to-move ----
  //
  // Mirrors the shape-vertex drag in `useMapDraw.js`: map-layer mousedown →
  // disable dragPan → window-level mousemove/mouseup. Live preview updates
  // MANUAL_TRACKS_SOURCE directly (no DB write per frame). The DB write
  // happens once on release. A zero-movement press falls through to the
  // dispatcher's click handler so panels still open on plain clicks.

  function setupTrackDrag(map, layers) {
    const canvas = map.getCanvasContainer()

    function onLayerMouseDown(e) {
      if (suppress.value || placing.value) return
      if (e.originalEvent?.button !== 0) return
      const id = e.features?.[0]?.properties?._dbId
      if (id == null) return
      const feature = featuresStore.features.find(f => f.id === id)
      if (!feature) return
      const geometry   = JSON.parse(feature.geometry)
      const properties = JSON.parse(feature.properties)
      if (geometry.type !== 'Point') return

      e.preventDefault()
      map.dragPan.disable()
      canvas.style.cursor = 'grabbing'

      let hasMoved = false
      let lastLngLat = null

      function onWindowMouseMove(me) {
        hasMoved = true
        const rect = canvas.getBoundingClientRect()
        lastLngLat = map.unproject([me.clientX - rect.left, me.clientY - rect.top])
        const src = map.getSource(MANUAL_TRACKS_SOURCE)
        if (!src) return
        const fc = manualTrackCollection.value
        src.setData({
          ...fc,
          features: fc.features.map(f =>
            f.properties._dbId === id
              ? { ...f, geometry: { type: 'Point', coordinates: [lastLngLat.lng, lastLngLat.lat] } }
              : f
          )
        })
      }

      function finish(commit) {
        window.removeEventListener('mousemove', onWindowMouseMove)
        window.removeEventListener('mouseup', onWindowMouseUp)
        window.removeEventListener('keydown', onWindowKeyDown)
        map.dragPan.enable()
        canvas.style.cursor = ''

        if (commit && hasMoved && lastLngLat) {
          // Swallow the mouseup → click the map fires on release so the
          // dispatcher doesn't open the panel for the just-dragged track.
          suppressNextClick = true
          setTimeout(() => { suppressNextClick = false }, 0)
          featuresStore.updateFeature(
            id,
            { type: 'Point', coordinates: [lastLngLat.lng, lastLngLat.lat] },
            properties
          )
        } else {
          map.getSource(MANUAL_TRACKS_SOURCE)?.setData(manualTrackCollection.value)
        }
      }

      function onWindowMouseUp()       { finish(true) }
      function onWindowKeyDown(ke)     { if (ke.key === 'Escape') finish(false) }

      window.addEventListener('mousemove', onWindowMouseMove)
      window.addEventListener('mouseup', onWindowMouseUp)
      window.addEventListener('keydown', onWindowKeyDown)
    }

    for (const layer of layers) map.on('mousedown', layer, onLayerMouseDown)
  }

  // ---- Watchers ----

  const stopDataWatch = watch(
    manualTrackCollection,
    (collection) => {
      const map = getMap()
      if (!map) return
      if (settingsStore.milStdSymbology) {
        ensureMilStdIcons(map, collection.features)
      }
      map.getSource(MANUAL_TRACKS_SOURCE)?.setData(collection)
    },
    { deep: false }
  )

  watch(
    () => settingsStore.milStdSymbology,
    (use2525) => {
      const map = getMap()
      if (!map?.getLayer(MANUAL_TRACKS_LAYER)) return
      if (use2525) {
        ensureMilStdIcons(map, manualTrackCollection.value.features)
        map.getSource(MANUAL_TRACKS_SOURCE)?.setData(manualTrackCollection.value)
        map.setFilter(MANUAL_TRACKS_LAYER, FILTER_CIRCLE_MILSTD)
        map.setLayoutProperty(MANUAL_TRACKS_SYMBOLS, 'visibility', 'visible')
      } else {
        map.setFilter(MANUAL_TRACKS_LAYER, null)
        map.setLayoutProperty(MANUAL_TRACKS_SYMBOLS, 'visibility', 'none')
      }
      map.setLayoutProperty(MANUAL_TRACKS_LABELS, 'text-offset', use2525 ? [0, 2.5] : [0, 1.5])
    }
  )

  const stopDeleteWatch = watch(
    () => featuresStore.features,
    (features) => {
      const ids = new Set(
        features.filter(f => f.type === 'manual-track').map(f => f.id)
      )
      for (const id of openPanelIds.value) {
        if (!ids.has(id)) closePanel(id)
      }
    },
    { deep: false }
  )

  onUnmounted(() => {
    if (dispatcher) dispatcher.unregister('manual-tracks')
    stopDataWatch()
    stopDeleteWatch()
    removePlaceHandlers()
    placing.value = null
    const map = getMap()
    if (!map) return
    if (map.getLayer(MANUAL_TRACKS_LABELS))  map.removeLayer(MANUAL_TRACKS_LABELS)
    if (map.getLayer(MANUAL_TRACKS_SYMBOLS)) map.removeLayer(MANUAL_TRACKS_SYMBOLS)
    if (map.getLayer(MANUAL_TRACKS_LAYER))   map.removeLayer(MANUAL_TRACKS_LAYER)
    if (map.getSource(MANUAL_TRACKS_SOURCE)) map.removeSource(MANUAL_TRACKS_SOURCE)
  })

  return { placing, setPlacing, openPanelList, openPanel, closePanel, focusedId, initLayers }
}
