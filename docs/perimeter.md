# Perimeter

> Live-following standoff rings around individual tracks, with optional breach alerts.

## Overview

A perimeter is a dashed circle of a user-given radius drawn around a single track — CoT track, AIS vessel, or mission feature (manual track). The ring follows the track as it moves. When the "alert" flag is on, any **other** track (from any of the three stores) that falls inside the ring is flagged as a breach: the ring strokes red and every intruder gets a red halo circle on the map.

Perimeters differ from bloodhounds in a few key ways:

- **One-per-track.** Adding a perimeter to a track that already has one replaces the old radius/alert. Keyed by `${kind}:${id}`.
- **Attaches to tracks only.** Shapes, routes, and raw coordinates are not valid owners — the ring must have a moving source to be meaningful.
- **Single-click placement.** Unlike bloodhound's two-click pairing, selecting a track commits the perimeter with the current default radius and exits selection.
- **Breach recomputation** runs on every source-store tick, not just on owner movement.

## Entry points

- **Toolbar button** (`mdi-shield-outline`, Analysis group, alongside Measure and Bloodhound): opens / closes `PerimeterPanel.vue`. Closing the panel does not clear perimeters — use "Clear all".
- **Assistant**: `perimeter_list`, `perimeter_add`, `perimeter_remove`, `perimeter_set_radius`, `perimeter_set_alert`, `perimeter_clear` (see `/docs/assistant.md`).

## Panel UX

`PerimeterPanel.vue` mirrors `BloodhoundPanel.vue` styling — rgba surface, 1 px surface-variant border, draggable header, 280 px width. Sections top-to-bottom:

1. **Header** — shield icon, "Perimeter" title, minimize, close.
2. **Default radius row** — numeric input (meters). Committed on blur or Enter. Seeded at 500 m; the last committed value is reused for the next add.
3. **Add button** — `+ Add perimeter`. Clicking enters selection mode; the label flips to "Click a track…". The map cursor becomes a crosshair when hovering any snappable track layer. One click attaches the perimeter at the default radius and exits selection. Press **Esc** to abort.
4. **Perimeter list** — one row per active perimeter:
   - Kind icon + owner label (callsign / vessel name / feature label).
   - Inline radius input (meters), committed on blur or Enter. A derived unit-aware label (e.g., "270 nmi") is shown next to the input.
   - **Alert** checkbox.
   - **Breach line** (red, only when the owner currently has intruders inside) — comma-separated labels of the breached tracks.
   - **✕ button** — remove just this perimeter.
5. **Clear all** — visible once at least one perimeter exists.

## Owner kinds

Owner refs are typed, resolved to coordinates on every source-store tick:

| Kind      | Stored fields           | Resolved from            | Label                        |
|-----------|-------------------------|--------------------------|------------------------------|
| `cot`     | `uid`, `coord`          | `tracksStore.tracks`     | `callsign` or `uid`          |
| `ais`     | `mmsi`, `coord`         | `aisStore.vessels`       | vessel `name` or `mmsi`      |
| `feature` | `featureId`, `coord`    | `featuresStore.features` | `callsign` / `name` / `#id`  |

`coord` always holds the last-resolved `[lng, lat]`. Feature centroid resolution matches the bloodhound convention (`properties.center` if present, box SW/NE midpoint, else `geometryBounds` midpoint). This is only meaningful for manual-track features, which is the only `feature` kind a user can realistically target through the UI — the SNAP_LAYERS list excludes shapes and routes.

## Reactivity

`useMapPerimeters` installs three watchers — one each on `tracksStore.tracks`, `aisStore.vessels`, `featuresStore.features`. Any one firing triggers `reresolveAll()`, which:

1. **Drops** any perimeter whose feature owner was deleted (same authoritative-deletion rule as bloodhound). CoT / AIS owner disappearance does **not** drop the perimeter — the ring freezes at the last-known coord, matching the compromise in bloodhound for noisy AIS feeds and pruned CoT tracks.
2. **Re-resolves** each surviving owner's `coord`.
3. **Recomputes breaches** for every alert-enabled perimeter (see below).
4. **Rebuilds** the rings and halos sources in one batch.

Watchers are lazy — installed on the first `addPerimeter` and torn down when the last perimeter is removed. Mounting the view without using the tool costs nothing.

## Breach detection

For every perimeter with `alert=true`, on each tick:

- Iterate every live CoT track, AIS vessel, and manual-track feature.
- Skip the perimeter's own owner.
- If `distanceBetween(intruder, center) < radius` (great-circle, via `src/services/geometry.js`), mark the intruder as breached.

**AIS visibility gate** — the AIS loop is skipped entirely when `aisStore.visible === false`. A breach halo floating over empty map (with no vessel rendered) is confusing, and an operator who has explicitly hidden AIS has opted out of AIS-driven alerting. A watcher on `aisStore.visible` triggers `reresolveAll()` so breaches appear / disappear immediately on toggle.

Results drive two MapLibre sources:

| Source            | Layer                  | Role                                                                                 |
|-------------------|------------------------|--------------------------------------------------------------------------------------|
| `perimeter-rings` | `perimeter-rings-line` | One polygon per perimeter. Dashed line. Stroke color = `'#e53935'` if `breached`, else `'#4a9ade'`. |
| `perimeter-halos` | `perimeter-halos-circle` | One point per breached intruder. Stroke-only red circle radius ~14 px, no fill.    |

