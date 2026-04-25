# TODO

Running backlog for Ares. Not a strict roadmap — reorder as priorities shift. Items are grouped by theme; notes on scope, prior context, or design seeds live under each item.

## Backlog — feature ideas

- **Track prediction ghosts** — project each CoT / AIS / manual track forward by its current course + speed and render a semi-transparent "ghost" of where it'll be in N seconds. Per-track toggle, global time horizon. Related to `useMapGhosts` (existing, different feature).
- **CoT track history trails** — render the recent path of each live CoT track as a fading polyline. **Design note** (already in memory): trail length scales with the track's current speed — faster tracks get longer trails so the visual span of the trail represents roughly the same time window.
- **Replay / time scrub** — record incoming CoT + AIS positions over time and let the operator scrub a timeline to replay movement. Separate store for historical positions; draw layer in a "replay" styling.
- **Speed unit: m/s** — `formatSpeed` / `speedUnitLabel` in `src/services/geometry.js` currently support `metric` (km/h), `nautical` (kts), and `statute` (mph). Add `m/s` as a fourth option so the Settings dialog's speed unit can be set to raw SI, then thread it through everywhere `settingsStore.distanceUnits` flows into `formatSpeed` (track panels, AIS panel, CallInterceptorPanel, etc.). Note: today the speed unit is coupled to `distanceUnits` — splitting it into its own `speedUnits` setting is the cleaner shape if the user wants kts-for-speed with km-for-distance, etc.

## Follow-ups from recent work

- **More alert-chip sources** — the `useMapAlerts` store is generic; the only source wired today is perimeter breach. Natural next hooks:
  - Intercept TTI crossing a threshold (e.g., "TTI < 60s" as a warning).
  - Bloodhound proximity (range line drops below a user-set distance).
- **Panel async loading** — deferred from the bundle-size pass. `BloodhoundPanel`, `PerimeterPanel`, `CallInterceptorPanel`, `LayersPanel`, `TrackListPanel`, etc. could become `defineAsyncComponent` instances so they only load when the operator opens them. Trims the `MapView` chunk; each panel is small but they add up.

## Assistant coverage gaps

Map functionality the operator has in the UI but the assistant cannot drive. Each would be a small tool bundle modelled on the existing `perimeterTools` / `annotationTools` shape (`readonly` + confirm flow via `previewRender`). Grouped by likely impact.

- **Intercept tools** — listed separately below under "Intercept v1 follow-ups". Biggest gap: the assistant can set up a perimeter or a bloodhound but not an intercept. Model on `useMapIntercepts.interceptApi` (`addIntercept({ hostile, friendly, mode, offsetRange?, offsetBearing? })`, `removeIntercept(id)`, `setAimRingRadius(r)`, `clearAll()`). Tool surface: `intercept_list`, `intercept_add`, `intercept_remove`, `intercept_set_aim_radius`, `intercept_clear`.

- **CoT listener control + outbound send** — `cotTools` currently covers reads (`cot_list_tracks`, `cot_get_track`, `cot_tracks_near`) and `cot_remove_track` only. Missing:
  - Listener CRUD: `settingsStore.addCotListener / updateCotListener / removeCotListener / toggleCotListener` — no tool. The operator can't ask the agent to "start listening on UDP 4242" or "disable the VRS listener".
  - Outbound CoT send — no programmatic path at all today (the existing `scripts/cot-sender.mjs` is a dev script, not a service). Separate from the tools gap; needs a service layer first.

- **Scenes: update / delete / apply** — `scenesTools` covers `scenes_list` + `scenes_create_scene`. The store exposes `updateScene` (label / description / icon), `deleteScene`, and `saveSceneCards`; none are surfaced. "Load/apply a scene" has no semantics today either — if scenes are meant to be recallable, that's a store design decision before it's a tool.

- **Snapshot capture** — `useMapSnapshot.capture()` exists but has no tool. The agent can't be asked to "export a PNG brief of the current view". One tool, one call; write-op because it prompts the native save dialog.

- **Measure (multi-segment chain)** — `map_measure_distance` handles a single pair of coordinates. The interactive measure tool in `useMapMeasure` accumulates a polyline chain of clicks; no tool surface for "total the route through these five points" beyond what `map_draw_route` would achieve. Low priority — probably subsumed by `map_draw_route` + `route_get` for most use cases.

- **Alerts — programmatic read** — `useMapAlerts` aggregates perimeter breaches (and will pick up more sources). No tool to list active alerts, get a specific one, or acknowledge. Natural follow-up once more sources are wired per the "More alert-chip sources" item below.

- **Manual-track editing coverage** — `map_create_track` creates them; `map_update_track` / `map_move_feature` / `map_rename_feature` / `map_update_feature_color` / `map_delete_feature` cover the edit surface. No obvious gap, but worth re-verifying once affiliation-filter or entity-type changes land.

## Intercept v1 — explicitly out-of-scope follow-ups

From `docs/intercept.md`, marked as deferred for v1:

- **Assistant tools for intercept** — bundle modelled on `perimeterTools` (`perimeter_list`, `perimeter_add`, etc.). Would let the assistant add / remove / describe intercepts. Also cross-referenced under "Assistant coverage gaps" above — pick one place as the source of truth when this ships.
- **Persistence across app restarts** — intercepts are currently ephemeral, matching bloodhound / perimeter / range. If we persist any of them, do all of them together.
- **Kinematic envelope** — the solver assumes an instantaneous course change; no minimum turn radius or acceleration limit.
- **Multi-leg intercepts** — no waypoint support; the friendly flies a single straight leg to the aim point.
- **Affiliation filtering in intercept rosters** — the hostile dropdown currently lists every track regardless of colour code. Friendly is already filtered to `affil === 'f'`.

## Housekeeping

- **Branch hygiene** — working on `development`. If any of the items above grow into a substantial diff, cut a feature branch first per the repo workflow.
