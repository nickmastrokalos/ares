// Water-only route planner used by the `map_draw_route_water_only` and
// `route_check_land_crossing` assistant tools.
//
// Approach: grid-based A* over a bbox containing both endpoints, with land
// cells (centers inside any land polygon) marked impassable. Final path is
// smoothed by greedy line-of-sight to drop redundant waypoints. The land
// dataset is dynamic-imported on first use so the asset isn't part of the
// initial bundle.
//
// Land polygons: OpenStreetMap simplified-land-polygons (osmdata.openstreet
// map.de), reprojected to WGS84. ~58 MB, 67k polygons. Significantly finer
// than Natural Earth 10m at coastal scales — captures small inlets, barrier
// islands, and similar features that NE 10m generalizes away. © OSM
// contributors, ODbL license.
//
// Caveats:
//   - Planar lng/lat distance metric. Fine at coastal scales; degrades for
//     ocean-crossing routes near the poles or the antimeridian.
//   - Inland lakes are not in this dataset (it models the ocean coastline,
//     so a route through a continent is unconstrained — out of scope).

import {
  pointInPolygon,
  segmentCrossesPolygon,
  findLandCrossingIndex,
  geometryBounds,
  distanceBetween
} from './geometry'

let landPromise = null      // dynamic-import the dataset once
let polygonCache = null     // [{ geometry, bbox: [[w,s],[e,n]] }, …]

async function loadAllPolygons() {
  if (polygonCache) return polygonCache
  if (!landPromise) {
    landPromise = import('@/assets/osm-land-simplified.json').then(m => m.default ?? m)
  }
  const fc = await landPromise
  polygonCache = []
  for (const f of fc.features ?? []) {
    const g = f.geometry
    if (!g) continue
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const bbox = geometryBounds(g)
      if (bbox) polygonCache.push({ geometry: g, bbox })
    }
  }
  return polygonCache
}

function bboxesOverlap(a, b) {
  return !(a[1][0] < b[0][0] || a[0][0] > b[1][0] ||
           a[1][1] < b[0][1] || a[0][1] > b[1][1])
}

// Land polygons whose bbox overlaps the query bbox. Cheap pre-filter so the
// inner grid loop only checks a handful of polygons per cell instead of the
// thousands in the global file.
async function polygonsInBbox(queryBbox) {
  const all = await loadAllPolygons()
  return all.filter(p => bboxesOverlap(p.bbox, queryBbox)).map(p => p.geometry)
}

function paddedBbox(start, end, padFraction = 0.25, padMin = 0.05) {
  const w = Math.min(start[0], end[0])
  const e = Math.max(start[0], end[0])
  const s = Math.min(start[1], end[1])
  const n = Math.max(start[1], end[1])
  const padX = Math.max((e - w) * padFraction, padMin)
  const padY = Math.max((n - s) * padFraction, padMin)
  return [[w - padX, s - padY], [e + padX, n + padY]]
}

// Cell size in degrees so the longer bbox dimension yields ~`gridSize` cells.
function chooseStep(bbox, gridSize) {
  const [[w, s], [e, n]] = bbox
  return Math.max((e - w) / gridSize, (n - s) / gridSize, 0.001)
}

// Snap a coord to the nearest grid index inside the bbox.
function toIndex(coord, bbox, step) {
  const [[w, s]] = bbox
  return [Math.round((coord[0] - w) / step), Math.round((coord[1] - s) / step)]
}

function fromIndex(idx, bbox, step) {
  const [[w, s]] = bbox
  return [w + idx[0] * step, s + idx[1] * step]
}

// 8-directional neighbors with diagonal cost √2 and straight cost 1.
const NEIGHBORS = [
  [ 1,  0, 1], [-1,  0, 1], [ 0,  1, 1], [ 0, -1, 1],
  [ 1,  1, Math.SQRT2], [ 1, -1, Math.SQRT2],
  [-1,  1, Math.SQRT2], [-1, -1, Math.SQRT2]
]

