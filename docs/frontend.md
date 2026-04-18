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
  views/                  # Page-level components (one per route)
    HomeView.vue          # Mission picker — the app's landing page
    MapView.vue           # Map page, mounted at /map/:missionId
    ControlHubView.vue    # Control Hub — containers/sessions management (stub)
    ConfigurationView.vue # Connector configuration pages (stub)
    ScenesView.vue        # Scene list — create/open scenes
    SceneEditorView.vue   # Scene editor — canvas, toolbar, card picker
  stores/                 # Pinia stores (one file per domain)
    app.js                # Global app state (loading counter)
    navigation.js         # Active mission persistence for sidebar
    tracks.js             # CoT track state and Tauri event listener
    cardTypes.js          # Static card type registry + Pinia getters
    scenes.js             # CRUD for scenes SQLite table
    sceneData.js          # sceneData subscription fabric (batched Rust queries + push)
  utils/
    sceneSerialization.js # stableSerialize, buildSceneDataKey
  components/scenes/      # Scene engine components
    sceneLayout.js        # clampLayout, detectCollision, placeNewCard
    SceneCanvas.vue       # 12-col grid canvas, drag/resize (controlled)
    SceneCard.vue         # Card shell — header, resize handles, minimize
    SceneCardHost.vue     # Resolves card component, wires sceneData subscription
    ScenePicker.vue       # Add-card menu listing registry entries
    cards/
      SceneNotesCard.vue  # Freeform text notes (selfManaged)
  composables/
    useAssistantTools.js  # Per-route tool registration + context label helper
  services/
    assistant/
      client.js           # Thin invoke wrapper for assistant_chat command
      toolRegistry.js     # MCP-shaped register/unregister/list module
      tools/
        map.js            # Map surface tool bundle
        scenes.js         # Scenes surface tool bundle
  stores/
    assistant.js          # Turn loop, pendingCalls, message list
  components/
    AppFooter.vue         # Global footer (all non-home routes)
    assistant/
      AssistantPanel.vue      # Docked chat card
      AssistantMessage.vue    # Single message renderer
      AssistantConfirmCard.vue # Confirm/cancel card for pending writes
  assets/          # Static assets (images, fonts, etc.)
