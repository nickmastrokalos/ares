import { ref, computed, watch, onUnmounted } from 'vue'
import { useFeaturesStore } from '@/stores/features'

const MANUAL_TRACKS_SOURCE = 'manual-tracks'
const MANUAL_TRACKS_LAYER  = 'manual-tracks-points'
const MANUAL_TRACKS_LABELS = 'manual-tracks-labels'

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

export function useMapManualTracks(getMap, suppress = { value: false }) {
  const featuresStore = useFeaturesStore()

  const placing      = ref(null)   // null | 'f' | 'n' | 'u' | 'h'
  const openPanelIds = ref(new Set())
  const focusedId    = ref(null)

  let placeClickHandler = null
  let keyHandler        = null

  // ---- Derived data ----

  const manualTrackCollection = computed(() => ({
    type: 'FeatureCollection',
    features: featuresStore.features
      .filter(f => f.type === 'manual-track')
      .map(f => {
        const props = JSON.parse(f.properties)
        return {
          type: 'Feature',
          geometry: JSON.parse(f.geometry),
          properties: {
            _dbId:       f.id,
            callsign:    props.callsign,
            affiliation: props.affiliation
          }
        }
      })
  }))

  const openPanelList = computed(() => [...openPanelIds.value])

  // ---- Panel management ----

  function openPanel(id) {
    focusedId.value = id  // always signal focus, even if panel is already open
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
      const affiliation = placing.value
      if (!affiliation) return
      const callsign = nextName(affiliation)
      await featuresStore.addFeature(
        'manual-track',
        { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] },
        { callsign, affiliation }
      )
      // Stay in placing mode — allows rapid sequential drops
    }

    keyHandler = (e) => {
      if (e.key === 'Escape') setPlacing(null)
    }

    map.on('click', placeClickHandler)
    window.addEventListener('keydown', keyHandler)
  }

  function setPlacing(key) {
    removePlaceHandlers()
    if (key && key === placing.value) {
      // Toggle off — same key clicked again
      placing.value = null
    } else {
      placing.value = key
      if (key) activatePlacement()
    }
  }

  // ---- Map layers ----

  function initLayers() {
    const map = getMap()
    if (!map || map.getSource(MANUAL_TRACKS_SOURCE)) return

    // Use current collection as initial data — features may already be loaded
    // from the DB before the map was ready, so we can't rely on the watcher
    // to fire for data that arrived before initLayers() was called.
    map.addSource(MANUAL_TRACKS_SOURCE, {
      type: 'geojson',
      data: manualTrackCollection.value
    })

    map.addLayer({
      id: MANUAL_TRACKS_LAYER,
      type: 'circle',
      source: MANUAL_TRACKS_SOURCE,
      paint: {
        'circle-radius': 6,
        'circle-color': AFFIL_MATCH,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000'
      }
    })

    map.addLayer({
      id: MANUAL_TRACKS_LABELS,
      type: 'symbol',
      source: MANUAL_TRACKS_SOURCE,
      layout: {
        'text-field': ['get', 'callsign'],
        'text-size': 11,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-allow-overlap': false
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1
      }
    })

    // Click a track dot → open its detail panel.
    // Suppressed while in placement mode (click lands as a drop, not a selection)
    // and while other suppress conditions are active (ranging, routing, etc.).
    map.on('click', MANUAL_TRACKS_LAYER, (e) => {
      if (suppress.value || placing.value) return
      const id = e.features?.[0]?.properties?._dbId
      if (id != null) openPanel(id)
    })

    map.on('mouseenter', MANUAL_TRACKS_LAYER, () => {
      if (placing.value) return
      map.getCanvasContainer().style.cursor = 'pointer'
    })
    map.on('mouseleave', MANUAL_TRACKS_LAYER, () => {
      if (placing.value) return
      map.getCanvasContainer().style.cursor = ''
    })
  }

  // ---- Watchers ----

  // Push store changes to the map source.
  const stopDataWatch = watch(
    manualTrackCollection,
    (collection) => {
      getMap()?.getSource(MANUAL_TRACKS_SOURCE)?.setData(collection)
    },
    { deep: false }
  )

  // Close panels when their backing feature is deleted.
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
    stopDataWatch()
    stopDeleteWatch()
    removePlaceHandlers()
    placing.value = null
    const map = getMap()
    if (!map) return
    if (map.getLayer(MANUAL_TRACKS_LABELS)) map.removeLayer(MANUAL_TRACKS_LABELS)
    if (map.getLayer(MANUAL_TRACKS_LAYER))  map.removeLayer(MANUAL_TRACKS_LAYER)
    if (map.getSource(MANUAL_TRACKS_SOURCE)) map.removeSource(MANUAL_TRACKS_SOURCE)
  })

  return { placing, setPlacing, openPanelList, openPanel, closePanel, focusedId, initLayers }
}
