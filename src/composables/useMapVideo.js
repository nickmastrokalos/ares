import html2canvas from 'html2canvas-pro'
import { writeFile } from '@tauri-apps/plugin-fs'
import { save } from '@tauri-apps/plugin-dialog'
import { desktopDir, join } from '@tauri-apps/api/path'

// Map video clip recorder. Composites the entire map container
// (WebGL canvas + HTML markers + every floating panel) onto an
// offscreen canvas every frame via html2canvas-pro, then streams
// the offscreen canvas through `MediaRecorder`. Mirrors the
// scope the snapshot composable produces — what you see on the
// map is what lands in the recording, panels included.
//
// Cross-platform notes (we ship to Windows / macOS / Linux Tauri
// webviews):
//   - WebView2 (Windows / Chromium) → WebM with VP8 / VP9 reliably.
//   - WKWebView (macOS Big Sur+)    → MP4 with H.264.
//   - WebKitGTK (Linux)             → MediaRecorder is only in 2.36+
//                                     (early 2022). Older builds get a
//                                     graceful "no codec" error.
// `pickMimeType` walks a candidate list in preference order and the
// caller never sees a hard crash if nothing's available.
//
// Frame rate: html2canvas-pro is heavyweight (a full DOM walk +
// rasterisation per frame). The `fps` arg below is a *cap*; the
// stream's actual rate is whatever html2canvas can keep up with —
// typically 5–15 fps on a moderate panel layout. The video plays
// back at real-time speed because the recorder timestamps frames
// as they arrive, not on a fixed cadence.

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.42E01F',
  'video/mp4'
]

const DEFAULT_FPS = 30

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    } catch {
      // older WebKitGTK throws on unrecognized strings instead of
      // returning false; treat that as "not supported" and continue.
    }
  }
  return null
}