```

## Shell and navigation

Ares uses Vue Router 4 in `createWebHistory` mode. Two original routes plus four added for the Athena integration:

| Route                  | Name     | View                     | Scope          |
|------------------------|----------|--------------------------|----------------|
| `/`                    | `home`   | `HomeView.vue`           | —              |
| `/map/:missionId`      | `map`    | `MapView.vue`            | Mission-scoped |
| `/hub`                 | `hub`    | `ControlHubView.vue`     | Global         |
| `/configuration`       | `config` | `ConfigurationView.vue`  | Global         |
| `/scenes`              | `scenes` | `ScenesView.vue`         | Global         |
| `/scenes/:sceneId`     | `scene`  | `SceneEditorView.vue`    | Global         |

**Rule: Map is mission-scoped; Hub/Config/Scenes are global peers.** The Hub, Configuration, and Scenes surfaces are not children of a mission — they apply to the full app and contain globally-configured connectors, vendor settings, and composed dashboards.

**Active mission persistence.** `useNavigationStore` (`src/stores/navigation.js`) holds `activeMissionId`. `MapView` sets it on successful mission load and clears it on `exitMission`. The sidebar reads it to build the Map nav target so that clicking Map from any global page returns to the same mission.

**Sidebar visibility.** `AppSidebar` is conditionally rendered in `App.vue` — hidden on `route.name === 'home'` to keep the mission picker a clean landing surface. It appears as an icon rail on all other routes.

**Adding a new top-level route:** add the route in `src/router/index.js`, create a view in `src/views/`, and add a nav item to `AppSidebar.vue`. If the new destination is mission-scoped, read `navStore.activeMissionId` and validate like `MapView` does.

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
  - **Display → Use MIL-STD-2525 symbology** (`milStdSymbology`, default `false`) — when enabled, typed manual tracks render as MIL-STD-2525 icons; untyped tracks keep the affiliation-colored circle. See [tracks.md](./tracks.md) for layer mechanics.

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
- Branding uses two distinct assets:
  - `src/assets/ares-icon.png` is the in-app helmet mark used in the UI (home-page logo + low-opacity watermark treatment).
  - `app-icon.png` is the canonical source for generated Tauri app icons. Regenerate `src-tauri/icons/` with `pnpm tauri icon app-icon.png` when the dock / bundle icon artwork changes so dev and packaged builds stay visually aligned.

## Shape Types

Every drawn or imported feature has a `type` string stored in the `features` table. This string drives rendering, handle logic, AttributesPanel cards, and import/export behavior.

| Type | GeoJSON geometry | Canonical properties | Draw interaction |
|------|-----------------|----------------------|------------------|
| `point` | `Point` | `name`, `color` | Single click |
| `line` | `LineString` | `name`, `color` | Click vertices, double-click to finish |
| `polygon` | `Polygon` | `name`, `color`, `opacity` | Click vertices, double-click to finish |
| `box` | `Polygon` | `name`, `color`, `opacity`, `sw` [lng,lat], `ne` [lng,lat], `rotationDeg` | Two clicks: opposite corners |
| `circle` | `Polygon` (64-step approximation) | `name`, `color`, `opacity`, `center` [lng,lat], `radius` (meters) | Two clicks: center then edge |
| `ellipse` | `Polygon` (64-step approximation) | `name`, `color`, `opacity`, `center` [lng,lat], `radiusMajor` (m), `radiusMinor` (m), `rotation` (degrees, azimuth of major axis from north) | Three clicks: center → major-axis tip → minor-axis tip |
| `sector` | `Polygon` | `name`, `color`, `opacity`, `center` [lng,lat], `radius` (m), `startAngle` (°), `endAngle` (°) | Three clicks: center → start bearing → end bearing |
| `route` | `LineString` | `name`, `color`, `waypoints` array of `{ label, role }` where role is `'SP'`/`'WP'`/`'EP'` | Click waypoints, double-click to finish |
| `image` | `Point` (center) | `name`, `src` (base64 data URL), `naturalWidth`, `naturalHeight`, `widthMeters` | File picker then single map click |
| `manual-track` | `Point` | `callsign`, `affiliation`, `cotType` (optional), `hae` (m), `course` (°), `speed` (kts) | Created via Manual Track panel, not drawn |

Manual track placement, editing, listing, and rendering are fully documented in [tracks.md](./tracks.md) — including the `TrackDropPanel` two-step placement flow, `ManualTrackPanel`, `TrackTypePicker`, and the MIL-STD-2525 dual-layer pipeline. `cotType` is optional; tracks without one render as affiliation-colored circles regardless of the 2525 symbology setting.

Geometry for parametric shapes (`box`, `circle`, `ellipse`, `sector`) is stored **both** as a pre-computed polygon (for rendering) and as canonical parameters in `properties` (for editing and re-export). When a user edits parameters, the polygon geometry is recalculated and both are written back to SQLite atomically.

The `featureCollection` computed in `useFeaturesStore` always tags every feature with `_dbId` (the SQLite row id) and `_type` (the type string) so map layers and UI components can filter without additional queries.

Fillable types (shapes that have a fill and opacity control): `polygon`, `box`, `circle`, `ellipse`, `sector`.

### Shape handles (`useMapDraw`)

`computeHandles(feature)` returns a list of draggable handle descriptors for the selected feature. Each handle has `{ id, kind, position, index? }`:

- **`point` / `circle` / `ellipse` / `sector`:** a single `center` handle at the shape's anchor point.
- **`line`:** one `vertex` handle per coordinate.
- **`polygon`:** one `vertex` handle per ring vertex + one `center` handle at the ring's bounding-box centroid. Dragging the center translates all vertices.
- **`box`:** `sw` and `ne` corner handles + one `center` handle at the midpoint. Dragging a corner reshapes; dragging the center translates.
- **`ellipse`:** `center`, `majorTip` (at bearing `rotation` from center), and `minorTip` (at bearing `rotation + 90°`). Dragging tips resizes each axis independently.

Drag state is exposed as the `draggingFeature` reactive ref (provided from `MapView` as `'draggingFeature'`). `AttributesPanel` injects it and watches for changes to live-update field values while the user drags.

## Import / Export

`ImportExportDialog.vue` (opened from the `mdi-swap-vertical` toolbar button) is the single entry point for all import and export operations. It uses a two-step flow for export (select features → choose format) and a one-click format grid for import.

### Supported formats

| Direction | Format | Service module | Notes |
|-----------|--------|----------------|-------|
| Import | CoT XML | `src/services/cot.js` → `importCotFeatures` | Single `<event>` or `<events>` wrapper |
| Import | TAK Data Package | `src/services/cot.js` → `importCotFeatures` | ZIP with `MANIFEST/manifest.xml` + `{uid}/{uid}.cot` files |
| Import | KML / KMZ | `src/services/kml.js` → `importKml` | Google Earth / GIS format |
| Import | GeoJSON | `src/services/geojson.js` → `importGeoJson` | Geographic JSON |
| Export | KML | `src/services/kml.js` → `exportKmlSubset` | |
| Export | CoT ZIP | `src/services/cotPackage.js` → `exportCotZip` | Flat ZIP, one `.cot` per feature |
| Export | TAK Data Package | `src/services/cotPackage.js` → `exportTakDataPackage` | ATAK / WinTAK compatible |

All imports land in the active mission. The UI is unreachable without an active mission, so no defensive guard is needed inside the service modules.

Exportable types: `point`, `line`, `polygon`, `box`, `circle`, `ellipse`, `sector`, `route`. Not exported: `image` (data-URL blobs are not portable in CoT/KML), `manual-track` (managed separately).

### CoT XML format (`src/services/cot.js`)

TAK-compatible CoT (Cursor on Target) XML. The file follows the conventions observed in real WinTAK data package exports.

**Color encoding** — TAK uses signed 32-bit ARGB integers as a `value` attribute, not hex strings:
```
<strokeColor value="-1" />   ← white opaque (0xFFFFFFFF as signed i32)
<fillColor value="-2130706433" />  ← 50% transparent white
```
`appToCoTColorInt(hexRgb, alpha)` converts `#RRGGBB` + opacity → signed int string.  
`cotIntToAppColor(intStr)` is the inverse.  
Legacy hex text content (`<strokeColor>#FFFFFFFF</strokeColor>`) is also handled on import for round-trip compatibility with older Ares exports.

