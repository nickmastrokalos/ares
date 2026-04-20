# Bullseye

> Operator-placed reference point with concentric range rings and cardinal spokes, for classic tactical position calls.

## Overview

A bullseye is a single shared reference point on the map. Positions of other tracks are reported as bearing and range from that point — e.g., *"ALPHA1 bullseye 090 / 10 nm"*. The bullseye is not attached to a track; it is a neutral frame of reference that every operator agrees on so callouts are unambiguous.

**Only one bullseye is active at a time.** Placing a new one replaces the old. This matches traditional usage — a mission has *the* bullseye, not a cluster of them.

**Persistence is per-mission.** The bullseye lives in the SQLite `bullseyes` table (migration v4), one row per mission keyed on `mission_id`. The FK cascades on mission delete so bullseyes can never outlive their owner. Placing, editing, or clearing the bullseye writes through immediately via `INSERT … ON CONFLICT(mission_id) DO UPDATE` / `DELETE`.

On first load for a mission, `init()` performs a one-time migration from the previous `@tauri-apps/plugin-store` key (`bullseye:${missionId}`) — the entry is copied into the table (if SQLite has no row yet) and then removed from the kv store. This is harmless for installs that never had the kv layout.

## Bearing reference

Bearings are measured in **degrees true north**. Magnetic declination is not modelled — there is no per-location correction. If an operation needs magnetic, that would be a per-mission setting added later.

Distances are rendered on-map using the user's preferred distance unit (`settings.distanceUnits`: metric / nautical / statute). The underlying storage is always meters.

## Entry points

- **Toolbar button** (`mdi-bullseye`, Analysis group, alongside Measure / Bloodhound / Perimeter): opens / closes `BullseyePanel.vue`. Closing the panel does not clear the bullseye.
- The panel's **Set bullseye** button puts the map into click-to-place mode; one click anywhere on the map places (or replaces) the bullseye.
- **Clicking the bullseye centre on the map** opens `BullseyePanel.vue` and reveals the white handle dot. This is a two-step select-then-drag flow that matches annotations and manual tracks: the first click just selects (panel opens, handle appears); a subsequent mousedown on the now-visible handle starts a drag. The handle is a 6 px white circle with a blue ring, matching the shape-vertex handle visual language.
- **Dragging the handle** (once visible) moves the bullseye. Rings, cardinal spokes, and every label follow the cursor live via source-data updates (no DB write per frame). On release `setBullseye({ lat, lon })` commits the new position.
- **Clicking empty map** hides the handle. Unlike annotations, the panel stays open — the user asked that bullseye settings remain accessible across handle deselection.

## Panel UX

`BullseyePanel.vue` mirrors the other analysis panels — rgba surface, draggable header, 260 px. Sections top-to-bottom:

1. **Header** — bullseye icon, title, minimize, close.
2. **Set / Move button** — `+ Set bullseye` before one exists; `⊕ Move bullseye` after. Clicking enters click-to-place mode; the map cursor becomes a crosshair. One click anywhere on the map commits. Press **Esc** to abort.
3. **Config** (visible only when a bullseye is placed):
   - **Name** — free-text. Renders just above the center on the map. Default `BULLSEYE`.
   - **Ring interval** — meters between consecutive rings. Default 1852 m (1 nm).
   - **Ring count** — how many rings to draw. Default 5, max 20.
   - **Show cardinal spokes** — toggles the N / E / S / W lines and corner letters.
4. **Center** — editable via the shared `CoordInput` component; the displayed sub-fields follow the user's `coordinateFormat` setting (DD / DMS / MGRS). Commits on Enter or when focus leaves the input group.
5. **Track list** — friendly-only bullseye calls, sorted ascending by range. Bullseye calls are used to report own-force positions, so hostile / neutral / unknown contacts are intentionally excluded. AIS vessels are excluded as well (no affiliation concept, would flood the list). A CoT track is friendly when its `cotType` has `'f'` at index 2 (`a-f-…`); a manual track is friendly when `properties.affiliation === 'f'`. Each row shows the callsign and the call formatted `NNN / <distance>`.
6. **Clear bullseye** — removes the bullseye and hides all map layers.

## Map rendering

Three geojson sources drive the overlay:

