// Snapshot capture tool — calls into `useMapSnapshot.capture` with the
// 'desktop' destination so the agent doesn't bounce through a native
// save dialog. The user already approves the action via the confirm
// card, which is the right gate point for "write a file."

import { rejectIfContextDerived } from '@/services/featureNaming'

export function snapshotTools({ captureSnapshotToDesktop }) {
  if (typeof captureSnapshotToDesktop !== 'function') return []

  return [
    {
      name: 'map_capture_snapshot',
      description: 'Save a PNG of the current map view directly to the user\'s Desktop. The image includes everything inside the map container — the basemap and all map layers, every visible HTML marker (bullseye / bloodhound / perimeter labels), AND every floating panel currently open over the map (host panels like Track List, AIS, Bloodhound, Perimeter, Bullseye, Annotations, Layers, Draw, Attributes, Chat, Ghost, Intercept, Routes, Track detail; plugin panels like Armada SA, Persistent Systems, etc.). A legend strip is appended at the bottom with mission name, UTC timestamp, and zoom + center coordinate. Default filename: `ares_screen_capture_<UTC ISO timestamp>.png`. Use when the user asks to "snapshot", "screenshot", "capture", or "export" the current view. Pass `filename` ONLY when the user explicitly names the snapshot, e.g. "create a snapshot called <name>" — the system appends `.png` automatically and sanitises filesystem-unsafe characters. The user has approved this via the confirm card so no further prompts appear.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'OPTIONAL filename for the saved PNG (without path). Pass ONLY when the user explicitly names the snapshot. Otherwise OMIT — the default `ares_screen_capture_<UTC ISO timestamp>.png` is used. The system appends `.png` if missing and sanitises filesystem-unsafe characters.'
          }
        },
        required: []
      },
      previewRender({ filename }) {
        const named = filename ? `"${filename}"` : 'default name'
        return `Capture map snapshot · ${named} → Desktop`
      },
      async handler({ filename } = {}) {
        const reject = rejectIfContextDerived(filename, 'filename'); if (reject) return reject
        const res = await captureSnapshotToDesktop({ filename })
        if (!res?.ok) return { error: res?.error ?? 'Snapshot failed.' }
        return { success: true, filePath: res.filePath }
      }
    }
  ]
}
