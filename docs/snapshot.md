# Snapshot

> Export the current map view as a PNG with a legend strip — for briefing slides and after-action reports.

## Overview

A one-click export from the map toolbar (camera icon) that reads the current MapLibre canvas, composites a legend strip beneath it, and writes a PNG to disk via the native save dialog.

The user frames the map first (pan / zoom / toggle the overlays they want visible), then clicks **Snapshot**. No bbox selection UI in v1.

## Scope (v1)

- PNG only. PDF and multi-page briefs are deferred.
- Captures **the current view** at native canvas resolution (device pixel ratio respected).
- Legend strip is a fixed bottom band, not a side column.
- Whatever is visible on the map is what's captured — toggle overlays before exporting.

## Legend contents

| Line | Content |
|------|---------|
| 1a | Mission name (bold, from `featuresStore.activeMission.name`) |
| 1b | UTC timestamp (right-aligned, `YYYY-MM-DD HH:MM:SSZ`) |
| 2 | View info (dim) — `zoom X.XX · lat, lng` of the center |

The legend deliberately does not include an overlay-count summary — what's on the map is what's in the image, and the counts added noise without adding information.

## Architecture

```
MapToolbar.vue  — camera button, emits `snapshot`
    ↓
MapView.vue:captureSnapshot()
    ↓
composables/useMapSnapshot.js:capture()
    ├─ awaits map `idle`, triggers a repaint
    ├─ reads map.getCanvas() and drawImage()s it onto an offscreen canvas
    ├─ rasterizes text-bearing HTML markers (bullseye / bloodhound /
    │     perimeter labels, etc.) onto the canvas at their current
    │     screen positions — WebGL readback misses DOM overlays
    ├─ draws legend strip (dark band + text rows) at the bottom
    ├─ canvas.toBlob('image/png')
    ├─ @tauri-apps/plugin-dialog `save()` → file path (or null on cancel)
    └─ @tauri-apps/plugin-fs `writeFile(path, bytes)`
```

The WebGL readback requires `preserveDrawingBuffer: true` on the MapLibre constructor in `MapView.vue`. Without that flag, the drawing buffer is cleared after each paint and the pixel readback is blank.

## User feedback

Success is silent — the save dialog completing is itself confirmation. On error (disk full, permission denied, encode failure) the global alert chip (`useMapAlerts`) shows a critical message that self-clears after 6 seconds. User-cancelled dialog is a no-op.

## Out of scope (v1 — future work)

- **PDF export** with page framing / header / legend on one side. Adds a PDF dep (`jspdf` or similar); cleanest as a second button next to the PNG one.
- **BBox select-to-export** — drag a rectangle on the map; the snapshot renders only that region at a chosen aspect ratio.
- **Hi-DPI export at a fixed target resolution** (e.g., "export at 3840×2160 regardless of window size") — would require a second off-screen MapLibre instance or temporarily resizing the live map.
- **Per-overlay visibility picker in the snapshot dialog** — today the user toggles overlays in the real map; a dialog-level picker would let a snapshot differ from the current view.
- **Configurable legend fields** and alternative layouts (no legend / side column / multi-row detail list).
- **Metadata sidecar** — write a JSON companion with bounds, zoom, bearing, pitch, and overlay counts for downstream tooling.

## File naming

Default save name is `${missionName}_${ISO_TIMESTAMP}.png` with non-word characters collapsed to underscores. The user can override in the save dialog.