// Min-heap keyed by f-score. Tiny pure-JS impl — A* expands enough nodes that
// linear-scan would dominate on long routes, but this stays under ~50 LOC.
class MinHeap {
  constructor() { this.a = [] }
  size() { return this.a.length }
  push(item) {
    this.a.push(item)
    let i = this.a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.a[p].f <= this.a[i].f) break
      ;[this.a[p], this.a[i]] = [this.a[i], this.a[p]]
      i = p
    }
  }
  pop() {
    const top = this.a[0]
    const last = this.a.pop()
    if (this.a.length) {
      this.a[0] = last
      let i = 0
      const n = this.a.length
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2
        let m = i
        if (l < n && this.a[l].f < this.a[m].f) m = l
        if (r < n && this.a[r].f < this.a[m].f) m = r
        if (m === i) break
        ;[this.a[m], this.a[i]] = [this.a[i], this.a[m]]
        i = m
      }
    }
    return top
  }
}

// Lazy land-cell test cached per coordinate hash.
function makeLandTest(polygons) {
  const cache = new Map()
  return (coord) => {
    const key = `${coord[0].toFixed(5)},${coord[1].toFixed(5)}`
    if (cache.has(key)) return cache.get(key)
    let onLand = false
    for (const g of polygons) {
      if (pointInPolygon(coord, g)) { onLand = true; break }
    }
    cache.set(key, onLand)
    return onLand
  }
}

// Walk outward in a small spiral until a water cell is found. Used when an
// endpoint snaps to a land cell (e.g. a coastal start point).
function nearestWaterIndex(idx, bbox, step, isLand, maxRing = 8) {
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const cand = [idx[0] + dx, idx[1] + dy]
        const c = fromIndex(cand, bbox, step)
        if (!isLand(c)) return cand
      }
    }
  }
  return null
}

function heuristic(a, b, step) {
  const dx = (a[0] - b[0]) * step
  const dy = (a[1] - b[1]) * step
  return Math.hypot(dx, dy)
}

// Greedy line-of-sight smoother. Drops intermediate waypoints whose direct
// connection to the next-next waypoint doesn't cross any land polygon.
function smoothPath(coords, polygons) {
  if (coords.length <= 2) return coords
  const out = [coords[0]]
  let i = 0
  while (i < coords.length - 1) {
    let j = coords.length - 1
    while (j > i + 1) {
      const a = coords[i], b = coords[j]
      let blocked = false
      for (const g of polygons) {
        if (segmentCrossesPolygon(a, b, g)) { blocked = true; break }
      }
      if (!blocked) break
      j--
    }
    out.push(coords[j])
    i = j
  }
  return out
}

/**
 * Returns whether a polyline crosses any land. Lazy-loads the dataset.
 *
 * @param {Array<[number, number]>} coordinates  [lng, lat] pairs in order
 * @returns {Promise<{ crosses: boolean, segmentIndex: number }>}
 *   `segmentIndex` is the index of the first crossing leg (i → i+1), or -1.
 */
export async function checkRouteCrossesLand(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return { crosses: false, segmentIndex: -1 }
  }
  // Build a query bbox from the polyline so we only test relevant polygons.
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity
  for (const [x, y] of coordinates) {
    if (x < w) w = x; if (x > e) e = x
    if (y < s) s = y; if (y > n) n = y
  }
  const polygons = await polygonsInBbox([[w, s], [e, n]])
  const idx = findLandCrossingIndex(coordinates, polygons)
  return { crosses: idx >= 0, segmentIndex: idx }
}

/**
 * Plans a polyline from `start` to `end` that stays in water.
 * Returns `{ ok: true, coordinates }` on success, or `{ ok: false, reason }`
 * if no path exists (endpoint inside land with no nearby water, A* exhausts
 * the grid, etc.).
 *
 * @param {[number, number]} start  [lng, lat]
 * @param {[number, number]} end    [lng, lat]
 * @param {{ gridSize?: number }} [opts]
 * @returns {Promise<{ ok: true, coordinates: Array<[number, number]>, lengthMeters: number }
 *                  | { ok: false, reason: string }>}
 */
