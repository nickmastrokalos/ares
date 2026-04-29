import { defineStore } from 'pinia'
import { ref } from 'vue'

// In-memory persistence for bloodhound lines across MapView mount /
// unmount cycles (route navigation away and back). The composable
// `useMapBloodhound` reads / writes through this store so the
// committed lines + their endpoint refs survive a navigation; the
// MapLibre markers themselves are recreated each time the map view
// remounts because they're tied to the live map instance.
//
// Each line: { id, epA, epB }
//   ep: { kind, uid|mmsi|featureId|coord }
//   • kind === 'cot'     → uid (string)        — coord re-resolved on mount
//   • kind === 'ais'     → mmsi (string)       — coord re-resolved on mount
//   • kind === 'feature' → featureId (number)  — coord re-resolved on mount
//   • kind === 'point'   → coord ([lng, lat])  — coord IS the source of truth
//
// `coord` on the typed kinds is a cached last-known value; the
// composable's reresolve loop updates it as the underlying entity
// moves and on rehydrate.

export const useBloodhoundsStore = defineStore('bloodhounds', () => {
  const lines = ref([])
  // Monotonic counter; held in the store so IDs don't collide with
  // ones already persisted across a remount. Plain number, mutated
  // through `add()`.
  let _nextId = 1

  function add(epA, epB) {
    const id = _nextId++
    lines.value = [...lines.value, { id, epA: { ...epA }, epB: { ...epB } }]
    return id
  }

  // Update one or both endpoints' cached coords (used by the
  // composable's reresolve tick when the underlying entity moved).
  // Returns true if anything actually changed.
  function updateCoords(id, epACoord, epBCoord) {
    let changed = false
    lines.value = lines.value.map(l => {
      if (l.id !== id) return l
      const nextA = epACoord && (l.epA.coord?.[0] !== epACoord[0] || l.epA.coord?.[1] !== epACoord[1])
        ? { ...l.epA, coord: epACoord } : l.epA
      const nextB = epBCoord && (l.epB.coord?.[0] !== epBCoord[0] || l.epB.coord?.[1] !== epBCoord[1])
        ? { ...l.epB, coord: epBCoord } : l.epB
      if (nextA !== l.epA || nextB !== l.epB) {
        changed = true
        return { ...l, epA: nextA, epB: nextB }
      }
      return l
    })
    return changed
  }

  function remove(id) {
    lines.value = lines.value.filter(l => l.id !== id)
  }

  function clear() {
    lines.value = []
  }

  return { lines, add, updateCoords, remove, clear }
})