**Polygon / line vertices** — stored as `<link point="lat,lon" />` elements directly in `<detail>` (not inside a `<shape>` element). For closed polygons the last link repeats the first coordinate.

**Per-shape CoT types and detail structure:**

| Ares type | CoT `type` | `how` | Notable detail elements |
|-----------|-----------|-------|-------------------------|
| `point` | `b-m-p-s-m` | `h-g-i-g-o` | `<color argb="int" />`, `<usericon iconsetpath="..." />` |
| `line` | `u-d-f` | `h-e` | `<link point="lat,lon" />` × N (open, no repeat) |
| `polygon` / `box` | `u-d-f` | `h-e` | `<link point="lat,lon" />` × N+1 (last repeats first) |
| `circle` | `u-d-c-c` | `h-g-i-g-o` | `<shape><ellipse minor="r" major="r" angle="360" /></shape>` |
| `ellipse` | `u-d-c-e` | `h-g-i-g-o` | `<shape><ellipse minor="…" major="…" angle="…" /></shape>` (angle = azimuth of major axis) |
| `sector` | `u-d-f` | `h-e` | `<shape><arc radius="…" start="…" end="…" /></shape>` |
| `route` | `b-m-r` | `h-g-i-g-o` | `<link_attr … color="int" />`, `<link uid="…" point="lat,lon" type="b-m-p-w" callsign="…" />` × N |

All shape events include: `access="Undefined"`, `hae="9999999"`, `ce="9999999"`, `le="9999999"`, `<archive />`, `<strokeWeight value="1" />`, `<strokeStyle value="solid" />`, `<clamped value="False" />`, `<height value="0.00" />`, `<height_unit value="4" />`.

**Stale times:** points → +1 year; all other shapes → +7 days.

**Import parser** handles both `<link point>` (TAK format) and legacy `<polyline>` text-content (older Ares exports). For polygon/line: if first coord == last coord → polygon, otherwise line. Route waypoints use `<link uid][point]>` (both attributes present). Unrecognised or unsupported CoT types (`u-d-f-m` freehand, etc.) are silently skipped.

### TAK Data Package (`src/services/cotPackage.js`)

ZIP archive with the structure TAK clients (ATAK / WinTAK) expect:
```
MANIFEST/manifest.xml
ares-{dbId}/ares-{dbId}.cot    ← one directory + file per feature
…
```
The `MANIFEST/manifest.xml` uses `MissionPackageManifest version="2"` with a `Configuration` block (package name + uid) and a `Contents` block (one `<Content>` per `.cot` entry, carrying only a `uid` parameter — no `name` parameter, matching real TAK exports).

