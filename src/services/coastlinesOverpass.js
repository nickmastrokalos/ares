// On-demand high-resolution coastline fetcher backed by the public
// Overpass API. Exists to augment the bundled Natural Earth 10m
// coastlines (~250–500 m generalisation) with raw OSM coastline ways
// (~10 m detail) for the routing planner's smoother LOS check.
//
// Free, no API key. Multiple public mirrors are tried in turn so a
// single endpoint outage doesn't kill the planner. All callers
// already have an offline fallback (NE 10m) so failures here are
// soft — log and return [].
//
// Returns plain GeoJSON-shaped LineString geometries; the planner
// uses them as line obstacles for `smoothPath`'s third LOS stage.
// We do NOT close them into polygons here — that's Phase 2.

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter'
]

// Tier-4 bboxes (continental scale) can return >1000 coastline ways
// in dense regions; 8 s was occasionally tight. 20 s gives margin
// without making local routes feel slow — Overpass returns small
// queries in <1 s anyway, so the bound only fires for big fetches.
const TIMEOUT_MS = 20_000

// Cache key resolution: round bbox edges to 0.01° (≈1 km at the
// equator) so two plans in the same neighbourhood share a fetch.
// Coastlines don't change in a session, so TTL is "until reload".
const CACHE_GRID_DEG = 0.01
const _cache = new Map()

function bboxKey(bbox) {
  const [[w, s], [e, n]] = bbox
  const round = (v) => (Math.round(v / CACHE_GRID_DEG) * CACHE_GRID_DEG).toFixed(3)
  return `${round(w)},${round(s)},${round(e)},${round(n)}`
}

function buildQuery(bbox) {
  const [[w, s], [e, n]] = bbox
  // Overpass bbox order: south, west, north, east. Server timeout
  // matches the client TIMEOUT_MS so we don't get a server abort
  // before the client gives up.
  return `[out:json][timeout:18];way["natural"="coastline"](${s},${w},${n},${e});out geom;`
}

async function fetchFromEndpoint(endpoint, query, signal) {
  // GET is "simple" by CORS standards (no preflight, no custom
  // headers), which is more robust than POST when the webview is
  // a stricter-than-browser environment. Overpass accepts both.
  const url = `${endpoint}?data=${encodeURIComponent(query)}`
  const res = await fetch(url, { method: 'GET', signal })
  if (!res.ok) {
    let body = ''
    try { body = (await res.text()).slice(0, 200) } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim())
  }
  return res.json()
}

function elementsToLineStrings(elements) {
  const out = []
  if (!Array.isArray(elements)) return out
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue
    const coords = el.geometry
      .map(p => [Number(p.lon), Number(p.lat)])
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
    if (coords.length >= 2) {
      out.push({ type: 'LineString', coordinates: coords })
    }
  }
  return out
}

/**
 * Fetch OSM coastline ways within a bbox. Returns LineString
 * geometries or `[]` on any error / timeout / abort. Caches per
 * grid-aligned bbox key.
 *
 * @param {[[number, number], [number, number]]} bbox
 *   [[west, south], [east, north]] in degrees.
 * @returns {Promise<Array<{type:'LineString', coordinates:[number,number][]}>>}
 */
export async function fetchOsmCoastlines(bbox) {
  const key = bboxKey(bbox)
  if (_cache.has(key)) {
    const cached = _cache.get(key)
    console.info(`[overpass] cache hit ${key} → ${cached.length} ways`)
    return cached
  }

  const query = buildQuery(bbox)
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  console.info(`[overpass] fetching ${key}`)

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const t0 = performance.now()
      const json = await fetchFromEndpoint(endpoint, query, ctrl.signal)
      clearTimeout(timer)
      const lines = elementsToLineStrings(json?.elements ?? [])
      const dt = Math.round(performance.now() - t0)
      console.info(`[overpass] ${endpoint} → ${lines.length} ways (${dt} ms)`)
      _cache.set(key, lines)
      return lines
    } catch (err) {
      if (ctrl.signal.aborted) break
      console.warn(`[overpass] ${endpoint} failed:`, err?.message ?? err)
    }
  }
  clearTimeout(timer)
  console.warn('[overpass] all mirrors failed; falling back to NE 10m')
  _cache.set(key, [])
  return []
}

// Test hook: clear the in-memory cache. Not exported elsewhere —
// intended for unit tests / dev workflows that want to re-fetch.
export function _clearOverpassCache() {
  _cache.clear()
}
