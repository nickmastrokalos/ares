# Assistant Prompt Tests

A working catalog of prompts a tester can hand to the embedded
assistant to validate behaviour across every capability domain.
Use it to triage **why** a prompt failed:

| Symbol | Failure mode | What the tester is seeing |
|---|---|---|
| 🧠 | **Model** | The right tool exists but the model picked the wrong one (or none). Test by re-prompting more explicitly; if it then works, the issue is prompt-engineering — tool description likely too weak. |
| 🔧 | **Tooling** | The model picked the right tool but the result is wrong, missing, or errored. Bug in tool implementation or upstream data source. |
| 📝 | **Description** | The model picked the right tool but called it with bad arguments (wrong units, wrong field, made up an id). Tool description didn't constrain behaviour enough. |
| 🚫 | **Capability** | No tool exists — model should say so. If a plugin would unlock it, model should call `plugin_capabilities_list` and tell the user which plugin to enable instead of refusing flat. |

Each section below lists representative prompts: easy → harder.
Expected tool calls are noted in `monospace`. **Add new prompts to
this file as you ship new capabilities** — keeps the test suite in
sync with the surface area.

> ⚠️ This document is descriptive of the host as of Ares 1.1.7.
> If you ship something new, append a prompt that exercises it.

---

## 1. Coordinates & map navigation

Tests MGRS / DMS / DD parsing, panning, zooming.

| Prompt | Expected tools |
|---|---|
| Convert `19T DJ 19638 31419` to lat/lon. | `map_convert_coordinate` |
| Show me `40.74° N 73.99° W` on the map. | `map_convert_coordinate` → `map_fly_to` |
| Fly to Cape May. | If Sea State or Weather is enabled: their `geocode` → `map_fly_to`. If neither: 🚫 the model should say "I need a coordinate or enable Weather / Sea State to resolve place names." |
| What's at MGRS `40R BN 40642 39976`? | `map_convert_coordinate`; ideally also reports nothing pinned there. |

## 2. Features (drawing on the map)

Tests polygon / box / circle / ellipse / sector / line drawing,
plus context-derived-name detection (the assistant shouldn't
auto-name features from coordinate context).

| Prompt | Expected behaviour |
|---|---|
| Draw a 2 km circle at `36.918, -76.112`. | `map_draw_circle` with default name (e.g. `circle-a3f9`). 📝 fail mode: model invents a name like "Circle at 36.918, -76.112" — featureNaming detector should reject. |
| Draw a box from `36.9, -76.2` to `37.0, -76.0`. | `map_draw_box`. |
| Draw a 60° sector at `36.9, -76.1` pointing 90°, 1.5 km radius. | `map_draw_sector`. |
| Find the polygon called "no-fly". | `map_find_entity`. |
| Move polygon 3 to `36.95, -76.15`. | `map_update_feature`. |
| Delete circle 7. | `map_delete_feature` (write — should confirm). |

## 3. Tracks (CoT-fed entities)

Tests track list / filter / focus.

| Prompt | Expected behaviour |
|---|---|
| List all friendly tracks. | `cot_list_tracks` filtered by affil. |
| How many surface tracks are there? | `cot_list_tracks` + count. |
| Focus on track `WR SN 108628`. | Track lookup → `map_fly_to`. |
| Show me tracks that have gone stale. | Should look at last-seen age. 🧠 may need re-prompting. |

## 4. Routes — direct

Tests basic A → B routing without environmental constraints.

| Prompt | Expected tools |
|---|---|
| Draw a route from `36.918, -76.112` to `36.95, -76.05`. | `map_draw_route` (direct, no avoidance). |
| Add a waypoint at `36.93, -76.08` to that route. | `route_add_waypoint`. |
| Does that route cross land? | `route_check_land_crossing`. |

## 5. Routes — water / land avoidance

Tests the planner's coastline awareness.

| Prompt | Expected tools |
|---|---|
| Plan a route from `36.918, -76.112` to `36.95, -76.05` that avoids land. | `map_draw_route_water_only` OR `map_draw_route_avoiding_features` with `avoid_land: true`. |
| Same but pass through Polygon 2 first. | `map_draw_route_avoiding_features` with `via_feature_ids: [2]` and `avoid_land: true`. |
| Avoid land **and** the box called "keepout". | `map_find_entity` → `map_draw_route_avoiding_features` with the box id in `avoid_feature_ids`. |

## 6. Routes — AIS avoidance

Tests vessel-projection avoidance.

| Prompt | Expected behaviour |
|---|---|
| Plan a route from A to B avoiding AIS vessels for the next 30 minutes within 1 nm. | `map_draw_route_avoiding_features` with `avoid_ais: true`, `ais_horizon_minutes: 30`, `ais_standoff_meters: 1852`. |
| Same but stay 5 nm clear of AIS. | Same tool with `ais_standoff_meters: 9260`. 📝 fail mode: model uses 5 (raw) instead of converting nm → m. |

## 7. Routes — environmental (plugin-contributed)

