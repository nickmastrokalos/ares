import { ref, computed } from 'vue'

// Central alert store for the map. Any source (perimeter breach, intercept
// TTI crossing, bloodhound proximity, …) can set an alert by id; the chip
// overlay renders them top-center. Alerts are keyed so a source can update
// or clear its own entries without touching others.
//
// Alert shape:
//   { id, source, level: 'warning' | 'critical', message, details?, timestamp }
//
// `details` is an optional array of `{ label, coord? }` entries — the chip
// shows them in its expanded popover, underneath the summary message.
// When a detail has a `coord` ([lng, lat]), the chip renders a crosshair
// button that flies the map there.
//
// Levels rank 'critical' above 'warning' when sorted for display.

const LEVEL_RANK = { critical: 2, warning: 1 }

export function useMapAlerts() {
  const alertsMap = ref(new Map())

  const alerts = computed(() => {
    return [...alertsMap.value.values()].sort((a, b) => {
      const r = (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0)
      if (r !== 0) return r
      return a.timestamp - b.timestamp
    })
  })

  function setAlert(id, payload) {
    if (!payload) {
      if (alertsMap.value.has(id)) {
        const next = new Map(alertsMap.value)
        next.delete(id)
        alertsMap.value = next
      }
      return
    }
    const prev = alertsMap.value.get(id)
    const next = new Map(alertsMap.value)
    next.set(id, {
      id,
      source:  payload.source  ?? 'unknown',
      level:   payload.level   ?? 'warning',
      message: payload.message ?? '',
      details: Array.isArray(payload.details) ? payload.details : null,
      timestamp: prev?.timestamp ?? Date.now()
    })
    alertsMap.value = next
  }

  function clearAlert(id) {
    setAlert(id, null)
  }

  function clearSource(source) {
    const next = new Map(alertsMap.value)
    let changed = false
    for (const [id, a] of next) {
      if (a.source === source) { next.delete(id); changed = true }
    }
    if (changed) alertsMap.value = next
  }

  function clearAll() {
    if (alertsMap.value.size === 0) return
    alertsMap.value = new Map()
  }

  return { alerts, setAlert, clearAlert, clearSource, clearAll }
}
