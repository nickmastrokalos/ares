import { ref } from 'vue'

/**
 * Central click dispatcher for all interactive map features.
 *
 * Each composable registers its clickable layers and callbacks here. A single
 * global map click handler queries all active layers at the click point,
 * deduplicates hits, and either fires the matching action directly (1 hit) or
 * shows a disambiguation picker (2+ hits).
 *
 * This prevents multiple independent click handlers from firing simultaneously
 * and gives users a way to choose when features overlap.
 */
export function useClickDispatcher() {
  // Map<domainId, { layers, action, suppress, label, dedupeKey, onMiss? }>
  const registrations = new Map()

  // Layer id → domain id lookup for fast hit resolution.
  const layerToDomain = new Map()

  // Reactive picker state — null when closed.
  // When open: { x, y, items: [{ text, subtitle, icon, feature, domainId, reg }] }
  const pickerState = ref(null)

  let map = null
  let clickHandler = null

  // ---- Registration ----

  function register(domainId, opts) {
    registrations.set(domainId, opts)
    for (const layer of opts.layers) {
      layerToDomain.set(layer, domainId)
    }
  }

  function unregister(domainId) {
    const reg = registrations.get(domainId)
    if (reg) {
      for (const layer of reg.layers) {
        layerToDomain.delete(layer)
      }
    }
    registrations.delete(domainId)
  }

  // ---- Picker control ----

  function dismiss() {
    pickerState.value = null
  }

  function selectItem(item) {
    item.reg.action(item.feature)
    // Notify onMiss for all other domains (e.g. deselect a drawn shape when
    // the user clicks a track in the disambiguation popup).
    for (const [id, reg] of registrations) {
      if (id !== item.domainId && reg.onMiss) reg.onMiss()
    }
    dismiss()
  }

  // ---- Install global handler ----

  function install(mapInstance) {
    map = mapInstance

    clickHandler = (e) => {
      dismiss()

      // Build the layer list from all non-suppressed registrations.
      const activeLayers = []
      for (const [, reg] of registrations) {
        if (reg.suppress()) continue
        activeLayers.push(...reg.layers)
      }

      if (activeLayers.length === 0) return

      const hits = map.queryRenderedFeatures(e.point, { layers: activeLayers })

      if (hits.length === 0) {
        // Empty space — fire onMiss for any domain that needs it (e.g. deselect shape).
        for (const [, reg] of registrations) {
          if (reg.onMiss) reg.onMiss()
        }
        return
      }

      // Deduplicate hits: within each domain keep only the first occurrence per
      // dedupeKey. This collapses a route's line + dot (same _dbId) to one entry,
      // and a track's circle + symbol layer (same uid) to one entry.
      const seen = new Set()
      const unique = []
      for (const hit of hits) {
        const domainId = layerToDomain.get(hit.layer.id)
        if (!domainId) continue
        const reg = registrations.get(domainId)
        if (!reg || reg.suppress()) continue
        const key = `${domainId}::${reg.dedupeKey(hit)}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push({ feature: hit, domainId, reg })
      }

      if (unique.length === 0) return

      if (unique.length === 1) {
        const { feature, domainId, reg } = unique[0]
        reg.action(feature)
        // Deselect in other domains (draw deselection, etc.)
        for (const [id, r] of registrations) {
          if (id !== domainId && r.onMiss) r.onMiss()
        }
        return
      }

      // Multiple unique features — show the picker.
      const items = unique.map(({ feature, domainId, reg }) => ({
        ...reg.label(feature),
        feature,
        domainId,
        reg
      }))

      pickerState.value = { x: e.point.x, y: e.point.y, items }
    }

    map.on('click', clickHandler)
  }

  function cleanup() {
    if (map && clickHandler) {
      map.off('click', clickHandler)
      clickHandler = null
    }
    registrations.clear()
    layerToDomain.clear()
    map = null
  }

  return { register, unregister, install, cleanup, pickerState, selectItem, dismiss }
}
