import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'

// Map snapshot / brief export — composites the current MapLibre canvas
// with a legend strip (mission, timestamp, overlay counts, view info) and
// saves the result as PNG via the Tauri file dialog.
//
// Requires `preserveDrawingBuffer: true` on the map constructor; without it
// the WebGL readback after paint produces a blank image.

const LEGEND_HEIGHT = 72     // CSS pixels
const LEGEND_BG     = '#141820'
const LEGEND_BORDER = '#353c50'
const LEGEND_TEXT   = '#e3e6ee'
const LEGEND_DIM    = '#8a92a8'
const LEGEND_PAD    = 16

export function useMapSnapshot({
  getMap,
  featuresStore
}) {

  // HTML text labels (bullseye / bloodhound / perimeter / measure) live
  // in the DOM overlay, so `map.getCanvas()` alone misses them. Rasterise
  // each visible text marker at its current screen position. Map-layer
  // features (tracks, annotations, bullseye handle, etc.) are already in
  // the canvas readback and need no special handling.
  function drawHtmlMarkers(ctx, map, dpr) {
    const container = map.getContainer()
    const cRect = container.getBoundingClientRect()
    const markers = container.querySelectorAll('.maplibregl-marker')
    for (const el of markers) {
      if (el.style.display === 'none' || el.style.visibility === 'hidden') continue

      const text = (el.textContent ?? '').trim()
      if (!text) continue  // skip ornamental markers (dots, crosses)
      drawTextPill(ctx, el, text, cRect, dpr)
    }
  }

  function drawTextPill(ctx, el, text, cRect, dpr) {
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const style = window.getComputedStyle(el)
    const bg    = style.backgroundColor || 'rgba(22,22,22,0.75)'
    const color = style.color           || '#e3e6ee'
    const fontWeight = style.fontWeight || '400'
    const fontSize   = parseFloat(style.fontSize) || 11
    const fontFamily = style.fontFamily || 'sans-serif'

    const x = Math.round((rect.left - cRect.left) * dpr)
    const y = Math.round((rect.top  - cRect.top)  * dpr)
    const w = Math.round(rect.width  * dpr)
    const h = Math.round(rect.height * dpr)

    ctx.fillStyle = bg
    roundRect(ctx, x, y, w, h, Math.round(2 * dpr))
    ctx.fill()

    ctx.fillStyle = color
    ctx.font = `${fontWeight} ${Math.round(fontSize * dpr)}px ${fontFamily}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(text, x + w / 2, y + h / 2 + Math.round(dpr))
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
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
    drawHtmlMarkers(ctx, map, dpr)

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
    ctx.textBaseline = 'top'

    // Row 2 — view info (zoom + center)
    const c = map.getCenter()
    const view = `zoom ${map.getZoom().toFixed(2)} · ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`
    ctx.fillStyle = LEGEND_DIM
    ctx.font = `${Math.round(11 * dpr)}px sans-serif`
    ctx.fillText(view, pad, legendY + pad + Math.round(28 * dpr))

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
