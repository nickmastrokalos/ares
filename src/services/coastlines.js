// Shared access to the bundled Natural Earth 10 m land dataset.
//
// The route planner has its own internal cache of these polygons (see
// `landRouting.js`); this module wraps the same dataset behind a smaller
// general-purpose surface so plugins (via the host API) can answer
// "is this point over water?" and pull land polygons for a bbox without
// reaching into route-planner internals.
//
// First call lazy-loads the ~10 MB dataset; subsequent calls are fast.

import { pointInPolygon, geometryBounds } from './geometry'

let _datasetPromise = null
let _cache = null     // [{ geometry, bbox: [[w,s],[e,n]] }, …]

async function loadAll() {
  if (_cache) return _cache
  if (!_datasetPromise) {
    _datasetPromise = import('@/assets/ne-land-10m.json').then(m => m.default ?? m)
  }
  const fc = await _datasetPromise
  const out = []
  for (const f of fc.features ?? []) {
    const g = f.geometry
    if (!g) continue
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const bbox = geometryBounds(g)
      if (bbox) out.push({ geometry: g, bbox })
    }
  }
  _cache = out
  return _cache
}

function bboxContainsPoint(bbox, [lon, lat]) {
  const [[w, s], [e, n]] = bbox
  return lon >= w && lon <= e && lat >= s && lat <= n
}

function bboxesOverlap(a, b) {
  return !(a[1][0] < b[0][0] || a[0][0] > b[1][0] ||
           a[1][1] < b[0][1] || a[0][1] > b[1][1])
}

/**
 * @param {[number, number]} coord  [lon, lat]
 * @returns {Promise<boolean>}      true when the point lies outside every
 *                                  bundled land polygon (i.e. on water).
 */
export async function isOverWater(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return false
  const all = await loadAll()
  for (const p of all) {
    if (!bboxContainsPoint(p.bbox, coord)) continue
    if (pointInPolygon(coord, p.geometry)) return false
  }
  return true
}

/**
 * Land polygons in (or overlapping) the given bbox, returned as a GeoJSON
 * FeatureCollection so plugins can feed it straight into a MapLibre source.
 *
 * @param {[[number,number],[number,number]] | null | undefined} bbox
 *   Optional `[[west, south], [east, north]]`. If omitted, returns every
 *   bundled polygon (~10 K features — only do this if you actually need it).
 * @returns {Promise<{ type: 'FeatureCollection', features: Array<...> }>}
 */
export async function getLandPolygons(bbox) {
  const all = await loadAll()
  const filtered = bbox
    ? all.filter(p => bboxesOverlap(p.bbox, bbox))
    : all
  return {
    type: 'FeatureCollection',
    features: filtered.map(p => ({
      type: 'Feature',
      geometry: p.geometry,
      properties: {}
    }))
  }
}
