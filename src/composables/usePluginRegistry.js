import { ref, computed } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { useTracksStore } from '@/stores/tracks'
import { useSettingsStore } from '@/stores/settings'
import { getStore } from '@/plugins/store'
import { isOverWater, getLandPolygons } from '@/services/coastlines'
import { version as HOST_VERSION } from '../../package.json'

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
    if (!_events.has(manifest.id)) _events.set(manifest.id, [])

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
        addLayer({ id, source, layer, onClick, onHover, onHoverEnd }) {
          const map = getMap()
          if (!map) throw new Error('Map not ready yet. Plugins normally activate after the map loads; if you see this from a long-lived watcher, defer the call.')
          if (!id || typeof id !== 'string') throw new Error('addLayer: id is required')
          if (map.getLayer(id) || map.getSource(id)) {
            throw new Error(`addLayer: id "${id}" already in use`)
          }
          map.addSource(id, source)
          map.addLayer({ ...layer, id, source: id })
          _layers.get(manifest.id).add(id)

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
        onZoom:   (handler) => _onMapEvent('zoomend', handler)
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

  // ---- Internal helpers ----

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
      for (const layerId of _layers.get(id) ?? []) {
        try {
          if (map.getLayer(layerId))  map.removeLayer(layerId)
          if (map.getSource(layerId)) map.removeSource(layerId)
        } catch (e) {
          console.warn(`[plugin-registry] Failed to remove layer "${layerId}":`, e)
        }
      }
      for (const { event, mapHandler } of _events.get(id) ?? []) {
        try { map.off(event, mapHandler) } catch { /* ignore */ }
      }
    }
    _layers.delete(id)
    _events.delete(id)

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

  // ---- Public API ----

  // Called by pluginLoader for each successfully imported module.
  function registerPlugin(manifest, filePath) {
    if (!manifest?.id || typeof manifest.activate !== 'function') {
      console.warn('[plugin-registry] Skipping invalid plugin manifest from:', filePath)
      return
    }
    _manifests.set(manifest.id, manifest)

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

  // Called from SettingsDialog when the user enables a plugin.
  async function enablePlugin(id) {
    const row = discoveredPlugins.value.find(p => p.id === id)
    if (row?.incompatible) return  // toggle is disabled in the UI; belt-and-suspenders
    if (!settingsStore.enabledPlugins.includes(id)) {
      await settingsStore.setSetting('enabledPlugins', [...settingsStore.enabledPlugins, id])
    }
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

  return {
    allToolbarButtons,
    allPanels,
    discoveredPlugins,
    isPanelOpen,
    closePanel,
    registerPlugin,
    enablePlugin,
    disablePlugin
  }
}
