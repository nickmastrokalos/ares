import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { listen } from '@tauri-apps/api/event'

// Map CoT type character at index 1 to a short affiliation token.
// CoT type format: "a-{affiliation}-..." e.g. "a-f-G-U-C"
function affiliationFromCotType(cotType) {
  const char = cotType?.[2] ?? 'u'
  if (char === 'f') return 'f'
  if (char === 'h') return 'h'
  if (char === 'n') return 'n'
  return 'u'
}

export const useTracksStore = defineStore('tracks', () => {
  // uid → track object
  const tracks = ref(new Map())
  const listening = ref(false)

  // GeoJSON FeatureCollection derived from the tracks Map.
  // Each feature carries all track fields as properties plus a derived
  // `affiliation` for styling and an `updatedAt` timestamp.
  const trackCollection = computed(() => ({
    type: 'FeatureCollection',
    features: Array.from(tracks.value.values()).map(t => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      properties: {
        uid: t.uid,
        cotType: t.cotType,
        affiliation: affiliationFromCotType(t.cotType),
        callsign: t.callsign,
        hae: t.hae,
        speed: t.speed,
        course: t.course,
        time: t.time,
        stale: t.stale,
        updatedAt: t.updatedAt
      }
    }))
  }))

  // Maximum history window kept in memory. The breadcrumb length setting
  // controls how much of this is *shown* — we keep more so the user can
  // extend the window without losing data.
  const MAX_HISTORY_MS = 30 * 60 * 1000  // 30 minutes

  let unlistenFn = null
  let pruneInterval = null

  async function startListening() {
    if (listening.value) return
    listening.value = true

    unlistenFn = await listen('cot-event', (event) => {
      const e = event.payload
      const now = Date.now()
      const existing = tracks.value.get(e.uid)

      // Carry forward history, append current position, prune old entries.
      const history = existing?.history ?? []
      history.push({ lon: e.lon, lat: e.lat, t: now })
      const cutoff = now - MAX_HISTORY_MS
      // Prune in-place from the front to avoid allocating a new array each tick.
      while (history.length > 0 && history[0].t < cutoff) history.shift()

      tracks.value.set(e.uid, {
        uid: e.uid,
        cotType: e.cot_type,
        lat: e.lat,
        lon: e.lon,
        hae: e.hae,
        speed: e.speed,
        course: e.course,
        callsign: e.callsign,
        time: e.time,
        stale: e.stale,
        updatedAt: now,
        history
      })
      // Trigger reactivity — Map mutations don't trigger Vue's reactive system
      // unless we reassign or use a reactive Map wrapper. Reassign the ref value
      // to force the computed to rerun.
      tracks.value = new Map(tracks.value)
    })

    // Prune stale tracks every 30 seconds.
    pruneInterval = setInterval(() => {
      const now = new Date()
      let pruned = false
      for (const [uid, track] of tracks.value) {
        if (track.stale && new Date(track.stale) < now) {
          tracks.value.delete(uid)
          pruned = true
        }
      }
      if (pruned) tracks.value = new Map(tracks.value)
    }, 30_000)
  }

  function stopListening() {
    if (unlistenFn) {
      unlistenFn()
      unlistenFn = null
    }
    if (pruneInterval) {
      clearInterval(pruneInterval)
      pruneInterval = null
    }
    listening.value = false
  }

  function removeTrack(uid) {
    const m = new Map(tracks.value)
    m.delete(uid)
    tracks.value = m
  }

  function clearTracks() {
    tracks.value = new Map()
  }

  // ---- Open panels ----
  // A Set of UIDs whose detail panels are currently open. Multiple panels can
  // be open simultaneously — each one is independent.

  const openPanels = ref(new Set())
  const focusedUid = ref(null)

  // Array form for v-for in templates (Set is not directly iterable in Vue templates).
  const openPanelList = computed(() => Array.from(openPanels.value))

  function openPanel(uid) {
    focusedUid.value = uid  // always signal focus, even if panel is already open
    if (openPanels.value.has(uid)) return
    openPanels.value = new Set(openPanels.value).add(uid)
  }

  function closePanel(uid) {
    const s = new Set(openPanels.value)
    s.delete(uid)
    openPanels.value = s
  }

  return {
    tracks,
    listening,
    trackCollection,
    startListening,
    stopListening,
    removeTrack,
    clearTracks,
    openPanels,
    openPanelList,
    focusedUid,
    openPanel,
    closePanel
  }
})
