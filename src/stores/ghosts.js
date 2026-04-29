import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { distanceBetween } from '@/services/geometry'
import { defaultFeatureName } from '@/services/featureNaming'
import { getDb } from '@/plugins/database'

const TICK_MS = 100

let _nextId = 1

export const useGhostsStore = defineStore('ghosts', () => {
  const ghosts = ref([])
  let _tickerInterval = null

  // Persistence — per-mission rows in the SQLite `ghosts` table
  // (migration 6). Live position (status, currentIndex, segment
  // progress, current lon/lat) is intentionally NOT saved: on
  // load every ghost re-anchors to its `start_waypoint_index` in
  // the idle state. Operator restarts after re-opening the app.
  let _missionId       = null
  let _persistEnabled  = false   // gated during init() hydration

  async function _dbInsert(g) {
    if (!_persistEnabled || _missionId == null) return
    try {
      const db = await getDb()
      await db.execute(
        `INSERT INTO ghosts (id, mission_id, route_id, name, start_waypoint_index, direction, speed_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [g.id, _missionId, g.routeId, g.name, g.startWaypointIndex, g.direction, g.speedMs]
      )
    } catch (err) {
      console.error('[ghosts] insert failed:', err)
    }
  }

  async function _dbUpdate(id, patch) {
    if (!_persistEnabled || _missionId == null) return
    const cols = []
    const vals = []
    let i = 1
    for (const [col, val] of Object.entries(patch)) {
      cols.push(`${col} = $${i++}`)
      vals.push(val)
    }
    if (!cols.length) return
    cols.push(`updated_at = datetime('now')`)
    vals.push(id, _missionId)
    try {
      const db = await getDb()
      await db.execute(
        `UPDATE ghosts SET ${cols.join(', ')} WHERE id = $${i++} AND mission_id = $${i}`,
        vals
      )
    } catch (err) {
      console.error('[ghosts] update failed:', err)
    }
  }

  async function _dbDelete(id) {
    if (!_persistEnabled || _missionId == null) return
    try {
      const db = await getDb()
      await db.execute(
        'DELETE FROM ghosts WHERE id = $1 AND mission_id = $2',
        [id, _missionId]
      )
    } catch (err) {
      console.error('[ghosts] delete failed:', err)
    }
  }

  // Load ghosts for the current mission. Each row re-anchors to
  // its start waypoint and comes back idle. Rows whose `route_id`
  // no longer points at a route in the features store are dropped
  // (cascade behaviour matches `reresolveAll` in the
  // perimeter / bloodhound composables — orphans don't linger).
  async function init(missionId) {
    _missionId = missionId
    _persistEnabled = false
    ghosts.value = []
    _nextId = 1
    if (missionId == null) return
    try {
      const db = await getDb()
      const rows = await db.select(
        `SELECT id, route_id, name, start_waypoint_index, direction, speed_ms
           FROM ghosts WHERE mission_id = $1 ORDER BY id`,
        [missionId]
      )
      const featuresStore = useFeaturesStore()
      const liveRouteIds = new Set(
        featuresStore.features.filter(f => f.type === 'route').map(f => f.id)
      )
      const restored = []
      let maxId = 0
      for (const row of rows) {
        if (!liveRouteIds.has(row.route_id)) {
          // Dangling ghost — route was deleted while the app was
          // closed. Drop it to keep the table clean.
          await db.execute('DELETE FROM ghosts WHERE id = $1', [row.id])
          continue
        }
        const coords = _routeCoords(row.route_id)
        if (!coords || coords.length < 2) continue
        const idx = Math.max(0, Math.min(row.start_waypoint_index, coords.length - 1))
        const startCoord = coords[idx]
        restored.push({
          id:                 row.id,
          name:               row.name,
          routeId:            row.route_id,
          startWaypointIndex: idx,
          direction:          row.direction,
          speedMs:            row.speed_ms,
          status:             'idle',
          currentLon:         startCoord[0],
          currentLat:         startCoord[1],
          currentIndex:       idx,
          segmentProgress:    0
        })
        if (row.id > maxId) maxId = row.id
      }
      ghosts.value = restored
      _nextId = maxId + 1
    } catch (err) {
      console.error('[ghosts] init failed:', err)
    } finally {
      _persistEnabled = true
    }
  }

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

  function createGhost({ routeId, startWaypointIndex, direction, speedMs, name }) {
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
    // Default-name pattern matches the rest of Ares (`route-7c2e`,
    // `polygon-a3f9`, …). Caller-supplied non-empty `name` wins so
    // the assistant / panel can pass an explicit label at create
    // time.
    const useName = (typeof name === 'string' && name.trim().length)
      ? name.trim()
      : defaultFeatureName('ghost')

    const ghost = {
      id,
      name: useName,
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
    ghosts.value = [...ghosts.value, ghost]
    _dbInsert(ghost)

    return id
  }

  function deleteGhost(id) {
    ghosts.value = ghosts.value.filter(g => g.id !== id)
    _maybeStopTicker()
    _dbDelete(id)
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
    _dbUpdate(id, { speed_ms: speedMs })
  }

  // Rename a ghost. Empty / whitespace-only names are rejected so
  // the panel + agent can't blank out the label by accident.
  function renameGhost(id, name) {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) return false
    let changed = false
    ghosts.value = ghosts.value.map(g => {
      if (g.id !== id) return g
      if (g.name === trimmed) return g
      changed = true
      return { ...g, name: trimmed }
    })
    if (changed) _dbUpdate(id, { name: trimmed })
    return changed
  }

  // Move an idle ghost to a different waypoint of its assigned
  // route. Updates both the configured start (so `resetGhost` lands
  // at the new spot) and the live position. Refuses while running
  // — the operator must stop / reset first to avoid teleporting a
  // moving ghost mid-track.
  function setStartWaypoint(id, waypointIndex) {
    const g = ghosts.value.find(x => x.id === id)
    if (!g) return { ok: false, reason: `Ghost ${id} not found.` }
    if (g.status === 'running') {
      return { ok: false, reason: 'Ghost is running. Stop or reset it first.' }
    }
    const coords = _routeCoords(g.routeId)
    if (!coords || coords.length < 2) {
      return { ok: false, reason: 'Ghost has no valid route coordinates.' }
    }
    const lastIndex = coords.length - 1
    const idx = Math.max(0, Math.min(Number(waypointIndex) | 0, lastIndex))
    const startCoord = coords[idx]
    // Clamp direction at endpoints so the ghost can actually move
    // when started (forward at SP, backward at EP).
    let dir = g.direction
    if (idx === 0)         dir = 'forward'
    if (idx === lastIndex) dir = 'backward'
    ghosts.value = ghosts.value.map(x => {
      if (x.id !== id) return x
      return {
        ...x,
        startWaypointIndex: idx,
        direction:          dir,
        currentIndex:       idx,
        segmentProgress:    0,
        currentLon:         startCoord[0],
        currentLat:         startCoord[1]
      }
    })
    _dbUpdate(id, { start_waypoint_index: idx, direction: dir })
    return { ok: true, waypointIndex: idx, direction: dir }
  }

  // Flip the travel direction on an idle ghost. Refuses at SP
  // (forward forced) / EP (backward forced) and while running.
  function setDirection(id, direction) {
    const g = ghosts.value.find(x => x.id === id)
    if (!g) return { ok: false, reason: `Ghost ${id} not found.` }
    if (g.status === 'running') {
      return { ok: false, reason: 'Ghost is running. Stop or reset it first.' }
    }
    if (direction !== 'forward' && direction !== 'backward') {
      return { ok: false, reason: 'direction must be "forward" or "backward".' }
    }
    const coords = _routeCoords(g.routeId)
    if (coords && coords.length >= 2) {
      const lastIndex = coords.length - 1
      if (g.startWaypointIndex === 0 && direction !== 'forward') {
        return { ok: false, reason: 'At the start waypoint direction is forced forward.' }
      }
      if (g.startWaypointIndex === lastIndex && direction !== 'backward') {
        return { ok: false, reason: 'At the end waypoint direction is forced backward.' }
      }
    }
    ghosts.value = ghosts.value.map(x => x.id === id ? { ...x, direction } : x)
    _dbUpdate(id, { direction })
    return { ok: true, direction }
  }

  function stopAll() {
    ghosts.value = ghosts.value.map(g => ({ ...g, status: 'idle' }))
    _maybeStopTicker()
  }

  return {
    ghosts,
    ghostCollection,
    init,
    createGhost,
    deleteGhost,
    startGhost,
    stopGhost,
    resetGhost,
    setSpeed,
    renameGhost,
    setStartWaypoint,
    setDirection,
    stopAll
  }
})
