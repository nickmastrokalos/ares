# Frontend

> Source of truth for frontend architecture and design decisions.

## Stack
- **Framework:** Vue 3 (Composition API, `<script setup>`)
- **UI Library:** Vuetify 3 (auto-imported via vite-plugin-vuetify)
- **Build Tool:** Vite
- **Language:** JavaScript (no TypeScript)
- **Icons:** Material Design Icons (@mdi/font)
- **Routing:** Vue Router 4 (history mode)
- **State Management:** Pinia 3 (Composition API style)
- **Persistent Store:** @tauri-apps/plugin-store (key-value, persists to JSON)
- **Tauri API:** @tauri-apps/api for invoking Rust commands
- **Path Alias:** `@/` resolves to `src/`

## Project Structure
```
src/
  main.js          # App entry — mounts Vue with Pinia, Router, and Vuetify
  App.vue          # Root shell — contains <router-view />
  router/
    index.js       # Route definitions
  plugins/
    vuetify.js     # Vuetify configuration (theme, defaults)
    database.js    # SQLite database singleton (getDb)
    store.js       # Key-value store singleton (getStore)
  views/           # Page-level components (one per route)
    HomeView.vue   # Mission picker — the app's landing page
    MapView.vue    # Map page, mounted at /map/:missionId
  stores/          # Pinia stores (one file per domain)
    app.js         # Global app state
  composables/     # Reusable composition functions (useX.js)
  services/        # Pure modules (geometry, parsers, etc.) with no Vue deps
  components/      # Reusable Vue components
  assets/          # Static assets (images, fonts, etc.)
```

## State Management
- Use Pinia for all shared state.
- Use the Composition API style (`defineStore` with a setup function) for all stores.
- One store per domain — name files after their concern (e.g., `app.js`, `auth.js`).
- Store files live in `src/stores/`.

## Persistent Store (tauri-plugin-store)
- Use for app settings, preferences, and small persisted values — not for domain data (use SQLite for that).
- Access via `src/plugins/store.js` singleton (`getStore()`).
- Persists to `settings.json` in the app data directory with auto-save enabled.
- **Don't touch `getStore()` directly from components.** Wrap all keys in `useSettingsStore` (see below) so there's one place that knows the full schema.

```js
import { getStore } from '@/plugins/store'

const store = await getStore()
await store.set('theme', 'dark')
const theme = await store.get('theme')
```

## Settings
- `useSettingsStore` (`src/stores/settings.js`) is the Pinia wrapper around the persistent store. Components read reactive refs; writes go through `setSetting(key, value)` which persists and updates the ref in one call.
- `DEFAULTS` at the top of the store is the single source of truth for which keys exist and their fallback values. Adding a new setting = add a default, add a matching `ref`, register it in the internal `refs` map, export it.
- `load()` is idempotent and promise-cached. `App.vue` fires it on mount; consumers that need a settled value before proceeding (e.g. `MapView` before creating map layers) can `await settingsStore.load()` — the second caller just awaits the first call's promise.
- `SettingsDialog.vue` is the UI surface: a `v-dialog` with `v-tabs` sections. Adding a new section = add an entry to `TABS` + a matching `<v-window-item>`. Opens from the gear icon in `MapToolbar`, wired through a `toggle-settings` event handled in `MapView`.
- Current settings:
  - **Display → Show feature names on map** (`showFeatureLabels`, default `true`) — toggles the `draw-features-labels` symbol layer in `useMapDraw`. Label rendering needs a `glyphs` URL on the MapLibre style; see `MapView.vue` (`glyphs:` field). TODO: self-host glyphs so labels work offline.
  - **Display → Distance units** (`distanceUnits`, default `'metric'`) — controls how distances are formatted throughout the app. Options: `'metric'` (m/km), `'statute'` (ft/mi), `'nautical'` (m/nm). `formatDistance(meters, units)` in `src/services/geometry.js` is the single conversion point.
  - **Display → Coordinate format** (`coordinateFormat`, default `'dd'`) — controls how map coordinates are displayed in `MapFooter`. Options: `'dd'` (decimal degrees), `'dms'` (degrees/minutes/seconds), `'mgrs'` (MGRS via the `mgrs` npm package). `formatCoordinate(lng, lat, format)` in `src/services/coordinates.js` is the single conversion point.

## Routing
- Define all routes in `src/router/index.js`.
- Page-level components live in `src/views/` and are named `*View.vue`.
- Reusable components live in `src/components/` — do not put them in `views/`.
- `App.vue` is the shell (`<v-app>` + `<v-main>` + `<router-view />`). Page layout belongs in views, not in App.vue.

## Conventions
- Use `@/` alias for all imports (e.g., `import { getDb } from '@/plugins/database'`).
- Use Vuetify components for all UI elements — do not use raw HTML for things Vuetify provides.
- Use `<script setup>` syntax for all components.
- Vuetify is auto-imported via the Vite plugin; no need to import individual components.
- Invoke Tauri commands via `import { invoke } from '@tauri-apps/api/core'`.

