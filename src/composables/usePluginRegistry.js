import { ref, computed, watch, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, emit } from '@tauri-apps/api/event'
import { useFeaturesStore } from '@/stores/features'
import { useTracksStore } from '@/stores/tracks'
import { useSettingsStore } from '@/stores/settings'
import { getStore } from '@/plugins/store'
import { isOverWater, getLandPolygons } from '@/services/coastlines'
import { formatDistance, formatSpeed } from '@/services/geometry'
import { formatCoordinate } from '@/services/coordinates'
import { version as HOST_VERSION } from '../../package.json'
import {
  register as registerAssistantTools,
  unregister as unregisterAssistantTools,
  getByName as getAssistantToolByName
} from '@/services/assistant/toolRegistry'

// Derive a short slug from a reverse-domain plugin id for use as a
// tool-name prefix. We take the trailing segment ("com.ares.weather"
// → "weather") and lowercase + sanitize to `[a-z0-9_]`. Falls back to
// `plugin` for ids that don't fit the reverse-domain shape.
function _toolSlug(pluginId) {
  const trail = String(pluginId ?? '').split('.').pop() ?? ''
  const slug  = trail.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return slug || 'plugin'
}

// Compare two `MAJOR.MINOR.PATCH` strings. Returns -1, 0, +1. Anything
// non-numeric in a slot is treated as 0; trailing slots default to 0 so
// "1.1" and "1.1.0" compare equal. Pre-release / build metadata (`-rc.1`,
// `+sha`) is ignored — plugins shouldn't depend on it for gating.
function compareSemver(a, b) {
  const parse = (s) => String(s ?? '').split('-')[0].split('+')[0].split('.')
    .map(n => Number.parseInt(n, 10) || 0)
  const ax = parse(a)
  const bx = parse(b)
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const av = ax[i] ?? 0
    const bv = bx[i] ?? 0
    if (av !== bv) return av < bv ? -1 : 1
  }
  return 0
}

/**
 * Sanitise a plugin's `manifest.provides` block into a predictable
 * shape: three arrays of plain `{ name|id, label, description }`
 * entries. Returns empty arrays for any field the plugin omitted or
 * mistyped. Defensive — manifest content comes from the plugin
 * loader (an arbitrary JS file on disk), so we don't trust the
 * shape blindly.
 */
function normaliseProvides(raw) {
  const block = raw && typeof raw === 'object' ? raw : {}
  const safeStr = (v) => typeof v === 'string' ? v : ''
  const tools = Array.isArray(block.tools) ? block.tools.map(t => ({
    name:        safeStr(t?.name),
    description: safeStr(t?.description)
  })).filter(t => t.name) : []
  const mapIded = (arr) => Array.isArray(arr) ? arr.map(e => ({
    id:          safeStr(e?.id),
    label:       safeStr(e?.label) || safeStr(e?.id),
    description: safeStr(e?.description)
  })).filter(e => e.id) : []
  return {
    tools,
    avoidances: mapIded(block.avoidances),
    evaluators: mapIded(block.evaluators)
  }
}

