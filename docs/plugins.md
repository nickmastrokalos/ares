# Plugin Authoring Guide

> Plugins extend Ares with new toolbar buttons and mission data automation. They are plain JavaScript files loaded at startup from a dedicated folder in the app data directory.

## Quick start

1. Create a directory named after your plugin (e.g. `my-plugin/`).
2. Inside it, create `index.js` following the **Plugin contract** below. This is the entry point Ares loads.
3. Drop the directory into the Ares plugins folder (see **Plugin directory** below).
4. Launch (or restart) Ares.
5. Open **Settings → Plugins**, find your plugin, and enable it.

A toolbar button or other registered UI appears immediately on enable, and is torn down cleanly on disable — no restart needed for toggles.

> **Single-file plugins** (a bare `.js` file directly in the plugins folder, no directory) are also supported as a convenience for simple scripts.

---

## Plugin directory

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/com.ares.app/plugins/` |
| Windows  | `%APPDATA%\com.ares.app\plugins\` |
| Linux    | `~/.config/com.ares.app/plugins/` |

The directory is created automatically on first launch with a `README.txt` pointing to this document.

**Expected layout:**
```
plugins/
  my-plugin/          ← plugin directory
    index.js          ← entry point (required)
    helpers.js        ← any other files your index.js references*
  another-plugin/
    index.js
  simple-script.js    ← single-file plugin (also supported)
```

\* See the **Self-contained requirement** below — `index.js` cannot use ES `import` to load sibling files at runtime. Bundle everything into `index.js` before dropping the directory into the plugins folder.

`index.js` may be a **symlink** to a bundle elsewhere on disk (the standard development pattern: symlink `<plugins>/my-plugin/index.js` to your project's `dist/index.js` and rebuilds land instantly without re-copying). The loader allows symlinks at the leaf as long as the containing directory is inside the plugins folder.

---

## Plugin contract

A plugin is a **self-contained ES module** whose default export is an object with the following shape:

```js
export default {
  id:      'com.your-org.plugin-name',   // reverse-domain, globally unique
  name:    'My Plugin',                  // display name in Settings → Plugins
  version: '1.0.0',

  // Optional — minimum Ares host version this plugin needs. Compared with
  // simple `MAJOR.MINOR.PATCH` semver. If the running host is older the
  // plugin is shown in Settings → Plugins with a "Requires Ares ≥ X.Y.Z"
  // error and the enable toggle is disabled. Set this whenever you start
  // calling a host API that didn't exist in earlier versions.
  minHostVersion: '1.1.2',

  activate(api) {
    // Register toolbar buttons, set up watchers, etc.
    // Called once when the user enables the plugin.
  },

  // Optional — called automatically if the plugin throws during activate().
  // Usually you register cleanup via api.onDeactivate() instead.
}
```

### Self-contained requirement

Plugins are loaded via a Blob URL and **cannot use ES `import` statements inside the file**. All dependencies must be inlined into the single `.js` file (or accessed through the `api` object). If you need third-party utilities, bundle your plugin with a tool like esbuild or Rollup into a single file before dropping it in the plugins folder.

---

## The `api` object

`activate(api)` receives a capability-gated API. Plugins only see what is explicitly exposed here — they do not have direct access to Pinia stores or the MapLibre instance.

### Identity

```js
api.plugin   // { id, name, version } — the plugin's own manifest
```

### Reactive data (read-only)

```js
api.features   // ComputedRef — array of all feature rows in the active mission
               // Each row: { id, type, geometry (JSON string), properties (JSON string) }

api.tracks     // ComputedRef — array of all live CoT-feed tracks
               // Each row: { uid, cotType, lat, lon, hae, speed, course, callsign, ... }
               // Note: CoT track positions are read-only. They are overwritten by the
               // next feed event; there is no mutation API for feed tracks.
```

### Mutations (features only)

```js
await api.updateFeature(id, geometry, properties)
// geometry: GeoJSON geometry object
// properties: plain object

await api.addFeature(type, geometry, properties)
// type: any valid feature type string ('manual-track', 'point', 'line', etc.)
// Returns the new feature's SQLite id.