export async function planWaterRoute(start, end, { gridSize = 200 } = {}) {
  if (!Array.isArray(start) || !Array.isArray(end)) {
    return { ok: false, reason: 'start and end must be [lng, lat] coordinates' }
  }

  // If the straight line is already water-clear, no planning needed.
  const direct = await checkRouteCrossesLand([start, end])
  if (!direct.crosses) {
    return {
      ok: true,
      coordinates: [start, end],
      lengthMeters: distanceBetween(start, end)
    }
  }

  const bbox = paddedBbox(start, end)
  const polygons = await polygonsInBbox(bbox)
  if (polygons.length === 0) {
    // Pre-filter says no land in the bbox — direct line must've been a
    // false positive somehow; bail honestly.
    return {
      ok: true,
      coordinates: [start, end],
      lengthMeters: distanceBetween(start, end)
    }
  }

  const step = chooseStep(bbox, gridSize)
  const isLand = makeLandTest(polygons)

  let startIdx = toIndex(start, bbox, step)
  let endIdx   = toIndex(end,   bbox, step)
  if (isLand(fromIndex(startIdx, bbox, step))) {
    const w = nearestWaterIndex(startIdx, bbox, step, isLand)
    if (!w) return { ok: false, reason: 'start point is on land with no water nearby' }
    startIdx = w
  }
  if (isLand(fromIndex(endIdx, bbox, step))) {
    const w = nearestWaterIndex(endIdx, bbox, step, isLand)
    if (!w) return { ok: false, reason: 'end point is on land with no water nearby' }
    endIdx = w
  }

  const key = (i) => `${i[0]},${i[1]}`
  const open = new MinHeap()
  const gScore = new Map()
  const came   = new Map()
  const startKey = key(startIdx)
  gScore.set(startKey, 0)
  open.push({ idx: startIdx, f: heuristic(startIdx, endIdx, step) })

  const endKey = key(endIdx)
  let found = false
  // Hard cap so a pathological case can't lock the UI.
  const maxNodes = gridSize * gridSize * 4
  let popped = 0

  while (open.size() && popped < maxNodes) {
    const cur = open.pop()
    popped++
    const ck = key(cur.idx)
    if (ck === endKey) { found = true; break }

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nIdx = [cur.idx[0] + dx, cur.idx[1] + dy]
      const nCoord = fromIndex(nIdx, bbox, step)
      if (nCoord[0] < bbox[0][0] || nCoord[0] > bbox[1][0] ||
          nCoord[1] < bbox[0][1] || nCoord[1] > bbox[1][1]) continue
      if (isLand(nCoord)) continue
      const nk = key(nIdx)
      const tentative = (gScore.get(ck) ?? Infinity) + cost
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        came.set(nk, ck)
        gScore.set(nk, tentative)
        open.push({ idx: nIdx, f: tentative + heuristic(nIdx, endIdx, step) })
      }
    }
  }

  if (!found) {
    return { ok: false, reason: 'no water path found between start and end within the search bbox' }
  }

  // Reconstruct.
  const path = []
  let walk = endKey
  while (walk) {
    const [x, y] = walk.split(',').map(Number)
    path.unshift(fromIndex([x, y], bbox, step))
    walk = came.get(walk)
  }
  // Replace synthesized first/last with the user's exact endpoints.
  path[0] = start
  path[path.length - 1] = end

  const smoothed = smoothPath(path, polygons)
  let len = 0
  for (let i = 1; i < smoothed.length; i++) {
    len += distanceBetween(smoothed[i - 1], smoothed[i])
  }
  return { ok: true, coordinates: smoothed, lengthMeters: len }
}
