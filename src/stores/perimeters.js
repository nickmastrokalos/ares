import { defineStore } from 'pinia'
import { ref } from 'vue'

// In-memory persistence for perimeter rings across MapView mount /
// unmount cycles. The composable `useMapPerimeters` reads / writes
// through this store so the rings + their owner refs + radius +
// alert flag survive a navigation. The on-map sources / breach sets
// are recreated each time the map view remounts because they depend
// on the live map and current track positions.
//
// One entry per ownerKey:
//   ownerKey: 'cot:<uid>' | 'ais:<mmsi>' | 'feature:<id>'
//   value:    { owner: { kind, uid|mmsi|featureId, coord }, radius, alert }
// `coord` on the owner is a cached last-known value; the composable
// reresolves it from the live store on every tick.

export const usePerimetersStore = defineStore('perimeters', () => {
  // Map<ownerKey, { owner, radius, alert }>. Stored as a Map ref so
  // assigning a new Map triggers reactivity (matches the pattern
  // tracksStore uses).
  const entries = ref(new Map())
  const defaultRadius = ref(500)

  function set(ownerKey, value) {
    const next = new Map(entries.value)
    next.set(ownerKey, {
      owner:  { ...value.owner },
      radius: Number(value.radius) || 0,
      alert:  Boolean(value.alert)
    })
    entries.value = next
  }

  // Patch a single field on an existing entry. No-op if the key
  // isn't present.
  function patch(ownerKey, partial) {
    const cur = entries.value.get(ownerKey)
    if (!cur) return
    const next = new Map(entries.value)
    next.set(ownerKey, { ...cur, ...partial })
    entries.value = next
  }

  // Update only the cached owner coord (called from the composable's
  // reresolve tick when the underlying entity moved). Skips the
  // bookkeeping cost of building a fresh Map when nothing changed.
  function updateOwnerCoord(ownerKey, coord) {
    const cur = entries.value.get(ownerKey)
    if (!cur || !coord) return false
    if (cur.owner.coord?.[0] === coord[0] && cur.owner.coord?.[1] === coord[1]) return false
    const next = new Map(entries.value)
    next.set(ownerKey, { ...cur, owner: { ...cur.owner, coord } })
    entries.value = next
    return true
  }

  function remove(ownerKey) {
    if (!entries.value.has(ownerKey)) return false
    const next = new Map(entries.value)
    next.delete(ownerKey)
    entries.value = next
    return true
  }

  function clear() {
    entries.value = new Map()
  }

  function setDefaultRadius(r) {
    defaultRadius.value = Number(r) || 0
  }

  return { entries, defaultRadius, set, patch, updateOwnerCoord, remove, clear, setDefaultRadius }
})
