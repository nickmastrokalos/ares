const EARTH_RADIUS = 6371000 // meters

export function boxPolygon(a, b) {
  return {
    type: 'Polygon',
    coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]]
  }
}

// Build a box polygon from canonical SW/NE corners, optionally rotated by
// `rotationDeg` degrees clockwise around the box's center (compass bearing
// convention — positive angle spins the box east-of-north, matching the
// Rot° field and the on-map rotation handle). Rotation is applied in a
// cosine-corrected local plane so it looks correct at any latitude.
export function rotatedBoxPolygon(sw, ne, rotationDeg = 0) {
  const cx = (sw[0] + ne[0]) / 2
  const cy = (sw[1] + ne[1]) / 2
  const corners = [sw, [ne[0], sw[1]], ne, [sw[0], ne[1]]]
  const rotated = corners.map(([lng, lat]) => {
    if (rotationDeg === 0) return [lng, lat]
    // Negative sign makes positive rotationDeg a clockwise (compass) rotation
    // in the east/north local plane.
    const rad = -(rotationDeg * Math.PI) / 180
    const cosA = Math.cos(rad)
    const sinA = Math.sin(rad)
    const cosLat = Math.cos(cy * Math.PI / 180)
    const dx = (lng - cx) * cosLat
    const dy = lat - cy
    return [cx + (dx * cosA - dy * sinA) / cosLat, cy + dx * sinA + dy * cosA]
  })
  return { type: 'Polygon', coordinates: [[...rotated, rotated[0]]] }
}

export function circlePolygon(center, radiusMeters, steps = 64) {
  const coords = []
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 360
    coords.push(destinationPoint(center, radiusMeters, angle))
  }
  return { type: 'Polygon', coordinates: [coords] }
}

// Build an ellipse polygon from a center point, semi-major and semi-minor radii
// (in meters), and a rotation (azimuth of the major axis from north, in degrees).
// The parametric form is converted to bearing + distance per step so the shape
// is accurate on the sphere regardless of latitude.
export function ellipsePolygon(center, radiusMajor, radiusMinor, rotationDeg = 0, steps = 64) {
  const coords = []
  const r = rotationDeg * Math.PI / 180
  for (let i = 0; i <= steps; i++) {
    const t     = (i / steps) * 2 * Math.PI
    // Decompose into east/north components using the rotated ellipse frame.
    const east  = radiusMajor * Math.cos(t) * Math.sin(r) + radiusMinor * Math.sin(t) * Math.cos(r)
    const north = radiusMajor * Math.cos(t) * Math.cos(r) - radiusMinor * Math.sin(t) * Math.sin(r)
    const dist    = Math.sqrt(east * east + north * north)
    const bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360
    coords.push(destinationPoint(center, dist, bearing))
  }
  return { type: 'Polygon', coordinates: [coords] }
}

// Rectangular corridor polygon centred on the line `start → end`, extending
// `halfWidthMeters` perpendicular to it on each side. Used as a route
// obstacle when projecting a moving entity (AIS vessel, etc.) forward
// along its course: feed the current and projected positions as endpoints
// and the corridor stands in for "anywhere this vessel will be over the
// horizon ± standoff." Square ends — no rounded caps — which is fine for
// the rasterizer.
export function corridorPolygon(start, end, halfWidthMeters) {
  const bearing = bearingBetween(start, end)
  const left  = (bearing + 270) % 360  // -90°
  const right = (bearing +  90) % 360
  const aL = destinationPoint(start, halfWidthMeters, left)
  const aR = destinationPoint(start, halfWidthMeters, right)
  const bL = destinationPoint(end,   halfWidthMeters, left)
  const bR = destinationPoint(end,   halfWidthMeters, right)
  return { type: 'Polygon', coordinates: [[aL, bL, bR, aR, aL]] }
}

export function sectorPolygon(center, radiusMeters, startAngle, endAngle, steps = 64) {
  const coords = [center]
  let sweep = endAngle - startAngle
  if (sweep <= 0) sweep += 360
  for (let i = 0; i <= steps; i++) {
    const angle = startAngle + (i / steps) * sweep
    coords.push(destinationPoint(center, radiusMeters, angle))
  }
  coords.push(center)
  return { type: 'Polygon', coordinates: [coords] }
}

