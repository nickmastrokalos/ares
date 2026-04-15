import { watch, onUnmounted } from 'vue'
import { useGhostsStore } from '@/stores/ghosts'

const GHOSTS_SOURCE       = 'ghost-tracks'
const GHOSTS_LAYER_POINTS = 'ghost-tracks-points'
const GHOSTS_LABEL_LAYER  = 'ghost-tracks-labels'

const STATUS_OPACITY = ['case', ['==', ['get', 'status'], 'running'], 1, 0.4]

export function useMapGhosts(getMap) {
  const ghostsStore = useGhostsStore()
  let initialized = false

  function initLayers() {
    const map = getMap()
    if (!map || initialized) return

    map.addSource(GHOSTS_SOURCE, {
      type: 'geojson',
      data: ghostsStore.ghostCollection
    })

    map.addLayer({
      id: GHOSTS_LAYER_POINTS,
      type: 'circle',
      source: GHOSTS_SOURCE,
      paint: {
        'circle-radius': 6,
        'circle-color': '#ff9800',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': STATUS_OPACITY,
        'circle-stroke-opacity': STATUS_OPACITY
      }
    })

    map.addLayer({
      id: GHOSTS_LABEL_LAYER,
      type: 'symbol',
      source: GHOSTS_SOURCE,
      layout: {
        'text-field': ['get', 'name'],
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

    initialized = true
  }

  const stopDataWatch = watch(
    () => ghostsStore.ghostCollection,
    (collection) => {
      getMap()?.getSource(GHOSTS_SOURCE)?.setData(collection)
    },
    { deep: false }
  )

  onUnmounted(() => {
    stopDataWatch()
    const map = getMap()
    if (!map) return
    if (map.getLayer(GHOSTS_LABEL_LAYER))  map.removeLayer(GHOSTS_LABEL_LAYER)
    if (map.getLayer(GHOSTS_LAYER_POINTS)) map.removeLayer(GHOSTS_LAYER_POINTS)
    if (map.getSource(GHOSTS_SOURCE))      map.removeSource(GHOSTS_SOURCE)
    initialized = false
  })

  return { initLayers }
}
