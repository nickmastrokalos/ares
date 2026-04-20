# Annotations

> Operator-placed sticky notes pinned to map locations — free text, coloured, draggable.

## Overview

Annotations are short text notes the operator drops on the map. They're meant for quick callouts — "check this ridge", "last known contact 14:22", "FARP 1" — rather than structured mission data. Many per mission, freely placed, freely edited.

Each annotation renders as a small coloured circle with the MDI `note-text-outline` glyph centred inside — no outline unless selected. The full text body is shown only on hover via a MapLibre popup so the map stays legible even with dozens of notes placed. Editing happens in the side panel, not on the map.

## Persistence

Annotations live in the SQLite `annotations` table (migration v5), one row per note, `mission_id` as a plain FK (many per mission) with `ON DELETE CASCADE`. Schema is documented in `docs/database.md`.

Every mutation writes through immediately — there is no dirty/save cycle. The composable owns the SQL; there is no Pinia store layer.

## Entry points

- **Toolbar button** (`mdi-note-text-outline`, Annotation group alongside Draw / Layers / Route / Overlays / Track Drop / Track List): opens `AnnotationsPanel.vue`. Closing the panel does not hide the notes — they remain on the map.
- **Panel "+ Add annotation" button**: enters click-to-place mode; the cursor becomes a crosshair. One click anywhere on the map drops a note with placeholder text `New note`. **Esc** aborts.

## Map interaction

- **Hover a pin** to reveal its full text in a MapLibre popup above the pin. The popup is dismissed the moment a drag begins.
- **Click an unselected pin** to select it. `selectedId` updates, the `AnnotationsPanel` opens (if closed), the corresponding row is scrolled into view and outlined, and the on-map pin picks up a brighter blue ring via the `annotations-pin-selected` filtered layer. No drag occurs on this first click — it only arms the pin for moving.
- **Drag an already-selected pin** to move it — the new position persists on `mouseup`. Drag is wired as a `map.on('mousedown', 'annotations-pin', …)` handler with window-level `mousemove`/`mouseup`/`keydown` — the same two-step select-then-move flow draw features use. Live preview patches the `annotations-points` source directly; the DB write happens once on release. **Esc** mid-drag reverts the preview without persisting.
- **Click away** (a map click with no pin hit) deselects the active annotation and closes the panel. Wired as a `map.on('click', …)` handler in the composable that ignores the event when `selectedId` is already null, when click-to-place is active, or when a pin was hit at the click point (`queryRenderedFeatures` against `annotations-pin`). `MapView.vue` watches `selectedId` and closes the panel whenever it goes to `null`; the panel's own close emit also clears `selectedId`, so the two directions are symmetrical without looping.
- Adding a new annotation does *not* auto-select, and interacting with a panel row (typing, recolouring) does not flip the on-map blue outline. The open-panel callback is passed into `useMapAnnotations` from `MapView.vue` — the composable itself doesn't own panel visibility.
- Drag release suppresses the next `click` via a short-lived `suppressNextClick` flag so add-mode doesn't drop a new annotation on top of the just-dragged one.

## Panel UX

`AnnotationsPanel.vue` mirrors the other analysis / annotation panels — rgba surface, draggable header, 300 px wide, list body scrolls if it exceeds 60 vh.

Sections top-to-bottom:

1. **Header** — note icon, title, minimize, close.
2. **Add row** — `+ Add annotation`. Toggles click-to-place; shows `Click map…` while active.
3. **List** — one row per annotation, ordered by id (creation order). Each row has:
   - A colour dot (matches the pin).
   - A 2-row `<textarea>` bound to the note text (commits on blur / change).
   - A delete button.
   - A row of 8 colour swatches; clicking one recolours the pin.
   - Selected row (via map-pin click) is outlined in the primary colour.
4. **Clear all** — deletes every annotation for this mission after a confirm prompt.

## Colour palette

Panel and pin use the same 8-swatch palette (yellow / orange / pink / red / green / blue / purple / grey). The schema is colour-blind — any hex string is valid — but the panel only surfaces these eight to keep things consistent.

## Programmatic API

`useMapAnnotations(getMap, missionId, onRequestOpenPanel?, suppress?)` returns:

