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

Two geojson sources drive the static overlay:

| Source               | Layer                    | Role                                      |
|----------------------|--------------------------|-------------------------------------------|
| `bullseye-rings`     | `bullseye-rings-line`    | One polygon per ring (`ringCount` total). Dashed neutral grey stroke. |
| `bullseye-cardinals` | `bullseye-cardinals-line`| Four lines from center to outer ring. Only populated when `showCardinals` is true. |

MapLibre HTML markers render the ring distance labels, cardinal letters (N / E / S / W), the bullseye name, and a small + cross at the center. HTML markers avoid dependence on the glyph server for text — perimeter / measure use the same pattern.

The overlay is static: nothing watches any live store. Only programmatic mutations (`setBullseye`, `updateBullseye`, `clearBullseye`) trigger a rebuild.

### Label declutter

At wide zooms the rings collapse to a few pixels across and the text labels stack on top of each other. On every `zoom` / `move` event the composable projects `center` and a point at `ringInterval` meters on bearing 0 to screen pixels, and computes the screen-space ring spacing:

- **Ring distances + name** — hidden when ring spacing < 28 px.
- **Cardinal letters (N/E/S/W)** — hidden when the outer-ring radius < 48 px (they get further from center so survive slightly longer).
- **Center cross** — always visible.

Projection (rather than zoom level) handles the globe-projection case: 1 nm near the pole looks much smaller on screen than 1 nm at the equator.

## Programmatic API

`useMapBullseye(getMap, missionId)` returns:

```js
{
  bullseye,            // ComputedRef<Bullseye | null>
  bullseyeCount,       // ComputedRef<0 | 1>    — snapshot legend uses this
  bullseyeSelecting,   // ComputedRef<boolean> — panel-exposed click-to-place state
  toggleSelecting,     // enter / exit click-to-place mode
  setBullseye(patch),  // place or replace; patch must include lat + lon (or merge onto an existing bullseye)
  updateBullseye(patch), // merge patch into the existing bullseye; no-op if none placed
  clearBullseye(),
  init()               // async — restore this mission's persisted bullseye; call from map.on('load')
}
```

`missionId` scopes persistence. Pass `null` to disable persistence entirely (useful for tests or non-mission views). `init()` must be invoked after the MapLibre style has loaded — `MapView.vue` calls it from `map.on('load')` alongside the other composable `initLayers` functions.

`Bullseye` is:
```js
{ lat, lon, name, ringInterval, ringCount, showCardinals }
```

The composable instance is provided under the `'bullseyeApi'` inject key from `MapView.vue`. `BullseyePanel.vue` injects it.

## Geometry helper

`bullseyeCall(bullseye, target)` in `src/services/geometry.js` returns `{ bearing, range }` (true bearing in degrees, range in meters) or `null` if either argument is missing. It is a thin wrapper over `bearingBetween` + `distanceBetween`; callers that already have those values inline don't need it.

## Coexistence with click dispatcher

Bullseye's click-to-place handler is a raw `map.on('click', …)` handler, like bloodhound / perimeter. Other entity composables must continue to gate their click actions when `bullseyeSelecting` is true. `MapView.vue` OR's `bullseyeSelecting` into both `entitySelecting` (for draw / route) and `suppressEntityClicks` (for tracks / AIS / manual tracks).

## Snapshot integration

When a bullseye is placed, the snapshot legend adds a `bullseye` token to the overlay summary (`useMapSnapshot` reads `bullseyeApi.bullseyeCount`).

## Files

| File                                        | Role |
|---------------------------------------------|------|
| `src/composables/useMapBullseye.js`         | Composable — state, two geojson sources, HTML-marker labels, click-to-place, programmatic API. |
| `src/components/BullseyePanel.vue`          | Draggable panel — place, config, live bullseye-call list. |
| `src/views/MapView.vue`                     | Instantiates the composable, provides `bullseyeApi`, mounts the panel, extends `suppressEntityClicks` / `entitySelecting`. |
| `src/components/MapToolbar.vue`             | `bullseyePanelOpen` prop + `toggle-bullseye` event (icon `mdi-bullseye`, tooltip "Bullseye") in the Analysis group. |
| `src/services/geometry.js`                  | `bullseyeCall(from, to)` helper. |

## Out of scope (v1)

- **Magnetic bearings** — everything is true-north. No declination model.
- **Multiple bullseyes** — only one at a time; second placement replaces the first.
- **AIS in the track list** — intentional, avoids flooding the panel. Could be surfaced via a future toggle.
- **Per-track panel bullseye line** — track panels do not yet display bullseye calls; a follow-up could add a single read-only line to `TrackPanel`, `AisTrackPanel`, and `ManualTrackPanel`.
- **Assistant tools** — no bundle yet (`bullseye_set`, `bullseye_clear`, etc.). Natural follow-up modelled on `perimeterTools`.
