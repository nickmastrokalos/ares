# Roadmap — Assistant-authored telemetry chart cards

> **Status: not built.** This document describes a proposed future
> feature and the gaps it would close. It does *not* describe the
> current state of any code in `main` / `development`. Use it as
> a starting point when picking the work up later.

## The question this answers

When Ares starts logging telemetry from network devices (Starlink
terminals, radios, autopilots, etc.) into the database, can the AI
assistant create scene **cards** with custom data on demand? The
canonical example we're scoping against:

> "create a card that charts all of the Starlink terminals' GPS
> satellite count for the last 24 hours"

**Yes — most of the infrastructure is already in place.** The
remaining work is well-scoped and listed below.

## What we already have

- **Scenes + cards persistence.** `src/stores/scenes.js` plus the
  `scenes` SQLite table at `src-tauri/src/migrations.rs:65-82`
  store cards as a JSON array in a `TEXT` column. Each card has
  the shape:
  ```js
  { id, typeId, layout: { x, y, w, h }, controls, source }
  ```
  Save is debounced (~300 ms); load deserialises back into the
  store and the scene re-mounts its cards.
- **Card host pipeline.** `src/components/scenes/SceneCardHost.vue`
  resolves a card's `typeId` against a static `CARD_COMPONENTS`
  map and mounts the chosen Vue component. Self-managed cards
  (currently only `scene-notes`) get `controls` and emit
  `update-controls` for the host to persist; data-driven cards
  *also* get `data` + `meta` returned from a `subscribeQuery`
  call.
- **Data fetch pipeline.** Tauri command `scene_data_fetch_batch`
  in `src-tauri/src/scenes/commands.rs` accepts
  `{ key, card_type_id, source, controls }` and returns
  `{ data, row_count, query_ms, … }`. The frontend store
  `src/stores/sceneData.js` polls every 30 s. Today the per-type
  resolvers in `query_registry.rs` are stubs that return empty
  data — the wiring is in place, the resolvers aren't.
- **Assistant create-tool patterns.** The assistant can already
  create scenes (`scenes_create_scene`), annotations
  (`annotation_add` and friends), and 30+ map features (`map.js`
  tools). Adding a `scenes_create_card` slots into the same
  shape.

## The gap

1. **Telemetry storage.** No `telemetry` (or equivalent) table
   today. Existing migrations cover discrete entities (missions,
   features, scenes, bullseyes, annotations) — not time-series
   rows. Proposed schema:
   ```sql
   CREATE TABLE telemetry (
     id          INTEGER PRIMARY KEY,
     device_id   TEXT    NOT NULL,
     device_kind TEXT    NOT NULL,       -- 'starlink' | 'armada' | 'persistent-systems' | …
     metric      TEXT    NOT NULL,       -- 'gps_sats_visible' | 'rsrp' | 'sog_kts' | …
     value       REAL    NOT NULL,
     ts          INTEGER NOT NULL,        -- ms since epoch
     meta        TEXT                    -- optional JSON for non-numeric extras
   );
   CREATE INDEX telemetry_kind_metric_ts ON telemetry (device_kind, metric, ts);
   CREATE INDEX telemetry_device_ts      ON telemetry (device_id, ts);
   ```
2. **Chart card type.** `src/stores/cardTypes.js` only has
   `scene-notes`. Add `time-series-chart` with a Vue component
   that consumes the standard `{ data, meta }` flow.
3. **Chart library.** `package.json` has none. Pick one — TBD
   between `chart.js` + `vue-chartjs` (smaller, simpler, what
   most dashboards reach for) and ECharts (richer interactions,
   bigger). Decision criteria: bundle size, Vue-native fit,
   crosshair / multi-series support, accessibility.
4. **Constrained query DSL for `source`.** Today `source` is an
   unvalidated string passthrough. For the chart card define a
   JSON shape, e.g.:
   ```js
   source: {
     table:   'telemetry',
     filter:  { device_kind: 'starlink', metric: 'gps_sats_visible' },
     range:   '24h',
     groupBy: 'device_id'
   }
   ```
   And a resolver in `src-tauri/src/scenes/query_registry.rs`
   that compiles the shape into a parameterised SQL query —
   keeps the assistant out of arbitrary-SQL territory and gives
   us a single place to add new operators.
5. **Assistant tools.**
   - `scenes_list_card_types` — returns the registry plus, for
     `time-series-chart`, the list of `(device_kind, metric)`
     pairs the resolver currently knows how to query, so the
     model has a closed vocabulary to map prompts onto.
   - `scenes_create_card({ sceneId, cardTypeId, layout, controls, source })`
     — same shape as `scenes_create_scene`. Validates `source`
     before persisting.
6. **Plugin write hook.** A thin `api.telemetry.write(deviceId,
   metric, value, meta?)` wrapper around the new Rust command so
   plugins (Armada today; future Starlink plugin) can feed the
   table without touching SQL directly. Batched writes; 1 Hz × N
   devices × M metrics is fine, but a transaction wrapper keeps
   the write rate well under SQLite's natural ceiling.