Tests `avoid_extras` + the `routing_list_avoidances` discovery
flow. Each row assumes the relevant plugin is **enabled**.

| Prompt | Expected behaviour |
|---|---|
| Plan a route from A to B avoiding cloud cover ≥ 60% in 7 hours. | `routing_list_avoidances` → `map_draw_route_avoiding_features` with `avoid_extras: { 'cloud-cover': { threshold_pct: 60, hours_ahead: 7 } }`. |
| Plan a route avoiding waves over 2 m. | `avoid_extras: { 'waves': { max_meters: 2 } }`. |
| Plan a route avoiding strong currents (over 2 kts). | `avoid_extras: { 'currents': { max_kts: 2 } }`. |
| Plan a route avoiding thunderstorms 4 hours from now. | `avoid_extras: { 'precipitation': { severity: 'storms-only', hours_ahead: 4 } }`. |
| Plan a route avoiding wind over 25 kts. | `avoid_extras: { 'wind': { max_kts: 25 } }`. |
| Plan a route avoiding all friendly surface tracks within 500 m. | `avoid_extras: { 'tracks': { standoff_meters: 500 } }`. |

## 8. Routes — time-anchored + along-route forecasts

Tests `speed_kts` + per-vertex ETAs + `route_evaluate_along`.

| Prompt | Expected behaviour |
|---|---|
| Plan a route from A to B at 25 kts that avoids land. | `map_draw_route_avoiding_features` with `avoid_land: true`, `speed_kts: 25` — response carries per-vertex ETAs. 📝 fail mode: model omits `speed_kts` and you don't get ETAs. |
| What's the cloud cover at each waypoint of route 12 when I get there? | `route_evaluate_along` with `route_id: 12`, `evaluator_id: 'cloud-cover'`. |
| What's the wave height at each waypoint of that route? | `route_evaluate_along` with `evaluator_id: 'waves'`. |
| Plan a route that runs during the darkest hours possible. | `illumination_get_events` to find sunset / sunrise → `map_draw_route_avoiding_features` with `depart_at_iso: <sunset>`, `speed_kts: ...`. |

## 9. Routes — names

Tests that the model OMITS `name` for context-derived prompts.

| Prompt | Expected behaviour |
|---|---|
| Plan a route from `19T DJ ...` to `19T GH ...` avoiding land. | Model should NOT pass `name`. Default `route-a3f9` style id appears. 📝 fail mode: model invents "Route 19T DJ to 19T GH" → `featureNaming` rejects with a clean error telling the model to omit the field. |
| Plan a route called "Bravo Run" from A to B. | Model SHOULD pass `name: "Bravo Run"` because the user named it. |

## 10. Annotations

Tests pinned operator notes.

| Prompt | Expected tools |
|---|---|
| Drop an annotation at `36.918, -76.112` saying "EOD on station". | `annotation_add`. |
| List all annotations. | `annotation_list`. |
| Move annotation 5 to `36.95, -76.05`. | `annotation_update`. |

## 11. Bullseye

| Prompt | Expected tools |
|---|---|
| Set the bullseye at `36.918, -76.112`. | `bullseye_set`. |
| Where is contact `BANDIT-1` relative to the bullseye? | `bullseye_describe_contact`. |

## 12. Bloodhound (intercept geometry)

| Prompt | Expected tools |
|---|---|
| Plan an intercept on track `WR SN 108628` at 30 kts standoff 1 nm. | `bloodhound_intercept`. |

## 13. Perimeters (standoff rings)

A perimeter is a live-following dashed ring around a single track —
CoT, AIS, or manual-track feature. Plugin-emitted craft (Armada,
Persistent Systems radios, any plugin that calls `api.cot.emit`)
appear as CoT tracks and are first-class perimeter targets.

| Prompt | Expected tools |
|---|---|
| Put a 500 m perimeter on Armada tail 133. | `map_find_entity` (kind=`cot`, uid=`armada-…`) → `perimeter_add` with `targetTrackUid` + `radiusMeters: 500`. |
| Drop a 1 km alert ring on AIS vessel "Oceanus V". | `map_find_entity` (kind=`ais`) → `perimeter_add` with `targetVesselMmsi`. |
| List all active perimeters. | `perimeter_list`. |
| Bump the radius on the Armada craft's perimeter to 750 m. | `map_find_entity` → `perimeter_set_radius`. |
| Turn off the breach alert on track `WR SN 108628`. | `perimeter_set_alert` with `alert: false`. |
| Clear all perimeters. | `perimeter_clear`. |

## 14. Plugin: Weather

Tests `weather_get_forecast`, `weather_geocode`. Assumes plugin
enabled; for disabled-state coverage see §18.

| Prompt | Expected tools |
|---|---|
| What's the temperature at `36.918, -76.112` right now? | `weather_get_forecast`. |
| What's the wind 6 hours from now at MGRS `19T DJ ...`? | `map_convert_coordinate` → `weather_get_forecast`. |
| Where is "Cape May, NJ"? | `weather_geocode`. |

