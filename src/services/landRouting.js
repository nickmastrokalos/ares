// Route planner used by the `map_draw_route_water_only`,
// `route_check_land_crossing`, and `map_draw_route_avoiding_features`
// assistant tools.
//
// Approach: rasterize the relevant obstacle polygons into a Uint8Array
// bitmap covering the query bbox at the planner's grid resolution,
// optionally dilate by a buffer, then run grid A* on the bitmap. Final
// path is smoothed by greedy line-of-sight against the same bitmap.
//
// Why rasterize: NE 10m's continental polygons can have hundreds of
// thousands of vertices. Per-cell `pointInPolygon` against those polygons
// times tens of thousands of A* cells froze the UI. Scanline
// rasterization is `O(rows × edges_in_band)` once up front, after which
// A* and the smoother are O(1) bitmap lookups.
//
// Two callers, two configs:
//   - `planWaterRoute` — uses bundled NE 10m land + a `LAND_BUFFER_DEG`
//     dilation to absorb the dataset's coastline generalization error.
//   - `planRouteAvoidingObstacles` — takes user-drawn polygons (keepout
//     boxes, no-go zones) and runs with no buffer by default since the
//     polygons are exact.
//
// The dataset is dynamic-imported on first use so the asset isn't part
// of the initial bundle.
//
// Caveats — water case only:
//   - NE 10m fidelity is roughly 1:10M scale: fine for ocean-crossing and
//     large-bay routes, but generalizes small bays / barrier islands /
//     narrow peninsulas at the city scale — the planner can produce
//     routes that visually clip land at zoom levels finer than ~1
//     km/pixel even though the bitmap says no crossing. The buffer
//     mitigates the worst case but does not fix the underlying data
//     fidelity.
//
// Caveats:
//   - Planar lng/lat distance metric. Fine at coastal scales; degrades for
//     ocean-crossing routes near the poles or the antimeridian.
//   - Lakes are still "land" in Natural Earth's land file (which models
//     "land = not ocean"). For inland lake routing this would produce odd
//     results; out of scope here.

import {
  findLandCrossingIndex,
  geometryBounds,
  distanceBetween
} from './geometry'

let landPromise = null      // dynamic-import the dataset once
let polygonCache = null     // [{ geometry, bbox: [[w,s],[e,n]] }, …]

