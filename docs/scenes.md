# Scenes

> Source of truth for the Scenes dashboard engine in Ares.

## What is a scene?

A **scene** is a user-authored dashboard composed of draggable, resizable cards. Scenes are **global** — not scoped to any mission. A user creates a scene, adds cards to it, and arranges them on a grid canvas. Cards display typed data (from connectors wired in later phases) or self-managed content like freeform notes.

Scenes persist in the `scenes` SQLite table (migration v3 in `src-tauri/src/migrations.rs`).

### Scene schema

| Column       | Type    | Notes                                                                 |
|--------------|---------|-----------------------------------------------------------------------|
| `id`         | TEXT PK | UUID generated in the webview (`crypto.randomUUID()`).               |
| `label`      | TEXT    | Human-readable scene name.                                           |
| `description`| TEXT    | Optional description.                                                |
| `icon`       | TEXT    | MDI icon name (e.g. `mdi-view-dashboard-outline`).                   |
| `order_idx`  | INTEGER | Display order. Assigned at creation time; not drag-reorderable yet.  |
| `cards`      | TEXT    | JSON array of card objects (see Card schema below).                  |
| `created_at` | TEXT    | `datetime('now')` default.                                           |
| `updated_at` | TEXT    | Bumped on save.                                                      |

### Card schema (embedded in `scenes.cards` JSON)

Each element in the `cards` array is:

```json
{
  "id": "<uuid>",
  "typeId": "scene-notes",
  "source": null,
  "controls": { "text": "…" },
  "layout": { "x": 0, "y": 0, "w": 3, "h": 2 }
}
```

- `typeId` references an entry in the card registry (`src/stores/cardTypes.js`).
- `source` selects the data source (e.g. `"direct"` / `"enterprise"`). Null for self-managed cards.
- `controls` is a card-type-specific configuration object.
- `layout` uses fractional 12-column grid units.

**Why embed cards as JSON rather than a normalized table:** card `controls` are card-type-specific; normalizing would require a per-type table or an EAV blob. A single `cards` JSON column handles all card types uniformly and matches how Athena's proven approach worked at 35 card types.

## Card registry (`src/stores/cardTypes.js`)

The card registry is a static JS object exported from `cardTypes.js`. Each entry defines a card type:

| Field            | Type    | Notes |
|------------------|---------|-------|
| `id`             | string  | Unique key used in `card.typeId`. |
| `label`          | string  | Human-readable name. |
| `description`    | string  | Short description shown in the picker. |
| `icon`           | string  | MDI icon name. |
| `category`       | string  | Grouping (currently unused in UI). |
| `component`      | string  | Vue component name, resolved in `SceneCardHost.vue`. |
| `resizable`      | boolean | Whether to show resize handles. |
| `defaultWidth`   | number  | Default card width in grid columns. |
| `defaultHeight`  | number  | Default card height in grid rows. |
| `defaultControls`| object  | Initial controls value for new cards. |
| `selfManaged`    | boolean | If `true`, the card manages its own data (no `subscribeQuery`). |
| `sourceOptions`  | array   | Available source strings (empty for self-managed). |
| `defaultSource`  | string? | Source selected by default. |

**Adding a new card type (Phase 2+):**
1. Add an entry to `CARD_TYPES` in `src/stores/cardTypes.js`.
2. Create the Vue component in `src/components/scenes/cards/` and name it to match `component`.
3. Register it in the `CARD_COMPONENTS` map in `SceneCardHost.vue`.
4. If not `selfManaged`, add a resolver arm in `src-tauri/src/scenes/query_registry.rs`.

## sceneData subscription fabric (`src/stores/sceneData.js`)

Cards that need connector-sourced data use the sceneData subscription fabric rather than fetching data themselves. The fabric coalesces identical subscriptions, batches requests to Rust, and delivers push invalidations when connectors emit changes.

### API

```js
const sub = sceneDataStore.subscribeQuery({ cardTypeId, source, controls })
// sub.key    — the coalescing key for this subscription
// sub.unsubscribe() — decrement refcount; entry evicted by LRU when no subscribers remain

const entry = sceneDataStore.entries[sub.key]
// entry: { status: 'loading'|'ok'|'error', loading: bool, data, meta, error }
// meta: { asOfTs: number, rowCount: number, queryMs: number }
```

### Key algorithm

`buildSceneDataKey(cardTypeId, source, controls)` in `src/utils/sceneSerialization.js`:
```
"<cardTypeId>|<source>|<stableSerialize(controls)>"
```

Two subscriptions with identical `(cardTypeId, source, controls)` share the same entry — only one Rust fetch occurs.

### Lifecycle

