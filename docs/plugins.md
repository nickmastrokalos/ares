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

---

## Plugin contract

A plugin is a **self-contained ES module** whose default export is an object with the following shape:

```js
export default {
  id:      'com.your-org.plugin-name',   // reverse-domain, globally unique
  name:    'My Plugin',                  // display name in Settings → Plugins
  version: '1.0.0',

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

### UI registration

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

A working example lives at `examples/plugins/hello-world/index.js`. It adds a toolbar button that logs the current feature and track counts and flies to the first feature on the map. To install it, copy the `hello-world/` directory into your plugins folder.

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
| Settings → Plugins tab | `src/components/SettingsDialog.vue` |
