import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { distanceBetween } from '@/services/geometry'

const TICK_MS = 100

let _nextId = 1

export const useGhostsStore = defineStore('ghosts', () => {
  const ghosts = ref([])
  let _tickerInterval = null

  // ---- Computed ----

  const ghostCollection = computed(() => ({
    type: 'FeatureCollection',
    features: ghosts.value.map(g => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [g.currentLon, g.currentLat] },
      properties: { id: g.id, name: g.name, status: g.status }
    }))
  }))

  // ---- Internal helpers ----

  function _routeCoords(routeId) {
    const featuresStore = useFeaturesStore()
    const feature = featuresStore.features.find(f => f.id === routeId)
    if (!feature) return null
    try {
      const geom = JSON.parse(feature.geometry)
      return geom?.coordinates ?? null
    } catch {
      return null
    }
  }

  function _advanceGhost(g, coords) {
    let distToTravel = g.speedMs * (TICK_MS / 1000)

    while (distToTravel > 0) {
      const toIndex = g.direction === 'forward' ? g.currentIndex + 1 : g.currentIndex - 1

      if (toIndex < 0 || toIndex >= coords.length) {
        g.status = 'idle'
        break
      }

      const from = coords[g.currentIndex]
      const to   = coords[toIndex]
      const segLen = distanceBetween(from, to)

      // Skip degenerate segments
      if (segLen < 0.01) {
        g.currentIndex = toIndex
        g.segmentProgress = 0
        g.currentLon = to[0]
        g.currentLat = to[1]
        continue
      }

      const remaining = segLen * (1 - g.segmentProgress)

      if (distToTravel < remaining) {
        g.segmentProgress += distToTravel / segLen
        g.currentLon = from[0] + (to[0] - from[0]) * g.segmentProgress
        g.currentLat = from[1] + (to[1] - from[1]) * g.segmentProgress
        distToTravel = 0
      } else {
        distToTravel -= remaining
        g.currentIndex = toIndex
        g.segmentProgress = 0
        g.currentLon = to[0]
        g.currentLat = to[1]
      }
    }
  }

  function _tick() {
    let anyRunning = false
    const next = ghosts.value.map(g => {
      if (g.status !== 'running') return g
      const coords = _routeCoords(g.routeId)
      if (!coords || coords.length < 2) return g
      const copy = { ...g }
      _advanceGhost(copy, coords)
      if (copy.status === 'running') anyRunning = true
      return copy
    })
    // Check if anything changed before reassigning (avoid spurious reactivity)
    ghosts.value = next
    _maybeStopTicker()
  }

  function _ensureTicker() {
    if (_tickerInterval !== null) return
    _tickerInterval = setInterval(_tick, TICK_MS)
  }

  function _maybeStopTicker() {
    if (ghosts.value.every(g => g.status !== 'running')) {
      if (_tickerInterval !== null) {
        clearInterval(_tickerInterval)
        _tickerInterval = null
      }
    }
  }

  // ---- Public API ----

  function createGhost({ routeId, startWaypointIndex, direction, speedMs }) {
    const coords = _routeCoords(routeId)
    if (!coords || coords.length < 2) return null

    const lastIndex = coords.length - 1

    // Clamp direction at endpoints
    let dir = direction
    if (startWaypointIndex === 0) dir = 'forward'
    if (startWaypointIndex === lastIndex) dir = 'backward'

    const idx = Math.max(0, Math.min(startWaypointIndex, lastIndex))
    const startCoord = coords[idx]

    const id = _nextId++
    const name = `Ghost ${id}`

    ghosts.value = [
      ...ghosts.value,
      {
        id,
        name,
        routeId,
        startWaypointIndex: idx,
        direction: dir,
        speedMs,
        status: 'idle',
        currentLon: startCoord[0],
        currentLat: startCoord[1],
        currentIndex: idx,
        segmentProgress: 0
      }
    ]

    return id
  }

  function deleteGhost(id) {
    ghosts.value = ghosts.value.filter(g => g.id !== id)
    _maybeStopTicker()
  }

  function startGhost(id) {
    ghosts.value = ghosts.value.map(g => {
      if (g.id !== id) return g
      return { ...g, status: 'running' }
    })
    _ensureTicker()
  }

  function stopGhost(id) {
    ghosts.value = ghosts.value.map(g => {
      if (g.id !== id) return g
      return { ...g, status: 'idle' }
    })
    _maybeStopTicker()
  }

  function resetGhost(id) {
    ghosts.value = ghosts.value.map(g => {
      if (g.id !== id) return g
      const coords = _routeCoords(g.routeId)
      const startCoord = coords ? coords[g.startWaypointIndex] : null
      return {
        ...g,
        status: 'idle',
        currentIndex: g.startWaypointIndex,
        segmentProgress: 0,
        currentLon: startCoord ? startCoord[0] : g.currentLon,
        currentLat: startCoord ? startCoord[1] : g.currentLat
      }
    })
    _maybeStopTicker()
  }

  function setSpeed(id, speedMs) {
    ghosts.value = ghosts.value.map(g => {
      if (g.id !== id) return g
      return { ...g, speedMs }
    })
  }

  function stopAll() {
    ghosts.value = ghosts.value.map(g => ({ ...g, status: 'idle' }))
    _maybeStopTicker()
  }

  return {
    ghosts,
    ghostCollection,
    createGhost,
    deleteGhost,
    startGhost,
    stopGhost,
    resetGhost,
    setSpeed,
    stopAll
  }
})
