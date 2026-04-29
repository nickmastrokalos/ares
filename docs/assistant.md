# Assistant

> In-app AI assistant — natural-language interface backed by a cloud LLM.

## Overview

The assistant exposes Ares's data and actions as tools to a cloud LLM (Anthropic Claude by default). The user types natural language; the model decides which tools to call; Ares executes them and returns results; the model synthesises a final answer. The loop repeats until the model produces a turn with no tool calls.

Examples:
- Map: *"draw a 500 m red circle at 34.05, -118.25"* → model calls `map_draw_circle` → Ares shows a confirm card → user confirms → circle is drawn.
- Scenes: *"create a scene called Ops Board"* → model calls `scenes_create_scene` → confirm → scene is added to the sidebar.

## Architecture

```
User input
    ↓
stores/assistant.js           (panel state, message log, send())
    ↓ invokes
services/assistant/turnRunner.js  (pure loop — chat + tool dispatch)
    ↓ invoke
src-tauri/src/assistant/commands.rs  (assistant_chat Tauri command)
    ↓ reqwest HTTPS
Anthropic API  (cloud LLM)
    ↑ response JSON (content blocks with text / tool_use)
    ↓
turnRunner resolves tool_use blocks via toolRegistry
    ├─ readonly → execute immediately, feed tool_result back to LLM
    └─ write   → stores/assistantConfirm.js queues the call;
                  AssistantConfirmCard lets the user confirm or cancel;
                  on confirm → execute + feed tool_result
                  on cancel  → feed "user declined" and continue
```

Split of concerns:
- `stores/assistant.js` — panel open/minimized/messages/contextLabel/send. Thin.
- `services/assistant/turnRunner.js` — the chat → dispatch loop. Pure; takes callbacks; no Vue/Pinia imports; testable in isolation.
- `stores/assistantConfirm.js` — pending-write queue plus the `Promise` resolvers that gate confirmations. UI components read this store directly.
- `services/assistant/toolBundles.js` — `buildMapToolBundles(deps)` aggregator. `MapView.vue` calls it once instead of hand-spreading every bundle.
- `services/assistant/entityResolution.js` — shared `resolveEndpoint` / `resolveTarget` / `featureCentroid` for tools that accept (featureId | trackUid | vesselMmsi | coordinate).

The Rust command is the only thing that touches the network. The API key travels from the settings store to the command invocation and is used only as an HTTP header — it is never logged.

## UI

- **`AppFooter.vue`** — thin fixed strip (28 px) on all non-home routes. Right side holds the assistant toggle button (`mdi-robot-outline` / `mdi-robot`). Left side is a reserved slot for future status indicators.
- **`AssistantPanel.vue`** — docked card anchored `bottom: 40px; right: 12px; width: 360px`. Styled identically to `RoutePanel.vue` (`rgba(surface, 0.97)`, surface-variant border, 4 px radius). Header: icon + per-route context label + minimize + close. Body: message log + input row. Panel is not draggable (v1).
- **`AssistantMessage.vue`** — renders one message. User messages: right-aligned rgba bubble. Assistant text: left-aligned plain text. Tool calls: inline monospace chips (`• map_draw_circle`).
- **`AssistantConfirmCard.vue`** — inline card for each pending write. Shows the tool name + `previewRender` output. Confirm / Cancel buttons.

The panel opens from the footer button and stays open across route changes. Closing it clears the conversation (v1 — no persistence across app restarts).

## Safety model

| Tool kind | Execution |
|-----------|-----------|
| `readonly: true` | Runs immediately when the model requests it. No user interaction needed. |
| `readonly: false` | Queued as a `pendingCall`. The UI renders an `AssistantConfirmCard`. The turn loop is suspended until the user clicks **Confirm** (executes the handler, feeds `tool_result`) or **Cancel** (feeds `"user declined"` tool_result; model continues gracefully). |

Multiple write tools in a single model turn each get their own confirm card and resolve in order.

## Tool registry