7. **Plugin → card-type extension API (optional).**
   `usePluginRegistry.js` has no `api.cards.registerType` today.
   Two paths:
   - **(a)** Keep card types host-side and have plugins only
     write to the standard telemetry table. The built-in chart
     card reads everything. Sufficient for the canonical
     prompt; smallest API surface.
   - **(b)** Add `api.cards.registerType` so plugins can ship
     custom card components (e.g. a Starlink-specific status
     panel that isn't a generic chart). Defers cleanly — start
     with (a), add (b) only when a plugin actually needs it.
   - **Recommendation: (a) for v1.**

## End-to-end flow

User says: *"create a card that charts all of the Starlink
terminals' GPS satellite count for the last 24 hours"*.

1. Assistant calls `scenes_list_card_types` → sees
   `time-series-chart` advertised with the metric vocabulary
   the resolver currently understands.
2. Assistant maps the prompt to:
   ```js
   {
     cardTypeId: 'time-series-chart',
     source: {
       table:   'telemetry',
       filter:  { device_kind: 'starlink', metric: 'gps_sats_visible' },
       range:   '24h',
       groupBy: 'device_id'
     },
     controls: { title: 'Starlink GPS satellites — last 24 h' },
     layout:   { x: 0, y: 0, w: 6, h: 4 }
   }
   ```
3. Assistant calls `scenes_create_card` with the active scene
   id (host already tracks active scene).
4. Card appears, fetches via `scene_data_fetch_batch`, refreshes
   every 30 s. Scene save debounces; reloading the scene later
   restores the card and re-fetches with current data.

## Phased implementation order

So a future implementer doesn't have to re-plan from scratch:

| Phase | Work | Why this first |
|---|---|---|
| 1 | `telemetry` migration + `telemetry_insert` Rust command + `api.telemetry.write` plugin wrapper. | Cards can't render data that doesn't exist yet. |
| 2 | `time-series-chart` card type, chart library, query resolver in `query_registry.rs`. | One card type, one resolver — minimum viable charting. |
| 3 | `scenes_list_card_types` + `scenes_create_card` assistant tools. | Now the assistant can author cards. |
| 4 | First plugin writer. Armada is the natural pick — already has rich per-craft state (sog, ecm_volts, num_sats, etc.) we can pipe into `telemetry`. Same hook unlocks a future Starlink plugin. | Validates the loop end-to-end against real data. |
| 5 (optional) | `api.cards.registerType` for plugin-supplied card components. | Defer until a plugin actually wants a non-chart card. |

## Files anticipated to change

| Path | Phase | Change |
|---|---|---|
| `src-tauri/migrations/…` (new) | 1 | `telemetry` table + indexes |
| `src-tauri/src/lib.rs` | 1 | Register `telemetry_insert` command |
| `src/composables/usePluginRegistry.js` | 1 | `api.telemetry.write(...)` wrapper |
| `src-tauri/src/scenes/query_registry.rs` | 2 | `time_series_chart` resolver |
| `src/stores/cardTypes.js` | 2 | Add `time-series-chart` definition |
| `src/components/scenes/cards/TimeSeriesChartCard.vue` (new) | 2 | Renderer; consumes `data`, plots via chosen lib |
| `package.json` | 2 | + chart library dep |
| `src/services/assistant/tools/scenes.js` | 3 | `scenes_list_card_types`, `scenes_create_card` |

## Risks / open questions

- **Write rate.** Armada at ~1 Hz × 50 craft × 10 metrics is
  ~500 inserts/s when fully loaded. Starlink polls maybe every
  5–10 s. SQLite handles this fine with a transaction batcher;
  worth instrumenting before declaring done.
- **Retention.** A `telemetry` table grows fast. Decide between
  a fixed-window trim job (e.g. 30 days) or operator-driven
  export + purge. Address this in v1 — once the table becomes
  an archaeological dig, retroactively trimming is painful.
- **Source-DSL expressiveness vs. surface area.** Operators will
  eventually want band-pass filters, percentiles, multi-series
  math. Start with the smallest DSL that answers the canonical
  prompt; expand only when the assistant repeatedly hits the
  wall.
- **Assistant freedom over `source`.** Validate the shape on the
  Rust side and reject anything the resolver doesn't understand
  — otherwise a hallucinated `source` from the model corrupts a
  scene's persisted JSON.
- **Chart library lock-in.** Whichever we pick, the
  `TimeSeriesChartCard` component should be the only place that
  imports it, so a future swap touches one file.

## Out of scope for the v1 described here

- **Editor UI for cards.** The assistant-authored flow doesn't
  require it; an "edit card source" panel can ship later once we
  know what knobs operators actually want.
- **Cross-card aggregation / fleet dashboards beyond one scene.**
  Each card lives in one scene; no fleet-wide dashboards yet.
- **Streaming / WebSocket-style updates.** The 30 s polling
  pipeline already handles "last 24 h" charts comfortably;
  sub-second refresh is its own design.
- **Schema-on-read for arbitrary telemetry shapes.** v1 forces
  every metric into `(device_kind, metric, value REAL)`. Strings,
  vectors, JSON blobs need either separate tables or schema
  expansion the chart card ignores.

## Cross-references

- Scenes store: `src/stores/scenes.js`
- Scenes migration: `src-tauri/src/migrations.rs:65-82`
- Card host: `src/components/scenes/SceneCardHost.vue`,
  `src/components/scenes/SceneCard.vue`
- Card type registry: `src/stores/cardTypes.js`
- Data fetch frontend: `src/stores/sceneData.js`
- Data fetch backend: `src-tauri/src/scenes/commands.rs`,
  `src-tauri/src/scenes/query_registry.rs`
- Assistant scene tools: `src/services/assistant/tools/scenes.js`
- Plugin host API: `src/composables/usePluginRegistry.js`
- Plugin authoring guide: `docs/plugins.md`
