import { forward as toMgrs, toPoint as fromMgrs } from 'mgrs'

function formatDd(lng, lat) {
  const latDir = lat >= 0 ? 'N' : 'S'
  const lngDir = lng >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(5)}° ${latDir}  ${Math.abs(lng).toFixed(5)}° ${lngDir}`
}

function dmsPart(decimal, posDir, negDir) {
  const dir = decimal >= 0 ? posDir : negDir
  const abs = Math.abs(decimal)
  const d = Math.floor(abs)
  const mFull = (abs - d) * 60
  const m = Math.floor(mFull)
  const s = ((mFull - m) * 60).toFixed(1)
  const mStr = String(m).padStart(2, '0')
  const sInt = String(Math.floor(s)).padStart(2, '0')
  const sDec = s.split('.')[1]
  return `${d}°${mStr}'${sInt}.${sDec}"${dir}`
}

function formatDms(lng, lat) {
  return `${dmsPart(lat, 'N', 'S')}  ${dmsPart(lng, 'E', 'W')}`
}

function formatMgrs(lng, lat) {
  try {
    const str = toMgrs([lng, lat], 5)
    // "33UXP0084800848" → "33U XP 00848 00848"
    const m = str.match(/^(\d{1,2}[A-Z])([A-Z]{2})(\d+)$/)
    if (m) {
      const [, zone, square, digits] = m
      const half = digits.length / 2
      return `${zone} ${square} ${digits.slice(0, half)} ${digits.slice(half)}`
    }
    return str
  } catch {
    return '—'
  }
}

// ---- Parsing (inverse of format*) ----

function parseDd(str) {
  // Accept: "45.123° N  13.456° E", "45.123 N 13.456 E", "45.123, 13.456", "45.123 13.456"
  const re = /([+-]?\d+\.?\d*)\s*°?\s*([NSns]?)\s*[,\s]+([+-]?\d+\.?\d*)\s*°?\s*([EWew]?)/
  const m = str.match(re)
  if (!m) return null
  let lat = parseFloat(m[1])
  let lng = parseFloat(m[3])
  if (m[2].toUpperCase() === 'S') lat = -Math.abs(lat)
  if (m[4].toUpperCase() === 'W') lng = -Math.abs(lng)
  if (!isFinite(lat) || !isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return [lng, lat]
}

function parseDms(str) {
  const re = /(\d+)°\s*(\d+)'\s*([\d.]+)"\s*([NSns])\s*[,\s]*(\d+)°\s*(\d+)'\s*([\d.]+)"\s*([EWew])/i
  const m = str.replace(/['']/g, "'").replace(/[""]/g, '"').match(re)
  if (!m) return null
  const toDec = (d, mn, s) => parseInt(d) + parseInt(mn) / 60 + parseFloat(s) / 3600
  let lat = toDec(m[1], m[2], m[3])
  let lng = toDec(m[5], m[6], m[7])
  if (m[4].toUpperCase() === 'S') lat = -lat
  if (m[8].toUpperCase() === 'W') lng = -lng
  if (!isFinite(lat) || !isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return [lng, lat]
}

function parseMgrs(str) {
  try {
    const stripped = str.replace(/\s+/g, '')
    const result = fromMgrs(stripped)
    if (!result || !isFinite(result[0]) || !isFinite(result[1])) return null
    const [lng, lat] = result
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return [lng, lat]
  } catch {
    return null
  }
}

// Parse a coordinate string in the given format ('dd', 'dms', 'mgrs').
// Returns [lng, lat] on success, null on parse failure.
export function parseCoordinate(str, format = 'dd') {
  const trimmed = String(str ?? '').trim()
  if (!trimmed) return null
  if (format === 'mgrs') return parseMgrs(trimmed)
  if (format === 'dms') return parseDms(trimmed)
  return parseDd(trimmed)
}

export function formatCoordinate(lng, lat, format = 'dd') {
  if (format === 'dms') return formatDms(lng, lat)
  if (format === 'mgrs') return formatMgrs(lng, lat)
  return formatDd(lng, lat)
}
