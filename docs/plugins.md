# Plugin Authoring Guide

> Plugins extend Ares with new toolbar buttons and mission data automation. They are plain JavaScript files loaded at startup from a dedicated folder in the app data directory.

## Quick start

1. Create a directory named after your plugin (e.g. `my-plugin/`).
2. Inside it, create `index.js` following the **Plugin contract** below. This is the entry point Ares loads.
3. Drop the directory into the Ares plugins folder (see **Plugin directory** below).
4. Launch (or restart) Ares.
5. Open **Settings → Plugins**, find your plugin, and enable it.

A toolbar button or other registered UI appears immediately on enable, and is torn down cleanly on disable — no restart needed for toggles.

### Installing a packaged plugin

If you received a plugin as a `.zip` (the format `pnpm package` produces), you don't have to extract it yourself.

**Easiest path** — drag the `.zip` from Finder / Explorer onto the Ares map window. The host shows a "Drop to install plugin" overlay; release to install. The zip is copied into the plugins folder, extracted in place, and the plugin appears in Settings → Plugins immediately (toggled off — turn it on to activate). A snackbar reports success or any errors.

**Equivalent manual path** — drop the `.zip` directly into the Ares plugins folder and restart. Either way, the host extracts it into a folder of the same name and renames the source to `*.zip.installed` so it isn't re-extracted on every startup. To update later, drop in the new `.zip` (drag-drop or manual); files inside the archive overwrite the previously-extracted files.

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
  },
  beforeId: '@bottom'                     // Optional layer-stack placement.
                                           // '@top' (default) → on top of everything.
                                           // '@bottom'         → just above the basemap,
                                           //                     below all host content.
                                           // any other string  → MapLibre layer id to
                                           //                     anchor against (the new
                                           //                     layer is inserted before
                                           //                     it).
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
  iconSvg: '<svg ...>...</svg>', // optional inline SVG (overrides icon)
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
  icon:  'mdi-icon-name',                  // optional MDI class name
  iconSvg: '<svg ...>...</svg>',           // optional inline SVG (overrides icon)
  width: 340,                              // optional — pins panel width in px
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

The host caps each panel's height to the viewport (`100vh − pos.y − 24px`)
and applies `overflow-y: auto` to the body, so a panel that grows large
gets a vertical scrollbar instead of running off the bottom of the screen.
Plugins don't need to manage their own scrolling — let the body grow and
the host will handle overflow. For width, prefer the `width` field on
`registerPanel` over inline-styling the container element: pinning width
on the panel container (rather than the body) keeps the panel a consistent
size when the user collapses the body via the header chevron.

Each panel header carries a chevron toggle that hides the body. The DOM
is preserved (`v-show`, not unmount), so plugin internal state and any
in-progress work survive collapse cycles.

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

### Assistant tools

