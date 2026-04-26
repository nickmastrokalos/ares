# Bloodhound

> Live-tracking range lines between arbitrary map objects.

## Overview

A bloodhound is a dashed line drawn between two endpoints with a live distance label at its midpoint. Unlike a static measurement, each endpoint is bound to a source (CoT track, AIS vessel, mission feature, or raw coordinate). When a source moves or is edited, the line and label follow without the user re-placing anything.

Bloodhounds replace the earlier "range line" tool and keep the same visual style (blue dashed line, blue endpoint dots, dark label chip) but add:
- Live reactivity against **four** source types, not just CoT.
- A managed side panel for adding / removing / clearing lines.
- Assistant tools that accept typed endpoint refs.

## Entry points

- **Toolbar button** (`mdi-map-marker-distance`, Analysis group): opens / closes `BloodhoundPanel.vue`. The panel persists committed lines across close → reopen; closing the panel does **not** clear lines (use "Clear all" for that).
- **Assistant**: `bloodhound_list`, `bloodhound_add`, `bloodhound_remove`, `bloodhound_clear` (see `/docs/assistant.md`).

## Panel UX

`BloodhoundPanel.vue` mirrors `RoutePanel.vue` styling — rgba surface, 1 px surface-variant border, draggable header, 280 px width. Sections top-to-bottom:

1. **Header** — icon, "Bloodhound" title, minimize, close.
2. **Add button** — `+ Add bloodhound`. Clicking enters selection mode; the label flips to "Click two points…". The map cursor becomes a crosshair when hovering over any snappable feature. Click two features (or two mission shapes, or a track and a vessel, etc.) to commit a line. The handler resets after each pair, so consecutive lines can be placed without re-clicking Add. Press **Esc** to exit selection.
3. **Line list** — each row shows:
   - **A endpoint:** kind icon + label (callsign / vessel name / feature name / coord).
   - **B endpoint:** same.
   - **Distance** in the user's current units.
   - **✕ button** to remove just that line.
4. **Clear all** — visible once at least one line exists.

## Endpoint kinds

Endpoints are stored as typed refs, resolved to coordinates on every source change:

| Kind      | Stored fields            | Resolved from            | Label                      |
|-----------|--------------------------|--------------------------|----------------------------|
| `cot`     | `uid`, `coord`           | `tracksStore.tracks`     | `callsign` or `uid`        |
| `ais`     | `mmsi`, `coord`          | `aisStore.vessels`       | vessel `name` or `mmsi`    |
| `feature` | `featureId`, `coord`     | `featuresStore.features` | `properties.name` or `#id` |
| `point`   | `coord`                  | — (static)               | `lat, lon` (4 dp)          |

`coord` is always stored as the last-resolved `[lng, lat]`. Feature endpoints use the same bbox-midpoint logic used by assistant's `resolveCenter` (shapes with `properties.center` use that; boxes use SW/NE midpoint; other geometries use `geometryBounds` midpoint). This deliberately uses the bbox midpoint rather than geometric centroid — the math matches what users see selected in `AttributesPanel` and what other tools (CoT proximity, AIS proximity) already report.

## Reactivity

`useMapBloodhound` installs three Vue watchers — one each on `tracksStore.tracks`, `aisStore.vessels`, `featuresStore.features`. Any one firing triggers `reresolveAll()`, which:

1. Walks every committed line.
2. If either endpoint's anchor is gone — deleted feature, removed or stale-pruned CoT track, aged-out AIS vessel — the whole line is dropped. Mirrors the perimeter rule. Hidden anchors (track-list eye toggle) are still in their store and don't count as "gone" — visibility is separate from deletion.
3. Otherwise re-resolves each endpoint's `coord`; if it moved, rewrites the line on the map and updates both endpoint dots + the midpoint label.

The watchers are lazy — they start only after the first line is committed and stop when the last line is removed, so mounting the view doesn't pay for them.

## Selection flow

The click handler routes by topmost layer hit:

| Layer                                                     | Endpoint kind                              |
|-----------------------------------------------------------|--------------------------------------------|
| `cot-tracks-points`, `cot-tracks-symbols`                 | `{ kind: 'cot', uid, coord }`              |
| `ais-vessels-points`, `ais-vessels-arrows`                | `{ kind: 'ais', mmsi, coord }`             |
| `manual-tracks-points`, `manual-tracks-symbols`, `draw-features-points`, `draw-features-line`, `draw-features-fill`, `draw-image-bounds-fill`, `route-line`, `route-dot` | `{ kind: 'feature', featureId, coord }` (centroid, not click coord) |
| Empty map space                                           | `{ kind: 'point', coord }` (anchored at the click lng/lat) |