`src/services/assistant/toolRegistry.js` — a module-level `Map<token, ToolDef[]>` that supports per-route registration.

### `ToolDef` shape

```js
{
  name: String,            // snake_case, globally unique
  description: String,     // shown to the LLM in the tools parameter
  inputSchema: Object,     // JSON Schema for the tool's input (Anthropic format)
  handler: async (args) => any,  // called on execution; return value is stringified as tool_result
  readonly: Boolean,       // true → auto-execute; false → confirm card
  previewRender: (args) => String  // required for write tools; shown in confirm card body
}
```

### API

```js
import { register, unregister, list, getByName } from '@/services/assistant/toolRegistry'

const token = register(myToolDefs)  // returns a Symbol
unregister(token)                   // removes the bundle
list()                              // returns union of all registered defs (current route context)
getByName('map_draw_circle')        // lookup by name
```

## Per-route tool bundles

Each view registers its own tool bundle on mount and unregisters on unmount. The assistant sees only the tools relevant to the current context.

### `useAssistantTools(defsFactory, label)` composable

```js
// src/composables/useAssistantTools.js
import { useAssistantTools } from '@/composables/useAssistantTools'
import { mapTools } from '@/services/assistant/tools/map'

// Inside a <script setup> in a view:
const featuresStore = useFeaturesStore()
useAssistantTools(() => mapTools({ featuresStore }), 'Map assistant')
```

- `defsFactory` — called on mount; return an array of `ToolDef` objects.
- `label` — sets `assistantStore.contextLabel`, shown in the panel header.

### Adding a new tool bundle

1. Create `src/services/assistant/tools/{surface}.js` exporting a factory function.
2. Define your `ToolDef` array. For write tools, include `previewRender`.
3. Call `useAssistantTools(() => myTools({ ...deps }), 'My assistant')` in the view.

### Built-in bundles

All map-surface bundles register together from `MapView.vue`.

