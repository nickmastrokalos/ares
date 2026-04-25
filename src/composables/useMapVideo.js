import { writeFile } from '@tauri-apps/plugin-fs'
import { save } from '@tauri-apps/plugin-dialog'
import { desktopDir, join } from '@tauri-apps/api/path'

// Map video clip recorder. Streams MapLibre's WebGL canvas through the
// browser's `MediaRecorder` API and writes a video file when the
// requested duration elapses.
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
// Limitation: only the WebGL canvas is captured. HTML overlay markers
// (bullseye / bloodhound / perimeter / measure labels) are NOT in the
// video — that would need a per-frame composite onto an offscreen
// canvas. The snapshot composable does the composite for stills; videos
// would pay the cost on every frame, deferred for now.

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
   *   `fps`: target capture framerate (default 30). The actual rate
   *     depends on what the canvas produces.
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

    const canvas = map.getCanvas()
    let stream
    try {
      stream = canvas.captureStream(fps)
    } catch (err) {
      return { ok: false, error: `Could not capture canvas stream: ${err?.message ?? err}` }
    }

    let recorder
    try {
      recorder = new MediaRecorder(stream, { mimeType })
    } catch (err) {
      return { ok: false, error: `MediaRecorder rejected the chosen codec: ${err?.message ?? err}` }
    }

    const chunks = []
    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data) }

    // MapLibre only repaints when the camera or sources change. A static
    // map produces zero new frames, which captures as an empty stream.
    // Pulse `triggerRepaint` on every animation frame while recording so
    // the canvas is always producing something for the recorder to grab.
    let stopRaf = false
    const rafTick = () => {
      if (stopRaf) return
      try { map.triggerRepaint() } catch { /* map may have been torn down */ }
      requestAnimationFrame(rafTick)
    }

    let blob
    try {
      blob = await new Promise((resolve, reject) => {
        recorder.onstop = () => {
          stopRaf = true
          // Tear down the stream's tracks so the canvas releases its
          // capture-stream hook (otherwise WebKit can leak rendering
          // resources between recordings).
          try { stream.getTracks().forEach(t => t.stop()) } catch { /* no-op */ }
          if (chunks.length === 0) {
            reject(new Error('Recording produced no frames.'))
            return
          }
          resolve(new Blob(chunks, { type: mimeType }))
        }
        recorder.onerror = (e) => {
          stopRaf = true
          try { stream.getTracks().forEach(t => t.stop()) } catch { /* no-op */ }
          reject(e?.error ?? new Error('MediaRecorder error.'))
        }
        recorder.start()
        requestAnimationFrame(rafTick)
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
