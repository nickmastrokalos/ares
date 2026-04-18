import { computed, watch, onUnmounted } from 'vue'
import { useTracksStore } from '@/stores/tracks'
import { useSettingsStore } from '@/stores/settings'
import { cotTypeToSidc, getOrCreateIcon, clearIconCache } from '@/services/sidc'

const TRACKS_SOURCE        = 'cot-tracks'
const TRACKS_LAYER_POINTS  = 'cot-tracks-points'
const TRACKS_LAYER_SYMBOLS = 'cot-tracks-symbols'
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

/**
 * Ensure every feature has a `sidc` property and the corresponding icon is
 * registered with the map. Called before each `setData()` when 2525 is active.
 */
function ensureMilStdIcons(map, features) {
  for (const f of features) {
    const sidc = cotTypeToSidc(f.properties?.cotType)
    f.properties.sidc = sidc
    if (!map.hasImage(sidc)) {
      const { image } = getOrCreateIcon(sidc)
      map.addImage(sidc, image, { pixelRatio: 2 })
    }
  }
}

export function useMapTracks(getMap, suppress = { value: false }, dispatcher = null) {
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
      layout: {
        'visibility': settingsStore.milStdSymbology ? 'none' : 'visible'
      },
      paint: {
        'circle-radius': 6,
        'circle-color': AFFIL_MATCH,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000'
      }
    })

    map.addLayer({
      id: TRACKS_LAYER_SYMBOLS,
      type: 'symbol',
      source: TRACKS_SOURCE,
      layout: {
        'icon-image': ['get', 'sidc'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'visibility': settingsStore.milStdSymbology ? 'visible' : 'none'
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
        'text-allow-overlap': false,
        'visibility': settingsStore.showFeatureLabels ? 'visible' : 'none'
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1
      }
    })

    // Register with the central click dispatcher so overlapping features
    // can be disambiguated. Falls back to direct handler if no dispatcher.
    if (dispatcher) {
      dispatcher.register('cot-tracks', {
        layers: [TRACKS_LAYER_POINTS, TRACKS_LAYER_SYMBOLS],
        action: (f) => tracksStore.openPanel(f.properties.uid),
        suppress: () => suppress.value,
        label: (f) => ({
          text: f.properties.callsign || f.properties.uid,
          subtitle: 'Track',
          icon: 'mdi-crosshairs-gps'
        }),
        dedupeKey: (f) => f.properties.uid
      })
    } else {
      const onTrackClick = (e) => {
        if (suppress.value) return
        const uid = e.features?.[0]?.properties?.uid
        if (uid) tracksStore.openPanel(uid)
      }
      map.on('click', TRACKS_LAYER_POINTS,  onTrackClick)
      map.on('click', TRACKS_LAYER_SYMBOLS, onTrackClick)
    }

    // Pointer cursor while hovering track dots/symbols.
    const onTrackEnter = () => { map.getCanvasContainer().style.cursor = 'pointer' }
    const onTrackLeave = () => { map.getCanvasContainer().style.cursor = '' }
    map.on('mouseenter', TRACKS_LAYER_POINTS,  onTrackEnter)
    map.on('mouseleave', TRACKS_LAYER_POINTS,  onTrackLeave)
    map.on('mouseenter', TRACKS_LAYER_SYMBOLS, onTrackEnter)
    map.on('mouseleave', TRACKS_LAYER_SYMBOLS, onTrackLeave)

    initialized = true
  }

  // Push track dot updates to the map source.
  // When 2525 mode is active, ensure icons are registered before the setData call.
  const stopDataWatch = watch(
    () => tracksStore.trackCollection,
    (collection) => {
      const map = getMap()
      if (!map) return
      if (settingsStore.milStdSymbology) {
        ensureMilStdIcons(map, collection.features)
      }
      map.getSource(TRACKS_SOURCE)?.setData(collection)
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

  watch(
    () => settingsStore.showFeatureLabels,
    (show) => {
      const map = getMap()
      if (!map?.getLayer(TRACKS_LABEL_LAYER)) return
      map.setLayoutProperty(TRACKS_LABEL_LAYER, 'visibility', show ? 'visible' : 'none')
    }
  )

  watch(
    () => settingsStore.milStdSymbology,
    (use2525) => {
      const map = getMap()
      if (!map?.getLayer(TRACKS_LAYER_POINTS)) return
      // If switching to 2525, ensure all current tracks have icons registered first.
      if (use2525) {
        const collection = tracksStore.trackCollection
        ensureMilStdIcons(map, collection.features)
        map.getSource(TRACKS_SOURCE)?.setData(collection)
      }
      map.setLayoutProperty(TRACKS_LAYER_POINTS,  'visibility', use2525 ? 'none'    : 'visible')
      map.setLayoutProperty(TRACKS_LAYER_SYMBOLS, 'visibility', use2525 ? 'visible' : 'none')
      // Adjust label offset: 2525 icons are taller than the 6px circle dot.
      map.setLayoutProperty(TRACKS_LABEL_LAYER, 'text-offset', use2525 ? [0, 2.5] : [0, 1.5])
    }
  )

  onUnmounted(() => {
    if (dispatcher) dispatcher.unregister('cot-tracks')
    stopDataWatch()
    stopBreadcrumbWatch()
    clearIconCache()
    const map = getMap()
    if (!map) return
    if (map.getLayer(TRACKS_LABEL_LAYER))   map.removeLayer(TRACKS_LABEL_LAYER)
    if (map.getLayer(TRACKS_LAYER_SYMBOLS)) map.removeLayer(TRACKS_LAYER_SYMBOLS)
    if (map.getLayer(TRACKS_LAYER_POINTS))  map.removeLayer(TRACKS_LAYER_POINTS)
    if (map.getLayer(BREADCRUMBS_LAYER))    map.removeLayer(BREADCRUMBS_LAYER)
    if (map.getSource(TRACKS_SOURCE))       map.removeSource(TRACKS_SOURCE)
    if (map.getSource(BREADCRUMBS_SOURCE))  map.removeSource(BREADCRUMBS_SOURCE)
    initialized = false
  })

  return { initLayers }
}
