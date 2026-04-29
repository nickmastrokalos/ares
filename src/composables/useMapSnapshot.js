import html2canvas from 'html2canvas-pro'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { desktopDir, join } from '@tauri-apps/api/path'

// Map snapshot — captures the entire map container (the WebGL canvas
// AND every floating panel positioned over it: host panels, plugin
// panels, HTML markers, MapLibre controls) and appends a legend strip
// (mission, timestamp, view info) before saving as PNG.
//
// Requires `preserveDrawingBuffer: true` on the map constructor — without
// it, html2canvas can't read the WebGL backbuffer and the basemap layer
// in the captured image is blank.

const LEGEND_HEIGHT = 72     // CSS pixels
const LEGEND_BG     = '#141820'
const LEGEND_BORDER = '#353c50'
const LEGEND_TEXT   = '#e3e6ee'
const LEGEND_DIM    = '#8a92a8'
const LEGEND_PAD    = 16

// Replace any character that's unsafe in cross-platform filenames with `_`.
// Conservative — Windows is the strictest of the three platforms we ship to.
function sanitizeFileName(name) {
  return String(name).trim().replace(/[\/\\:*?"<>|]+/g, '_')
}

export function useMapSnapshot({ getMap, featuresStore }) {

  // Force a repaint and wait for the next idle so the drawing buffer holds
  // the current state before we read it back.
  function waitForIdle(map) {
    return new Promise(resolve => {
      map.once('idle', resolve)
      map.triggerRepaint()
    })
  }

  /**
   * Capture the current map view as a PNG.
   *
   * @param {{ destination?: 'dialog' | 'desktop', filename?: string }} [opts]
   *   `destination`: `'dialog'` (default) prompts the native save
   *     dialog with a suggested filename; `'desktop'` writes directly
   *     to the user's Desktop with no prompt. The agent's
   *     `map_capture_snapshot` tool uses 'desktop'; the toolbar button
   *     uses 'dialog'.
   *   `filename`: optional override. Sanitised for cross-platform
   *     filesystem safety. `.png` is appended if missing. Defaults to
   *     `ares_screen_capture_<UTC ISO timestamp>.png`.
   *
   * @returns {Promise<{ ok: true, filePath: string }
   *                  | { ok: false, cancelled?: true, error?: string }>}
   */
  async function capture({ destination = 'dialog', filename } = {}) {
    const map = getMap()
    if (!map) return { ok: false, error: 'Map not ready.' }

    await waitForIdle(map)

    const dpr = window.devicePixelRatio || 1
    const container = map.getContainer()

    // html2canvas-pro walks the DOM under `container` and rasterises
    // it into a canvas, including the MapLibre WebGL canvas (works
    // because `preserveDrawingBuffer: true`), HTML markers, and every
    // floating panel that lives inside the container (host + plugin).
    // `scale: dpr` keeps the readback at native pixel density so the
    // saved image matches what's on screen at retina resolution.
    let captured
    try {
      captured = await html2canvas(container, {
        backgroundColor: null,
        scale:        dpr,
        useCORS:      true,
        allowTaint:   true,
        logging:      false,
        // Skip the maplibre attribution control to keep the saved image
        // clean for ops use; everything else inside the map container
        // is fair game.
        ignoreElements: (el) => el.classList?.contains('maplibregl-ctrl-attrib')
      })
    } catch (err) {
      return { ok: false, error: `Snapshot render failed: ${err?.message ?? err}` }
    }

    const width    = captured.width
    const height   = captured.height
    const legendPx = Math.round(LEGEND_HEIGHT * dpr)

    const composite = document.createElement('canvas')
    composite.width  = width
    composite.height = height + legendPx
    const ctx = composite.getContext('2d')

    ctx.drawImage(captured, 0, 0)

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

    let fileName
    if (filename && String(filename).trim()) {
      const safe = sanitizeFileName(filename)
      fileName = safe.toLowerCase().endsWith('.png') ? safe : `${safe}.png`
    } else {
      const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
      fileName = `ares_screen_capture_${stamp}.png`
    }

    let filePath
    if (destination === 'desktop') {
      try {
        const dir = await desktopDir()
        filePath = await join(dir, fileName)
      } catch (err) {
        return { ok: false, error: `Could not resolve Desktop directory: ${err?.message ?? err}` }
      }
    } else {
      filePath = await save({
        defaultPath: fileName,
        filters: [{ name: 'PNG image', extensions: ['png'] }]
      })
      if (!filePath) return { ok: false, cancelled: true }
    }

    const bytes = new Uint8Array(await blob.arrayBuffer())
    await writeFile(filePath, bytes)
    return { ok: true, filePath }
  }

  return { capture }
}