```js
{
  annotations,          // Ref<Array<{ id, lat, lon, text, color }>>
  annotationCount,      // ComputedRef<number>
  annotationSelecting,  // ComputedRef<boolean>  — click-to-place state
  selectedId,           // Ref<id | null>         — panel scroll / highlight target
  toggleSelecting,      // enter / exit click-to-place
  addAnnotation(patch),     // Promise<annotation | null>
  updateAnnotation(id, patch),  // Promise<annotation | null>
  removeAnnotation(id),
  clearAnnotations(),       // delete all for this mission
  init()                    // async — load this mission's annotations; call from map.on('load')
}
```

`missionId` scopes persistence. Pass `null` to disable persistence entirely (tests, non-mission views). `init()` must be called after the MapLibre style has loaded — `MapView.vue` runs it inside `map.on('load')` alongside the other composables. `init()` also installs the map source / layers / drag / popup handlers up-front, so a first-placed annotation doesn't race with lazy layer creation.

`onRequestOpenPanel` is an optional callback fired when the user clicks a pin (no drag). `MapView.vue` passes `() => { annotationsPanelOpen.value = true }` so clicking a note opens the editor panel.

`suppress` is a ref-like `{ value: boolean }` consulted at drag start. When true (another entity mode active, a draw tool selected, etc.) the drag-to-move handler is ignored so it doesn't steal interactions from the currently-active tool. `MapView.vue` passes a shared `entitySuppressRef` kept in sync with `suppressEntityClicks` via `watch`.

The composable is provided under the `'annotationsApi'` inject key from `MapView.vue`. `AnnotationsPanel.vue` injects it.

## Coexistence with click dispatcher

Click-to-place uses a raw `map.on('click', …)` handler. `MapView.vue` OR's `annotationSelecting` into both `entitySelecting` (draw / route) and `suppressEntityClicks` (tracks / AIS / manual tracks) so the placement click doesn't also fire unrelated actions.

Drag-to-move is its own `map.on('mousedown', 'annotations-pin', …)` binding, not routed through the click dispatcher — annotations don't overlap any other clickable layer. The dispatcher's `suppress` signal and annotations' `suppress` ref share the same source so drag is silenced during draw / route / track-drop modes automatically.

## Files

| File                                          | Role |
|-----------------------------------------------|------|
| `src/composables/useMapAnnotations.js`        | Composable — collection state, SQLite CRUD, GeoJSON circle + symbol layer rendering (pin + note glyph), hover popup, click-to-place, drag-to-move. |
| `src/components/AnnotationsPanel.vue`         | Draggable panel — add, edit, recolour, delete. |
| `src/views/MapView.vue`                       | Instantiates, provides `annotationsApi`, mounts panel, extends `suppressEntityClicks` / `entitySelecting`. |
| `src/components/MapToolbar.vue`               | `annotationsPanelOpen` prop + `toggle-annotations` event (icon `mdi-note-text-outline`, tooltip "Annotations") in the Annotation group. |
| `src-tauri/src/migrations.rs`                 | Migration v5 — creates the `annotations` table and its `mission_id` index. |

## Assistant tools

Bundle: `src/services/assistant/tools/annotations.js`, registered through `toolBundles.js` and wired with `annotationsApi` from `MapView.vue`.

| Tool | Readonly | Purpose |
|------|----------|---------|
| `annotation_list`      | ✓ | Every annotation in the active mission — id, text, colour, lat/lon. |
| `annotation_add`       |   | Drop a new pin. Placement via `atFeatureId` / `atTrackUid` / `atVesselMmsi` / `atCoordinate` (exactly one). Text + optional colour. |
| `annotation_update`    |   | Change text / colour / position on an existing id. Position moves via `moveTo*` fields (same four options); omit all to leave it put. |
| `annotation_delete`    |   | Remove one annotation by id. |
| `annotation_clear_all` |   | Nuke every annotation in the mission. |

Coordinate resolution for `annotation_add` and `annotation_update`'s move fields reuses `entityResolution.resolveEndpoint` — the helper shared with bloodhound. Placements on tracks / vessels capture the instantaneous coordinate only; unlike perimeters, annotations do not follow a moving source.

All writes go through the confirm-card flow (the store-level `readonly: false` gate).

## Out of scope (v1)

- **Rich text / markdown** — plain text only.
- **Images / attachments** — text-only for now.
- **Per-annotation visibility toggle** — all or nothing per mission.
- **Clustering / zoom-based declutter** — every annotation renders at every zoom. The operator places them deliberately; auto-hiding would surprise more than help.
