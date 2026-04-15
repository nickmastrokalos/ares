import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { kml as parseKml } from '@tmcw/togeojson'
import JSZip from 'jszip'

// ---- Export ----------------------------------------------------------------

export async function exportKml(featuresStore) {
  const fc = featuresStore.featureCollection
  if (!fc.features.length) return

  const missionName = featuresStore.activeMission?.name || 'export'
  const kmlString = buildKml(fc.features, missionName)

  const file = await save({
    defaultPath: `${missionName}.kml`,
    filters: [
      { name: 'KML', extensions: ['kml'] },
      { name: 'KMZ', extensions: ['kmz'] }
    ]
  })
  if (!file) return

  if (file.endsWith('.kmz')) {
    const zip = new JSZip()
    zip.file('doc.kml', kmlString)
    const blob = await zip.generateAsync({ type: 'uint8array' })
    await writeFile(file, blob)
  } else {
    await writeFile(file, new TextEncoder().encode(kmlString))
  }
}

function buildKml(features, documentName) {
  const placemarks = features.map(featureToKml).filter(Boolean).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${esc(documentName)}</name>`,
    placemarks,
    '  </Document>',
    '</kml>'
  ].join('\n')
}

function featureToKml(feature) {
  const props   = feature.properties ?? {}
  const name    = esc(props.name || '')
  const color   = props.color   || '#ffffff'
  const opacity = props.opacity ?? 0.2
  const type    = props._type   || ''
  const geom    = feature.geometry

  // Preserve our internal shape type so the file round-trips correctly.
  const extData = type
    ? `\n    <ExtendedData>\n      <Data name="_type"><value>${esc(type)}</value></Data>\n    </ExtendedData>`
    : ''

  if (geom?.type === 'Point') {
    const kmlColor = toKmlColor(color, 1.0)
    const [lng, lat] = geom.coordinates
    return `
    <Placemark>
      <name>${name}</name>${extData}
      <Style>
        <IconStyle>
          <color>${kmlColor}</color>
          <scale>0.6</scale>
          <Icon>
            <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>
          </Icon>
        </IconStyle>
        <LabelStyle>
          <color>${kmlColor}</color>
          <scale>0.8</scale>
        </LabelStyle>
      </Style>
      <Point>
        <coordinates>${lng},${lat},0</coordinates>
      </Point>
    </Placemark>`
  }

  if (geom?.type === 'LineString') {
    const kmlColor = toKmlColor(color, 1.0)
    return `
    <Placemark>
      <name>${name}</name>${extData}
      <Style>
        <LineStyle>
          <color>${kmlColor}</color>
          <width>3</width>
        </LineStyle>
      </Style>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>
          ${coordStr(geom.coordinates)}
        </coordinates>
      </LineString>
    </Placemark>`
  }

  if (geom?.type === 'Polygon') {
    const lineColor = toKmlColor(color, 1.0)
    const fillColor = toKmlColor(color, opacity)
    return `
    <Placemark>
      <name>${name}</name>${extData}
      <Style>
        <LineStyle>
          <color>${lineColor}</color>
          <width>2</width>
        </LineStyle>
        <PolyStyle>
          <color>${fillColor}</color>
          <fill>1</fill>
          <outline>1</outline>
        </PolyStyle>
      </Style>
      <Polygon>
        <tessellate>1</tessellate>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              ${coordStr(geom.coordinates[0])}
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`
  }

  return ''
}

// Convert a CSS #RRGGBB hex color + 0–1 alpha to KML's AABBGGRR format.
function toKmlColor(hex, alpha) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  const x = n => n.toString(16).padStart(2, '0')
  return `${x(a)}${x(b)}${x(g)}${x(r)}`
}

function coordStr(coords) {
  return coords.map(([lng, lat]) => `${lng},${lat},0`).join('\n          ')
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---- Import (unchanged) ----------------------------------------------------

export async function importKml(featuresStore) {
  if (!featuresStore.activeMissionId) return
  const file = await open({
    multiple: false,
    filters: [{ name: 'KML/KMZ', extensions: ['kml', 'kmz'] }]
  })
  if (!file) return

  const bytes = await readFile(file)
  let parsed

  if (file.endsWith('.kmz')) {
    const zip = await JSZip.loadAsync(bytes)
    const kmlFile = Object.keys(zip.files).find(f => f.endsWith('.kml'))
    if (!kmlFile) return
    const kmlText = await zip.file(kmlFile).async('string')
    parsed = parseKmlString(kmlText)
  } else {
    const text = new TextDecoder().decode(bytes)
    parsed = parseKmlString(text)
  }

  const { geojson } = parsed
  if (!geojson?.features?.length) return

  for (const feature of geojson.features) {
    if (!feature.geometry) continue
    const type = inferType(feature)
    const props = { name: feature.properties?.name || type, ...feature.properties }
    await featuresStore.addFeature(type, feature.geometry, props)
  }

  return geojson.features.length
}

function parseKmlString(text) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'text/xml')
  return { geojson: parseKml(doc) }
}

// Prefer the original `_type` we wrote into ExtendedData on export (preserves
// circle / sector through a round-trip), fall back to inferring from geometry.
function inferType(feature) {
  const stored = feature?.properties?._type
  if (stored) return stored
  const type = feature?.geometry?.type
  if (type === 'LineString') return 'line'
  if (type === 'Polygon')    return 'polygon'
  if (type === 'Point')      return 'point'
  return 'polygon'
}
