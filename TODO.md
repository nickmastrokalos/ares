# TODO

Running backlog for Ares. Not a strict roadmap — reorder as priorities shift. Items are grouped by theme; notes on scope, prior context, or design seeds live under each item.

## Backlog — feature ideas

- **Track prediction ghosts** — project each CoT / AIS / manual track forward by its current course + speed and render a semi-transparent "ghost" of where it'll be in N seconds. Per-track toggle, global time horizon. Related to `useMapGhosts` (existing, different feature).
- **Bullseye / range rings** — an operator-placed reference point with concentric range rings + cardinal bearings. Reports of other tracks are given as "bullseye 090/10" style. Classic tactical aid.
- **Map annotations / stickies** — freeform text notes pinned to a map coord. Colour-coded, draggable, persisted per mission. Distinct from manual tracks (no affiliation, no kinematics) and from draw shapes (no geometry).
- **CoT track history trails** — render the recent path of each live CoT track as a fading polyline. **Design note** (already in memory): trail length scales with the track's current speed — faster tracks get longer trails so the visual span of the trail represents roughly the same time window.
- **Map snapshot / brief export** — render the current map state (or a selected bbox) to PNG / PDF with a legend strip — for briefing slides, after-action reports. Should include visible overlays, selected intercepts/perimeters, timestamp.
- **Replay / time scrub** — record incoming CoT + AIS positions over time and let the operator scrub a timeline to replay movement. Separate store for historical positions; draw layer in a "replay" styling.

## Follow-ups from recent work

- **More alert-chip sources** — the `useMapAlerts` store is generic; the only source wired today is perimeter breach. Natural next hooks:
  - Intercept TTI crossing a threshold (e.g., "TTI < 60s" as a warning).
  - Bloodhound proximity (range line drops below a user-set distance).
- **Panel async loading** — deferred from the bundle-size pass. `BloodhoundPanel`, `PerimeterPanel`, `CallInterceptorPanel`, `LayersPanel`, `TrackListPanel`, etc. could become `defineAsyncComponent` instances so they only load when the operator opens them. Trims the `MapView` chunk; each panel is small but they add up.

## Intercept v1 — explicitly out-of-scope follow-ups

From `docs/intercept.md`, marked as deferred for v1:

- **Assistant tools for intercept** — bundle modelled on `perimeterTools` (`perimeter_list`, `perimeter_add`, etc.). Would let the assistant add / remove / describe intercepts.
- **Persistence across app restarts** — intercepts are currently ephemeral, matching bloodhound / perimeter / range. If we persist any of them, do all of them together.
- **Kinematic envelope** — the solver assumes an instantaneous course change; no minimum turn radius or acceleration limit.
- **Multi-leg intercepts** — no waypoint support; the friendly flies a single straight leg to the aim point.
- **Affiliation filtering in intercept rosters** — the hostile dropdown currently lists every track regardless of colour code. Friendly is already filtered to `affil === 'f'`.

## Housekeeping

- **Branch hygiene** — working on `development`. If any of the items above grow into a substantial diff, cut a feature branch first per the repo workflow.
