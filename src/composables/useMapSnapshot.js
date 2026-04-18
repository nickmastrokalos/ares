import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'

// Map snapshot / brief export — composites the current MapLibre canvas
// with a legend strip (mission, timestamp, overlay counts, view info) and
// saves the result as PNG via the Tauri file dialog.
//
// Requires `preserveDrawingBuffer: true` on the map constructor; without it
// the WebGL readback after paint produces a blank image.

const LEGEND_HEIGHT = 96     // CSS pixels
const LEGEND_BG     = '#141820'
const LEGEND_BORDER = '#353c50'
const LEGEND_TEXT   = '#e3e6ee'
const LEGEND_DIM    = '#8a92a8'
const LEGEND_PAD    = 16

export function useMapSnapshot({
  getMap,
  featuresStore,
  tracksStore,
  aisStore,
  perimeterApi,
  bloodhoundApi,
  interceptApi,
  ghostsStore,
  bullseyeApi
}) {

  function overlaySummary() {
    const tokens = []
    if (aisStore.visible) {
      const n = aisStore.vessels.size
      if (n) tokens.push(`${n} AIS`)
    }
    const cot = tracksStore.tracks.size
    if (cot) tokens.push(`${cot} CoT`)
    const peri = perimeterApi?.perimeters?.value?.length ?? 0
    if (peri) tokens.push(`${peri} perimeter${peri === 1 ? '' : 's'}`)
    const bh = bloodhoundApi?.bloodhounds?.value?.length ?? 0
    if (bh) tokens.push(`${bh} bloodhound${bh === 1 ? '' : 's'}`)
    const ix = interceptApi?.intercepts?.value?.length ?? 0
    if (ix) tokens.push(`${ix} intercept${ix === 1 ? '' : 's'}`)
    const gh = ghostsStore?.ghosts?.length ?? 0
    if (gh) tokens.push(`${gh} ghost${gh === 1 ? '' : 's'}`)
    const be = bullseyeApi?.bullseyeCount?.value ?? 0
    if (be) tokens.push('bullseye')
    return tokens.length ? tokens.join(' · ') : 'No overlays active'
  }

  // Force a repaint and wait for the next idle so the drawing buffer holds
  // the current state before we read it back.
  function waitForIdle(map) {
    return new Promise(resolve => {
      map.once('idle', resolve)
      map.triggerRepaint()
    })
  }

  async function capture() {
    const map = getMap()
    if (!map) return { ok: false, error: 'Map not ready.' }

    await waitForIdle(map)

    const src = map.getCanvas()
    const dpr = window.devicePixelRatio || 1
    const legendPx = Math.round(LEGEND_HEIGHT * dpr)
    const width  = src.width
    const height = src.height

    const composite = document.createElement('canvas')
    composite.width  = width
    composite.height = height + legendPx
    const ctx = composite.getContext('2d')

    ctx.drawImage(src, 0, 0)

    // ---- Legend strip ----
    const legendY = height

    ctx.fillStyle = LEGEND_BG
    ctx.fillRect(0, legendY, width, legendPx)

    ctx.strokeStyle = LEGEND_BORDER
    ctx.lineWidth = Math.max(1, Math.round(dpr))
    ctx.beginPath()
    ctx.moveTo(0, legendY + 0.5)
    ctx.lineTo(width, legendY + 0.5)
    ctx.stroke()

    const pad = Math.round(LEGEND_PAD * dpr)
    const title = featuresStore.activeMission?.name ?? 'Ares Mission'
    const now = new Date()
    const ts = now.toISOString().slice(0, 19).replace('T', ' ') + 'Z'

    // Row 1 — title (left) + timestamp (right)
    ctx.textBaseline = 'top'
    ctx.fillStyle = LEGEND_TEXT
    ctx.font = `600 ${Math.round(14 * dpr)}px sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText(title, pad, legendY + pad)

    ctx.fillStyle = LEGEND_DIM
    ctx.font = `${Math.round(11 * dpr)}px sans-serif`
    ctx.textAlign = 'right'
    ctx.fillText(ts, width - pad, legendY + pad + Math.round(2 * dpr))
    ctx.textAlign = 'left'

    // Row 2 — overlay summary
    ctx.fillStyle = LEGEND_TEXT
    ctx.font = `${Math.round(12 * dpr)}px sans-serif`
    ctx.fillText(overlaySummary(), pad, legendY + pad + Math.round(28 * dpr))

    // Row 3 — view info
    const c = map.getCenter()
    const view = `zoom ${map.getZoom().toFixed(2)} · ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`
    ctx.fillStyle = LEGEND_DIM
    ctx.font = `${Math.round(11 * dpr)}px sans-serif`
    ctx.fillText(view, pad, legendY + pad + Math.round(52 * dpr))

    // ---- Encode + save ----
    const blob = await new Promise(resolve => composite.toBlob(resolve, 'image/png'))
    if (!blob) return { ok: false, error: 'Failed to encode PNG.' }

    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safeTitle = title.replace(/[^\w\-]+/g, '_').toLowerCase() || 'mission'
    const defaultName = `${safeTitle}_${stamp}.png`

    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (!filePath) return { ok: false, cancelled: true }

    const bytes = new Uint8Array(await blob.arrayBuffer())
    await writeFile(filePath, bytes)
    return { ok: true, filePath }
  }

  return { capture }
}
