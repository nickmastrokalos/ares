import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { kml as parseKml } from '@tmcw/togeojson'
import tokml from 'tokml'
import JSZip from 'jszip'

export async function importKml(featuresStore) {
  // Imports land in whatever mission is currently active — missions are
  // explicit now (picked on the home page) so we no longer create one per
  // file. Bail if the caller somehow invoked us without an active mission.
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

export async function exportKml(featuresStore) {
  const fc = featuresStore.featureCollection
  if (!fc.features.length) return

  const cleanedFeatures = fc.features.map(f => ({
    ...f,
    properties: cleanProps(f.properties)
  }))

  const kmlString = tokml({ type: 'FeatureCollection', features: cleanedFeatures })

  const missionName = featuresStore.activeMission?.name || 'export'

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

function parseKmlString(text) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'text/xml')
  return { geojson: parseKml(doc) }
}

// Prefer the original `_type` we wrote into properties on export (preserves
// `circle` / `sector` through a round-trip), fall back to inferring from the
// GeoJSON geometry type for foreign files that don't carry our metadata.
function inferType(feature) {
  const stored = feature?.properties?._type
  if (stored) return stored
  const type = feature?.geometry?.type
  if (type === 'LineString') return 'line'
  if (type === 'Polygon') return 'polygon'
  if (type === 'Point') return 'point'
  return 'polygon'
}

// Strip the internal DB id we inject via the `featureCollection` computed
// before handing the feature off to a serializer. `_type` stays so the file
// round-trips back into the same shape kind.
function cleanProps(props) {
  const cleaned = { ...props }
  delete cleaned._dbId
  return cleaned
}