Plugins can register tools the embedded AI assistant can call, so
operators can reach plugin functionality through the chat panel
("what's the weather over Delaware Bay tomorrow afternoon", "set
units to imperial", etc.) without the host needing to know the
plugin exists.

```js
const unregister = api.tools.register({
  name:        'get_forecast',
  description: 'Return the latest cached hourly forecast for the station nearest to the given lat/lon, up to 48 h from now.',
  inputSchema: {
    type: 'object',
    properties: {
      lat:         { type: 'number' },
      lon:         { type: 'number' },
      hours_ahead: { type: 'integer', minimum: 0, maximum: 48, default: 0 }
    },
    required: ['lat', 'lon']
  },
  readonly: true,                                  // runs without confirmation
  execute: async ({ lat, lon, hours_ahead = 0 }) => {
    return findNearestSample(lat, lon)?.hourly?.[hours_ahead] ?? null
  }
})

unregister()                                       // imperative removal
api.tools.unregister('get_forecast')               // alternate by name
```

Tool names are auto-prefixed with a slug derived from the plugin id
(reverse-domain trailing segment, sanitized to `[a-z0-9_]`). For
`com.ares.weather`, the example above ends up registered as
`weather_get_forecast`. If your supplied name already starts with
the slug + `_`, it's left alone — so writing it manually also works.
Names that collide with another tool throw immediately at
registration time.

`readonly: false` tools route through the assistant's confirmation
flow: the chat panel renders a confirm card with a `previewRender(args)
→ string` summary you can supply, and the handler only runs after the
user clicks Execute.

```js
api.tools.register({
  name:        'set_unit',
  description: 'Change the temperature unit shown on the map.',
  inputSchema: {
    type: 'object',
    properties: { unit: { type: 'string', enum: ['c', 'f'] } },
    required: ['unit']
  },
  readonly: false,
  previewRender: ({ unit }) => `Switch temperature unit to °${unit.toUpperCase()}.`,
  execute: async ({ unit }) => {
    setUnit(unit)
    return { unit }
  }
})
```

Returned values are JSON-stringified into the assistant's
`tool_result` block. Errors thrown from `execute` are caught and
returned as `{ error: <message> }` so the model can react. All
registrations are auto-removed on plugin disable.

### Network connections

Plugins can declare their own UDP connection kinds. The host owns
the socket lifecycle and the row in **Settings → Connections**;
inbound bytes are forwarded to the plugin's `onPacket` callback.

```js
const unregister = api.connections.registerKind({
  kind:        'armada-sa-telemetry',     // unique across all plugins
  label:       'Armada SA telemetry',     // shown in Connections panel
  description: 'DroneState messages from Armada SA drones.',
  protocol:    'udp',                     // tcp not yet supported
  defaults:    { address: '239.x.x.x', port: 15550 },
  onPacket(bytes, { sourceIp, sourcePort }) {
    const msg = MyProtoSchema.decode(bytes)   // plugin-owned parsing
    // do plugin things — update store, draw on map, render in panel…
  }
})
```

Plugin connections are scoped: `onPacket` only fires for bytes
arriving on the socket the host opened for *this* `kind`. If the
plugin is feeding CoT into the host pipeline, decode with
`api.cot.parse(bytes)` and forward with `api.cot.emit(event)` —
see the **CoT bridge** section below.

Behavior:

- The first time `registerKind` runs, a row is seeded in the
  Connections panel with the supplied defaults and labeled with
  `label`.
- Connection lifecycle mirrors plugin lifecycle: registering flips
  the row on and starts the socket; the plugin's deactivation flips
  it off and stops the socket. The user toggles the plugin in
  **Settings → Plugins** to control both — manual toggles in the
  Connections panel are honoured for the current session but every
  plugin re-activation re-asserts the on state.
- On subsequent activations the persisted address / port / protocol
  survives — plugin authors can change `defaults` without trampling
  user edits.
- Plugin-owned rows can't be deleted from the Connections UI; only
  the plugin's `unregister()` (or its uninstall) removes them.
- `bytes` is a `Uint8Array`. `sourceIp` is the dotted IPv4 / colon
  IPv6 string of the sender; `sourcePort` is its UDP source port.

### CoT bridge

Plugins ingesting CoT from a non-host source (TAK Server SSL, custom
gateway, PCAP replay, …) can inject parsed CoT events into the
host's pipeline:

```js
api.cot.emit({
  uid:      'DRONE-7',
  cot_type: 'a-f-A-M-F-Q',          // standard CoT type string
  lat:      38.78, lon: -75.10,
  hae:      0,
  callsign: 'Drone 7',
  speed:    0, course: 0,
  time:     new Date().toISOString(),
  stale:    new Date(Date.now() + 60_000).toISOString()
})
```

The event flows through the same `cot-event` channel the host's
protected CoT listeners use, so the existing tracks / chat / alert
stores pick it up unchanged. Required fields: `uid`, `cot_type`
(or `cotType`), `lat`, `lon`. Everything else has sane defaults.

When a plugin owns a raw socket whose payloads happen to be CoT
(XML or TAK Protocol v1), pair `cot.emit` with `cot.parse(bytes)`
to reuse the host's parser end-to-end:

```js
api.connections.registerKind({
  kind:    'persistent-systems-cot',
  label:   'Persistent Systems CoT',
  defaults: { address: '239.23.212.230', port: 18999 },
  async onPacket(bytes) {
    const event = await api.cot.parse(bytes)
    if (event) await api.cot.emit(event)
  }
})
```

`cot.parse` returns the parsed event on success or `null` if the
bytes weren't valid CoT (the failure is logged once at warn level
so noisy multicast groups don't flood the console).

### Route planning contributions

Plugins can teach the route planner about new avoidance
constraints (areas a route should not enter) and evaluators
(point-sampled values the assistant can walk along an existing
route). Both register through `api.routing.*`; the assistant
discovers them via the `routing_list_avoidances` and
`routing_list_evaluators` tools.

```js
// Avoidance: returns obstacle polygons for a route corridor
api.routing.registerAvoidance({
  id:           'cloud-cover',           // unique across all plugins
  label:        'Cloud cover',
  description:  'Forecasted cloud cover ≥ threshold at the supplied hours_ahead.',
  paramsSchema: {
    type: 'object',
    properties: {
      threshold_pct: { type: 'number',  minimum: 0, maximum: 100, default: 60 },
      hours_ahead:   { type: 'integer', minimum: 0, maximum: 48,  default: 0 }
    }
  },
  async getObstacles({ bbox, params }) {
    // bbox = [west, south, east, north]; the planner has already
    // padded ~5 % around the start/end/via corridor.
    // Sample the bbox, threshold by params.threshold_pct at
    // params.hours_ahead, return GeoJSON Polygons.
    return [{ type: 'Polygon', coordinates: [[…]] }]
  }
})

// Evaluator: point-sample at a route waypoint's ETA
api.routing.registerEvaluator({
  id:           'cloud-cover',
  label:        'Cloud cover %',
  description:  'Single-point cloud cover percent at lat/lon, evaluated at the route waypoint\'s ETA.',
  paramsSchema: { type: 'object', properties: {} },
  async sampleAt({ lat, lon, atIso, params }) {
    // atIso is the ISO 8601 timestamp the route assigns to the
    // waypoint based on its depart_at_iso + speed_kts.
    return { value: 75, unit: '%' }
  }
})
```

Behavior:

- `id` is unique across all plugins. Re-registering the same id
  (or colliding with a host-built-in like `tracks`) throws at
  registration time.
- Both `getObstacles` and `sampleAt` are async; the planner
  awaits them serially per route plan, so cache aggressively if
  the underlying source is slow.
- Plugin-contributed obstacle polygons are capped per plan at
  200 polygons per contributor — overflow is silently dropped
  and the count surfaces back to the assistant in the
  `applied_avoidances` block of the route response. Use
  marching-squares-style grouping or a coarser grid if you find
  yourself routinely hitting the cap.
- Both registrations auto-clean on plugin disable.
- The `paramsSchema` is JSON Schema. Validation is currently
  permissive (the planner passes whatever the assistant supplied);
  apply your own defaults inside `getObstacles` /  `sampleAt`.
  When a plugin registers BOTH an avoidance and an evaluator under
  the same `id`, keep the schemas consistent — the assistant treats
  them as the same conceptual quantity.
- Built-in host avoidances (e.g. `tracks` for surface CoT tracks
  from `tracksStore`) appear in `routing_list_avoidances` with a
  null `ownerPluginId`. They behave identically to plugin entries.

### Declaring capabilities for disabled-state discovery (`provides`)

Plugins are invisible to the AI assistant when they're disabled —
their tools, avoidances, and evaluators all disappear from the
host's registries. Without help, the assistant can't tell the user
"to do X you need to enable plugin Y". Plugin authors close that
gap by adding an optional **`provides`** block to the manifest:

```js
export default {
  id:    'com.ares.illumination',
  name:  'Illumination',
  ...
  provides: {
    tools: [
      { name: 'illumination_get',
        description: 'Sun + moon conditions and effective illumination at a point.' },
      { name: 'illumination_get_events',
        description: 'Astronomical event timeline at a point.' }
    ],
    avoidances: [
      { id: 'cloud-cover', label: 'Cloud cover',
        description: 'Forecasted cloud cover ≥ threshold.' }
    ],
    evaluators: [
      { id: 'cloud-cover', label: 'Cloud cover %',
        description: 'Single-point cloud cover at lat/lon at the route waypoint\'s ETA.' }
    ]
  }
}
```

What `provides` does:

- The host **indexes it at plugin discovery** (the moment the
  manifest is loaded), regardless of whether the plugin is
  enabled. The assistant can then list every plugin-contributed
  capability — both currently-live and currently-disabled — via
  the `plugin_capabilities_list` tool, plus see disabled
  contributors in the `disabled` arrays of
  `routing_list_avoidances` / `routing_list_evaluators`.
- When a user asks for something a disabled plugin would
  provide, the assistant tells them which plugin to enable in
  Settings → Plugins instead of failing silently.
- `provides` is **fully optional**. Plugins without it work
  exactly as before — their disabled state just isn't
  advertised. Recommended for any plugin that registers
  assistant tools or routing contributors.

Constraints:

- The runtime registry is **ground truth**. If `provides`
  declares an id that `activate()` never registers, the entry
  appears in `disabled` even when the plugin is active — easy to
  spot in dev. Plugin authors are responsible for keeping
  `provides` in sync with their actual `register*` calls.
- The host validates `provides` permissively: missing fields
  default to empty arrays, malformed entries are dropped. Plugins
  that ship a wrong shape don't crash the host.
- Tool names in `provides.tools` must be the **fully prefixed**
  names the assistant sees (e.g. `armada_sa_list`, not just
  `list`). The plugin slug prefix (`com.ares.armada-sa` →
  `armada_sa_`) is what `api.tools.register({ name: 'list' })`
  actually publishes; mirror that in `provides`.

### Display preferences (units + coordinate format)

Plugin panels should render distances, speeds, and coordinates the
same way the rest of Ares does — operators set their preferences
once in **Settings → Display** and expect everything (host panels
and plugin panels alike) to follow.

```js
// Live values — read these every render to pick up the latest setting.
api.units.distance     // 'metric' | 'statute' | 'nautical'
api.units.coordinate   // 'dd' | 'dms' | 'mgrs'

// Same formatters the host uses internally.
api.format.distance(meters)         // "1.20 km" / "3937 ft" / "0.65 nm"
api.format.speed(metersPerSecond)   // "12.5 km/h" / "7.8 mph" / "6.7 kts"
api.format.coordinate(lng, lat)     // "36.92148, -76.16219" or DMS / MGRS

// Subscribe so a render fires immediately when the user changes
// either setting (auto-cleaned on plugin disable).
api.units.onChange(({ distance, coordinate }) => render())
```

If a plugin renders on a tick (e.g. 1 Hz panel re-render), it'll
pick up changes automatically on the next tick — `onChange` is for
plugins that want instant response.

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