export function destinationPoint([lng, lat], distMeters, bearingDeg) {
  const toRad = Math.PI / 180
  const toDeg = 180 / Math.PI
  const angDist = distMeters / EARTH_RADIUS
  const bearing = bearingDeg * toRad
  const lat1 = lat * toRad
  const lng1 = lng * toRad

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) +
    Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing)
  )
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
    Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
  )

  return [lng2 * toDeg, lat2 * toDeg]
}

export function distanceBetween([lng1, lat1], [lng2, lat2]) {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLng = (lng2 - lng1) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Classic tactical bullseye call: bearing (degrees true) and range (meters)
// from the bullseye to the target. Returns null if either coord is missing.
export function bullseyeCall(bullseye, target) {
  if (!bullseye || !target) return null
  return {
    bearing: bearingBetween(bullseye, target),
    range: distanceBetween(bullseye, target)
  }
}

export function bearingBetween([lng1, lat1], [lng2, lat2]) {
  const toRad = Math.PI / 180
  const toDeg = 180 / Math.PI
  const dLng = (lng2 - lng1) * toRad
  const y = Math.sin(dLng) * Math.cos(lat2 * toRad)
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng)
  return ((Math.atan2(y, x) * toDeg) + 360) % 360
}

const M_PER_NM = 1852
const M_PER_MI = 1609.344
const M_PER_FT = 0.3048

// Compute the four lat/lon corners of a rectangular image overlay centered on
// `center`, with a map-space width of `widthMeters` and an aspect ratio of
// `aspectRatio` (naturalWidth / naturalHeight).
// Returns [topLeft, topRight, bottomRight, bottomLeft] — the order MapLibre's
// raster image source expects.
export function computeImageCorners(center, widthMeters, aspectRatio) {
  const heightMeters = widthMeters / aspectRatio
  const halfW = widthMeters / 2
  const halfH = heightMeters / 2
  const topCenter = destinationPoint(center, halfH, 0)
  const bottomCenter = destinationPoint(center, halfH, 180)
  return [
    destinationPoint(topCenter, halfW, 270),    // top-left
    destinationPoint(topCenter, halfW, 90),     // top-right
    destinationPoint(bottomCenter, halfW, 90),  // bottom-right
    destinationPoint(bottomCenter, halfW, 270)  // bottom-left
  ]
}