async function loadAllPolygons() {
  if (polygonCache) return polygonCache
  if (!landPromise) {
    landPromise = import('@/assets/ne-land-10m.json').then(m => m.default ?? m)
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

function paddedBbox(start, end, obstacleBboxes = [], padFraction = 0.25, padMin = 0.05) {
  let w = Math.min(start[0], end[0])
  let e = Math.max(start[0], end[0])
  let s = Math.min(start[1], end[1])
  let n = Math.max(start[1], end[1])
  for (const bb of obstacleBboxes) {
    if (!bb) continue
    if (bb[0][0] < w) w = bb[0][0]
    if (bb[1][0] > e) e = bb[1][0]
    if (bb[0][1] < s) s = bb[0][1]
    if (bb[1][1] > n) n = bb[1][1]
  }
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

// Rasterize the polygons into a Uint8Array land/water bitmap covering the
// query bbox at the planner's grid resolution. Two passes:
//
// 1. Scanline rasterization: for each y row, find which polygon edges
//    span y, compute their x intercepts, and fill cells between
//    even-odd intercept pairs. Only edges whose y-range overlaps the
//    bbox are considered (continental polygons can have hundreds of
//    thousands of vertices; the y-prefilter cuts this to ~1000s).
//    All rings (outer + holes) contribute edges so even-odd fill
//    correctly punches holes for inland features.
//
// 2. Dilation by `LAND_BUFFER_DEG / step` cells: each land cell marks
//    its surrounding cells out to that radius. This is a
//    Minkowski-style inflation that absorbs NE 10m's ~250-500 m
//    coastline generalization error, so the planner stays a margin
//    offshore from the simplified coast.
//
// After this, every cell test in A* and every sample test in the
// smoother is an O(1) bitmap lookup. The naïve "9 PIPs per cell × big
// continental polygon" path that froze the UI is gone.
function buildLandBitmap(polygons, bbox, step, bufferCells) {
  const [[w, s], [e, n]] = bbox
  const cellsX = Math.round((e - w) / step) + 1
  const cellsY = Math.round((n - s) / step) + 1

  // Collect edges spanning the bbox y range. Skip horizontal edges
  // (they have no y crossings and break the intercept formula).
  const edges = []
  for (const g of polygons) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    for (const rings of polys) {
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [x1, y1] = ring[j]
          const [x2, y2] = ring[i]
          if (y1 === y2) continue
          const yLo = y1 < y2 ? y1 : y2
          const yHi = y1 < y2 ? y2 : y1
          if (yHi <= s || yLo >= n) continue
          edges.push({ x1, y1, x2, y2, yLo, yHi })
        }
      }
    }
  }

  const raw = new Uint8Array(cellsX * cellsY)
  for (let yi = 0; yi < cellsY; yi++) {
    const y = s + yi * step
    const intercepts = []
    for (const eedge of edges) {
      if (y < eedge.yLo || y >= eedge.yHi) continue
      const t = (y - eedge.y1) / (eedge.y2 - eedge.y1)
      intercepts.push(eedge.x1 + t * (eedge.x2 - eedge.x1))
    }
    intercepts.sort((a, b) => a - b)
    for (let k = 0; k + 1 < intercepts.length; k += 2) {
      const xiStart = Math.max(0, Math.ceil((intercepts[k] - w) / step))
      const xiEnd   = Math.min(cellsX - 1, Math.floor((intercepts[k + 1] - w) / step))
      const off = yi * cellsX
      for (let xi = xiStart; xi <= xiEnd; xi++) raw[off + xi] = 1
    }
  }

  // Dilate by buffer radius (in cells). Caller supplies bufferCells so the
  // same routine works for water (NE 10m buffer) and user-drawn obstacles
  // (typically zero or a small standoff requested by the operator).
  if (!bufferCells || bufferCells <= 0) return { grid: raw, cellsX, cellsY }
  const buffered = new Uint8Array(raw)
  for (let yi = 0; yi < cellsY; yi++) {
    for (let xi = 0; xi < cellsX; xi++) {
      if (!raw[yi * cellsX + xi]) continue
      const yLo = Math.max(0, yi - bufferCells)
      const yHi = Math.min(cellsY - 1, yi + bufferCells)
      const xLo = Math.max(0, xi - bufferCells)
      const xHi = Math.min(cellsX - 1, xi + bufferCells)
      for (let dy = yLo; dy <= yHi; dy++) {
        const off = dy * cellsX
        for (let dx = xLo; dx <= xHi; dx++) buffered[off + dx] = 1
      }
    }
  }
  return { grid: buffered, cellsX, cellsY }
}

// Cell-index land lookup against a precomputed bitmap. Out-of-bbox
// queries return false (treated as water) — A* clamps neighbours to
// the bbox separately, so this only fires for samples beyond the edge.
function makeLandTest(bitmap, bbox, step) {
  const { grid, cellsX, cellsY } = bitmap
  const [[w, s]] = bbox
  return (coord) => {
    const xi = Math.round((coord[0] - w) / step)
    const yi = Math.round((coord[1] - s) / step)
    if (xi < 0 || xi >= cellsX || yi < 0 || yi >= cellsY) return false
    return grid[yi * cellsX + xi] === 1
  }
}

// True if any sample along the open segment a-b lands in buffered
// land per the bitmap. Sample interval = step (one cell) so a
// cell-sized obstacle can't slip past two samples.
function segmentInLand(a, b, isLand, step) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  const samples = Math.max(2, Math.ceil(len / step))
  for (let s = 0; s <= samples; s++) {
    const t = s / samples
    if (isLand([a[0] + dx * t, a[1] + dy * t])) return true
  }
  return false
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

// Coastline buffer in degrees — applied at every land test (cell + smoother
// LOS) to compensate for NE 10m's ~250-500 m coastline generalization. A
// coordinate within this distance of any land polygon counts as land. At
// lat 36° that's ~555 m of standoff from the simplified coastline, which
// is enough room for the *true* coastline (per the basemap) to fit inside
// the buffered zone in most cases. Tunable; bigger = safer but refuses
// narrow channels, smaller = threads channels but clips more land.
const LAND_BUFFER_DEG = 0.005