| Source               | Layer                         | Role                                      |
|----------------------|-------------------------------|-------------------------------------------|
| `bullseye-rings`     | `bullseye-rings-line`         | One polygon per ring (`ringCount` total). Dashed neutral grey stroke. |
| `bullseye-cardinals` | `bullseye-cardinals-line`     | Four lines from center to outer ring. Only populated when `showCardinals` is true. |
| `bullseye-handle`    | `bullseye-hit-target-layer`   | Invisible (`circle-opacity: 0`) 18 px circle — the click / hover target. Absorbs first-click selection, hover cursor, and click-away hit-testing so the 6 px handle doesn't have to be pixel-perfect to hit. |
| `bullseye-handle`    | `bullseye-handle-layer`       | Single Point feature at the centre. Rendered as a circle with paint identical to the shape-vertex handle (white fill, blue stroke). Starts with `layout.visibility: 'none'` — the composable's `isHandleShown` watch toggles it on once the bullseye is selected. |

MapLibre HTML markers render the ring distance labels, cardinal letters (N / E / S / W), and the bullseye name. HTML markers avoid dependence on the glyph server for text — perimeter / measure use the same pattern.

The overlay is mostly static: nothing watches any live store. Programmatic mutations (`setBullseye`, `updateBullseye`, `clearBullseye`) trigger a full rebuild; drag-to-move patches the three sources + repositions the label markers in place so it stays smooth.

### Select-then-drag

Interaction follows the same two-step flow as annotations and manual tracks:

1. **First click** on `bullseye-hit-target-layer` fires the `mousedown` handler with `isHandleShown === false`. It flips the flag to `true` (which reveals `bullseye-handle-layer` via the visibility watch) and calls `onRequestOpenPanel`. No drag, no mutation.
2. **Second mousedown** on the hit target (with the handle already visible) starts the drag. It mirrors the shape-vertex / manual-track pattern: `dragPan.disable()`, window-level `mousemove` / `mouseup` / `keydown` listeners take over, each frame re-runs `circlePolygon` / `destinationPoint` for the new centre and `setData`s all three sources; label markers are repositioned via `setLngLat` rather than torn down. Escape reverts to the committed centre; `mouseup` commits via `setBullseye`.

`suppressNextClick` still runs during drag commit so the trailing click doesn't re-enter Set/Move placement and doesn't fire the click-away handler that would hide the handle.

### Click-away

A separate `map.on('click')` handler (`setupDeselectOnMapClick`) runs `queryRenderedFeatures` against the hit-target layer. If the click lands on empty space (or any non-bullseye feature), `isHandleShown` flips to `false` and the watch hides the visible handle. The panel deliberately stays open — `BullseyePanel.vue` is modal-lite, not bound to selection, so the user can keep editing ring count / name while the on-map handle is hidden.

### Label declutter

At wide zooms the rings collapse to a few pixels across and the text labels stack on top of each other. On every `zoom` / `move` event the composable projects `center` and a point at `ringInterval` meters on bearing 0 to screen pixels, and computes the screen-space ring spacing:

- **Ring distances + name** — hidden when ring spacing < 28 px.
- **Cardinal letters (N/E/S/W)** — hidden when the outer-ring radius < 48 px (they get further from center so survive slightly longer).
- **Handle dot** — only visible when `isHandleShown` is true. Zoom has no effect on it.

Projection (rather than zoom level) handles the globe-projection case: 1 nm near the pole looks much smaller on screen than 1 nm at the equator.

## Programmatic API

`useMapBullseye(getMap, missionId, onRequestOpenPanel?, suppress?)` returns:

```js
{
  bullseye,            // ComputedRef<Bullseye | null>
  bullseyeCount,       // ComputedRef<0 | 1>
  bullseyeSelecting,   // ComputedRef<boolean> — panel-exposed click-to-place state
  draggingBullseye,    // Ref<{ lng, lat } | null> — live cursor coords during a drag; null otherwise
  toggleSelecting,     // enter / exit click-to-place mode
  setBullseye(patch),  // place or replace; patch must include lat + lon (or merge onto an existing bullseye)
  updateBullseye(patch), // merge patch into the existing bullseye; no-op if none placed
  clearBullseye(),
  init()               // async — restore this mission's persisted bullseye; call from map.on('load')
}
```

`missionId` scopes persistence. Pass `null` to disable persistence entirely (useful for tests or non-mission views). `init()` must be invoked after the MapLibre style has loaded — `MapView.vue` calls it from `map.on('load')` alongside the other composable `initLayers` functions.

`onRequestOpenPanel` is an optional callback fired on the **first** click of the bullseye centre (the one that reveals the handle dot). `MapView.vue` passes `() => { bullseyePanelOpen.value = true }`; ignored if omitted.

