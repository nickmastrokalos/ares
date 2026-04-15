import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'

export async function importGeoJson(featuresStore) {
  // Imports land in whatever mission is currently active. The caller (the
  // user's navigation from HomeView) is responsible for that; refuse to
  // import into an empty state rather than silently dropping features.
  if (!featuresStore.activeMissionId) return
  const file = await open({
    multiple: false,
    filters: [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }]
  })
  if (!file) return

  const bytes = await readFile(file)
  const text = new TextDecoder().decode(bytes)
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    console.error('Failed to parse GeoJSON:', err)
    return
  }

  const features = normalizeFeatures(data)
  if (!features.length) return

  for (const feature of features) {
    if (!feature.geometry) continue
    const type = inferType(feature)
    const props = { name: feature.properties?.name || type, ...fromSimplestyle(feature.properties ?? {}) }
    await featuresStore.addFeature(type, feature.geometry, props)
  }

  return features.length
}

export async function exportGeoJson(featuresStore) {
  const fc = featuresStore.featureCollection
  if (!fc.features.length) return

  const cleaned = {
    type: 'FeatureCollection',
    features: fc.features.map(f => ({
      ...f,
      properties: withSimplestyle(cleanProps(f.properties))
    }))
  }

  const missionName = featuresStore.activeMission?.name || 'export'

  const file = await save({
    defaultPath: `${missionName}.geojson`,
    filters: [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }]
  })
  if (!file) return

  const payload = JSON.stringify(cleaned, null, 2)
  await writeFile(file, new TextEncoder().encode(payload))
}

// Accept a FeatureCollection, a single Feature, or a bare geometry (the last
// is off-spec but common in the wild — wrap it so the rest of the pipeline
// stays uniform).
function normalizeFeatures(data) {
  if (!data) return []
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) return data.features
  if (data.type === 'Feature') return [data]
  if (data.type && data.coordinates) {
    return [{ type: 'Feature', geometry: data, properties: {} }]
  }
  return []
}

// Same semantics as the KML importer: prefer our own `_type` when we wrote
// it during export so circles / sectors survive a round-trip.
function inferType(feature) {
  const stored = feature?.properties?._type
  if (stored) return stored
  const type = feature?.geometry?.type
  if (type === 'LineString') return 'line'
  if (type === 'Polygon') return 'polygon'
  if (type === 'Point') return 'point'
  return 'polygon'
}

function cleanProps(props) {
  const cleaned = { ...props }
  delete cleaned._dbId
  return cleaned
}

// Add simplestyle-spec properties so tools like geojson.io render our colors.
// https://github.com/mapbox/simplestyle-spec
function withSimplestyle(props) {
  const color   = props.color   || '#ffffff'
  const opacity = props.opacity ?? 0.2
  const type    = props._type

  if (type === 'point') {
    return { ...props, 'marker-color': color, 'marker-size': 'medium' }
  }
  if (type === 'line') {
    return { ...props, 'stroke': color, 'stroke-width': 3, 'stroke-opacity': 1 }
  }
  // polygon, circle, sector, box — all filled shapes
  return {
    ...props,
    'stroke': color,
    'stroke-width': 2,
    'stroke-opacity': 1,
    'fill': color,
    'fill-opacity': opacity
  }
}

// When importing a foreign GeoJSON that carries only simplestyle properties
// (no internal color/opacity), map them back so the feature renders correctly.
function fromSimplestyle(props) {
  const result = { ...props }
  if (!result.color) {
    result.color = props['marker-color'] || props['stroke'] || props['fill'] || null
    if (result.color === null) delete result.color
  }
  if (result.opacity == null && props['fill-opacity'] != null) {
    result.opacity = props['fill-opacity']
  }
  return result
}
