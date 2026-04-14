import { forward as toMgrs } from 'mgrs'

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

export function formatCoordinate(lng, lat, format = 'dd') {
  if (format === 'dms') return formatDms(lng, lat)
  if (format === 'mgrs') return formatMgrs(lng, lat)
  return formatDd(lng, lat)
}