`suppress` is a ref-like `{ value: boolean }` consulted at drag start. When true (another entity mode active, a draw tool selected, etc.) the map-layer drag is ignored so it doesn't steal interactions from the currently-active tool. `MapView.vue` passes a shared `entitySuppressRef` kept in sync with `suppressEntityClicks` via `watch`.

`Bullseye` is:
```js
{ lat, lon, name, ringInterval, ringCount, showCardinals }
```

The composable instance is provided under the `'bullseyeApi'` inject key from `MapView.vue`. `BullseyePanel.vue` injects it.

## Geometry helper

`bullseyeCall(bullseye, target)` in `src/services/geometry.js` returns `{ bearing, range }` (true bearing in degrees, range in meters) or `null` if either argument is missing. It is a thin wrapper over `bearingBetween` + `distanceBetween`; callers that already have those values inline don't need it.

## Coexistence with click dispatcher

Bullseye's click-to-place handler is a raw `map.on('click', …)` handler, like bloodhound / perimeter. Other entity composables must continue to gate their click actions when `bullseyeSelecting` is true. `MapView.vue` OR's `bullseyeSelecting` into both `entitySelecting` (for draw / route) and `suppressEntityClicks` (for tracks / AIS / manual tracks).

The select-then-drag handler is its own `map.on('mousedown', 'bullseye-hit-target-layer', …)` binding, not routed through the click dispatcher — the hit target has no ambiguity with other entity layers. The click-away handler (`map.on('click')`) is similarly separate; it only cares whether the click landed on the bullseye hit target, so it doesn't need the dispatcher's cross-domain resolution. The dispatcher's `suppress` signal and bullseye's `suppress` ref share the same source so both handlers are silenced during draw / route / track-drop modes automatically.

## Assistant tools

Bundle: `src/services/assistant/tools/bullseye.js`, registered through `toolBundles.js` and wired with `bullseyeApi` from `MapView.vue`. Because the bullseye is not a mission feature, `map_list_features` / `map_move_feature` do not touch it — the assistant must use these dedicated tools when the user says "the bullseye".

| Tool | Readonly | Purpose |
|------|----------|---------|
| `bullseye_get`    | ✓ | Return the active bullseye (centre, name, ring interval in metres, ring count, cardinals flag) or null. |
| `bullseye_set`    |   | Place or replace the bullseye. Location via `atFeatureId` / `atTrackUid` / `atVesselMmsi` / `atCoordinate` (exactly one). Optional name / ringIntervalMeters / ringCount / showCardinals. |
| `bullseye_update` |   | Modify the existing bullseye. Any subset of name / rings / cardinals plus an optional `moveTo*` field (same four location options). Errors if no bullseye is placed. |
| `bullseye_clear`  |   | Remove the active bullseye. |

Coordinate resolution for `bullseye_set` and `bullseye_update`'s `moveTo*` fields reuses `entityResolution.resolveEndpoint` — the same helper used by annotations / bloodhound. Placements on tracks or vessels capture the instantaneous coordinate only; the bullseye does not follow a moving source.

All writes go through the confirm-card flow (`readonly: false`).

## Files

| File                                        | Role |
|---------------------------------------------|------|
| `src/composables/useMapBullseye.js`         | Composable — state, two geojson sources, HTML-marker labels, click-to-place, programmatic API. |
| `src/components/BullseyePanel.vue`          | Draggable panel — place, config, live bullseye-call list. |
| `src/views/MapView.vue`                     | Instantiates the composable, provides `bullseyeApi`, mounts the panel, extends `suppressEntityClicks` / `entitySelecting`. |
| `src/components/MapToolbar.vue`             | `bullseyePanelOpen` prop + `toggle-bullseye` event (icon `mdi-bullseye`, tooltip "Bullseye") in the Analysis group. |
| `src/services/assistant/tools/bullseye.js`  | Assistant tool bundle — `bullseye_get` / `_set` / `_update` / `_clear`. |
| `src/services/geometry.js`                  | `bullseyeCall(from, to)` helper. |

## Out of scope (v1)

- **Magnetic bearings** — everything is true-north. No declination model.
- **Multiple bullseyes** — only one at a time; second placement replaces the first.
- **AIS in the track list** — intentional, avoids flooding the panel. Could be surfaced via a future toggle.
- **Per-track panel bullseye line** — track panels do not yet display bullseye calls; a follow-up could add a single read-only line to `TrackPanel`, `AisTrackPanel`, and `ManualTrackPanel`.