## Composables
- Extract reusable stateful logic into composables in `src/composables/` (file names start with `use`).
- Examples:
  - `useDraggable` — pointer-based dragging for floating panels. Returns `{ pos, dragging, onPointerDown }`.
  - `useMapDraw` — MapLibre drawing tools, feature source/layer management, and selection.
  - `useMapMeasure` — Ephemeral distance measurement tool. Click points to form a path; shows per-segment and total distances via MapLibre Markers. Not persisted to the database.
- Composables own their own event listeners and clean them up in `onUnmounted`.

## Image Overlays
Image overlays are a special feature type (`_type: 'image'`) stored as GeoJSON `Point` features in SQLite. The `properties` payload carries the full base64 data URL (`src`), natural pixel dimensions (`naturalWidth`, `naturalHeight`), and the map-space width in meters (`widthMeters`, default 500).

**Placement flow:** clicking the image tool opens a file picker immediately (PNG / JPEG / GIF / WebP). After a file is picked, the cursor switches to crosshair and the next map click places the image centered on that point. Escape cancels before placement. Logic lives in `startImage()` in `useMapDraw` + `pickAndReadImage()` in `src/services/imageOverlay.js`.

**Rendering:** each image feature gets its own MapLibre raster source (`img_source_N`) and layer (`img_layer_N`) inserted below `draw-features-fill`. `syncImages(featureCollection)` in `useMapDraw` diffs the active image features against what's registered in MapLibre and adds/removes sources and layers accordingly. It is called from `initLayers()` and the `featureCollection` watcher. Corner coordinates are derived from center + `widthMeters` + aspect ratio via `computeImageCorners()` in `src/services/geometry.js`.

**Selection:** raster sources are not hit-testable. A transparent circle layer (`draw-features-image-targets`, radius 10, subtle blue stroke) filtered to `_type === 'image'` acts as the click target and is included in `SELECTABLE_LAYERS`. The regular `draw-features-points` layer excludes image features so they don't also render as dots.

**Deletion:** standard `removeFeature()` path — the `featureCollection` change triggers `syncImages()` which removes the orphaned source and layer.

## Map Feature Flow
The drawing feature stack is a single one-way pipeline:

1. **User interaction** — draw tool, attributes panel, or KML import mutates `useFeaturesStore`.
2. **Store** — persists to SQLite, then reloads `features.value` from the DB.
3. **Computed `featureCollection`** — derives a GeoJSON `FeatureCollection` from `features.value`, tagging each feature with `_dbId` and `_type` for identity and filtering.
4. **`useMapDraw` watcher** — observes `featureCollection` and pushes it onto the MapLibre `draw-features` source.

Consequences:
- Callers never touch the map source directly. Mutating the store is sufficient.
- Selection is stored in `selectedFeatureId` and drives the `draw-features-selected` highlight layer via a filter.
- Map click handlers use `queryRenderedFeatures` against the fill / line / point layers to resolve a click to a `_dbId`.

## Floating Panels
- `DrawPanel` (tool picker) and `AttributesPanel` (selected-feature editor) are absolutely positioned children of `.map-container`.
- Both use `useDraggable` for repositioning — the drag handle is the only interactive surface that starts a drag.
- `AttributesPanel` places itself centered along the bottom of the map on first mount, then yields to the user.

## Missions
- A **mission** is the top-level container the user picks on the home page. Everything drawn or imported while a mission is active belongs to that mission.
- `HomeView` is the mission picker: list existing missions, create, rename, or delete them. Picking a mission navigates to `/map/:missionId`.
- The mission list is rendered with `v-data-table` so new columns (mission status, last location, linked artifacts, etc.) can be slotted in by extending the `headers` array at the top of `HomeView.vue`. Current columns: Name, Overlays, Updated, Actions.
- Once the mission count exceeds `ROWS_BEFORE_SCROLL` (8), the table caps at `TABLE_SCROLL_HEIGHT` (380px) with `fixed-header` and an internal scroll — we intentionally skip pagination because a "next page" click to find a mission is worse UX than a short scroll for this size of list.
- Inline rename and inline delete-confirm share the same shape — an `editingId` / `confirmDeleteId` ref gates the actions cell between "default controls" and "check/close" controls. Row click opens the mission unless the clicked row is mid-edit or mid-delete.
- `MapView` reads `:missionId` from the route and calls `featuresStore.setActiveMission(id)` on mount. An unknown id redirects back to the picker — the map never boots without a valid mission.
- `useFeaturesStore.setActiveMission(id)` is the single entry point for "load this mission's features and make it active." It loads `missions` if needed, resolves the id, and fetches the feature rows. Returns the mission row on success, `null` if the id doesn't match.
- `featuresStore.renameMission(id, name)` bumps `updated_at` so renames surface as recent activity in the picker's default sort.
- `MapToolbar` shows the active mission name plus a chevron back to the picker.
- Branding: the helmet PNG at `src/assets/ares-icon.png` (transparent background, alpha channel) is used as both the small logo above the ARES wordmark and as an oversized low-opacity watermark behind the home page for ambient texture.

