import ms from 'milsymbol'

// SIDC icon cache: keyed by SIDC string. Icons are rendered once and reused.
const iconCache   = new Map()
const svgUrlCache = new Map()

/**
 * Convert a CoT type string (e.g. "a-f-G-U-C-I") to a 15-character
 * MIL-STD-2525C SIDC string (e.g. "SFGPUCI--------").
 *
 * CoT atom type format: a-{affil}-{dim}-{...func segments}
 * SIDC layout:          S {AFFIL} {DIM} P {FUNCID:6} {MODS:5}
 *
 * Only atom-type CoT events (starting with "a-") produce meaningful SIDCs.
 * All other types fall back to a generic warfighting unknown.
 */
export function cotTypeToSidc(cotType) {
  if (!cotType || !cotType.startsWith('a-')) {
    return 'SFZP-----------'
  }

  const parts = cotType.split('-')  // ['a', 'f', 'G', 'U', 'C', 'I']

  const affiliationMap = { f: 'F', h: 'H', n: 'N', u: 'U', j: 'J', k: 'K', s: 'S' }
  const affil = affiliationMap[parts[1]?.toLowerCase()] ?? 'U'
  const dim   = (parts[2] ?? 'Z').toUpperCase()

  // Function ID: join all segments after the dimension, take up to 6 chars,
  // pad to exactly 6 with '-' so the SIDC is always 15 characters.
  const funcRaw = parts.slice(3).join('').toUpperCase()
  const funcId  = funcRaw.slice(0, 6).padEnd(6, '-')

  return `S${affil}${dim}P${funcId}-----`
}

/**
 * Get or create a map-ready image descriptor for the given SIDC.
 *
 * Returns `{ image, width, height }` where `image` is `{ width, height, data }`
 * (the format MapLibre's `map.addImage()` accepts for raw pixel data).
 *
 * MapLibre 5.x only calls `getImageData()` for HTMLImageElement / ImageBitmap.
 * Passing an HTMLCanvasElement falls into the `{ width, height, data }` branch
 * where it reads `.data` — undefined on a canvas — producing a zero-length
 * Uint8Array and a "mismatched image size" error. We extract the pixel data
 * once here and cache it so MapLibre always receives the correct format.
 */
export function getOrCreateIcon(sidc) {
  if (iconCache.has(sidc)) return iconCache.get(sidc)

  // Size 20 produces ~50×35px symbols, suitable as track icons at 1× apparent size.
  // We render at 2× (pixelRatio 2) so they look crisp on retina displays.
  const symbol = new ms.Symbol(sidc, { size: 20 })
  const canvas = symbol.asCanvas(2)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { width, height } = symbol.getSize()

  // MapLibre expects { width, height, data: Uint8ClampedArray | Uint8Array }
  const image = { width: canvas.width, height: canvas.height, data: imageData.data }
  const result = { image, width, height }
  iconCache.set(sidc, result)
  return result
}

/**
 * Get a PNG data URL for the given SIDC suitable for use in img tags.
 * Rendered at 1× (no retina scaling) since these are used in picker UI, not on the map.
 */
export function sidcToDataUrl(sidc) {
  if (svgUrlCache.has(sidc)) return svgUrlCache.get(sidc)
  const symbol = new ms.Symbol(sidc, { size: 20 })
  const url = symbol.asCanvas(1).toDataURL()
  svgUrlCache.set(sidc, url)
  return url
}

/** Clear all cached icons (call on map teardown). */
export function clearIconCache() {
  iconCache.clear()
  svgUrlCache.clear()
}