await api.removeFeature(id)
```

All mutations write through to SQLite and are reflected reactively — `api.features` updates automatically.

### Map helpers

```js
api.flyToGeometry(geometry)  // pan/zoom the map to a GeoJSON geometry
```

### Map layers and viewport events

Plugins can draw their own MapLibre layers without going through the features
store. Layer ids must be unique across the whole map; the registry rejects
collisions. All registered layers are removed automatically on plugin
deactivation.

```js
const layer = api.map.addLayer({
  id: 'my-layer',                         // unique map-wide
  source: { type: 'geojson', data: collection },
  layer: {                                // standard MapLibre layer spec; `source` is filled in
    type: 'circle',
    paint: { 'circle-radius': 6, 'circle-color': '#ff4081' }
  },
  onClick({ feature, lngLat, point, originalEvent }) {
    // Optional. Fires when the user clicks a feature in this layer.
  },
  onHover({ feature, lngLat, point, originalEvent }) {
    // Optional. Fires on every cursor motion over a feature (both on
    // enter and on subsequent moves). Tooltip-friendly: position your
    // tooltip element near `point.x, point.y` and populate from
    // `feature.properties`.
  },
  onHoverEnd() {
    // Optional. Fires when the cursor leaves the layer. Use to hide
    // your tooltip element.
  }
})

// Cursor automatically turns to a pointer on hover whenever any
// interaction handler is registered. All click + hover handlers are
// removed when the layer unregisters.

// `layer` is the unregister function — call it directly to remove the
// layer + source — and also carries a `setData(geojson)` helper for
// updating the GeoJSON source's data without re-registering the layer:
layer.setData(newCollection)
layer()                  // unregister

const state = api.map.getState()
// → { bounds: { north, south, east, west },
//     center: { lng, lat },
//     zoom, bearing, pitch }

api.map.onMove((state) => { /* fired on moveend */ })
api.map.onZoom((state) => { /* fired on zoomend */ })
// Both return unregister functions; auto-cleaned on deactivation.

// Register a sprite image with the map's style so it can be referenced
// from `icon-image` in symbol layers. Useful when you want to avoid
// `text-field` entirely — `text-field` triggers fetches against the
// host's glyph server for codepoints not handled by the local-emoji
// fallback, which may not be available in offline / air-gapped
// deployments. With `addImage` you can bake every glyph into a
// canvas-rendered PNG and reference it as an icon, keeping your
// plugin fully self-contained.
const removeImage = api.map.addImage('my-icon', canvasOrImage, {
  pixelRatio: 2          // optional; same options as MapLibre's addImage
})
removeImage()            // unregister; image is also auto-removed on disable

api.map.removeImage('my-icon')   // imperative form
```

### UI registration — toolbar buttons

```js
const unregister = api.registerToolbarButton({
  id:      'my-button',          // unique within the plugin
  icon:    'mdi-icon-name',      // any Material Design icon
  tooltip: 'Button tooltip',
  onClick() { /* ... */ }
})
// Returns an unregister function. The button is also removed automatically
// when the plugin is deactivated.
```

### UI registration — floating panels

Plugins can also register draggable floating panels. The panel body is a plain
DOM element the plugin renders into — no Vue or Vuetify is shared with the
host, so use vanilla DOM (or whatever framework your bundle includes).

```js
const panel = api.registerPanel({
  id:    'my-panel',                       // unique map-wide
  title: 'My Panel',                       // shown in the panel header
  icon:  'mdi-icon-name',                  // optional, shown next to title
  initialPosition: { x: 60, y: 80 },        // optional
  mount(containerEl) {
    containerEl.innerHTML = '<div>Hello!</div>'
    // Optional return: cleanup function called on plugin deactivation.
    return () => { /* tear down listeners, etc. */ }
  }
})

