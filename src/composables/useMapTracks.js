import { computed, watch, onUnmounted } from 'vue'
import { useTracksStore } from '@/stores/tracks'
import { useSettingsStore } from '@/stores/settings'
import { cotTypeToSidc, getOrCreateIcon, clearIconCache } from '@/services/sidc'
import { distanceBetween } from '@/services/geometry'

const TRACKS_SOURCE        = 'cot-tracks'
const TRACKS_LAYER_POINTS  = 'cot-tracks-points'
const TRACKS_LAYER_SYMBOLS = 'cot-tracks-symbols'
const TRACKS_LAYER_SELF    = 'cot-tracks-self-ring'
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
  // Tail length is `trackBreadcrumbLength` meters of map distance —
  // independent of how fast the track is moving, so a walking foot
  // soldier and a transiting jet draw tails of identical visual
  // length. We walk backward through the recorded history,
  // accumulating segment distances until we reach the target length,
  // then truncate the last segment proportionally.
  const breadcrumbCollection = computed(() => {
    if (!settingsStore.trackBreadcrumbs) {
      return { type: 'FeatureCollection', features: [] }
    }
    const targetMeters = Math.max(0, settingsStore.trackBreadcrumbLength)
    if (targetMeters <= 0) return { type: 'FeatureCollection', features: [] }

    const features = []
    for (const t of tracksStore.tracks.values()) {
      if (tracksStore.hiddenIds.has(t.uid)) continue
      const history = t.history ?? []
      if (history.length < 2) continue

      // Walk newest → oldest, accumulating distance. Build the trail
      // newest-first and reverse at the end so the LineString is in
      // chronological order (which the map style expects).
      const trail = [[history[history.length - 1].lon, history[history.length - 1].lat]]
      let acc = 0
      for (let i = history.length - 1; i > 0; i--) {
        const newer = [history[i].lon,     history[i].lat]
        const older = [history[i - 1].lon, history[i - 1].lat]
        const segLen = distanceBetween(newer, older)
        if (segLen <= 0) continue
        if (acc + segLen >= targetMeters) {
          const remaining = targetMeters - acc
          const f = remaining / segLen
          trail.push([
            newer[0] + (older[0] - newer[0]) * f,
            newer[1] + (older[1] - newer[1]) * f
          ])
          acc = targetMeters
          break
        }
        trail.push(older)
        acc += segLen
      }
      if (trail.length < 2) continue
      trail.reverse()
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: trail },
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
        'circle-stroke-color': '#000000',
        // Lay flat with the map plane on pitch (matches AIS / ADS-B).
        'circle-pitch-alignment': 'map'
      }
    })

    // Self-ring: a thin hollow white halo around the operator's own track
    // so it's spottable at a glance without being label-dependent. Single
    // static ring, no fill, no animation — same dimming on pitch as the
    // affiliation circle. Filtered to features tagged `isSelf: true` by
    // the tracks store.
    // Self-ring radius is keyed off whether the rendered symbol is the
    // small affiliation dot (~6 px) or the chunkier 2525 SIDC icon
    // (~40 px wide at our 2x render). Without the size jump the ring
    // sits inside the SIDC icon and gets occluded.
    const selfRingRadius = settingsStore.milStdSymbology ? 22 : 11
    map.addLayer({
      id: TRACKS_LAYER_SELF,
      type: 'circle',
      source: TRACKS_SOURCE,
      filter: ['==', ['get', 'isSelf'], true],
      paint: {
        'circle-radius':         selfRingRadius,
        'circle-color':          'rgba(0, 0, 0, 0)',
        'circle-stroke-width':   1.5,
        'circle-stroke-color':   '#ffffff',
        'circle-stroke-opacity': 0.85,
        'circle-pitch-alignment': 'map'
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
        // Pitch-align only — yaw stays viewport-locked so 2525 symbol
        // orientation isn't rotated when the operator yaws the map.
        'icon-pitch-alignment': 'map',
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
      // Resize the self-ring so it wraps around the new symbol size.
      if (map.getLayer(TRACKS_LAYER_SELF)) {
        map.setPaintProperty(TRACKS_LAYER_SELF, 'circle-radius', use2525 ? 22 : 11)
      }
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
    if (map.getLayer(TRACKS_LAYER_SELF))    map.removeLayer(TRACKS_LAYER_SELF)
    if (map.getLayer(TRACKS_LAYER_SYMBOLS)) map.removeLayer(TRACKS_LAYER_SYMBOLS)
    if (map.getLayer(TRACKS_LAYER_POINTS))  map.removeLayer(TRACKS_LAYER_POINTS)
    if (map.getLayer(BREADCRUMBS_LAYER))    map.removeLayer(BREADCRUMBS_LAYER)
    if (map.getSource(TRACKS_SOURCE))       map.removeSource(TRACKS_SOURCE)
    if (map.getSource(BREADCRUMBS_SOURCE))  map.removeSource(BREADCRUMBS_SOURCE)
    initialized = false
  })

  return { initLayers }
}