export function formatDistance(meters, units = 'metric') {
  if (units === 'statute') {
    const feet = meters / M_PER_FT
    if (feet < 5280) return `${Math.round(feet)} ft`
    return `${(feet / 5280).toFixed(2)} mi`
  }
  if (units === 'nautical') {
    if (meters < M_PER_NM) return `${Math.round(meters)} m`
    return `${(meters / M_PER_NM).toFixed(2)} nm`
  }
  // metric (default)
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(2)} km`
}

// Bounding-box centroid of a closed coordinate ring. Returns [lng, lat].
// Used for both the AttributesPanel center display and the center drag handle.
export function ringCentroid(ring) {
  const lons = ring.map(c => c[0])
  const lats = ring.map(c => c[1])
  return [
    (Math.min(...lons) + Math.max(...lons)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2
  ]
}

// Bounding box for any standard GeoJSON geometry. Returns [[west, south],
// [east, north]] which MapLibre's fitBounds accepts directly, or null if
// the geometry has no usable coordinates.
export function geometryBounds(geometry) {
  const coords = collectCoords(geometry)
  if (!coords.length) return null
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lng, lat] of coords) {
    if (lng < west) west = lng
    if (lat < south) south = lat
    if (lng > east) east = lng
    if (lat > north) north = lat
  }
  return [[west, south], [east, north]]
}

// Ray-casting point-in-ring test. Ring is an array of [lng, lat]; polygon
// closure is handled implicitly (any closing duplicate coord is harmless).
// Works in planar lon/lat space — adequate for features on a single continent
// where rhumb vs great-circle differences are negligible at the scales the
// app draws. Not correct across the antimeridian.
export function pointInRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects =
      ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

// Point-in-polygon for GeoJSON Polygon / MultiPolygon. Honors holes.
export function pointInPolygon(point, geometry) {
  if (!geometry) return false
  if (geometry.type === 'Polygon') {
    const [outer, ...holes] = geometry.coordinates
    if (!pointInRing(point, outer)) return false
    return !holes.some(h => pointInRing(point, h))
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(poly => {
      const [outer, ...holes] = poly
      if (!pointInRing(point, outer)) return false
      return !holes.some(h => pointInRing(point, h))
    })
  }
  return false
}

// True if the open segments p1-p2 and p3-p4 intersect strictly. Touches at
// endpoints / collinear overlap return false. Planar [lng, lat] is fine here
// because callers only use it on small bboxes (route planning, land checks).
export function segmentsIntersect(p1, p2, p3, p4) {
  const [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = p3, [x4, y4] = p4
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
  if (d === 0) return false
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
  return t > 0 && t < 1 && u > 0 && u < 1
}

// True if the open segment a-b crosses any edge of the Polygon / MultiPolygon
// or has either endpoint strictly inside it (with holes honored). Useful for
// "does this leg of a route enter land?" — boundary touches are tolerated.
export function segmentCrossesPolygon(a, b, geometry) {
  if (!geometry) return false
  const polys =
    geometry.type === 'Polygon'      ? [geometry.coordinates] :
    geometry.type === 'MultiPolygon' ?  geometry.coordinates  :
    null
  if (!polys) return false

  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (segmentsIntersect(a, b, ring[j], ring[i])) return true
      }
    }
  }
  // Either endpoint inside the interior counts as crossing — handles the
  // case of a fully-interior segment that doesn't intersect any boundary.
  return pointInPolygon(a, geometry) || pointInPolygon(b, geometry)
}

// Returns the index of the first segment of `coordinates` that crosses any
// of the supplied land polygons, or -1 if none. Used by the assistant
// `route_check_land_crossing` tool.
export function findLandCrossingIndex(coordinates, landPolygons) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return -1
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = coordinates[i]
    const b = coordinates[i + 1]
    for (const geom of landPolygons) {
      if (segmentCrossesPolygon(a, b, geom)) return i
    }
  }
  return -1
}

function collectCoords(geometry) {
  if (!geometry?.coordinates) return []
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates]
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates.flat()
    case 'MultiPolygon':
      return geometry.coordinates.flat(2)
    default:
      return []
  }
}

export function formatSpeed(metersPerSec, units = 'metric') {
  if (units === 'nautical') return `${(metersPerSec * 1.94384).toFixed(1)} kts`
  if (units === 'statute') return `${(metersPerSec * 2.23694).toFixed(1)} mph`
  return `${(metersPerSec * 3.6).toFixed(1)} km/h`
}

export function speedUnitLabel(units = 'metric') {
  if (units === 'nautical') return 'kts'
  if (units === 'statute') return 'mph'
  return 'km/h'
}

export function parseSpeedToMs(value, units = 'metric') {
  const n = parseFloat(String(value).trim())
  if (isNaN(n) || n < 0) return null
  if (units === 'nautical') return n * (1852 / 3600)
  if (units === 'statute') return n * (1609.344 / 3600)
  return n / 3.6
}

export function distanceUnitLabel(units = 'metric') {
  if (units === 'nautical') return 'nm'
  if (units === 'statute') return 'mi'
  return 'km'
}

export function parseDistanceToMeters(value, units = 'metric') {
  const n = parseFloat(String(value).trim())
  if (isNaN(n) || n < 0) return null
  if (units === 'nautical') return n * 1852
  if (units === 'statute') return n * 1609.344
  return n * 1000
}

// Inverse of the cosine-corrected rotation applied by rotatedBoxPolygon.
// Rotates `point` around `center` by -deg degrees (compass convention) and
// returns a new [lng, lat]. Used by vertex drag to convert a screen-dragged
// corner back into the box's unrotated axis-aligned frame.
export function inverseRotateAroundCenter([lng, lat], [cx, cy], deg) {
  if (deg === 0) return [lng, lat]
  // Matches the negated sign convention in rotatedBoxPolygon so this stays
  // the true inverse.
  const rad = -(deg * Math.PI) / 180
  const cosA = Math.cos(rad)
  const sinA = Math.sin(rad)
  const cosLat = Math.cos(cy * Math.PI / 180)
  const dx = (lng - cx) * cosLat
  const dy = lat - cy
  return [cx + (dx * cosA + dy * sinA) / cosLat, cy + (-dx * sinA + dy * cosA)]
}
