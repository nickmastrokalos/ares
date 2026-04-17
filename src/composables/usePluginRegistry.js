import { ref, computed } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { useTracksStore } from '@/stores/tracks'
import { useSettingsStore } from '@/stores/settings'

export function usePluginRegistry({ flyToGeometry }) {
  const featuresStore = useFeaturesStore()
  const tracksStore   = useTracksStore()
  const settingsStore = useSettingsStore()

  // Map<pluginId, Array<buttonDef>> — reassigned (not mutated) to stay reactive.
  const _buttons  = ref(new Map())
  // Map<pluginId, manifest> — kept outside reactivity, not rendered directly.
  const _manifests = new Map()
  // Map<pluginId, Array<cleanupFn>>
  const _cleanups  = new Map()

  const discoveredPlugins = ref([])  // { id, name, version, filePath, active, error }

  // ---- API builder ----

  function _buildApi(manifest) {
    const cleanups = []
    _cleanups.set(manifest.id, cleanups)

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
    const fns = _cleanups.get(id) ?? []
    for (let i = fns.length - 1; i >= 0; i--) {
      try { fns[i]() } catch (e) {
        console.warn(`[plugin-registry] Cleanup error in "${id}":`, e)
      }
    }
    _cleanups.delete(id)
    const next = new Map(_buttons.value)
    next.delete(id)
    _buttons.value = next
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

    if (!discoveredPlugins.value.find(p => p.id === manifest.id)) {
      discoveredPlugins.value = [
        ...discoveredPlugins.value,
        {
          id:       manifest.id,
          name:     manifest.name     ?? manifest.id,
          version:  manifest.version  ?? '?',
          filePath,
          active:   false,
          error:    null
        }
      ]
    }

    if (settingsStore.enabledPlugins.includes(manifest.id)) {
      _activate(manifest.id)
    }
  }

  // Called from SettingsDialog when the user enables a plugin.
  async function enablePlugin(id) {
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

  return { allToolbarButtons, discoveredPlugins, registerPlugin, enablePlugin, disablePlugin }
}
