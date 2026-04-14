export const BASEMAPS = [
  {
    id: 'osm',
    name: 'Street',
    icon: 'mdi-road-variant',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 19
  },
  {
    id: 'arcgis-dark',
    name: 'Dark',
    icon: 'mdi-moon-waning-crescent',
    tiles: ['https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16
  },
  {
    id: 'arcgis-light',
    name: 'Light',
    icon: 'mdi-white-balance-sunny',
    tiles: ['https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 16
  },
  {
    id: 'arcgis-satellite',
    name: 'Satellite',
    icon: 'mdi-satellite-variant',
    tiles: ['https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 18
  }
]

export function getBasemap(id) {
  return BASEMAPS.find(b => b.id === id) || BASEMAPS[0]
}
