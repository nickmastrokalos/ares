import { computed, watch, onUnmounted } from 'vue'
import { useTracksStore } from '@/stores/tracks'
import { useSettingsStore } from '@/stores/settings'

const TRACKS_SOURCE        = 'cot-tracks'
const TRACKS_LAYER_POINTS  = 'cot-tracks-points'
const TRACKS_LABEL_LAYER   = 'cot-tracks-labels'
const BREADCRUMBS_SOURCE   = 'cot-breadcrumbs'
const BREADCRUMBS_LAYER    = 'cot-breadcrumbs-line'

// Affiliation → color. Used in both point and breadcrumb layers.
const AFFIL_MATCH = [
  'match', ['get', 'affiliation'],
  'f', '#4a9ade',
  'h', '#f44336',
  'n', '#4caf50',
  'u', '#ffeb3b',
  '#ffeb3b'
]

function affiliationFromCotType(cotType) {
  const c = cotType?.[2] ?? 'u'
  return ['f', 'h', 'n', 'u'].includes(c) ? c : 'u'
}

export function useMapTracks(getMap) {
  const tracksStore   = useTracksStore()
  const settingsStore = useSettingsStore()
  let initialized = false

  // GeoJSON LineString collection for breadcrumb trails.
  // Recomputes whenever tracks update OR settings change.
  const breadcrumbCollection = computed(() => {
    if (!settingsStore.trackBreadcrumbs) {
      return { type: 'FeatureCollection', features: [] }
    }
    const cutoff = Date.now() - settingsStore.trackBreadcrumbLength * 1_000

    const features = []
    for (const t of tracksStore.tracks.values()) {
      const coords = (t.history ?? [])
        .filter(h => h.t >= cutoff)
        .map(h => [h.lon, h.lat])
      if (coords.length < 2) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { uid: t.uid, affiliation: affiliationFromCotType(t.cotType) }
      })
    }
    return { type: 'FeatureCollection', features }
  })

  function initLayers() {
    const map = getMap()
    if (!map || initialized) return

    // --- Breadcrumb trails (added first — rendered below track dots) ---
    map.addSource(BREADCRUMBS_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })

    map.addLayer({
      id: BREADCRUMBS_LAYER,
      type: 'line',
      source: BREADCRUMBS_SOURCE,
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-width': 1.5,
        'line-opacity': 0.55,
        'line-color': AFFIL_MATCH
      }
    })

    // --- Track dots ---
    map.addSource(TRACKS_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })

    map.addLayer({
      id: TRACKS_LAYER_POINTS,
      type: 'circle',
      source: TRACKS_SOURCE,
      paint: {
        'circle-radius': 6,
        'circle-color': AFFIL_MATCH,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000'
      }
    })

    map.addLayer({
      id: TRACKS_LABEL_LAYER,
      type: 'symbol',
      source: TRACKS_SOURCE,
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

    // Click a track dot → open its detail panel (ignored if already open).
    map.on('click', TRACKS_LAYER_POINTS, (e) => {
      const uid = e.features?.[0]?.properties?.uid
      if (uid) tracksStore.openPanel(uid)
    })

    // Pointer cursor while hovering track dots.
    map.on('mouseenter', TRACKS_LAYER_POINTS, () => {
      map.getCanvasContainer().style.cursor = 'pointer'
    })
    map.on('mouseleave', TRACKS_LAYER_POINTS, () => {
      map.getCanvasContainer().style.cursor = ''
    })

    initialized = true
  }

  // Push track dot updates to the map source.
  const stopDataWatch = watch(
    () => tracksStore.trackCollection,
    (collection) => {
      getMap()?.getSource(TRACKS_SOURCE)?.setData(collection)
    },
    { deep: false }
  )

  // Push breadcrumb updates whenever tracks move or settings change.
  const stopBreadcrumbWatch = watch(
    breadcrumbCollection,
    (collection) => {
      getMap()?.getSource(BREADCRUMBS_SOURCE)?.setData(collection)
    },
    { deep: false }
  )

  onUnmounted(() => {
    stopDataWatch()
    stopBreadcrumbWatch()
    const map = getMap()
    if (!map) return
    if (map.getLayer(TRACKS_LABEL_LAYER))  map.removeLayer(TRACKS_LABEL_LAYER)
    if (map.getLayer(TRACKS_LAYER_POINTS)) map.removeLayer(TRACKS_LAYER_POINTS)
    if (map.getLayer(BREADCRUMBS_LAYER))   map.removeLayer(BREADCRUMBS_LAYER)
    if (map.getSource(TRACKS_SOURCE))      map.removeSource(TRACKS_SOURCE)
    if (map.getSource(BREADCRUMBS_SOURCE)) map.removeSource(BREADCRUMBS_SOURCE)
    initialized = false
  })

  return { initLayers }
}