// Greedy line-of-sight smoother. Drops intermediate waypoints whose direct
// connection to a later waypoint stays out of (buffered) land per the
// bitmap. Smoothing a path of N waypoints is O(N²) bitmap lookups —
// trivial relative to the rasterization cost.
//
// Earlier versions of this smoother applied an absolute distance cap
// (`MAX_SMOOTHED_LEG_M = 1000`) intended as a belt-and-suspenders against
// long bridges across NE 10m features the polygon missed. That cap turned
// out to interact badly with the cell size: when the bbox is large (~100
// km), `step` is ~500 m and 1 km caps merging at < 2 cells, leaving
// hundreds of stair-step waypoints in the output. The buffered bitmap LOS
// check is the real safety mechanism — the cap is removed and we trust
// the LOS test.
function smoothPath(coords, isLand, step) {
  if (coords.length <= 2) return coords
  const out = [coords[0]]
  let i = 0
  while (i < coords.length - 1) {
    let j = coords.length - 1
    while (j > i + 1) {
      const a = coords[i], b = coords[j]
      if (!segmentInLand(a, b, isLand, step)) break
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

// Shared core: bbox already chosen, obstacle polygons already filtered,
// run rasterization + A* + smoothing. Both `planWaterRoute` and
// `planRouteAvoidingObstacles` reach this with their own setup.
function planOnBbox(start, end, bbox, polygons, { gridSize, bufferCells, noPathReason }) {
  const step = chooseStep(bbox, gridSize)
  const bitmap = buildLandBitmap(polygons, bbox, step, bufferCells)
  const isLand = makeLandTest(bitmap, bbox, step)

  let startIdx = toIndex(start, bbox, step)
  let endIdx   = toIndex(end,   bbox, step)
  if (isLand(fromIndex(startIdx, bbox, step))) {
    const w = nearestWaterIndex(startIdx, bbox, step, isLand)
    if (!w) return { ok: false, reason: 'start point is inside an obstacle with no clear cell nearby' }
    startIdx = w
  }
  if (isLand(fromIndex(endIdx, bbox, step))) {
    const w = nearestWaterIndex(endIdx, bbox, step, isLand)
    if (!w) return { ok: false, reason: 'end point is inside an obstacle with no clear cell nearby' }
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
    return { ok: false, reason: noPathReason ?? 'no clear path found between start and end within the search bbox' }
  }

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

  const smoothed = smoothPath(path, isLand, step)
  let len = 0
  for (let i = 1; i < smoothed.length; i++) {
    len += distanceBetween(smoothed[i - 1], smoothed[i])
  }
  return { ok: true, coordinates: smoothed, lengthMeters: len }
}

/**
 * Plans a polyline from `start` to `end` that stays in water. Lazy-loads
 * the bundled coastline data on first call.
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
    return {
      ok: true,
      coordinates: [start, end],
      lengthMeters: distanceBetween(start, end)
    }
  }

  const step = chooseStep(bbox, gridSize)
  const bufferCells = Math.max(0, Math.round(LAND_BUFFER_DEG / step))
  return planOnBbox(start, end, bbox, polygons, {
    gridSize, bufferCells,
    noPathReason: 'no water path found between start and end within the search bbox'
  })
}

/**
 * Plans a polyline from `start` to `end` that does not enter any of the
 * supplied obstacle polygons. Used by the assistant's
 * `map_draw_route_avoiding_features` tool to route around user-drawn
 * keepouts. Does NOT use the bundled coastline data — caller must include
 * coastline obstacles explicitly if they care.
 *
 * @param {[number, number]} start  [lng, lat]
 * @param {[number, number]} end    [lng, lat]
 * @param {Array<{ type: string, coordinates: any }>} obstaclePolygons
 *   Polygon / MultiPolygon GeoJSON geometries to treat as impassable.
 * @param {{ gridSize?: number, bufferDeg?: number }} [opts]
 *   `bufferDeg` is an optional standoff distance from each obstacle in
 *   degrees (NOT meters). Default 0 — route may hug obstacle edges.
 */
export async function planRouteAvoidingObstacles(start, end, obstaclePolygons, { gridSize = 200, bufferDeg = 0 } = {}) {
  if (!Array.isArray(start) || !Array.isArray(end)) {
    return { ok: false, reason: 'start and end must be [lng, lat] coordinates' }
  }
  if (!Array.isArray(obstaclePolygons) || obstaclePolygons.length === 0) {
    return {
      ok: true,
      coordinates: [start, end],
      lengthMeters: distanceBetween(start, end)
    }
  }
  if (findLandCrossingIndex([start, end], obstaclePolygons) === -1) {
    return {
      ok: true,
      coordinates: [start, end],
      lengthMeters: distanceBetween(start, end)
    }
  }
  const obstacleBboxes = obstaclePolygons.map(geometryBounds).filter(Boolean)
  const bbox = paddedBbox(start, end, obstacleBboxes)
  const step = chooseStep(bbox, gridSize)
  const bufferCells = Math.max(0, Math.round(bufferDeg / step))
  return planOnBbox(start, end, bbox, obstaclePolygons, {
    gridSize, bufferCells,
    noPathReason: 'no path found around the supplied obstacles within the search bbox'
  })
}
