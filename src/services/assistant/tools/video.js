// Video capture tool — records the MapLibre canvas for a chosen
// duration and writes the result directly to the user's Desktop. The
// confirm card is the user-approval gate; no native save dialog runs.

const MIN_DURATION_S = 1
const MAX_DURATION_S = 60

export function videoTools({ captureVideoToDesktop }) {
  if (typeof captureVideoToDesktop !== 'function') return []

  return [
    {
      name: 'map_capture_video',
      description: 'Record the current map view for a chosen duration (any integer 1–60 seconds) and save the file directly to the user\'s Desktop. Use when the user asks for a "video", "movie", "clip", or "recording" of the map. The recording starts immediately after the user confirms and runs for `duration_seconds`. The user can pan / zoom during the window — that motion is in the output. Default filename: `ares_map_video_<UTC ISO timestamp>.<ext>` (extension picked at runtime — usually `.webm`, sometimes `.mp4` depending on the platform). Pass `filename` ONLY when the user explicitly names the clip ("create a 30-second video called <name>"). The system appends the right extension automatically and sanitises filesystem-unsafe characters. Note: HTML overlay text (bullseye / bloodhound / perimeter / measure labels) is NOT captured by the video — only the map canvas. If the user needs labels, suggest a snapshot instead.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          duration_seconds: {
            type: 'integer',
            minimum: MIN_DURATION_S,
            maximum: MAX_DURATION_S,
            description: 'Length of the recording in seconds. Any integer from 1 to 60.'
          },
          filename: {
            type: 'string',
            description: 'OPTIONAL filename for the saved video (without path or extension). Pass ONLY when the user explicitly names the clip. Otherwise OMIT — the default `ares_map_video_<UTC ISO timestamp>.<ext>` is used.'
          }
        },
        required: ['duration_seconds']
      },
      previewRender({ duration_seconds, filename }) {
        const named = filename ? `"${filename}"` : 'default name'
        return `Capture map video · ${duration_seconds}s · ${named} → Desktop`
      },
      async handler({ duration_seconds, filename } = {}) {
        const n = Number(duration_seconds)
        if (!Number.isInteger(n) || n < MIN_DURATION_S || n > MAX_DURATION_S) {
          return { error: `duration_seconds must be an integer between ${MIN_DURATION_S} and ${MAX_DURATION_S}.` }
        }
        const res = await captureVideoToDesktop({ durationSeconds: n, filename })
        if (!res?.ok) return { error: res?.error ?? 'Video capture failed.' }
        return {
          success: true,
          filePath: res.filePath,
          durationSeconds: res.durationSeconds,
          mimeType: res.mimeType
        }
      }
    }
  ]
}