Polygons are generated by `circlePolygon(center, radius, 64)` so the ring is a 64-segment geodesic approximation. Breach state and halos clear automatically as soon as an intruder leaves the radius on the next tick.

## Selection flow

Single-click attach. SNAP_LAYERS (tracks only — shapes and routes intentionally excluded):

| Layer                                    | Owner kind                             |
|------------------------------------------|----------------------------------------|
| `cot-tracks-points`, `cot-tracks-symbols`| `{ kind: 'cot', uid, coord }`          |
| `ais-vessels-points`, `ais-vessels-arrows` | `{ kind: 'ais', mmsi, coord }`       |
| `manual-tracks-points`, `manual-tracks-symbols` | `{ kind: 'feature', featureId, coord }` |

Clicking a track that already has a perimeter replaces the existing ring with a fresh one at the current default radius.

### Coexistence with the click dispatcher

Perimeter selection, like bloodhound selection, installs its own raw `map.on('click', …)` handler during selection; it does not flow through `useClickDispatcher`. Every dispatcher-registered composable must therefore gate its click action when `perimeterSelecting` is true:

- `useMapAis`, `useMapTracks`, `useMapManualTracks` — receive the shared `suppressEntityClicks` computed in `MapView.vue` (`bloodhounding || perimeterSelecting || routing || placing`).
- `useMapDraw`, `useMapRoute` — receive the combined `entitySelecting` ref (`bloodhounding || perimeterSelecting`) as their `suppress` ref, OR'd into their existing mode-specific suppress conditions.

Anyone adding a new clickable entity composable must take the same `suppressEntityClicks` ref and gate its dispatcher action the same way. If the new entity is itself attachable to a perimeter, its clickable layer ids must also be added to `SNAP_LAYERS`; otherwise the perimeter selection won't reach it.

## Programmatic API

`useMapPerimeters(getMap)` returns:

```js
{
  perimeterSelecting,      // Ref<boolean> — panel-exposed "selecting" state
  perimeters,              // ComputedRef<PerimeterSummary[]>
  defaultRadius,           // Ref<number> — meters, seeds each new add
  toggleSelecting,         // enter / exit click-to-attach mode
  addPerimeter(owner, radius, alert=true) → ownerKey | null,
  removePerimeter(ownerKey) → boolean,
  setRadius(ownerKey, radius) → boolean,
  setAlert(ownerKey, alert) → boolean,
  setDefaultRadius(r),
  clearAll()
}
```

`PerimeterSummary` is:
```js
{
  ownerKey,                        // `${kind}:${id}`
  owner: { kind, coord, label, uid? | mmsi? | featureId? },
  radius,                          // meters
  alert,                           // boolean
  breached: [{ kind, id, label }]  // empty when alert is off or nobody is inside
}
```

The composable instance is provided under the `'perimeterApi'` inject key from `MapView.vue`. `PerimeterPanel.vue` and future consumers inject it rather than instantiating the composable again.

## Assistant tools

Registered from `src/services/assistant/tools/perimeter.js`. The target spec accepts **exactly one** of three input fields per call; the handler rejects combinations.

| Tool | Shape | Notes |
|------|-------|-------|
| `perimeter_list`       | — | Returns `[{ownerKey, owner, radius, alert, breached}]`. |
| `perimeter_add`        | `target{FeatureId|TrackUid|VesselMmsi}`, `radiusMeters`, `alert?` | Creates or replaces the perimeter on that track. Raw coords are **not** accepted. |
| `perimeter_remove`     | `target{…}` | Removes by owner. |
| `perimeter_set_radius` | `target{…}`, `radiusMeters` | |
| `perimeter_set_alert`  | `target{…}`, `alert` | |
| `perimeter_clear`      | — | |

### Named-target resolution

The same convention as bloodhound: when the user references a target by name, the agent is instructed to call `map_find_entity(name)` first and translate the returned `kind` into the correct id field (`cot`→`targetTrackUid`, `ais`→`targetVesselMmsi`, `feature`→`targetFeatureId`). This removes the store-guessing step and keeps the tool chain short.

## Files

| File | Role |
|------|------|
| `src/composables/useMapPerimeters.js`            | Composable — owner-keyed state, watchers, two map sources, breach loop, programmatic API. |
| `src/components/PerimeterPanel.vue`              | Draggable side panel — default radius, add, list, per-row radius + alert, remove, clear. |
| `src/services/assistant/tools/perimeter.js`      | Assistant bundle — 6 tools, target resolver. |
| `src/views/MapView.vue`                          | Instantiates the composable, provides `perimeterApi`, mounts the panel, extends `suppressEntityClicks` / `entitySelecting`, registers the assistant bundle. |
| `src/components/MapToolbar.vue`                  | `perimeterPanelOpen` prop + `toggle-perimeter` event (icon `mdi-shield-outline`, tooltip "Perimeter"), in the Analysis group next to Measure and Bloodhound. |

## Out of scope (v1)

- Persisting perimeters across app restarts — ephemeral, matching bloodhound and range.
- Pulse / blink animation on breach — MapLibre can't animate paint natively; can be layered on later with a `setInterval` toggling halo opacity.
- Affiliation filtering — every other track counts as a potential intruder regardless of color code. A future "only alert on hostile" filter would hook into the breach loop.
- Perimeters around shapes or routes — intentional; an owner must be a moving track to justify the live-follow bookkeeping.
