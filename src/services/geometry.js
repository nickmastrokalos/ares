const EARTH_RADIUS = 6371000 // meters

export function circlePolygon(center, radiusMeters, steps = 64) {
  const coords = []
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 360
    coords.push(destinationPoint(center, radiusMeters, angle))
  }
  return { type: 'Polygon', coordinates: [coords] }
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