## Import / Export
- Supported formats live in `src/services/io.js` as `IO_FORMATS`:
  ```js
  { id, label, importFn, exportFn }
  ```
  Adding a new format = adding one entry plus a matching module under `src/services/<format>.js`. The `DrawPanel` menus iterate this list, so the UI picks up new formats automatically.
- **Imports always land in the active mission.** They no longer create a mission per file — missions are explicit and picked on the home page. An importer that's called with no active mission bails out (belt-and-suspenders; the UI isn't reachable without one).
- Each format module owns its own file dialog, parse/serialize, and filename handling. Shared conventions:
  - On **export**, the `_dbId` internal property is stripped but `_type` is preserved so a file can round-trip back into the same shape kind (a circle stays a circle, not a generic polygon). The default filename is derived from the active mission's name.
  - On **import**, `inferType(feature)` prefers `properties._type` if present and falls back to mapping GeoJSON geometry types to our shape vocabulary.
- The `DrawPanel` exposes one `mdi-import` and one `mdi-export` button. Each opens a `v-menu` listing `IO_FORMATS`; picking an entry invokes that format's `importFn` / `exportFn`.

## Overlay Management
- `OverlaysDialog` (triggered from the `DrawPanel`'s `mdi-shape-outline` button) lists **features in the current mission** with checkboxes and calls `removeFeatures(ids)` for bulk removal. Cross-mission management happens on the home page instead.
- Each row shows the user-given name (falling back to the capitalized type). When a name exists, the subtitle shows the shape type as a secondary cue; otherwise the subtitle is omitted so we don't repeat the type twice.
- Each row has a fly-to button (`mdi-crosshairs-gps`) wired to an injected `flyToGeometry` function. Clicking it pans/zooms the map to the feature's bounds (or flies to the point, for `Point` features) and closes the dialog so the destination is visible.
- The dialog takes a shallow copy of `featuresStore.features` when it opens — the store already scopes that list to the active mission, so no join or extra query is needed. The snapshot is intentionally non-reactive; reopening the dialog refreshes it.

## Map Footer
`MapFooter` is an absolutely positioned overlay anchored to the bottom of `.map-container`. It tracks the mouse position via `mousemove` / `mouseout` handlers registered on the MapLibre instance in `MapView` and passed in as a `coord` prop (`{ lng, lat } | null`). The footer is `pointer-events: none` so it never intercepts map interactions. The coordinate text is formatted by `formatCoordinate` from `src/services/coordinates.js` using the `coordinateFormat` setting.

## Map provide/inject
`MapView` is the owner of the MapLibre instance; components below it in the tree can ask for map-centric helpers via Vue's `inject` API without prop-drilling.

Currently provided:

| Key              | Shape                          | Source                       |
|------------------|--------------------------------|------------------------------|
| `flyToGeometry`  | `(geometry) => void`           | `useMapDraw().flyToGeometry` |
| `switchBasemap`  | `(id: string) => Promise`      | `MapView.switchBasemap`      |

## Basemap Switching
- Available basemaps are defined in `src/services/basemaps.js` as the `BASEMAPS` array. Adding a new online basemap = adding one entry with `{ id, name, icon, tiles, tileSize, maxzoom }`.
- The map source is named `basemap` (not tied to any specific provider). Switching uses `map.getSource('basemap').setTiles(newTiles)` — no `setStyle()` call, so draw/measure layers are preserved.
- The selected basemap id is persisted via `settingsStore.selectedBasemap` and restored on map init.
- `LayersPanel` is a floating draggable panel with Online and Offline tabs. Offline is scaffolded for a future map server integration.

## CoT Listeners
- Listener configuration is **global** (not mission-scoped) — persisted in the key-value settings store as `cotListeners`, an array of `{ address, enabled }` objects.
- `ListenersDialog` is a modal dialog opened from the toolbar's `mdi-access-point` button. Users can add addresses, toggle individual listeners on/off, and remove them.
- The settings store exposes `addCotListener(address)`, `removeCotListener(index)`, and `toggleCotListener(index)` helpers that mutate the array and persist in one step.
- Actual network listening (UDP sockets, CoT XML parsing) is not yet implemented — the configuration UI is scaffolded first.

Consumers must tolerate `null` (the injected helper is absent if the component is ever reused outside `MapView`). Keep these helpers pure "do the map thing" functions — no reactive state, no UI concerns.