- First subscriber for a key → entry created with `status: 'loading'`, fetch dispatched immediately.
- Subsequent subscribers for the same key → refcount incremented, no extra fetch.
- Last unsubscriber for a key → refcount drops to 0, subscription deleted. Entry stays cached until LRU evicts it.
- LRU: max 200 entries; oldest by `asOfTs` among unsubscribed entries evicted on each unsubscribe.
- Fallback poll every 30 seconds for subscribed keys (paused when tab is hidden).
- Push path: Rust connector emits `scene-data-invalidated` Tauri event with `string[]` of keys → only affected subscribed entries refetched.

### Rust side (`src-tauri/src/scenes/`)

- `commands.rs` — `#[tauri::command] scene_data_fetch_batch(reqs: Vec<QueryReq>) -> Vec<QueryResult>`. Delegates to the query registry.
- `query_registry.rs` — `resolve(card_type_id, source, controls) -> Result<QueryOutput>`. Phase 1: returns empty data for all types. Phase 2: add match arms per vendor.

Self-managed cards (e.g. `scene-notes`) set `selfManaged: true` in the registry and bypass `subscribeQuery` entirely — `SceneCardHost` short-circuits them.

## Canvas interaction model (`src/components/scenes/`)

### Grid

The canvas uses a **12-column fractional grid**. Card positions and sizes are stored in grid units (`{x, y, w, h}` all floats). The canvas converts them to absolute pixel positions on render using `unitWidth = (canvasWidth - totalGap) / cols`.

On `smAndDown` viewports (< 600px) the canvas switches to a 6-column layout automatically.

### Drag / resize

The canvas is a controlled component:
- `:cards` — the current cards array (immutable from inside the canvas).
- `@update:cards` — emitted on every pointer move with the live-updated cards array.
- `@commit` — emitted on `pointerup` and on explicit mutations (add/remove).

The parent (`SceneEditorView`) writes live updates directly into `scenesStore.scenes[idx].cards` for smooth rendering and calls `scenesStore.saveSceneCards(id, cards)` on commit, which debounces 300ms and skips the write if the content hasn't changed.

Resize handles appear only on the selected card and only for `resizable: true` card types. Eight handles (`n`, `ne`, `e`, `se`, `s`, `sw`, `w`, `nw`) are rendered as small absolutely-positioned `<div>` elements with cursor overrides.

Snap steps: drag snaps to 0.25-column increments; resize snaps to 0.1-column increments.

### Helper functions (`src/components/scenes/sceneLayout.js`)

| Function | Purpose |
|---|---|
| `clampLayout(layout)` | Ensures `x, y ≥ 0` and `w, h ≥ 1`; snaps to 0.05-column grid. |
| `detectCollision(a, b)` | Returns true if two layout rectangles overlap. |
| `placeNewCard(cards, w, h, cols)` | Finds the first collision-free position for a new card by scanning top-to-bottom, left-to-right. |

## Routing

| Route              | View                  | Scope  |
|--------------------|-----------------------|--------|
| `/scenes`          | `ScenesView.vue`      | Global |
| `/scenes/:sceneId` | `SceneEditorView.vue` | Global |

`ScenesView.vue` — the scene list (load all scenes, "New scene" → create + navigate to editor).
`SceneEditorView.vue` — the scene editor (loads scene by id, mounts `SceneCanvas`, inline title edit, add-card via `ScenePicker`, delete).

Active scene is derived from `route.params.sceneId` — there is no "active scene" in the store. If a `sceneId` resolves to null (unknown id), a "scene not found" state is shown.

## Files at a glance

```
src-tauri/src/
  migrations.rs                    # migration v3 adds `scenes` table
  scenes/
    mod.rs
    commands.rs                    # scene_data_fetch_batch command
    query_registry.rs              # Phase 1: no-op resolver; Phase 2: vendor arms

src/
  utils/
    sceneSerialization.js          # stableSerialize, buildSceneDataKey
  stores/
    cardTypes.js                   # static CARD_TYPES registry + Pinia store
    scenes.js                      # CRUD for scenes table + saveSceneCards
    sceneData.js                   # subscription fabric
  components/scenes/
    sceneLayout.js                 # clampLayout, detectCollision, placeNewCard
    SceneCanvas.vue                # 12-col grid, drag/resize, controlled
    SceneCard.vue                  # card shell (header, handles, minimize)
    SceneCardHost.vue              # resolves component, wires sceneData sub
    ScenePicker.vue                # add-card sheet listing registry entries
    cards/
      SceneNotesCard.vue           # freeform text notes card (selfManaged)
  views/
    ScenesView.vue                 # scene list
    SceneEditorView.vue            # scene editor
```
