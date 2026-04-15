import { importKml, exportKml } from '@/services/kml'
import { importGeoJson, exportGeoJson } from '@/services/geojson'

// Central registry of import/export formats. Adding a new format (GPX,
// Shapefile, etc.) is a one-line entry here — the DrawPanel menus iterate
// this list, so the UI picks it up automatically.
export const IO_FORMATS = [
  {
    id: 'geojson',
    label: 'GeoJSON',
    importFn: importGeoJson,
    exportFn: exportGeoJson
  },
  {
    id: 'kml',
    label: 'KML / KMZ',
    importFn: importKml,
    exportFn: exportKml
  }
]