panel.open()
panel.close()
panel.toggle()
panel.isOpen   // boolean — current open state
```

`mount(containerEl)` is called exactly once when the panel first appears in
the DOM (panel registration), not every time the user opens it. The DOM and
any internal state persist across close/reopen via `v-show`. The cleanup
function returned by `mount` runs only when the panel is unregistered
(plugin disable / app shutdown).

### Coastlines / land mask

Ares ships the Natural Earth 10 m land dataset (~10 MB, lazy-loaded on first
use) for the water-routing planner. Plugins can use the same data:

```js
const isWater = await api.land.isOverWater([-76.21, 37.01])  // → true
// Use it to pre-filter sample points before hitting an external API:
const samples = points.filter(async p => await api.land.isOverWater(p))

// Or pull the land polygons for a bbox to use as a clipping / mask layer:
const fc = await api.land.getLandPolygons([[-77, 36], [-75, 38]])
api.map.addLayer({
  id: 'land-mask',
  source: { type: 'geojson', data: fc },
  layer: { type: 'fill', paint: { 'fill-color': '#1a1a1a' } }
})
```

Both calls return promises. The dataset is cached after the first load,
so subsequent calls are fast.

### Plugin-scoped persistent settings

```js
await api.settings.set('refreshInterval', 600)
const interval = await api.settings.get('refreshInterval')
await api.settings.delete('refreshInterval')
const allKeys = await api.settings.keys()
```

All keys are namespaced under `plugin:<your-id>:<key>` in the same
`tauri-plugin-store` Ares uses for its own settings, so plugins can't collide
with each other or with host settings. Settings persist across app restarts
**and** across plugin disable/enable cycles — re-enabling a plugin restores
its prior preferences.

### Lifecycle

```js
api.onDeactivate(fn)
// Register a cleanup callback. Called (in reverse registration order) when
// the user disables the plugin or the app shuts down. Use this to cancel
// timers, clear state, remove watchers, etc.

api.log(...args)
// console.log prefixed with [plugin:your.id] for easy filtering in DevTools.
```

---

## Example plugin

A working example lives at `examples/plugins/hello-world/index.js`. It exercises every host API surface — toolbar buttons, a map layer (a magenta dot at lat/lon 0,0), a `moveend` listener that logs viewport state, a draggable panel with a click counter, and persistent plugin-scoped settings that keep the counter across reopen and disable/enable cycles. To install it, copy the `hello-world/` directory into your plugins folder.

```js
export default {
  id:      'com.example.hello-world',
  name:    'Hello World',
  version: '1.0.0',

  activate(api) {
    api.registerToolbarButton({
      id:      'hello-world-info',
      icon:    'mdi-information-outline',
      tooltip: 'Log counts',
      onClick() {
        api.log(`Features: ${api.features.value.length}, Tracks: ${api.tracks.value.length}`)
      }
    })
    api.onDeactivate(() => api.log('Goodbye.'))
  }
}
```

---

## Trust model

Plugins run as standard JavaScript inside the Ares webview with **full app permissions** — they share the same realm as the rest of the frontend and can call any Tauri command the app exposes. The `api` object is a convenience surface, not a security boundary.

**Only install plugins from sources you trust.** There is no code-signing, checksum verification, or sandboxing in v1.

---

## Lifecycle summary

```
App launch
  └─ list_plugin_files (Rust)       discover .js files in plugins dir
  └─ read_plugin_file + import()    load each file as a Blob URL module
  └─ registerPlugin(manifest)       store manifest; activate if in enabledPlugins

User enables plugin (Settings → Plugins)
  └─ enabledPlugins updated in store
  └─ manifest.activate(api) called

User disables plugin
  └─ enabledPlugins updated in store
  └─ onDeactivate callbacks run (reverse order)
  └─ toolbar buttons removed

App shutdown
  └─ all active plugins deactivated (onDeactivate callbacks run)
```

---

## Internal implementation

| Concern | File |
|---------|------|
| Registry + api builder | `src/composables/usePluginRegistry.js` |
| File discovery + dynamic import | `src/services/pluginLoader.js` |
| Rust commands (`list_plugin_files`, `read_plugin_file`) | `src-tauri/src/plugins.rs` |
| Settings (enabledPlugins) | `src/stores/settings.js` |
| Toolbar button slot | `src/components/MapToolbar.vue` |
| Plugin floating panels | `src/components/PluginPanel.vue` |
| Settings → Plugins tab | `src/components/SettingsDialog.vue` |
