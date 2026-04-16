import { circlePolygon, sectorPolygon, ellipsePolygon, ringCentroid } from '@/services/geometry'
import { esc } from '@/services/xml'

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_COLOR   = '#ffffff'
const DEFAULT_OPACITY = 0.2

// Shape types that have no meaningful CoT representation are skipped on export.
const SKIP_TYPES = new Set(['image', 'manual-track'])

// CoT types that are not importable into Ares (unsupported shapes).
const SKIP_COT_TYPES = new Set(['u-d-f-m'])

// ── Timestamp ────────────────────────────────────────────────────────────────

function isoZ(date) {
  return date.toISOString()
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 3600 * 1000)
}

function addYears(date, years) {
  const d = new Date(date)
  d.setFullYear(d.getFullYear() + years)
  return d
}

// ── Color conversion ─────────────────────────────────────────────────────────

// App stores color as #RRGGBB with a separate opacity (0–1).
// TAK CoT uses signed 32-bit ARGB integers as a "value" attribute.

// Returns a signed 32-bit ARGB integer string, e.g. "-1" for white opaque.
function appToCoTColorInt(hexRgb, alpha01) {
  const hex = (hexRgb ?? '#ffffff').replace('#', '').padStart(6, '0')
  const a   = Math.round((alpha01 ?? 1) * 255)
  const r   = parseInt(hex.slice(0, 2), 16) || 0
  const g   = parseInt(hex.slice(2, 4), 16) || 0
  const b   = parseInt(hex.slice(4, 6), 16) || 0
  const unsigned = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
  return unsigned > 0x7FFFFFFF ? String(unsigned - 0x100000000) : String(unsigned)
}

// Parses a signed 32-bit ARGB integer string → { color: '#rrggbb', opacity }.
function cotIntToAppColor(intStr) {
  const n = parseInt(intStr, 10)
  if (isNaN(n)) return null
  const unsigned = n < 0 ? (n + 0x100000000) >>> 0 : n >>> 0
  const a = (unsigned >>> 24) & 0xFF
  const r = (unsigned >>> 16) & 0xFF
  const g = (unsigned >>> 8)  & 0xFF
  const b =  unsigned         & 0xFF
  return {
    color:   '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join(''),
    opacity: Math.round((a / 255) * 100) / 100
  }
}