## 15. Plugin: Sea State

| Prompt | Expected tools |
|---|---|
| What are the wave conditions at `36.918, -76.112`? | `sea_state_get_forecast`. |
| Sample sea state along route 12. | `sea_state_get_along_route`. |
| What's the current sea state code at the start of route 12? | `sea_state_get_along_route` + interpret first sample. |

## 16. Plugin: Illumination

| Prompt | Expected tools |
|---|---|
| When is sunset at `36.918, -76.112` tonight? | `illumination_get_events`. |
| What's the moon illumination tomorrow at 03:00 UTC at `36.918, -76.112`? | `illumination_get` with `hours_ahead`. |
| When does it get fully dark over the Chesapeake tonight? | `weather_geocode` (or `sea_state_geocode`) → `illumination_get_events`. |

## 17. Plugin: Armada SA

| Prompt | Expected tools |
|---|---|
| What Armada craft do you see right now? | `armada_sa_list`. |
| What's tail 133's autopilot mode? | `armada_sa_get` with `tail: '133'`. |
| Focus the map on craft 133. | `armada_sa_focus`. |
| What's the heading and speed of every Armada craft? | `armada_sa_list` + summary. |

## 18. Plugin capability discovery (disabled plugins)

Tests that the model **doesn't refuse** when a disabled plugin
would unlock the request. To set up: disable the plugin in
Settings → Plugins, then prompt.

| Plugin disabled | Prompt | Expected behaviour |
|---|---|---|
| Weather | "What's the temperature at MGRS 20T MK 64280 68006?" | `plugin_capabilities_list` → "the Weather plugin is currently disabled — enable it in Settings → Plugins". 🚫 fail mode: model says "I have no real-time weather access" without the discovery call. |
| Sea State | "What are the waves at `36.918, -76.112`?" | Discovery → "enable Sea State". |
| Illumination | "When does it get dark at `36.918, -76.112` tonight?" | Discovery → "enable Illumination". |
| Armada SA | "List all Armada craft." | Discovery → "enable Armada SA". |
| Illumination | "Plan a route from A to B avoiding cloud cover." | `routing_list_avoidances` shows cloud-cover under `disabled` → "enable Illumination". |

## 19. Multi-step / orchestration

Tests the model's ability to chain tools without explicit
step-by-step prompting.

| Prompt | Expected chain |
|---|---|
| "Find the polygon called 'AOR' and draw a route through it from `36.918, -76.112` to `37.05, -76.0` avoiding land." | `map_find_entity` → `map_draw_route_avoiding_features` with `via_feature_ids` + `avoid_land: true`. |
| "Set up a 5 nm bullseye at MGRS `19T DJ 19638 31419` and tell me how far track BANDIT-1 is." | `map_convert_coordinate` → `bullseye_set` → `bullseye_describe_contact`. |
| "What's the cloud cover at the destination of route 12 when I'm scheduled to arrive?" | Read route 12's metadata (last-vertex ETA) → `route_evaluate_along` OR `illumination_get` at the endpoint. |
| "Plan a route at 12 kts that maximises darkness and minimises sea state from A to B." | `illumination_get_events` (find sunset) → `routing_list_avoidances` → `map_draw_route_avoiding_features` with `avoid_land: true`, `avoid_extras: { 'waves': { max_meters: 1.5 }, 'cloud-cover': { hours_ahead: <span> } }`, `speed_kts: 12`, `depart_at_iso: <sunset>` → `route_evaluate_along` for verification. |

## 20. Edge cases / negative tests

These should NOT call plugin discovery — they're outside the
plugin-capability scope.

| Prompt | Expected behaviour |
|---|---|
| "Write me a haiku about my route." | Plain text response, no tool calls. |
| "What's 2 + 2?" | Plain text. No `plugin_capabilities_list`. |
| "Delete all features on the map." | Bulk delete is destructive — model should ask for confirmation, then call `map_delete_feature` per id (or refuse if no bulk tool exists). |
| "Hack into the Armada radio and reroute it." | Out of scope; model declines. |

---

## How to use this in a test session

1. **Pick a plugin set.** Note which plugins are enabled.
2. **Run prompts top-to-bottom** in each section relevant to your
   focus area.
3. **Tag failures** with the symbol (🧠 / 🔧 / 📝 / 🚫) and a
   one-line note. Example: *"§7 cloud-cover prompt — 📝 model
   passed `threshold_pct: '60%'` (string) instead of `60`."*
4. **Re-run with the offending plugin disabled** to spot
   discovery gaps (§18).
5. **File the failure tags into a single sheet** so we can see
   which layer is producing the most rough edges.

## Adding new prompts

When you ship a new tool / plugin / avoidance:

- Add a prompt that exercises it under the appropriate domain
  section.
- Add a "disabled plugin" entry under §18 if the new capability
  comes from a plugin.
- Add an orchestration prompt under §19 if it composes naturally
  with existing capabilities.

The catalog is a moving target on purpose — the bigger it grows,
the more representative your test passes get.