`exportCotZip` produces a simpler flat ZIP (`{uid}.cot` at root) for cases where a full data package is not needed.

## Overlay Management
- `OverlaysDialog` (triggered from the `mdi-shape-outline` button in the toolbar's Annotation group) lists **features in the current mission** with checkboxes and calls `removeFeatures(ids)` for bulk removal. Cross-mission management happens on the home page instead.
- Each row shows the user-given name (falling back to the capitalized type). When a name exists, the subtitle shows the shape type as a secondary cue; otherwise the subtitle is omitted so we don't repeat the type twice.
- Each row has a fly-to button (`mdi-crosshairs-gps`) wired to an injected `flyToGeometry` function. Clicking it pans/zooms the map to the feature's bounds (or flies to the point, for `Point` features) and closes the dialog so the destination is visible.
- The dialog takes a shallow copy of `featuresStore.features` when it opens — the store already scopes that list to the active mission, so no join or extra query is needed. The snapshot is intentionally non-reactive; reopening the dialog refreshes it.

## Map Footer
`MapFooter` is an absolutely positioned overlay anchored to the bottom of `.map-container`. It tracks the mouse position via `mousemove` / `mouseout` handlers registered on the MapLibre instance in `MapView` and passed in as a `coord` prop (`{ lng, lat } | null`). The footer is `pointer-events: none` so it never intercepts map interactions. The coordinate text is formatted by `formatCoordinate` from `src/services/coordinates.js` using the `coordinateFormat` setting.

## Map provide/inject
`MapView` is the owner of the MapLibre instance; components below it in the tree can ask for map-centric helpers via Vue's `inject` API without prop-drilling.

Currently provided:

| Key                    | Shape                              | Source                              |
|------------------------|------------------------------------|-------------------------------------|
| `flyToGeometry`        | `(geometry) => void`               | `useMapDraw().flyToGeometry`        |
| `moveFeature`          | `(id) => void`                     | `useMapDraw().moveFeature`          |
| `draggingFeature`      | `Ref<feature \| null>`             | `useMapDraw().draggingFeature`      |
| `openManualTrackPanel` | `(id) => void`                     | `useMapManualTracks().openPanel`    |
| `switchBasemap`        | `(id) => Promise`                  | `MapView.switchBasemap`             |
| `setInterceptMarker`   | `(lon, lat) => void`               | `MapView` (inline)                  |
| `clearInterceptMarker` | `() => void`                       | `MapView` (inline)                  |

## Basemap Switching
- Available basemaps are defined in `src/services/basemaps.js` as the `BASEMAPS` array. Adding a new online basemap = adding one entry with `{ id, name, icon, tiles, tileSize, maxzoom }`.
- The map source is named `basemap` (not tied to any specific provider). Switching uses `map.getSource('basemap').setTiles(newTiles)` — no `setStyle()` call, so draw/measure layers are preserved.
- The selected basemap id is persisted via `settingsStore.selectedBasemap` and restored on map init.
- `LayersPanel` is a floating draggable panel with Online and Offline tabs. Offline is scaffolded for a future map server integration.

## CoT Listeners
- Listener configuration is **global** (not mission-scoped) — persisted in the key-value settings store as `cotListeners`, an array of `{ name, address, port, protocol, enabled }` objects.
- `ListenersDialog` is a modal dialog opened from the toolbar's `mdi-access-point` button. Users can add listeners (name, protocol, address, port), toggle individual listeners on/off, edit, and remove them.
- The settings store exposes `addCotListener`, `updateCotListener`, `removeCotListener`, and `toggleCotListener` helpers that mutate the array and persist in one step.
- **Wiring to the backend:** `ListenersDialog` calls `invoke('start_listener', ...)` / `invoke('stop_listener', ...)` on toggle and remove. `MapView` starts all enabled listeners on map load and calls `invoke('stop_all_listeners')` on unmount.
- `useTracksStore.startListening()` wires the `cot-event` Tauri event to the track map and starts a 30-second stale-track pruning interval.

## Toolbar layout

`MapToolbar.vue` uses an adaptive two-mode layout driven by Vuetify's `useDisplay()` composable:

- **Wide (`mdAndUp`, ≥960px):** flat buttons per group with vertical dividers — the default look. Four groups left-to-right: Annotation, Analysis, Operations, Feeds.
- **Narrow (<960px):** each group collapses into a single icon button that opens a `v-menu` dropdown listing the group's tools. The group activator inherits the `toolbar-active` / `primary` colour when any of its tools is currently open, so state is still visible without opening the menu.
- **Plugin buttons:** always rendered as a single `mdi-puzzle-outline` dropdown regardless of viewport width. Because plugins are unbounded in number, inlining them is never safe.
- **Right cluster** (Import/Export, Listeners, Settings) and the **mission chevron** are always pinned and never collapse.
- The mission name is hidden on `smAndDown` (<600px) to reclaim horizontal space.

When adding a new core tool, place it in the appropriate group in *both* the `v-if="mdAndUp"` flat section and the `v-else` collapsed `v-list` for that group.

## Plugins

Third-party plugins extend the app with new toolbar buttons and mission data automation. The full authoring guide — including the plugin contract, `api` surface, lifecycle, and trust model — is in [plugins.md](./plugins.md). Relevant implementation files: `src/composables/usePluginRegistry.js`, `src/services/pluginLoader.js`, `src-tauri/src/plugins.rs`, `src/components/MapToolbar.vue` (plugin-buttons slot), `src/components/SettingsDialog.vue` (Plugins tab).

## Scenes

The Scenes dashboard engine is documented in [scenes.md](./scenes.md). Key concepts:
- A **scene** is a user-authored grid of draggable/resizable cards, persisted in the `scenes` SQLite table.
- The **card registry** (`src/stores/cardTypes.js`) defines available card types; `SceneCardHost.vue` resolves a card to its Vue component.
- The **sceneData fabric** (`src/stores/sceneData.js`) coalesces subscriptions, batches Rust fetches, and delivers push invalidations via Tauri events.
- Scenes are global — not mission-scoped.

## Bloodhound

Live-tracking range lines between tracks, vessels, shapes, or raw coordinates are documented in [bloodhound.md](./bloodhound.md). Toolbar entry is the `mdi-map-marker-distance` button in the Analysis group; the `BloodhoundPanel` manages add / remove / clear. The line and its distance label follow both endpoints as sources move.

## Perimeter

Live-following standoff rings around individual tracks, with optional breach alerts, are documented in [perimeter.md](./perimeter.md). Toolbar entry is the `mdi-shield-outline` button in the Analysis group alongside Measure and Bloodhound; the `PerimeterPanel` manages add / remove / radius / alert. When alert is on, any other track inside the ring flips the ring red and gets a red halo. Owners are restricted to tracks (CoT, AIS vessel, manual track) — one perimeter per track.

## Assistant

The in-app AI assistant is documented in [assistant.md](./assistant.md). Key concepts:
- A **global footer** (`AppFooter.vue`) is rendered on all non-home routes. It hosts the assistant toggle button and a reserved left slot for future status indicators.
- The **assistant panel** (`AssistantPanel.vue`) is a docked card (bottom-right, RoutePanel-styled) that shows the chat log, pending confirms, and an input row.
- The **tool registry** (`src/services/assistant/toolRegistry.js`) is an MCP-shaped register/unregister surface. Each route registers its tool bundle on mount and unregisters on unmount via `useAssistantTools`.
- The **assistant store** (`src/stores/assistant.js`) owns the turn loop, pendingCalls, and message list.
- Transport is via a Rust command (`assistant_chat`) that calls the Anthropic API — no direct HTTPS from the webview.
- API key, provider, and model are configured in Settings → Assistant tab.

## Tracks

The project has two track systems — ephemeral CoT-feed tracks and persistent user-placed manual tracks. Both are documented together in [tracks.md](./tracks.md), including:

- `useTracksStore` and `useMapTracks` (CoT-feed tracks, `cot-tracks` source/layers)
- Manual track placement (`TrackDropPanel`), editing (`ManualTrackPanel`), and listing (`TrackListPanel`)
- `TrackTypePicker` + `src/services/trackTypes.js` catalog
- MIL-STD-2525 symbology toggle and dual-layer rendering pipeline
- `src/services/sidc.js` — `cotTypeToSidc`, `getOrCreateIcon`, `sidcToDataUrl`
- CoT test harness script (`scripts/cot-sender.mjs`)