For feature-backed layers, the endpoint tracks the **feature**, not the pixel the user clicked — so dragging a box to a new location moves the line with it, regardless of which corner the user originally clicked.

Empty-space clicks produce a static `point` endpoint — useful for measuring to/from an arbitrary location (a reported position, a waypoint, a terrain feature). The cursor stays `crosshair` for the entire selection so every pixel is reachable.

### Coexistence with the click dispatcher

The composable installs its own raw `map.on('click', …)` handler during selection — it does **not** flow through `useClickDispatcher`. The dispatcher still fires in parallel on every click and would otherwise trigger the clicked entity's default action (open info card, select shape, open route panel) on top of the endpoint capture. Every dispatcher-registered composable must therefore include `bloodhounding` in its `suppress()` callback:

- `useMapAis`, `useMapTracks`, `useMapManualTracks` — receive the shared `suppressEntityClicks` computed from `MapView.vue` (`bloodhounding || routing || placing`).
- `useMapDraw`, `useMapRoute` — receive `bloodhounding` directly as a `suppress` ref; it's OR'd into their existing mode-specific suppress conditions.

Bloodhound's own click handler, registered separately on the map when selection starts, still receives the click and captures the endpoint against its `SNAP_LAYERS` list. Anyone adding a new clickable entity composable must take the same suppress ref and gate its dispatcher action the same way, and must also add its clickable layer ids to `SNAP_LAYERS` — otherwise the new entity won't be reachable as a bloodhound endpoint, or bloodhound selection will "double-fire" on it.

## Programmatic API

`useMapBloodhound(getMap)` returns:

```js
{
  bloodhounding,       // Ref<boolean> — panel-exposed "selecting" state
  bloodhounds,         // ComputedRef<BloodhoundSummary[]>
  toggleSelecting,     // enter / exit click-to-place mode
  addBloodhound(epA, epB) → id | null,  // commit a line from typed endpoints
  removeBloodhound(id) → boolean,
  clearAll()
}
```

`BloodhoundSummary` is:
```js
{
  id,
  epA: { kind, coord, uid? | mmsi? | featureId?, label },
  epB: { /* same */ },
  distanceMeters
}
```

The composable instance is provided under the `'bloodhoundApi'` inject key from `MapView.vue`. `BloodhoundPanel.vue` and any future consumer injects it rather than instantiating the composable again.

## Assistant tools

Registered from `src/services/assistant/tools/bloodhound.js`. Each endpoint accepts **exactly one** of four input fields per side; the handler rejects combinations.

| Tool | Shape | Notes |
|------|-------|-------|
| `bloodhound_list`   | — | Returns `[{id, from, to, distanceMeters}]` with each endpoint's kind, id fields, coord, and human label. |
| `bloodhound_add`    | `from{FeatureId|TrackUid|VesselMmsi|Coordinate}`, `to{...}` | Resolves each endpoint against the live stores (returns error if the referenced source doesn't exist). |
| `bloodhound_remove` | `id` | |
| `bloodhound_clear`  | — | |

### Named-endpoint resolution

An endpoint can live in one of three stores (CoT tracks, AIS vessels, mission features), and the agent has no way to know from a name alone which one owns it. Early versions of the bundle let the agent call `map_list_features` / `ais_list_vessels` one-at-a-time and guess — which failed loudly when a CoT track name (e.g. "USV-Alpha") got confused with an unrelated mission-feature id.

The canonical resolver is `map_find_entity(name)` (in `tools/map.js`), which searches all three stores in one call and returns each hit with a typed `kind` field. The `bloodhound_add` description directs the agent to call `map_find_entity` first for any named endpoint, then translate `kind` → the matching id field (`cot`→`trackUid`, `ais`→`vesselMmsi`, `feature`→`featureId`). This removes the store-guessing step from the tool chain.

## Files

| File | Role |
|------|------|
| `src/composables/useMapBloodhound.js`                | Composable — state machine, watchers, map source/layer, programmatic API. |
| `src/components/BloodhoundPanel.vue`                 | Draggable side panel — add, list, remove, clear. |
| `src/services/assistant/tools/bloodhound.js`         | Assistant bundle — 4 tools, endpoint resolver. |
| `src/views/MapView.vue`                              | Instantiates the composable, provides `bloodhoundApi`, mounts the panel, registers the assistant bundle. |
| `src/components/MapToolbar.vue`                      | `bloodhoundPanelOpen` prop + `toggle-bloodhound` event (icon `mdi-map-marker-distance`, tooltip "Bloodhound"). |

## Out of scope (v1)

- Persisting bloodhounds across app restarts — lines are ephemeral, matching the pre-existing range behaviour.
- Per-line colour / style overrides.
- Arbitrary-shape endpoints (e.g., "closest point on this polygon" rather than its centroid).