function sanitizeFileName(name) {
  return String(name).trim().replace(/[\/\\:*?"<>|]+/g, '_')
}

function extensionForMime(mime) {
  if (!mime) return 'webm'
  if (mime.startsWith('video/webm')) return 'webm'
  if (mime.startsWith('video/mp4'))  return 'mp4'
  return 'webm'
}

export function useMapVideo({ getMap }) {

  /**
   * Record the current map view for `durationSeconds` and save the
   * result as a video file.
   *
   * @param {{
   *   durationSeconds: number,
   *   destination?: 'dialog' | 'desktop',
   *   filename?: string,
   *   fps?: number
   * }} opts
   *   `destination`: `'dialog'` (default) prompts the native save
   *     dialog; `'desktop'` writes directly to the user's Desktop with
   *     no prompt. Mirrors the snapshot composable.
   *   `filename`: optional override. Sanitised; the appropriate
   *     extension (`.webm` or `.mp4`, depending on the available
   *     codec) is appended if missing. Defaults to
   *     `ares_map_video_<UTC ISO timestamp>.<ext>`.
   *   `fps`: target capture cap (default 30). Actual rate is
   *     html2canvas-bound; see file header.
   *
   * @returns {Promise<{ ok: true, filePath: string, durationSeconds: number, mimeType: string }
   *                 | { ok: false, cancelled?: true, error?: string }>}
   */
  async function record({ durationSeconds, destination = 'dialog', filename, fps = DEFAULT_FPS } = {}) {
    const map = getMap()
    if (!map) return { ok: false, error: 'Map not ready.' }

    const seconds = Math.max(1, Math.min(600, Number(durationSeconds) || 0))
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { ok: false, error: 'durationSeconds must be a positive number.' }
    }

    const mimeType = pickMimeType()
    if (!mimeType) {
      return { ok: false, error: 'This webview does not expose a video codec MediaRecorder can use.' }
    }

    const container = map.getContainer()
    const dpr = window.devicePixelRatio || 1
    const rect = container.getBoundingClientRect()
    const width  = Math.max(1, Math.round(rect.width  * dpr))
    const height = Math.max(1, Math.round(rect.height * dpr))

    // Offscreen compositor — every frame, html2canvas-pro paints
    // the full map container (WebGL canvas + HTML markers + every
    // floating panel) onto this. captureStream watches it and feeds
    // MediaRecorder. The offscreen canvas is the single source of
    // truth for recorded pixels, so the saved video matches the
    // snapshot scope exactly.
    const offscreen = document.createElement('canvas')
    offscreen.width  = width
    offscreen.height = height
    const ctx = offscreen.getContext('2d')

    let stream
    try {
      stream = offscreen.captureStream(fps)
    } catch (err) {
      return { ok: false, error: `Could not capture composite stream: ${err?.message ?? err}` }
    }

    let recorder
    try {
      recorder = new MediaRecorder(stream, { mimeType })
    } catch (err) {
      return { ok: false, error: `MediaRecorder rejected the chosen codec: ${err?.message ?? err}` }
    }

    const chunks = []
    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data) }

    // Composite-frame loop. Self-pacing via requestAnimationFrame:
    // we kick the next frame after html2canvas resolves so a slow
    // raster doesn't queue up backlog. MapLibre only repaints when
    // the camera or sources change; `triggerRepaint` ensures the
    // WebGL backbuffer is fresh for html2canvas to read.
    let stopped = false
    const drawFrame = () => {
      if (stopped) return
      ;(async () => {
        try {
          map.triggerRepaint()
          const captured = await html2canvas(container, {
            backgroundColor: null,
            scale:        dpr,
            useCORS:      true,
            allowTaint:   true,
            logging:      false,
            ignoreElements: (el) => el.classList?.contains('maplibregl-ctrl-attrib')
          })
          if (!stopped) {
            ctx.clearRect(0, 0, width, height)
            ctx.drawImage(captured, 0, 0, width, height)
          }
        } catch { /* skip frame on raster error; the next tick retries */ }
        if (!stopped) requestAnimationFrame(drawFrame)
      })()
    }

    let blob
    try {
      blob = await new Promise((resolve, reject) => {
        recorder.onstop = () => {
          stopped = true
          // Tear down the stream's tracks so the offscreen canvas
          // releases its capture-stream hook.
          try { stream.getTracks().forEach(t => t.stop()) } catch { /* no-op */ }
          if (chunks.length === 0) {
            reject(new Error('Recording produced no frames.'))
            return
          }
          resolve(new Blob(chunks, { type: mimeType }))
        }
        recorder.onerror = (e) => {
          stopped = true
          try { stream.getTracks().forEach(t => t.stop()) } catch { /* no-op */ }
          reject(e?.error ?? new Error('MediaRecorder error.'))
        }
        recorder.start()
        // Prime the first composite synchronously-ish so captureStream
        // has a frame ready by the time MediaRecorder starts demanding
        // them; subsequent frames continue via the rAF loop above.
        requestAnimationFrame(drawFrame)
        setTimeout(() => {
          if (recorder.state === 'recording') {
            try { recorder.stop() } catch (err) { reject(err) }
          }
        }, seconds * 1000)
      })
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) }
    }

    const ext = extensionForMime(mimeType)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

    let outName
    if (filename && String(filename).trim()) {
      const safe  = sanitizeFileName(filename)
      const lower = safe.toLowerCase()
      outName = (lower.endsWith('.webm') || lower.endsWith('.mp4')) ? safe : `${safe}.${ext}`
    } else {
      outName = `ares_map_video_${stamp}.${ext}`
    }

    let filePath
    if (destination === 'desktop') {
      try {
        const dir = await desktopDir()
        filePath = await join(dir, outName)
      } catch (err) {
        return { ok: false, error: `Could not resolve Desktop directory: ${err?.message ?? err}` }
      }
    } else {
      filePath = await save({
        defaultPath: outName,
        filters: [{
          name: ext === 'webm' ? 'WebM video' : 'MP4 video',
          extensions: [ext]
        }]
      })
      if (!filePath) return { ok: false, cancelled: true }
    }

    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      await writeFile(filePath, bytes)
    } catch (err) {
      return { ok: false, error: `Failed to write video file: ${err?.message ?? err}` }
    }
    return { ok: true, filePath, durationSeconds: seconds, mimeType }
  }

  return { record }
}