| File | Surface | Tools |
|------|---------|-------|
| `tools/map.js`    | MapView | Feature read/edit: `map_get_mission_info`, `map_list_features`, `map_find_entity` (cross-store name resolver — searches CoT tracks + AIS vessels + mission features in one call, returns typed `kind` so the caller picks the right id field), `map_get_feature`, `map_convert_coordinate`, `map_offset_coordinate`, `map_measure_distance`, `map_features_in_area` (point-in-polygon across both mission features AND live CoT tracks). Draw: `map_draw_point/line/polygon/circle/ellipse/sector/box/box_around_features/route`. Tracks: `map_create_track`, `map_update_track`. Edit: `map_rename_feature`, `map_update_feature_color`, `map_update_shape`, `map_move_feature`. Delete: `map_delete_feature`. Navigation: `map_fly_to_feature`, `map_fly_to`. Basemap: `map_list_basemaps`, `map_set_basemap`. |
| `tools/routes.js` | MapView | Route-specific: `route_list`, `route_get`, `route_add_waypoint`, `route_delete_waypoint`, `route_move_waypoint`, `route_set_remarks`. (Rename / color / delete go through `map_rename_feature`, `map_update_feature_color`, `map_delete_feature`.) |
| `tools/waterRouting.js` | MapView | Routing tools backed by the grid-A* + bitmap planner in `src/services/landRouting.js`. `route_check_land_crossing` (read) tests an existing route's polyline against bundled Natural Earth 10m coastlines (`src/assets/ne-land-10m.json`, ~10 MB, lazy-loaded on first use). When `coastlineHiResEnabled` is on (default), the planner additionally pulls per-bbox high-fidelity coastline ways from the public OSM Overpass API (`src/services/coastlinesOverpass.js`) and rasterises them alongside NE 10m so capes / narrow peninsulas / small islands NE 10m generalises away are still respected. Both tools accept `coastline_standoff_meters` so the operator can override the default 555 m buffer (e.g. "hug the coast" → tighter; "wider berth from land" → looser). `map_draw_route_water_only` (write) plans + draws a polyline that detours around land. `map_draw_route_avoiding_features` (write) is the multi-constraint route tool: stacks any combination of `avoid_feature_ids` (route does not enter these shapes), `via_feature_ids` (route passes through these shapes' centers in order), `avoid_land: true` (also stays off the coastline), and `avoid_ais: true` (every AIS vessel gets a circular keepout of radius `ais_standoff_meters` at its current position; moving vessels additionally get a swept corridor of the same half-width extending `ais_horizon_minutes` forward along COG). Each via shape contributes one intermediate waypoint at its center; legs are planned independently via `planRouteAvoidingObstacles` and concatenated. Planner internals: scanline rasterization + dilation into per-layer bitmaps, OR'd together when multiple obstacle types are stacked. A* on the combined bitmap, greedy line-of-sight smoothing against that bitmap (no length cap — the buffered LOS test is the safety mechanism). The AIS audit returned by `map_draw_route_avoiding_features` distinguishes vessels cleared vs. still crossed and reports per-blocker `closest_endpoint` + distance details + `ais_suggested_standoff_meters` so the assistant can suggest a concrete numeric retry rather than a vague "reduce standoff". |
| `tools/ais.js`    | MapView | Config: `ais_get_status`, `ais_set_enabled` (refuses when feed URL / API key unset), `ais_set_visible`, `ais_set_heading_arrows` (icon style — circle vs heading-rotated arrow), `ais_set_breadcrumbs` (toggles the short fixed-length heading tail; independent of the global CoT breadcrumb setting). Vessel queries: `ais_list_vessels` (optional name substring filter), `ais_vessels_near` (radius search around a feature or coordinate, sorted nearest-first). |
| `tools/adsb.js`   | MapView | Free key-less aircraft feed from airplanes.live. Config: `adsb_get_status`, `adsb_set_enabled` (no key gate — endpoint is unauthenticated), `adsb_set_visible`, `adsb_set_heading_arrows` (icon style — circle vs track-rotated arrow), `adsb_set_breadcrumbs` (toggles the short fixed-length heading tail; independent of the global CoT breadcrumb setting). Aircraft queries: `adsb_list_aircraft` (optional callsign-or-hex substring filter), `adsb_aircraft_near` (radius search around a feature or coordinate, sorted nearest-first). Returned shape includes `hex`, `callsign`, `registration`, `type`, `coordinate`, `altitudeFt` (0 for on-ground), `speedKnots`, `trackDeg`, `headingDeg`, `squawk`. Rate-limited to 1 req/sec server-side; the composable polls every 10 s. |
| `tools/cot.js`    | MapView | Live CoT tracks from listeners (distinct from manual tracks — keyed by string `uid`, not integer id): `cot_list_tracks` (affiliation + name filters), `cot_get_track`, `cot_tracks_near` (radius search), `cot_remove_track` (local cache only — listener may re-add). Listener config: `cot_list_listeners`, `cot_add_listener` (validates IP / port / protocol, opens socket via `start_listener` Tauri command), `cot_remove_listener` (stops socket then deletes config), `cot_set_listener_enabled` (toggles a listener on / off by name). |
| `tools/bloodhound.js` | MapView | Live-tracking range lines (a.k.a. bloodhounds): `bloodhound_list`, `bloodhound_add`, `bloodhound_remove`, `bloodhound_clear`. Each endpoint is a typed ref — `from/to FeatureId` (mission feature), `from/to TrackUid` (CoT), `from/to VesselMmsi` (AIS), or `from/to Coordinate`. Lines follow their endpoints as tracks / vessels / features move. Backed by `useMapBloodhound`; full docs in `/docs/bloodhound.md`. |
| `tools/ghosts.js` | MapView | Simulated motion along a route: `ghost_list`, `ghost_create`, `ghost_start`, `ghost_stop`, `ghost_reset`, `ghost_delete`, `ghost_rename`, `ghost_set_speed`, `ghost_set_waypoint`, `ghost_set_direction`. `ghost_create` refuses if no routes exist on the map. `ghost_set_waypoint` / `ghost_set_direction` refuse while the ghost is running and auto-clamp direction at SP/EP. Ghost configuration is persisted per mission to the SQLite `ghosts` table (migration v6); live position is not — every ghost reloads idle at its configured start waypoint. |
| `tools/scenes.js` | ScenesView, SceneEditorView | `scenes_list`, `scenes_create_scene` |
| `tools/snapshot.js` | MapView | `map_capture_snapshot` (write) — composites the current MapLibre canvas with the standard legend strip and writes it to the user's Desktop as `ares_screen_capture_<UTC ISO timestamp>.png`. No native save dialog: the confirm card is the user-approval gate. Optional `filename` overrides the default. Backed by `useMapSnapshot.capture({ destination: 'desktop' })`. The toolbar snapshot button still uses the dialog flow (`destination: 'dialog'`). |
| `tools/video.js` | MapView | `map_capture_video` (write) — composites the entire map container (WebGL canvas + HTML markers + every floating panel currently open) onto an offscreen canvas via `html2canvas-pro` each frame, streams that through `MediaRecorder` for `duration_seconds` (any integer 1–60), then writes the result to the user's Desktop as `ares_map_video_<UTC ISO timestamp>.<ext>`. Codec is selected at runtime (`MediaRecorder.isTypeSupported`) — typically WebM/VP9 on Chromium-backed webviews (WebView2), MP4/H.264 on WKWebView (macOS). Optional `filename` overrides the default. The toolbar's video button uses fixed durations (5/10/30/60); the agent path is free-form. Recording captures everything the snapshot tool captures, so HTML overlay text and panel chrome are now in the output. Backed by `useMapVideo.record({ destination: 'desktop' })`. |

