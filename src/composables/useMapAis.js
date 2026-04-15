import { watch, onUnmounted } from 'vue'
import { useAisStore } from '@/stores/ais'

const AIS_CRUMBS  = 'ais-breadcrumbs'
const AIS_CRUMB_LAYER = 'ais-breadcrumbs-line'
const AIS_SOURCE  = 'ais-vessels'
const AIS_LAYER   = 'ais-vessels-points'
const AIS_LABELS  = 'ais-vessels-labels'

const DEBOUNCE_MS = 600

export function useMapAis(getMap) {
  const aisStore = useAisStore()
  let initialized   = false
  let debounceTimer = null

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

    map.addLayer({
      id: AIS_LAYER,
      type: 'circle',
      source: AIS_SOURCE,
      paint: {
        'circle-radius': 5,
        'circle-color': '#ffeb3b',
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000'
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
        'text-allow-overlap': false
      },
      paint: {
        'text-color': '#ffeb3b',
        'text-halo-color': '#000000',
        'text-halo-width': 1
      }
    })

    map.on('moveend', scheduleRefetch)
    map.on('zoomend', scheduleRefetch)

    initialized = true

    // Trigger an immediate fetch if already enabled
    if (aisStore.enabled) scheduleRefetch()
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

  // When enabled mid-session, kick off an immediate fetch
  const stopEnabledWatch = watch(
    () => aisStore.enabled,
    (val) => {
      if (val) scheduleRefetch()
    }
  )

  onUnmounted(() => {
    stopDataWatch()
    stopCrumbWatch()
    stopEnabledWatch()
    clearTimeout(debounceTimer)
    const map = getMap()
    if (!map) return
    map.off('moveend', scheduleRefetch)
    map.off('zoomend', scheduleRefetch)
    if (map.getLayer(AIS_LABELS))     map.removeLayer(AIS_LABELS)
    if (map.getLayer(AIS_LAYER))      map.removeLayer(AIS_LAYER)
    if (map.getLayer(AIS_CRUMB_LAYER)) map.removeLayer(AIS_CRUMB_LAYER)
    if (map.getSource(AIS_SOURCE))    map.removeSource(AIS_SOURCE)
    if (map.getSource(AIS_CRUMBS))    map.removeSource(AIS_CRUMBS)
    initialized = false
  })

  return { initLayers }
}
