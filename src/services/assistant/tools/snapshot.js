// Snapshot capture tool — calls into `useMapSnapshot.capture` with the
// 'desktop' destination so the agent doesn't bounce through a native
// save dialog. The user already approves the action via the confirm
// card, which is the right gate point for "write a file."

export function snapshotTools({ captureSnapshotToDesktop }) {
  if (typeof captureSnapshotToDesktop !== 'function') return []

  return [
    {
      name: 'map_capture_snapshot',
      description: 'Save a PNG of the current map view directly to the user\'s Desktop. The image includes the standard Ares legend strip at the bottom (mission name, UTC timestamp, zoom + center coordinate) and any visible HTML markers (bullseye / bloodhound / perimeter labels). Filename: `ares_screen_capture_<UTC ISO timestamp>.png`. Use when the user asks to "snapshot", "screenshot", "capture", or "export" the current view. The user has approved this via the confirm card so no further prompts appear.',
      readonly: false,
      inputSchema: { type: 'object', properties: {}, required: [] },
      previewRender() {
        return 'Capture map snapshot → Desktop'
      },
      async handler() {
        const res = await captureSnapshotToDesktop()
        if (!res?.ok) return { error: res?.error ?? 'Snapshot failed.' }
        return { success: true, filePath: res.filePath }
      }
    }
  ]
}