## Configuration

Three keys in `useSettingsStore` (persisted via `tauri-plugin-store`):

| Key | Default | Purpose |
|-----|---------|---------|
| `assistantProvider` | `'anthropic'` | LLM provider |
| `assistantModel` | `'claude-sonnet-4-6'` | Model identifier sent to the API |
| `assistantApiKey` | `''` | User's personal API key |

**Key storage note:** `tauri-plugin-store` persists to a JSON file in the app data directory. The file is not encrypted. The API key is disclosed as such in the Settings UI caption.

Settings UI: **Settings → Assistant tab** (`mdi-robot-outline`). Provider dropdown, model text field, API key field with eye toggle.

## Turn loop (technical)

`src/services/assistant/turnRunner.js` exports `runTurnLoop({ provider, model, apiKey, system, getMessages, appendMessage, confirmWrite })`:

1. Builds `tools` array from `toolRegistry.list()` mapped to Anthropic's `{name, description, input_schema}` shape.
2. Serialises the conversation from `getMessages()` (user/assistant roles; tool_result turns use role `user` with `tool_result` content blocks — Anthropic format).
3. Calls `assistant_chat` via `client.chat(...)`.
4. Calls `appendMessage('assistant', blocks)`.
5. For each `tool_use` block in the response:
   - Looks up the `ToolDef` by name.
   - Readonly → `await toolDef.handler(args)` → stash result.
   - Write → `await confirmWrite(toolDef, block)` → the assistant store queues an entry in `assistantConfirm.pending`, awaits the user, then executes (or returns a cancel envelope).
6. Calls `appendMessage('user', toolResults)`.
7. If `response.stop_reason === 'tool_use'`, loops from step 1.
8. Otherwise, the loop exits — the final text is already appended in step 4.

Closing the assistant panel calls `assistantConfirm.clear()`, which rejects any outstanding resolvers so an in-flight write tool returns a cancel result rather than hanging.

## Out of scope (v1)

- OpenAI / multi-provider (stub in settings, `Err` from Rust command)
- Scene card-authoring tools (LLM composing `typeId` + `controls`)
- Real MCP server (stdio / SSE for external clients — the registry is MCP-schema-compatible, so this is a future promotion)
- Streaming responses
- Conversation persistence across app restarts
- Markdown rendering in messages
- Undo stack (writes require confirm instead)
- Keyring-based key storage