export function usePluginRegistry({ flyToGeometry, getMap = () => null }) {
  const featuresStore = useFeaturesStore()
  const tracksStore   = useTracksStore()
  const settingsStore = useSettingsStore()

  // Map<pluginId, Array<buttonDef>> — reassigned (not mutated) to stay reactive.
  const _buttons  = ref(new Map())
  // Map<pluginId, manifest> — kept outside reactivity, not rendered directly.
  const _manifests = new Map()
  // Map<pluginId, Array<cleanupFn>>
  const _cleanups  = new Map()

  // Per-plugin live state for the new map / panel surfaces. Tracked here so
  // _runCleanup(id) can tear them down without each plugin having to remember
  // to do it in onDeactivate.
  //
  // Map<pluginId, Set<layerId>>
  const _layers   = new Map()
  // Map<pluginId, Set<imageId>> — sprites registered via api.map.addImage
  const _images   = new Map()
  // Map<layerId, resolveOwner(feature) → OwnerRef|null> — opt-in
  // selection bridge for plugin-rendered map layers. Populated by
  // `api.map.addLayer({ ..., snapResolver })`. The host's selection
  // composables (perimeter, bloodhound) consult this to treat plugin
  // layers as snap targets and map their features back to a host
  // owner ref ({kind:'cot', uid}, etc.) — without this, clicks on a
  // plugin's custom sprite never reach the selection logic.
  const _snapResolvers = new Map()
  // Subscribers notified whenever a plugin adds or removes a map layer.
  // Lets host composables (e.g. useMapTracks lifting breadcrumbs above
  // plugin sprites) re-assert their preferred z-order without polling.
  const _layerChangeHandlers = new Set()
  function _notifyLayerChange() {
    for (const fn of _layerChangeHandlers) {
      try { fn() } catch (err) {
        console.warn('[plugin-registry] layer-change handler threw:', err)
      }
    }
  }
  // Map<pluginId, Map<toolName, registryToken>> — assistant tools
  // registered via api.tools.register. One token per tool so we can
  // unregister individually.
  const _tools    = new Map()
  // Map<pluginId, Set<kind>> — connection kinds the plugin owns via
  // api.connections.registerKind.
  const _conns    = new Map()
  // Flat Map<kind, { ownerPluginId, onPacket }> for the global
  // connection-packet dispatcher. Faster than walking every plugin's
  // set on each inbound packet.
  const _connKinds = new Map()
  // Routing contribution registries — populated via
  // `api.routing.registerAvoidance` / `registerEvaluator` (plugins) and
  // `_hostRegisterAvoidance` / `_hostRegisterEvaluator` (built-ins like
  // the surface-track avoidance the host owns directly). Flat maps for
  // O(1) lookup by id; per-plugin sets so we can clean up everything
  // a plugin contributed when it's disabled.
  //
  // Avoidance entries:  Map<id, { ownerPluginId|null, label, description, paramsSchema, getObstacles }>
  // Evaluator entries:  Map<id, { ownerPluginId|null, label, description, paramsSchema, sampleAt }>
  const _avoidances        = new Map()
  const _evaluators        = new Map()
  const _avoidancesByPlugin = new Map()
  const _evaluatorsByPlugin = new Map()

  // Manifest-declared capabilities, indexed at plugin discovery
  // (`registerPlugin`) regardless of whether the plugin is later
  // activated. Lets the assistant surface what a *disabled* plugin
  // *would* contribute, so it can tell the operator "enable plugin X
  // to use Y" instead of just shrugging.
  //
  // Each plugin's manifest can carry an optional `provides` block:
  //   provides: {
  //     tools:      [{ name, description }],
  //     avoidances: [{ id, label, description }],
  //     evaluators: [{ id, label, description }]
  //   }
  // Plugins without `provides` work exactly as before — their
  // disabled state simply isn't advertised.
  //
  // Map<pluginId, { tools, avoidances, evaluators }>
  const _provides = new Map()
  // Set once we've installed the global `connection-packet` listener
  // so we don't double-subscribe.
  let _connPacketUnsubscribe = null
  // Map<pluginId, Array<{ event, handler, mapHandler }>>
  const _events   = new Map()
  // Map<panelId, panelDef> — global, but each entry carries its owner pluginId.
  const _panels = ref(new Map())
  // Reactive Set of open panel IDs. Lifted out of each panel entry because
  // refs nested in plain objects don't propagate reliably through v-for +
  // v-show in templates (Vue tracks the ref access, but the v-for loop
  // re-evaluation depends on the outer collection — easier to drive
  // openness off a single top-level Set).
  const _openPanelIds = ref(new Set())

  // `incompatible: true` blocks activation entirely (toggle is disabled in
  // the Plugins settings tab). `error` carries the human-readable reason —
  // either a host-version mismatch or an exception thrown during activate().
  const discoveredPlugins = ref([])  // { id, name, version, filePath, active, error, incompatible }

  // ---- API builder ----

  function _buildApi(manifest) {
    const cleanups = []
    _cleanups.set(manifest.id, cleanups)
    if (!_layers.has(manifest.id)) _layers.set(manifest.id, new Set())
    if (!_images.has(manifest.id)) _images.set(manifest.id, new Set())
    if (!_tools.has(manifest.id))  _tools.set(manifest.id,  new Map())
    if (!_conns.has(manifest.id))  _conns.set(manifest.id,  new Set())
    if (!_events.has(manifest.id)) _events.set(manifest.id, [])
    if (!_avoidancesByPlugin.has(manifest.id)) _avoidancesByPlugin.set(manifest.id, new Set())
    if (!_evaluatorsByPlugin.has(manifest.id)) _evaluatorsByPlugin.set(manifest.id, new Set())

    _ensureConnectionPacketDispatcher()

    function _resolveBeforeId(beforeId) {
      // Default / '@top' → append on top of everything (current
      // behavior). Specific id → pass through. '@bottom' → walk the
      // current style and return the id of the first non-basemap
      // layer, so the new layer ends up just above the basemap and
      // below every other host or plugin layer.
      if (!beforeId || beforeId === '@top') return undefined
      if (beforeId !== '@bottom') return beforeId
      const map = getMap()
      if (!map) return undefined
      const layers = map.getStyle()?.layers ?? []
      let pastBasemap = false
      for (const l of layers) {
        if (l.id === 'basemap-tiles') { pastBasemap = true; continue }
        if (pastBasemap) return l.id
      }
      // If we never crossed the basemap (e.g. style has no
      // `basemap-tiles` because the operator picked a different
      // basemap) just return the first layer id, which is still the
      // bottom of the stack.
      return layers[0]?.id
    }

    function _captureMapState() {
      const map = getMap()
      if (!map) return null
      const b = map.getBounds()
      const c = map.getCenter()
      return {
        bounds: {
          north: b.getNorth(),
          south: b.getSouth(),
          east:  b.getEast(),
          west:  b.getWest()
        },
        center:  { lng: c.lng, lat: c.lat },
        zoom:    map.getZoom(),
        bearing: map.getBearing(),
        pitch:   map.getPitch()
      }
    }

    function _onMapEvent(event, handler) {
      const map = getMap()
      if (!map) {
        console.warn(`[plugin:${manifest.id}] map not ready; ${event} listener ignored`)
        return () => {}
      }
      const wrapped = () => {
        try { handler(_captureMapState()) }
        catch (err) { console.error(`[plugin:${manifest.id}] error in ${event} handler:`, err) }
      }
      map.on(event, wrapped)
      const entry = { event, handler, mapHandler: wrapped }
      _events.get(manifest.id).push(entry)
      const unregister = () => {
        const m = getMap()
        if (m) m.off(event, wrapped)
        const list = _events.get(manifest.id) ?? []
        const i = list.indexOf(entry)
        if (i >= 0) list.splice(i, 1)
      }
      cleanups.push(unregister)
      return unregister
    }

    return {
      plugin: { id: manifest.id, name: manifest.name, version: manifest.version },

      features: computed(() => featuresStore.features),
      tracks:   computed(() => [...tracksStore.tracks.values()]),

      // Track visibility — the host's track-list panel lets the
      // operator hide individual CoT tracks. Host layers (track
      // dots, breadcrumbs, perimeter, bloodhound) all skip hidden
      // uids; plugin-rendered sprites should respect the same
      // toggle so the sprite, host marker, and breadcrumb stay
      // consistent. `isHidden(uid)` is a synchronous check;
      // `onHiddenChange(handler)` fires whenever the hidden set
      // changes, with the new set as a fresh `Set<string>`. The
      // returned unregister fn is also auto-cleaned on plugin
      // deactivation.
      trackVisibility: {
        isHidden(uid) {
          return tracksStore.hiddenIds.has(uid)
        },
        // Write-through so a plugin's own visibility toggle (e.g.
        // Armada SA's eye button on each craft card) flips the host
        // hidden gate too. Without this, host-side consumers of
        // `hiddenIds` (perimeter breach detection, breadcrumb,
        // bloodhound) keep treating the track as live and pick it
        // up — even though the plugin sprite is hidden. Idempotent;
        // only mutates when the state actually changes.
        setHidden(uid, hidden) {
          if (typeof uid !== 'string' || !uid) return
          const want = !!hidden
          const has  = tracksStore.hiddenIds.has(uid)
          if (want === has) return
          const next = new Set(tracksStore.hiddenIds)
          if (want) next.add(uid)
          else      next.delete(uid)
          tracksStore.hiddenIds = next
        },
        onHiddenChange(handler) {
          if (typeof handler !== 'function') return () => {}
          const stop = watch(
            () => tracksStore.hiddenIds,
            (next) => {
              try { handler(new Set(next)) }
              catch (err) {
                console.warn(`[plugin:${manifest.id}] trackVisibility.onHiddenChange threw:`, err)
              }
            }
          )
          cleanups.push(stop)
          return stop
        }
      },

      updateFeature: (id, geometry, properties) =>
        featuresStore.updateFeature(id, geometry, properties),
      addFeature: (type, geometry, properties) =>
        featuresStore.addFeature(type, geometry, properties),
      removeFeature: (id) =>
        featuresStore.removeFeature(id),

      flyToGeometry,

      // ---- Map surface ----
      // Plugins can draw their own MapLibre layers, read viewport state, and
      // subscribe to viewport-change events. Layer ids must be unique across
      // the whole map; the registry rejects collisions before touching state.
      map: {
        addLayer({ id, source, layer, onClick, onHover, onHoverEnd, beforeId, snapResolver }) {
          const map = getMap()
          if (!map) throw new Error('Map not ready yet. Plugins normally activate after the map loads; if you see this from a long-lived watcher, defer the call.')
          if (!id || typeof id !== 'string') throw new Error('addLayer: id is required')
          if (map.getLayer(id) || map.getSource(id)) {
            throw new Error(`addLayer: id "${id}" already in use`)
          }
          map.addSource(id, source)
          // `beforeId` controls where the layer is inserted in the
          // map's layer stack:
          //   undefined / '@top' → append (default, on top of everything)
          //   '@bottom'          → just above the basemap, below all
          //                        host operator layers (tracks, features,
          //                        annotations, etc.) — useful for
          //                        encompassing background overlays like
          //                        a heatmap that should sit under tracks
          //   any other string   → passed straight through to MapLibre
          //                        as a specific anchor layer id
          map.addLayer({ ...layer, id, source: id }, _resolveBeforeId(beforeId))
          _layers.get(manifest.id).add(id)
          if (typeof snapResolver === 'function') {
            _snapResolvers.set(id, snapResolver)
          }
          _notifyLayerChange()

          // Optional click + hover callbacks. Cursor turns to a pointer
          // on hover whenever any interaction handler is registered, so
          // the layer reads as interactive.
          const interactive = typeof onClick === 'function'
                           || typeof onHover === 'function'
                           || typeof onHoverEnd === 'function'
          let clickHandler, moveHandler, enterHandler, leaveHandler
          function payload(e) {
            return {
              feature:      e.features?.[0] ?? null,
              lngLat:       { lng: e.lngLat.lng, lat: e.lngLat.lat },
              point:        { x: e.point.x, y: e.point.y },
              originalEvent: e.originalEvent
            }
          }
          if (typeof onClick === 'function') {
            clickHandler = (e) => {
              try { onClick(payload(e)) }
              catch (err) { console.error(`[plugin:${manifest.id}] click handler for "${id}" threw:`, err) }
            }
            map.on('click', id, clickHandler)
          }
          if (typeof onHover === 'function') {
            // mousemove fires both on enter and on every cursor motion
            // over the layer; that's what tooltips want (positions the
            // tip near the live cursor).
            moveHandler = (e) => {
              try { onHover(payload(e)) }
              catch (err) { console.error(`[plugin:${manifest.id}] hover handler for "${id}" threw:`, err) }
            }
            map.on('mousemove', id, moveHandler)
          }
          if (interactive) {
            enterHandler = () => { map.getCanvas().style.cursor = 'pointer' }
            leaveHandler = () => {
              map.getCanvas().style.cursor = ''
              if (typeof onHoverEnd === 'function') {
                try { onHoverEnd() }
                catch (err) { console.error(`[plugin:${manifest.id}] hoverEnd handler for "${id}" threw:`, err) }
              }
            }
            map.on('mouseenter', id, enterHandler)
            map.on('mouseleave', id, leaveHandler)
          }

          const unregister = () => {
            const m = getMap()
            if (!m) return
            if (clickHandler) m.off('click',      id, clickHandler)
            if (moveHandler)  m.off('mousemove',  id, moveHandler)
            if (enterHandler) m.off('mouseenter', id, enterHandler)
            if (leaveHandler) m.off('mouseleave', id, leaveHandler)
            if (m.getLayer(id))  m.removeLayer(id)
            if (m.getSource(id)) m.removeSource(id)
            _layers.get(manifest.id)?.delete(id)
            _snapResolvers.delete(id)
            _notifyLayerChange()
          }
          cleanups.push(unregister)
          // Return the unregister fn — historical shape — but also hang
          // a `setData` method off it so plugins can update the layer's
          // GeoJSON source without removing + re-adding the layer (which
          // would flicker and require capturing a new unregister ref each
          // round). Only meaningful for `geojson` sources.
          unregister.setData = (data) => {
            const m = getMap()
            const src = m?.getSource(id)
            if (src && typeof src.setData === 'function') src.setData(data)
          }
          return unregister
        },

        getState: _captureMapState,
        onMove:   (handler) => _onMapEvent('moveend', handler),
        onZoom:   (handler) => _onMapEvent('zoomend', handler),

        // Register a sprite image with the map's style so it can be
        // referenced from `icon-image` in symbol layers — useful for
        // plugins that want to avoid `text-field` (which triggers
        // glyph-server fetches) in favour of self-contained PNGs they
        // bake themselves via canvas.
        //
        // `image` accepts anything MapLibre's `map.addImage` does:
        // HTMLImageElement, HTMLCanvasElement, ImageBitmap, ImageData,
        // or { width, height, data: Uint8Array }. `options` passes
        // through (`pixelRatio`, `sdf`, `content`, `stretchX/Y`).
        //
        // Returns an unregister fn (consistent with addLayer). All
        // images are also auto-removed on plugin deactivation.
        addImage(id, image, options = {}) {
          const map = getMap()
          if (!map) throw new Error('Map not ready yet.')
          if (!id || typeof id !== 'string') throw new Error('addImage: id is required')
          if (map.hasImage(id)) {
            throw new Error(`addImage: id "${id}" already in use`)
          }
          map.addImage(id, image, options)
          _images.get(manifest.id).add(id)
          const unregister = () => {
            const m = getMap()
            if (m && m.hasImage(id)) m.removeImage(id)
            _images.get(manifest.id)?.delete(id)
          }
          cleanups.push(unregister)
          return unregister
        },

        // Imperative removal — use the unregister fn returned by
        // addImage instead when possible. Provided for symmetry and
        // for cases where the plugin loses the unregister reference.
        removeImage(id) {
          const map = getMap()
          if (map && map.hasImage(id)) map.removeImage(id)
          _images.get(manifest.id)?.delete(id)
        }
      },

      // ---- UI ----
      registerToolbarButton(btn) {
        const current = _buttons.value.get(manifest.id) ?? []
        _buttons.value = new Map(_buttons.value.set(manifest.id, [...current, btn]))
        const unregister = () => {
          const updated = (_buttons.value.get(manifest.id) ?? []).filter(b => b.id !== btn.id)
          _buttons.value = new Map(_buttons.value.set(manifest.id, updated))
        }
        cleanups.push(unregister)
        return unregister
      },

      registerPanel(def) {
        if (!def?.id || typeof def.id !== 'string') throw new Error('registerPanel: id is required')
        if (_panels.value.has(def.id)) throw new Error(`registerPanel: id "${def.id}" already in use`)
        if (typeof def.mount !== 'function') throw new Error('registerPanel: mount(containerEl) is required')
        const entry = {
          id:              def.id,
          title:           def.title ?? manifest.name,
          icon:            def.icon  ?? null,
          // Optional inline SVG markup rendered in the header in
          // place of the MDI icon. Useful when the plugin needs
          // domain-specific iconography that MDI doesn't carry
          // (e.g. a jetski silhouette). When both `icon` and
          // `iconSvg` are present, `iconSvg` wins.
          iconSvg:         typeof def.iconSvg === 'string' ? def.iconSvg : null,
          // Optional pinned width in px. Applied to the panel
          // container so collapsing the body via the chevron
          // doesn't shrink the panel to header-content width.
          width:           Number.isFinite(def.width) ? def.width : null,
          // Optional HTML for an info-legend popover anchored to a
          // small mdi-information-outline button next to the title.
          // Hovering the button reveals the legend. Lets plugins
          // explain their colour codes / glyph meanings without
          // burning a row inside the panel body. Plugins are
          // trusted code, so HTML is rendered via `v-html`.
          infoHtml:        typeof def.infoHtml === 'string' ? def.infoHtml : null,
          initialPosition: def.initialPosition ?? { x: 60, y: 80 },
          mount:           def.mount,
          ownerId:         manifest.id
        }
        _panels.value = new Map(_panels.value.set(def.id, entry))

        function _setOpen(open) {
          const next = new Set(_openPanelIds.value)
          if (open) next.add(def.id)
          else      next.delete(def.id)
          _openPanelIds.value = next
        }
        const handle = {
          open()   { _setOpen(true) },
          close()  { _setOpen(false) },
          toggle() { _setOpen(!_openPanelIds.value.has(def.id)) },
          get isOpen() { return _openPanelIds.value.has(def.id) }
        }
        const unregister = () => {
          _setOpen(false)
          const next = new Map(_panels.value)
          next.delete(def.id)
          _panels.value = next
        }
        cleanups.push(unregister)
        return handle
      },

      // ---- Coastlines ----
      // Bundled Natural Earth 10 m land dataset, exposed so plugins can
      // pre-filter "is this point over water?" or pull land polygons for
      // a bbox to use as a clipping mask. First call lazy-loads ~10 MB;
      // subsequent calls are fast.
      land: {
        isOverWater(coord)         { return isOverWater(coord) },
        getLandPolygons(bbox)      { return getLandPolygons(bbox) }
      },

      // ---- Network connections ----
      // Plugins can declare their own UDP / TCP connection kinds. The
      // host materializes each as a row in Settings → Connections,
      // owns the socket lifecycle, and forwards inbound bytes to the
      // plugin's `onPacket` callback. The user controls address /
      // port / enabled in the Connections UI; the plugin name is
      // fixed by `label`. Plugin-owned rows can't be deleted from
      // the UI — only the plugin can unregister them.
      //
      // The socket runs only when BOTH the plugin is enabled (via
      // Settings → Plugins) AND the connection's `enabled` toggle in
      // the Connections panel is on. Disabling either drops the
      // socket; enabling both resumes it.
      connections: {
        registerKind({ kind, label, description, protocol = 'udp', defaults, onPacket }) {
          if (typeof kind !== 'string' || !kind) {
            throw new Error('connections.registerKind: `kind` is required')
          }
          if (typeof label !== 'string' || !label) {
            throw new Error('connections.registerKind: `label` is required')
          }
          if (typeof onPacket !== 'function') {
            throw new Error('connections.registerKind: `onPacket(bytes, src)` is required')
          }
          const d = defaults ?? {}
          if (typeof d.address !== 'string' || !d.address) {
            throw new Error('connections.registerKind: `defaults.address` is required')
          }
          if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
            throw new Error('connections.registerKind: `defaults.port` must be 1–65535')
          }
          // Collision check: only this plugin can register/replace its
          // own kinds; another plugin trying to grab the same `kind`
          // throws so the second plugin can pick a different name.
          const existing = _connKinds.get(kind)
          if (existing && existing.ownerPluginId !== manifest.id) {
            throw new Error(
              `connections.registerKind: kind "${kind}" already registered by ${existing.ownerPluginId}`
            )
          }
          _connKinds.set(kind, { ownerPluginId: manifest.id, onPacket })
          _conns.get(manifest.id).add(kind)

          // Seed / refresh the row in the connections store and flip
          // it on. Connection lifecycle mirrors plugin lifecycle:
          // registering = the plugin is active = the socket runs. The
          // user toggles the plugin (Settings → Plugins) to control
          // both. Address / port / protocol edits made via the
          // Connections panel still persist across reloads.
          settingsStore.upsertPluginConnection({
            kind,
            name:           label,
            ownerPluginId:  manifest.id,
            defaultAddress: d.address,
            defaultPort:    d.port,
            defaultProtocol: protocol
          }).then(async (row) => {
            await settingsStore.setConnectionEnabledByKind(kind, true)
            invoke('start_listener', {
              address:  row.address,
              port:     row.port,
              protocol: row.protocol ?? 'udp',
              kind:     row.kind,
              parser:   'raw'
            }).catch(err => {
              console.error(`[connections] failed to start ${kind}:`, err)
            })
          })

          const unregister = () => {
            // Stop the socket and flip the row off so the disabled
            // state is reflected in Settings → Connections (and so a
            // host restart while the plugin is disabled doesn't
            // resurrect the socket).
            const row = settingsStore.connections.find(c => c.kind === kind)
            if (row) {
              invoke('stop_listener', { address: row.address, port: row.port })
                .catch(() => {})
              settingsStore.setConnectionEnabledByKind(kind, false).catch(() => {})
            }
            _connKinds.delete(kind)
            _conns.get(manifest.id)?.delete(kind)
            // The row itself stays — address / port / protocol edits
            // survive plugin disable/enable cycles.
          }
          cleanups.push(unregister)
          return unregister
        }
      },

      // ---- Route planning contributions ----
      // Plugins can teach the host's route planner about new
      // avoidance constraints (areas a route should not enter)
      // and evaluators (point-sampled values the assistant can
      // walk along an existing route). Both registries are
      // keyed by `id`; the assistant discovers them via the
      // `routing_list_avoidances` / `routing_list_evaluators`
      // tools. Clean-up on plugin disable removes the plugin's
      // entries from both registries.
      routing: {
        registerAvoidance(spec)  { return _registerRouting('avoidance', manifest.id, cleanups, spec) },
        registerEvaluator(spec)  { return _registerRouting('evaluator', manifest.id, cleanups, spec) }
      },

      // ---- Host display preferences ----
      // Mirror the user's distance-unit and coordinate-format
      // settings so plugin panels render consistently with the
      // rest of the app. Getters return the live value (a setting
      // change between calls is reflected immediately); the
      // `format.*` helpers wrap the same `services/{geometry,
      // coordinates}.js` functions the host itself uses.
      //
      // For reactive re-render on a setting change, plugins can
      // subscribe via `api.units.onChange(handler)` — auto-cleaned
      // on plugin disable.
      units: {
        get distance()   { return settingsStore.distanceUnits },
        get coordinate() { return settingsStore.coordinateFormat },
        onChange(handler) {
          if (typeof handler !== 'function') {
            throw new Error('units.onChange: handler is required')
          }
          const stop = watch(
            () => [settingsStore.distanceUnits, settingsStore.coordinateFormat],
            () => {
              try { handler({
                distance:   settingsStore.distanceUnits,
                coordinate: settingsStore.coordinateFormat
              }) }
              catch (err) {
                console.error(`[plugin:${manifest.id}] units.onChange handler threw:`, err)
              }
            }
          )
          cleanups.push(stop)
          return stop
        }
      },
      format: {
        distance(meters)  { return formatDistance(meters, settingsStore.distanceUnits) },
        speed(mps)        { return formatSpeed(mps, settingsStore.distanceUnits) },
        coordinate(lng, lat) { return formatCoordinate(lng, lat, settingsStore.coordinateFormat) }
      },

      // ---- Display toggles ----
      // Host-wide visual prefs that aren't units. Plugins rendering
      // their own labels / overlays should respect these so a user
      // toggling the global "Show feature labels" switch flips
      // plugin labels too. Currently exposes:
      //   - showLabels: mirrors `settingsStore.showFeatureLabels`,
      //     the same setting that drives the host CoT label layer.
      // Forward-extensible: future host prefs (theme, MIL-STD
      // symbology, etc.) can land here without breaking plugins.
      display: {
        get showLabels() { return settingsStore.showFeatureLabels },
        onChange(handler) {
          if (typeof handler !== 'function') {
            throw new Error('display.onChange: handler is required')
          }
          const stop = watch(
            () => settingsStore.showFeatureLabels,
            () => {
              try { handler({ showLabels: settingsStore.showFeatureLabels }) }
              catch (err) {
                console.error(`[plugin:${manifest.id}] display.onChange handler threw:`, err)
              }
            }
          )
          cleanups.push(stop)
          return stop
        }
      },

      // ---- CoT bridge ----
      // Plugins ingesting CoT from a non-host source (TAK Server SSL,
      // a custom gateway, a PCAP replay) can inject a parsed CoT
      // event directly into the host's pipeline. The event flows
      // through the same `cot-event` channel the host's protected
      // listeners use, so all the existing track / chat / annotation
      // stores pick it up unchanged.
      cot: {
        // Parse raw CoT bytes (XML or TAK Protocol v1) into the host's
        // event shape. Returns the parsed event on success, or `null`
        // if the bytes weren't a valid CoT message — plugins owning a
        // raw socket use this to decode their own packets before
        // calling `cot.emit`. The error is swallowed (and logged once
        // per call) because plugin sockets routinely receive
        // non-CoT noise on shared multicast groups.
        async parse(bytes) {
          const buf = bytes instanceof Uint8Array ? Array.from(bytes) : bytes
          try {
            return await invoke('parse_cot_bytes', { bytes: buf })
          } catch (err) {
            console.warn(`[plugin:${manifest.id}] cot.parse failed:`, err)
            return null
          }
        },

        emit(event) {
          if (!event || typeof event !== 'object') {
            throw new Error('cot.emit: event is required')
          }
          if (typeof event.uid !== 'string' || !event.uid) {
            throw new Error('cot.emit: event.uid is required')
          }
          if (typeof event.cot_type !== 'string' || !event.cot_type) {
            // Tolerate `cotType` (camelCase) too — the rest of the host
            // exposes camelCase JS, but the on-wire field is `cot_type`.
            if (typeof event.cotType === 'string' && event.cotType) {
              event.cot_type = event.cotType
            } else {
              throw new Error('cot.emit: event.cot_type is required')
            }
          }
          if (!Number.isFinite(event.lat) || !Number.isFinite(event.lon)) {
            throw new Error('cot.emit: event.lat and event.lon must be finite numbers')
          }
          // Sane defaults for fields the parsed-CoT shape expects.
          const out = {
            uid:      event.uid,
            cot_type: event.cot_type,
            lat:      event.lat,
            lon:      event.lon,
            hae:      Number.isFinite(event.hae) ? event.hae : 0,
            speed:    Number.isFinite(event.speed) ? event.speed : 0,
            course:   Number.isFinite(event.course) ? event.course : 0,
            callsign: event.callsign ?? event.uid,
            time:     event.time  ?? new Date().toISOString(),
            stale:    event.stale ?? new Date(Date.now() + 60_000).toISOString(),
            ...event,
            // Opt-in: when true, host suppresses its default marker
            // (cot-tracks-points / -symbols / -labels) and excludes
            // the entity from the generic Track-List panel. The
            // entity still flows through history accumulation,
            // breadcrumbs, perimeter / bloodhound targetability,
            // route avoidance, and assistant lookups — only the
            // generic UI surfaces are skipped. Use when the plugin
            // renders its own sprite + panel for this entity.
            // Strict boolean coercion (post-spread) so plugins can't
            // accidentally enable the gate with a truthy non-bool.
            pluginManaged: event.pluginManaged === true,
            // Auto-stamped ownership so `_runCleanup(id)` can sweep
            // a plugin's bridged tracks the instant it deactivates
            // (otherwise the track sticks around for up to one
            // 90 s stale window after disable, leaving an orphan
            // breadcrumb on the map). Only stamped when the emitter
            // explicitly opts into pluginManaged — non-managed
            // bridges (Persistent Systems-style relays) intentionally
            // outlive the plugin's session.
            pluginOwner: event.pluginManaged === true ? manifest.id : null
          }
          return emit('cot-event', out)
        }
      },

      // ---- Assistant tools ----
      // Plugins can register tools the embedded AI assistant can call.
      // Names are auto-prefixed with a slug derived from the plugin id
      // (e.g. com.ares.weather → "weather_") so plugins don't collide
      // with each other or with the host's built-in tool families
      // (cot_*, ais_*, adsb_*, route_*, …). If the plugin author
      // already supplied the prefix, we leave the name alone.
      //
      // Tool defs flow through the same registry (and the same
      // confirmation flow for `readonly: false` tools) the host uses
      // internally — see src/services/assistant/turnRunner.js.
      tools: {
        register({ name, description, inputSchema, readonly = false, execute, previewRender }) {
          if (typeof name !== 'string' || !name) {
            throw new Error('tools.register: `name` is required')
          }
          if (typeof execute !== 'function') {
            throw new Error('tools.register: `execute(args)` is required')
          }
          const slug = _toolSlug(manifest.id)
          const fullName = name.startsWith(`${slug}_`) ? name : `${slug}_${name}`
          if (_tools.get(manifest.id).has(fullName)) {
            throw new Error(`tools.register: "${fullName}" already registered by this plugin`)
          }
          if (getAssistantToolByName(fullName)) {
            throw new Error(`tools.register: "${fullName}" collides with an existing tool`)
          }
          const def = {
            name:        fullName,
            description: description ?? '',
            inputSchema: inputSchema ?? { type: 'object', properties: {} },
            handler:     async (args) => execute(args),
            readonly,
            ...(typeof previewRender === 'function' ? { previewRender } : {})
          }
          const token = registerAssistantTools([def])
          _tools.get(manifest.id).set(fullName, token)
          const unregister = () => {
            const t = _tools.get(manifest.id)?.get(fullName)
            if (t) {
              unregisterAssistantTools(t)
              _tools.get(manifest.id).delete(fullName)
            }
          }
          cleanups.push(unregister)
          return unregister
        },

        unregister(name) {
          const slug = _toolSlug(manifest.id)
          const fullName = name.startsWith(`${slug}_`) ? name : `${slug}_${name}`
          const token = _tools.get(manifest.id)?.get(fullName)
          if (!token) return
          unregisterAssistantTools(token)
          _tools.get(manifest.id).delete(fullName)
        }
      },

      // ---- Plugin-scoped persistent settings ----
      // All keys are namespaced under `plugin:<pluginId>:<key>` in the same
      // tauri-plugin-store the rest of the app uses, so plugins can't collide
      // with each other or with host settings.
      settings: {
        async get(key)        { return (await getStore()).get(`plugin:${manifest.id}:${key}`) },
        async set(key, value) { await (await getStore()).set(`plugin:${manifest.id}:${key}`, value) },
        async delete(key)     { await (await getStore()).delete(`plugin:${manifest.id}:${key}`) },
        async keys() {
          const store = await getStore()
          const all = await store.keys()
          const prefix = `plugin:${manifest.id}:`
          return all.filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
        }
      },

      onDeactivate(fn) { cleanups.push(fn) },

      log(...args) { console.log(`[plugin:${manifest.id}]`, ...args) }
    }
  }

  /**
   * Shared registration path for both `registerAvoidance` and
   * `registerEvaluator`. `kind` is `'avoidance'` or `'evaluator'`;
   * the rest of the validation rules are identical so it lives in
   * one place. `cleanups` is the per-activation cleanup list — we
   * push an unregister fn there so the plugin's contributions are
   * removed atomically when it disables.
   *
   * Host-internal callers (`_hostRegisterAvoidance` etc.) bypass
   * this helper and write to the registries directly; they have no
   * pluginId to track and no cleanup list to push into.
   */
  function _registerRouting(kind, ownerPluginId, cleanups, spec) {
    const isEval = kind === 'evaluator'
    const noun   = isEval ? 'registerEvaluator' : 'registerAvoidance'
    if (!spec || typeof spec.id !== 'string' || !spec.id) {
      throw new Error(`routing.${noun}: \`id\` is required`)
    }
    if (typeof spec.label !== 'string' || !spec.label) {
      throw new Error(`routing.${noun}: \`label\` is required`)
    }
    const callback = isEval ? spec.sampleAt : spec.getObstacles
    if (typeof callback !== 'function') {
      throw new Error(`routing.${noun}: \`${isEval ? 'sampleAt' : 'getObstacles'}\` is required`)
    }
    const registry  = isEval ? _evaluators        : _avoidances
    const ownerSets = isEval ? _evaluatorsByPlugin : _avoidancesByPlugin
    if (registry.has(spec.id)) {
      const existing = registry.get(spec.id)
      throw new Error(`routing.${noun}: id "${spec.id}" already registered by ${existing.ownerPluginId ?? '@host'}`)
    }
    registry.set(spec.id, {
      ownerPluginId,
      label:        spec.label,
      description:  spec.description ?? '',
      paramsSchema: spec.paramsSchema ?? { type: 'object', properties: {} },
      ...(isEval ? { sampleAt: spec.sampleAt } : { getObstacles: spec.getObstacles })
    })
    if (ownerPluginId) ownerSets.get(ownerPluginId)?.add(spec.id)
    const unregister = () => {
      registry.delete(spec.id)
      if (ownerPluginId) ownerSets.get(ownerPluginId)?.delete(spec.id)
    }
    if (cleanups) cleanups.push(unregister)
    return unregister
  }

  /**
   * Built-in avoidances / evaluators owned by the host (e.g. the
   * surface-track avoidance whose data lives in tracksStore). Same
   * shape as the plugin API but with no owner / cleanup wiring —
   * host registrations live for the app's lifetime.
   */
  function _hostRegisterAvoidance(spec) {
    return _registerRouting('avoidance', null, null, spec)
  }
  function _hostRegisterEvaluator(spec) {
    return _registerRouting('evaluator', null, null, spec)
  }

  // ---- Internal helpers ----

  /**
   * Install the global `connection-packet` Tauri-event listener that
   * fans inbound bytes out to whichever plugin owns the matching
   * `kind`. Lazy: only attaches on first plugin registration so we
   * don't open a channel listener on a host with zero plugins.
   */
  async function _ensureConnectionPacketDispatcher() {
    if (_connPacketUnsubscribe) return
    try {
      _connPacketUnsubscribe = await listen('connection-packet', (event) => {
        const p = event.payload
        if (!p || typeof p.kind !== 'string') return
        const reg = _connKinds.get(p.kind)
        if (!reg) return  // no plugin owns this kind right now
        try {
          reg.onPacket(
            // Tauri serialises Vec<u8> as Array<number>. Hand plugins a
            // Uint8Array — typed access, .length works the same, and
            // it's the natural shape for protobuf decoders.
            new Uint8Array(p.bytes ?? []),
            { sourceIp: p.source_ip, sourcePort: p.source_port }
          )
        } catch (err) {
          console.error(`[connections] onPacket for "${p.kind}" threw:`, err)
        }
      })
    } catch (err) {
      console.error('[connections] failed to install dispatcher:', err)
    }
  }

  function _patch(id, patch) {
    discoveredPlugins.value = discoveredPlugins.value.map(p =>
      p.id === id ? { ...p, ...patch } : p
    )
  }

  function _runCleanup(id) {
    // Run plugin-registered cleanup functions in reverse (LIFO) so layers
    // / panels / events are torn down in the inverse of registration order.
    const fns = _cleanups.get(id) ?? []
    for (let i = fns.length - 1; i >= 0; i--) {
      try { fns[i]() } catch (e) {
        console.warn(`[plugin-registry] Cleanup error in "${id}":`, e)
      }
    }
    _cleanups.delete(id)

    // Defensive sweep — anything still tracked under this plugin id after
    // explicit cleanups (e.g. a plugin that threw mid-activate before its
    // unregister was pushed) gets removed here.
    const map = getMap()
    if (map) {
      const layersToSweep = _layers.get(id)
      if (layersToSweep && layersToSweep.size > 0) {
        for (const layerId of layersToSweep) {
          try {
            if (map.getLayer(layerId))  map.removeLayer(layerId)
            if (map.getSource(layerId)) map.removeSource(layerId)
          } catch (e) {
            console.warn(`[plugin-registry] Failed to remove layer "${layerId}":`, e)
          }
          _snapResolvers.delete(layerId)
        }
        _notifyLayerChange()
      }
      for (const imageId of _images.get(id) ?? []) {
        try {
          if (map.hasImage(imageId)) map.removeImage(imageId)
        } catch (e) {
          console.warn(`[plugin-registry] Failed to remove image "${imageId}":`, e)
        }
      }
      for (const { event, mapHandler } of _events.get(id) ?? []) {
        try { map.off(event, mapHandler) } catch { /* ignore */ }
      }
    }
    // Tool tokens live in the assistant registry, not on the map —
    // unregister regardless of whether the map exists.
    for (const token of (_tools.get(id)?.values() ?? [])) {
      try { unregisterAssistantTools(token) } catch (e) {
        console.warn(`[plugin-registry] Failed to unregister tool token for "${id}":`, e)
      }
    }
    // Connection kinds: stop sockets and detach the onPacket
    // dispatcher entry. The persisted row stays in
    // settingsStore.connections so the user's address / port edits
    // survive plugin reloads.
    for (const kind of _conns.get(id) ?? []) {
      const row = settingsStore.connections.find(c => c.kind === kind)
      if (row) {
        invoke('stop_listener', { address: row.address, port: row.port })
          .catch(() => {})
        settingsStore.setConnectionEnabledByKind(kind, false).catch(() => {})
      }
      _connKinds.delete(kind)
    }
    // Routing contributions: remove every avoidance / evaluator
    // this plugin registered. The cleanup fns pushed by
    // `_registerRouting` already do this on plugin reload, but the
    // defensive sweep here covers the case where a plugin throws
    // mid-activate before its unregister was tracked.
    for (const aid of _avoidancesByPlugin.get(id) ?? []) _avoidances.delete(aid)
    for (const eid of _evaluatorsByPlugin.get(id) ?? []) _evaluators.delete(eid)
    _avoidancesByPlugin.delete(id)
    _evaluatorsByPlugin.delete(id)

    _layers.delete(id)
    _images.delete(id)
    _tools.delete(id)
    _conns.delete(id)
    _events.delete(id)

    // Plugin-managed CoT bridges: remove every track this plugin
    // emitted with `pluginManaged: true`. Without this, a disabled
    // plugin's last-emitted tracks stay in tracksStore for up to
    // one stale window (90 s by default), so breadcrumbs / perimeter
    // rings / bloodhound lines linger on a map where the plugin
    // sprite has already disappeared. The `pluginOwner` field is
    // auto-stamped by `api.cot.emit`, so plugins don't need any
    // bookkeeping. Non-managed bridges (relays of real wire
    // traffic, e.g. Persistent Systems' radio repeats) keep their
    // tracks; those are intentionally meant to outlive the plugin
    // session.
    if (tracksStore.tracks?.size) {
      const ownedUids = []
      for (const [uid, track] of tracksStore.tracks) {
        if (track.pluginOwner === id) ownedUids.push(uid)
      }
      if (ownedUids.length) {
        const next = new Map(tracksStore.tracks)
        for (const uid of ownedUids) next.delete(uid)
        tracksStore.tracks = next
        if (tracksStore.hiddenIds?.size) {
          const nextHidden = new Set(tracksStore.hiddenIds)
          let dirty = false
          for (const uid of ownedUids) {
            if (nextHidden.delete(uid)) dirty = true
          }
          if (dirty) tracksStore.hiddenIds = nextHidden
        }
      }
    }

    // Remove any orphan panels owned by this plugin and drop them from the
    // open-panels set so they don't render after disable.
    const next = new Map(_panels.value)
    const openNext = new Set(_openPanelIds.value)
    let dirty = false
    for (const [panelId, entry] of next) {
      if (entry.ownerId === id) {
        next.delete(panelId)
        openNext.delete(panelId)
        dirty = true
      }
    }
    if (dirty) {
      _panels.value = next
      _openPanelIds.value = openNext
    }

    // Remove any toolbar buttons owned by this plugin.
    const buttonsNext = new Map(_buttons.value)
    buttonsNext.delete(id)
    _buttons.value = buttonsNext
  }

  function _activate(id) {
    const manifest = _manifests.get(id)
    if (!manifest) return
    try {
      manifest.activate(_buildApi(manifest))
      _patch(id, { active: true, error: null })
    } catch (err) {
      _patch(id, { active: false, error: err?.message ?? String(err) })
      console.error(`[plugin-registry] Failed to activate "${id}":`, err)
    }
  }

  // The plugin registry is owned by MapView's setup. When MapView
  // unmounts (route navigation away from the map), every plugin
  // that registered tools / panels / map layers / connections
  // needs to release them — otherwise on a remount the host
  // re-runs `loadPlugins` and the old tool registrations collide
  // with the new ones (`tools.register: "armada_sa_list" collides
  // with an existing tool`). Walk every plugin we have a cleanup
  // bag for and run the standard teardown.
  onUnmounted(() => {
    for (const id of [..._cleanups.keys()]) {
      try { _runCleanup(id) } catch (err) {
        console.warn(`[plugin-registry] Teardown of "${id}" on unmount failed:`, err)
      }
    }
  })

  // ---- Public API ----

  // Called by pluginLoader for each successfully imported module.
  function registerPlugin(manifest, filePath) {
    if (!manifest?.id || typeof manifest.activate !== 'function') {
      console.warn('[plugin-registry] Skipping invalid plugin manifest from:', filePath)
      return
    }
    _manifests.set(manifest.id, manifest)
    _provides.set(manifest.id, normaliseProvides(manifest.provides))

    // Host-version gate. Plugins may declare `minHostVersion: 'X.Y.Z'` to
    // refuse loading on hosts that don't expose enough of the API surface.
    // We surface the mismatch in the Plugins settings tab and skip
    // activation — even if the plugin is in `enabledPlugins` from a prior
    // session, it stays inert until the host is upgraded.
    let incompatible = false
    let error = null
    if (manifest.minHostVersion) {
      if (compareSemver(HOST_VERSION, manifest.minHostVersion) < 0) {
        incompatible = true
        error = `Requires Ares ≥ ${manifest.minHostVersion}; this host is ${HOST_VERSION}.`
        console.warn(`[plugin-registry] Skipping "${manifest.id}": ${error}`)
      }
    }

    if (!discoveredPlugins.value.find(p => p.id === manifest.id)) {
      discoveredPlugins.value = [
        ...discoveredPlugins.value,
        {
          id:           manifest.id,
          name:         manifest.name    ?? manifest.id,
          version:      manifest.version ?? '?',
          filePath,
          active:       false,
          error,
          incompatible
        }
      ]
    }

    if (!incompatible && settingsStore.enabledPlugins.includes(manifest.id)) {
      _activate(manifest.id)
    }
  }

  /**
   * Re-read the plugin file from disk and replace the cached
   * manifest. Used by `enablePlugin` so a developer iterating on a
   * plugin can rebuild dist/index.js, toggle the plugin off → on,
   * and see the new code without restarting Ares. Each call gets a
   * fresh Blob URL so JS module caching doesn't return the old
   * import. Failures fall through silently — the previously cached
   * manifest is left in place and `_activate` will use it.
   */
  async function _reloadFromDisk(id) {
    const row = discoveredPlugins.value.find(p => p.id === id)
    if (!row?.filePath) return
    try {
      const source = await invoke('read_plugin_file', { path: row.filePath })
      const blob = new Blob([source], { type: 'text/javascript' })
      const url  = URL.createObjectURL(blob)
      try {
        const module = await import(/* @vite-ignore */ url)
        const manifest = module.default
        if (manifest?.id && typeof manifest.activate === 'function') {
          _manifests.set(id, manifest)
          _provides.set(id, normaliseProvides(manifest.provides))
          // Refresh the surface fields so the Plugins settings row
          // reflects e.g. an updated version string.
          _patch(id, {
            name:    manifest.name    ?? manifest.id,
            version: manifest.version ?? '?'
          })
        }
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.warn(`[plugin-registry] Reload from disk failed for "${id}":`, err)
    }
  }

  // Called from SettingsDialog when the user enables a plugin.
  async function enablePlugin(id) {
    const row = discoveredPlugins.value.find(p => p.id === id)
    if (row?.incompatible) return  // toggle is disabled in the UI; belt-and-suspenders
    if (!settingsStore.enabledPlugins.includes(id)) {
      await settingsStore.setSetting('enabledPlugins', [...settingsStore.enabledPlugins, id])
    }
    // Pick up any on-disk edits made since the host loaded. This is
    // what lets `pnpm build` + plugin off/on iterate without an Ares
    // restart.
    await _reloadFromDisk(id)
    _activate(id)
  }

  // Called from SettingsDialog when the user disables a plugin.
  async function disablePlugin(id) {
    await settingsStore.setSetting(
      'enabledPlugins',
      settingsStore.enabledPlugins.filter(p => p !== id)
    )
    _runCleanup(id)
    _patch(id, { active: false })
  }

  // Flat ordered list of all buttons registered across all enabled plugins.
  const allToolbarButtons = computed(() => {
    const result = []
    for (const btns of _buttons.value.values()) result.push(...btns)
    return result
  })

  // Registered panels — `MapView.vue` iterates this and v-shows each
  // open one. Open state is keyed by panel id in `_openPanelIds`.
  const allPanels = computed(() => Array.from(_panels.value.values()))

  function isPanelOpen(id) {
    return _openPanelIds.value.has(id)
  }

  function closePanel(id) {
    if (!_openPanelIds.value.has(id)) return
    const next = new Set(_openPanelIds.value)
    next.delete(id)
    _openPanelIds.value = next
  }

  // Read-side surface for the routing tool / assistant tools.
  // Avoidance and evaluator entries are mutated by plugin
  // enable/disable, so callers should re-read at use time rather
  // than caching the iterators.
  // Compute per-plugin status for the disabled-capability listers.
  // Active = plugin manifest is in `_manifests` AND its row in
  // `discoveredPlugins` is `active: true`. Loaded = manifest is in
  // `_manifests` (regardless of activation). Incompatible = the
  // host-version gate flagged it at registerPlugin time.
  function _pluginStatus(id) {
    const row = discoveredPlugins.value.find(p => p.id === id)
    return {
      id,
      name:         row?.name ?? id,
      loaded:       _manifests.has(id),
      active:       row?.active === true,
      incompatible: row?.incompatible === true
    }
  }
  function _disabledReason(status) {
    if (status.incompatible) return 'plugin_incompatible'
    if (!status.active)      return 'plugin_disabled'
    return 'plugin_not_registered'  // active but didn't register
  }
  function _walkDeclared(kind, registry) {
    // `kind` = 'avoidances' | 'evaluators'. Returns each declared
    // entry (across every loaded plugin) that ISN'T currently in
    // the live registry. Skips plugins whose declaration is empty.
    const out = []
    for (const [pluginId, declared] of _provides.entries()) {
      const list = declared?.[kind] ?? []
      if (!list.length) continue
      const status = _pluginStatus(pluginId)
      for (const d of list) {
        if (registry.has(d.id)) continue   // already live, don't double-list
        out.push({
          id:                   d.id,
          label:                d.label,
          description:          d.description,
          requires_plugin_id:   pluginId,
          requires_plugin_name: status.name,
          plugin_loaded:        status.loaded,
          plugin_active:        status.active,
          plugin_incompatible:  status.incompatible,
          reason:               _disabledReason(status)
        })
      }
    }
    return out
  }

  const routing = {
    listAvoidances() {
      const enabled = [..._avoidances.entries()].map(([id, e]) => ({
        id,
        ownerPluginId: e.ownerPluginId,
        label:         e.label,
        description:   e.description,
        paramsSchema:  e.paramsSchema
      }))
      return { enabled, disabled: _walkDeclared('avoidances', _avoidances) }
    },
    listEvaluators() {
      const enabled = [..._evaluators.entries()].map(([id, e]) => ({
        id,
        ownerPluginId: e.ownerPluginId,
        label:         e.label,
        description:   e.description,
        paramsSchema:  e.paramsSchema
      }))
      return { enabled, disabled: _walkDeclared('evaluators', _evaluators) }
    },
    getAvoidance(id) { return _avoidances.get(id) ?? null },
    getEvaluator(id) { return _evaluators.get(id) ?? null },
    // Lookup helpers for the route tool's error path: when an
    // avoid_extras id isn't live, find which plugin declared it
    // (if any) so the error can name the plugin to enable.
    findDeclaredAvoidance(id) {
      for (const entry of _walkDeclared('avoidances', _avoidances)) {
        if (entry.id === id) return entry
      }
      return null
    },
    findDeclaredEvaluator(id) {
      for (const entry of _walkDeclared('evaluators', _evaluators)) {
        if (entry.id === id) return entry
      }
      return null
    },
    // Host-side built-in registration. Used by MapView to wire
    // the surface-track avoidance once tracksStore is available.
    hostRegisterAvoidance: _hostRegisterAvoidance,
    hostRegisterEvaluator: _hostRegisterEvaluator
  }

  // Plugin-capability discovery. Lets the assistant answer "what
  // can I do, and what would enabling another plugin unlock?". The
  // returned `disabled` array enumerates each loaded but inactive
  // (or incompatible) plugin's declared `provides` block; the
  // assistant uses this to suggest enabling specific plugins
  // instead of failing silently.
  const capabilities = {
    list() {
      // Enabled tools: walk `_tools` for active plugins. Each tool
      // name is the assistant-facing prefixed name (e.g.
      // `armada_sa_list`). Manifests' `provides.tools` carries the
      // same names so the disabled side stays consistent.
      const enabledTools = []
      for (const [pluginId, byName] of _tools.entries()) {
        const status = _pluginStatus(pluginId)
        if (!status.active) continue
        for (const [toolName] of byName.entries()) {
          enabledTools.push({
            name:                 toolName,
            owner_plugin_id:      pluginId,
            owner_plugin_name:    status.name
          })
        }
      }
      const enabledAvoidances = routing.listAvoidances().enabled
      const enabledEvaluators = routing.listEvaluators().enabled

      // Disabled — one block per plugin that's loaded-but-inactive
      // (or incompatible) and declared something. We aggregate by
      // plugin so the assistant has a clear "enable plugin X to
      // unlock all of these" presentation.
      const disabled = []
      for (const [pluginId, declared] of _provides.entries()) {
        const status = _pluginStatus(pluginId)
        if (status.active && !status.incompatible) continue
        const dt = declared.tools.filter(t => !_isToolNameLive(t.name))
        const da = declared.avoidances.filter(a => !_avoidances.has(a.id))
        const de = declared.evaluators.filter(e => !_evaluators.has(e.id))
        if (!dt.length && !da.length && !de.length) continue
        disabled.push({
          plugin: {
            id:           pluginId,
            name:         status.name,
            loaded:       status.loaded,
            active:       status.active,
            incompatible: status.incompatible,
            reason:       _disabledReason(status)
          },
          tools:      dt,
          avoidances: da,
          evaluators: de
        })
      }

      return {
        enabled:  { tools: enabledTools, avoidances: enabledAvoidances, evaluators: enabledEvaluators },
        disabled
      }
    }
  }

  // Helper used by capabilities.list to skip declared tool names
  // that are also live (handles a plugin declaring AND registering).
  function _isToolNameLive(name) {
    if (!name) return false
    for (const byName of _tools.values()) if (byName.has(name)) return true
    return false
  }

  // Snap target accessors for selection composables (perimeter,
  // bloodhound). The composables can't reactively re-bind their click
  // handlers when plugins enable/disable, so they read the live set
  // each click — `layerIds()` returns the snappable plugin layers
  // currently on the map, and `resolve(layerId, feature)` maps a hit
  // back to a host owner ref.
  const snap = {
    layerIds() {
      return [..._snapResolvers.keys()]
    },
    resolve(layerId, feature) {
      const fn = _snapResolvers.get(layerId)
      if (!fn) return null
      try { return fn(feature) ?? null }
      catch (err) {
        console.warn(`[plugin-registry] snapResolver for "${layerId}" threw:`, err)
        return null
      }
    },
    // Lift every plugin-rendered map layer to the top of the
    // MapLibre stack and re-fire the layer-change notification so
    // any host listener (e.g. useMapTracks lifting breadcrumbs
    // above plugin sprites) re-asserts its preferred z-order on
    // top of that. Called by host composables that lazily add
    // their own overlay layers (bloodhound, perimeter rings) so
    // plugin sprites + LEDs stay above those overlays — without
    // this, the user sees the LED gumball buried under a freshly
    // drawn bloodhound line that lands on the boat.
    liftPluginLayers() {
      const m = getMap()
      if (!m) return
      let lifted = false
      for (const ids of _layers.values()) {
        for (const id of ids) {
          try {
            if (m.getLayer(id)) { m.moveLayer(id); lifted = true }
          } catch { /* layer was torn down between iter and move */ }
        }
      }
      if (lifted) _notifyLayerChange()
    }
  }

  // Subscribe to plugin map-layer adds/removes. Returns an
  // unregister function. Used by host composables that want to
  // re-assert z-order (e.g. lifting breadcrumbs above plugin
  // sprites) without polling.
  function onLayerChange(fn) {
    if (typeof fn !== 'function') return () => {}
    _layerChangeHandlers.add(fn)
    return () => _layerChangeHandlers.delete(fn)
  }

  return {
    allToolbarButtons,
    allPanels,
    discoveredPlugins,
    isPanelOpen,
    closePanel,
    registerPlugin,
    enablePlugin,
    disablePlugin,
    routing,
    capabilities,
    snap,
    onLayerChange
  }
}