// Legacy: parses #AARRGGBB hex string → { color, opacity }.
function cotHexToAppColor(argbHex) {
  const raw = (argbHex ?? '').replace(/^#/, '')
  if (raw.length === 8) {
    return {
      color:   '#' + raw.slice(2).toLowerCase(),
      opacity: Math.round((parseInt(raw.slice(0, 2), 16) / 255) * 100) / 100
    }
  }
  if (raw.length === 6) {
    return { color: '#' + raw.toLowerCase(), opacity: 1 }
  }
  return null
}

// Reads a color from a single element, trying signed-int value attr then
// legacy hex text content. Returns { color, opacity } or null if unparseable.
function readArgbElement(el) {
  if (!el) return null
  const v = el.getAttribute('value')
  if (v !== null) {
    const p = cotIntToAppColor(v)
    if (p) return p
  }
  const t = el.textContent?.trim()
  if (t) {
    const p = cotHexToAppColor(t)
    if (p) return p
  }
  return null
}

// Extracts the stroke/fill color pair from a CoT <detail> element.
// Handles both shape format (<strokeColor value> / <fillColor value>) and
// TAK point format (<color argb> / <color value>).
function extractImportColors(detail) {
  const strokeParsed = readArgbElement(detail?.querySelector('strokeColor'))
  const fillParsed   = readArgbElement(detail?.querySelector('fillColor'))

  if (strokeParsed) {
    // Shape format — color from strokeColor, opacity from fillColor alpha.
    return {
      color:   strokeParsed.color,
      opacity: fillParsed?.opacity ?? DEFAULT_OPACITY
    }
  }

  // Point format — <color argb="int" /> or <color value="int" />
  const colorEl  = detail?.querySelector('color')
  const argbAttr = colorEl?.getAttribute('argb') ?? colorEl?.getAttribute('value')
  if (argbAttr != null) {
    const p = cotIntToAppColor(argbAttr)
    if (p) return { color: p.color, opacity: 1 }
  }

  return { color: DEFAULT_COLOR, opacity: DEFAULT_OPACITY }
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function round6(n) { return Math.round(n * 1e6) / 1e6 }
function round2(n) { return Math.round(n * 100)  / 100  }

// ── CoT event assembly ────────────────────────────────────────────────────────

// Builds a single <event>…</event> XML string in the TAK-compatible format.
// innerDetailLines: array of strings to inject inside <detail> after the
//   standard color/metadata block (used for <link point>, <shape>, etc.)
// opts.isPoint:     if true, emits point-specific elements and stale = +1 year
// opts.how:         "h-e" (default) or "h-g-i-g-o"
function buildEvent({
  uid, cotType, lat, lon,
  nowStr, staleStr, how,
  name, strokeColorInt, fillColorInt,
  innerDetailLines,
  remarks,
  isPoint
}) {
  const resolvedHow = how ?? 'h-e'

  const lines = [
    `<event version="2.0" uid="${esc(uid)}" type="${cotType}" time="${nowStr}" start="${nowStr}" stale="${staleStr}" how="${resolvedHow}" access="Undefined">`,
    `  <point lat="${round6(lat)}" lon="${round6(lon)}" hae="9999999" ce="9999999" le="9999999" />`,
    `  <detail>`,
    `    <contact callsign="${esc(name)}" />`,
  ]

  if (!isPoint) {
    lines.push(`    <strokeColor value="${strokeColorInt}" />`)
    lines.push(`    <fillColor value="${fillColorInt}" />`)
    lines.push(`    <strokeWeight value="1" />`)
    lines.push(`    <clamped value="False" />`)
    lines.push(`    <strokeStyle value="solid" />`)
  }

  if (remarks) {
    lines.push(`    <remarks>${esc(remarks)}</remarks>`)
  } else {
    lines.push(`    <remarks />`)
  }

  if (innerDetailLines?.length) {
    for (const l of innerDetailLines) lines.push(l)
  }

  if (!isPoint) {
    lines.push(`    <height value="0.00" />`)
    lines.push(`    <height_unit value="4" />`)
  }

  lines.push(`    <archive />`)
  lines.push(`  </detail>`)
  lines.push(`</event>`)

  return lines.join('\n')
}

// ── Feature → CoT event ───────────────────────────────────────────────────────

function featureToCoT(feature, now) {
  const p         = feature.properties
  const shapeType = p._type
  if (!shapeType || SKIP_TYPES.has(shapeType)) return null

  const color        = (p.color   ?? DEFAULT_COLOR)
  const opacity      = p.opacity  ?? DEFAULT_OPACITY
  const uid          = `ares-${p._dbId}`
  const name         = p.name ?? shapeType
  const remarks      = p.remarks ?? ''
  const nowStr       = isoZ(now)
  const strokeInt    = appToCoTColorInt(color, 1)
  const fillInt      = appToCoTColorInt(color, opacity)

  // Point ───────────────────────────────────────────────────────────────────
  if (shapeType === 'point') {
    const [lon, lat] = feature.geometry.coordinates
    const staleStr   = isoZ(addYears(now, 1))
    const colorInt   = appToCoTColorInt(color, 1)
    return buildEvent({
      uid, cotType: 'b-m-p-s-m', lat, lon,
      nowStr, staleStr, how: 'h-g-i-g-o',
      name, strokeColorInt: colorInt, fillColorInt: colorInt,
      innerDetailLines: [
        `    <color argb="${colorInt}" />`,
        `    <usericon iconsetpath="COT_MAPPING_SPOTMAP/b-m-p-s-m/${colorInt}" />`,
      ],
      remarks,
      isPoint: true
    })
  }

  const staleStr7 = isoZ(addDays(now, 7))
  const base = {
    uid, nowStr, staleStr: staleStr7, how: 'h-e',
    name, strokeColorInt: strokeInt, fillColorInt: fillInt, remarks
  }

  // Line ────────────────────────────────────────────────────────────────────
  if (shapeType === 'line') {
    const coords = feature.geometry.coordinates
    const mid    = coords[Math.floor(coords.length / 2)]
    const links  = coords.map(([lo, la]) => `    <link point="${round6(la)},${round6(lo)}" />`)
    return buildEvent({ ...base, cotType: 'u-d-f', lat: mid[1], lon: mid[0], innerDetailLines: links })
  }

  // Polygon / Box ───────────────────────────────────────────────────────────
  if (shapeType === 'polygon' || shapeType === 'box') {
    const ring          = feature.geometry.coordinates[0]
    const [clon, clat]  = ringCentroid(ring)
    // GeoJSON ring already has first == last for closed polygons; emit all.
    const links = ring.map(([lo, la]) => `    <link point="${round6(la)},${round6(lo)}" />`)
    return buildEvent({ ...base, cotType: 'u-d-f', lat: clat, lon: clon, innerDetailLines: links })
  }

  // Circle ──────────────────────────────────────────────────────────────────
  if (shapeType === 'circle') {
    const [lon, lat] = p.center
    const r          = round2(p.radius)
    const kmlColor   = argbIntToKmlHex(strokeInt)
    const kmlFill    = argbIntToKmlHex(fillInt)
    const shapeLines = [
      `    <shape>`,
      `      <ellipse minor="${r}" angle="360" major="${r}" />`,
      `      <link relation="p-c" uid="${esc(uid)}.style" type="b-x-KmlStyle">`,
      `        <Style>`,
      `          <LineStyle><color>${kmlColor}</color><width>3</width></LineStyle>`,
      `          <PolyStyle><color>${kmlFill}</color></PolyStyle>`,
      `        </Style>`,
      `      </link>`,
      `    </shape>`,
    ]
    return buildEvent({ ...base, cotType: 'u-d-c-c', lat, lon, innerDetailLines: shapeLines })
  }

  // Ellipse ─────────────────────────────────────────────────────────────────
  if (shapeType === 'ellipse') {
    const [lon, lat] = p.center
    const major      = round2(p.radiusMajor)
    const minor      = round2(p.radiusMinor)
    const rotAngle   = round2(p.rotation ?? 0)
    const kmlColor   = argbIntToKmlHex(strokeInt)
    const kmlFill    = argbIntToKmlHex(fillInt)
    const shapeLines = [
      `    <shape>`,
      `      <ellipse minor="${minor}" angle="${rotAngle}" major="${major}" />`,
      `      <link relation="p-c" uid="${esc(uid)}.style" type="b-x-KmlStyle">`,
      `        <Style>`,
      `          <LineStyle><color>${kmlColor}</color><width>3</width></LineStyle>`,
      `          <PolyStyle><color>${kmlFill}</color></PolyStyle>`,
      `        </Style>`,
      `      </link>`,
      `    </shape>`,
    ]
    return buildEvent({ ...base, cotType: 'u-d-c-e', lat, lon, innerDetailLines: shapeLines })
  }

  // Sector ──────────────────────────────────────────────────────────────────
  if (shapeType === 'sector') {
    const [lon, lat] = p.center
    const r          = round2(p.radius)
    const start      = round2(p.startAngle)
    const end        = round2(p.endAngle)
    const shapeLines = [
      `    <shape>`,
      `      <arc radius="${r}" start="${start}" end="${end}" />`,
      `    </shape>`,
    ]
    return buildEvent({ ...base, cotType: 'u-d-f', lat, lon, innerDetailLines: shapeLines })
  }

  // Route ───────────────────────────────────────────────────────────────────
  if (shapeType === 'route') {
    const coords    = feature.geometry.coordinates
    const waypoints = p.waypoints ?? coords.map((_, i) => ({
      label: i === 0 ? 'SP' : i === coords.length - 1 ? 'EP' : `WP ${i}`,
      role:  i === 0 ? 'SP' : i === coords.length - 1 ? 'EP' : 'WP'
    }))
    const colorInt  = appToCoTColorInt(color, 1)
    const staleStr  = isoZ(addDays(now, 7))

    const linkLines = coords.map(([lo, la], i) => {
      const wp       = waypoints[i] ?? {}
      const wpUid    = `${uid}-wp-${i}`
      const callsign = esc(wp.label ?? '')
      const wpType   = callsign ? 'b-m-p-w' : 'b-m-p-c'
      return `    <link uid="${wpUid}" point="${round6(la)},${round6(lo)}" type="${wpType}" callsign="${callsign}" remarks="" relation="" />`
    })

    const lines = [
      `<event version="2.0" uid="${esc(uid)}" type="b-m-r" time="${nowStr}" start="${nowStr}" stale="${staleStr}" how="h-g-i-g-o" access="Undefined">`,
      `  <point lat="0" lon="0" hae="9999999" ce="9999999" le="9999999" />`,
      `  <detail>`,
      `    <contact callsign="${esc(name)}" />`,
      `    <link_attr order="Ascending" routetype="Primary" direction="Infil" method="Foot" color="${colorInt}" />`,
      remarks ? `    <remarks>${esc(remarks)}</remarks>` : `    <remarks />`,
      `    <archive />`,
      `    <__routeinfo><__navcues /></__routeinfo>`,
      ...linkLines,
      `    <height_unit>5</height_unit>`,
      `  </detail>`,
      `</event>`,
    ]
    return lines.join('\n')
  }

  return null
}

// Converts a signed ARGB int string to a KML AABBGGRR hex string.
// KML uses AABBGGRR byte order (reversed from ARGB).
function argbIntToKmlHex(intStr) {
  const n        = parseInt(intStr, 10)
  const unsigned = n < 0 ? (n + 0x100000000) >>> 0 : n >>> 0
  const a = (unsigned >>> 24) & 0xFF
  const r = (unsigned >>> 16) & 0xFF
  const g = (unsigned >>> 8)  & 0xFF
  const b =  unsigned         & 0xFF
  return [a, b, g, r].map(c => c.toString(16).padStart(2, '0').toUpperCase()).join('')
}

// ── Single-feature CoT document ───────────────────────────────────────────────

// Returns a standalone CoT XML document string for a single feature, suitable
// for writing to an individual .cot file inside a ZIP or TAK Data Package.
// Returns null for unsupported types (image, manual-track).
export function featureToCoTDoc(feature) {
  const now = new Date()
  const xml = featureToCoT(feature, now)
  if (!xml) return null
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`
}

// ── Public export ─────────────────────────────────────────────────────────────

// Accepts the featureCollection.features array from the features store.
// Returns a CoT XML string wrapping all events.
export function exportFeaturesToCot(fcFeatures) {
  const now    = new Date()
  const events = fcFeatures
    .map(f => featureToCoT(f, now))
    .filter(Boolean)
    .join('\n\n')

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<events>`,
    ``,
    events,
    ``,
    `</events>`
  ].join('\n')
}

// ── CoT → feature objects ─────────────────────────────────────────────────────

// Parses <link point="lat,lon" /> elements from a detail element.
function parseLinkPoints(detail) {
  return [...(detail?.querySelectorAll('link[point]') ?? [])]
    .map(el => el.getAttribute('point'))
    .filter(Boolean)
    .map(s => {
      const [la, lo] = s.split(',').map(Number)
      return [lo, la]  // GeoJSON order: [lng, lat]
    })
    .filter(([lo, la]) => !isNaN(lo) && !isNaN(la))
}

// Parses legacy <polyline> text content (Ares-exported files pre-fix).
function parsePolylineCoords(text) {
  return (text ?? '').trim()
    .split(/\s+/)
    .filter(s => s.includes(','))
    .map(pair => {
      const [la, lo] = pair.split(',').map(Number)
      return [lo, la]
    })
    .filter(([lo, la]) => !isNaN(lo) && !isNaN(la))
}

// Accepts a CoT XML string (single <event> or <events> wrapper).
// Returns an array of { type, geometry, properties } objects ready for
// featuresStore.addFeature.
export function importCotFeatures(xmlText) {
  const parser = new DOMParser()
  const doc    = parser.parseFromString(xmlText, 'application/xml')

  if (doc.querySelector('parsererror')) {
    throw new Error('CoT import failed: invalid XML')
  }

  const results = []

  for (const event of doc.querySelectorAll('event')) {
    const cotType = event.getAttribute('type') ?? ''
    const uid     = event.getAttribute('uid')  ?? ''

    // Skip unsupported types silently.
    if (SKIP_COT_TYPES.has(cotType)) continue

    const pointEl = event.querySelector(':scope > point')
    if (!pointEl) continue

    const lat = parseFloat(pointEl.getAttribute('lat'))
    const lon = parseFloat(pointEl.getAttribute('lon'))
    if (isNaN(lat) || isNaN(lon)) continue

    const detail  = event.querySelector('detail')
    const name    = detail?.querySelector('contact')?.getAttribute('callsign') ?? uid ?? 'Imported'
    const remarks = detail?.querySelector('remarks')?.textContent?.trim() ?? ''

    const { color, opacity } = extractImportColors(detail)

    const props = { name, color, opacity, ...(remarks ? { remarks } : {}) }

    // Route — b-m-r ──────────────────────────────────────────────────────
    if (cotType === 'b-m-r') {
      // Waypoints are <link uid="..." point="lat,lon" ...> elements.
      const wpLinks = [...(detail?.querySelectorAll('link[uid][point]') ?? [])]
      if (wpLinks.length < 2) continue

      const coords    = []
      const waypoints = []
      for (const link of wpLinks) {
        const ptStr = link.getAttribute('point')
        if (!ptStr) continue
        const [la, lo] = ptStr.split(',').map(Number)
        if (isNaN(lo) || isNaN(la)) continue
        coords.push([lo, la])
        waypoints.push({ label: link.getAttribute('callsign') ?? '', role: 'WP' })
      }
      if (coords.length < 2) continue

      // Assign SP / EP roles based on position.
      const total = waypoints.length
      waypoints[0].role = 'SP'
      waypoints[total - 1].role = 'EP'
      // Fill in generic labels for any unlabelled middle waypoints.
      for (let i = 1; i < total - 1; i++) {
        if (!waypoints[i].label) waypoints[i].label = `WP ${i}`
      }
      if (!waypoints[0].label)       waypoints[0].label       = 'SP'
      if (!waypoints[total - 1].label) waypoints[total - 1].label = 'EP'

      // Color from <link_attr color="signedInt" /> (defaults to white).
      const linkAttr     = detail?.querySelector('link_attr')
      const linkAttrClr  = linkAttr?.getAttribute('color')
      const routeColor   = linkAttrClr ? (cotIntToAppColor(linkAttrClr)?.color ?? DEFAULT_COLOR) : DEFAULT_COLOR

      results.push({
        type:       'route',
        geometry:   { type: 'LineString', coordinates: coords },
        properties: { name, color: routeColor, waypoints, ...(remarks ? { remarks } : {}) }
      })
      continue
    }

    const shape    = detail?.querySelector('shape')
    const ellipse  = shape?.querySelector('ellipse')
    const arc      = shape?.querySelector('arc')
    const polyline = detail?.querySelector('polyline')  // legacy Ares format

    // Circle (u-d-c-c) or Ellipse (u-d-c-e) ──────────────────────────────
    if (ellipse) {
      const major = parseFloat(ellipse.getAttribute('major') ?? '500')
      const minor = parseFloat(ellipse.getAttribute('minor') ?? String(major))
      const angle = parseFloat(ellipse.getAttribute('angle') ?? '0')

      if (cotType === 'u-d-c-e') {
        // True ellipse — angle is the azimuth of the major axis from north.
        const rotation = isNaN(angle) ? 0 : angle
        const center   = [lon, lat]
        results.push({
          type:       'ellipse',
          geometry:   ellipsePolygon(center, major, minor, rotation),
          properties: { ...props, center, radiusMajor: major, radiusMinor: minor, rotation }
        })
      } else {
        // Circle (u-d-c-c) or other — average major/minor as radius.
        const radius = (major + minor) / 2
        const center = [lon, lat]
        results.push({
          type:       'circle',
          geometry:   circlePolygon(center, radius),
          properties: { ...props, center, radius }
        })
      }
      continue
    }

    // Sector ──────────────────────────────────────────────────────────────
    if (arc) {
      const radius     = parseFloat(arc.getAttribute('radius') ?? '500')
      const startAngle = parseFloat(arc.getAttribute('start')  ?? '0')
      const endAngle   = parseFloat(arc.getAttribute('end')    ?? '90')
      const center = [lon, lat]
      results.push({
        type:       'sector',
        geometry:   sectorPolygon(center, radius, startAngle, endAngle),
        properties: { ...props, center, radius, startAngle, endAngle }
      })
      continue
    }

    // Polygon / Line — TAK format: <link point="lat,lon" /> ───────────────
    const linkCoords = parseLinkPoints(detail)
    if (linkCoords.length >= 2) {
      const first = linkCoords[0]
      const last  = linkCoords[linkCoords.length - 1]
      const isClosed = first[0] === last[0] && first[1] === last[1]

      if (isClosed) {
        results.push({
          type:       'polygon',
          geometry:   { type: 'Polygon', coordinates: [linkCoords] },
          properties: props
        })
      } else {
        results.push({
          type:       'line',
          geometry:   { type: 'LineString', coordinates: linkCoords },
          properties: props
        })
      }
      continue
    }

    // Polygon / Line — legacy Ares format: <polyline closed="…"> ─────────
    if (polyline) {
      const closed = polyline.getAttribute('closed') === 'true'
      const coords = parsePolylineCoords(polyline.textContent)
      if (coords.length < 2) continue

      if (closed) {
        const ring = [...coords]
        const [f0, l0] = [ring[0], ring[ring.length - 1]]
        if (f0[0] !== l0[0] || f0[1] !== l0[1]) ring.push([...f0])
        results.push({
          type:       'polygon',
          geometry:   { type: 'Polygon', coordinates: [ring] },
          properties: props
        })
      } else {
        results.push({
          type:       'line',
          geometry:   { type: 'LineString', coordinates: coords },
          properties: props
        })
      }
      continue
    }

    // Point — b-m-p-* types or any unrecognised CoT type with a valid point ─
    // Skip anything that looks like a non-point type we don't support.
    if (cotType.startsWith('u-d-f-')) continue

    results.push({
      type:       'point',
      geometry:   { type: 'Point', coordinates: [lon, lat] },
      properties: props
    })
  }

  return results
}
