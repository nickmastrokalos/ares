import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { useSettingsStore } from '@/stores/settings'

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
  const settingsStore = useSettingsStore()

  // uid → track object
  const tracks = ref(new Map())
  const listening = ref(false)

  // Session-only set of uids hidden from the map via the track list.
  // Cleared on uid removal so a re-appearing track doesn't stay hidden.
  const hiddenIds = ref(new Set())

  // GeoJSON FeatureCollection derived from the tracks Map.
  // Each feature carries all track fields as properties plus a derived
  // `affiliation` for styling and an `updatedAt` timestamp.
  // Hidden uids are dropped here so the map source reflects visibility.
  const trackCollection = computed(() => {
    const selfUid = settingsStore.selfUid
    return {
      type: 'FeatureCollection',
      features: Array.from(tracks.value.values())
        .filter(t => !hiddenIds.value.has(t.uid))
        .map(t => ({
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
            updatedAt: t.updatedAt,
            isSelf: !!selfUid && t.uid === selfUid
          }
        }))
    }
  })

  // Maximum history window kept in memory. The breadcrumb length setting
  // controls how much of this is *shown* — we keep more so the user can
  // extend the window without losing data.
  const MAX_HISTORY_MS = 30 * 60 * 1000  // 30 minutes

  // CoT peers without a synced clock (radios with no GPS lock, PCAP
  // replays, badly-configured TAK servers) send `time` and `stale`
  // referenced to their own clock — sometimes hours or months off
  // ours. When the skew exceeds STALE_SKEW_THRESHOLD_MS we honour
  // the peer's intended freshness window (`stale − time`) but
  // anchor it to local receive time so the prune sweeper stops
  // killing the track on the next tick. DEFAULT_STALE_MS is the
  // fallback when the peer's window is invalid (`stale ≤ time`).
  const STALE_SKEW_THRESHOLD_MS = 5 * 60 * 1000
  const DEFAULT_STALE_MS        = 90 * 1000

  let unlistenFn = null
  let pruneInterval = null

  async function startListening() {
    if (listening.value) return
    listening.value = true

    unlistenFn = await listen('cot-event', (event) => {
      const e = event.payload
      // Type filter: only "atom" CoT types (`a-…`) are units / vessels /
      // aircraft — i.e. things that belong on the track list. Chat
      // (`b-t-f`), drawings, markers, replies, etc. ride the same
      // listeners but are routed to other stores. Previously the XML
      // parser silently dropped chat events because they ship with
      // `point lat=0 lon=0` which read as NaN through some encoders;
      // TAK Protocol v1 events carry valid 0/0 floats so the bad ones
      // would land here as Null-Island ghosts. Explicit filter keeps
      // both wire formats producing the same track list.
      if (typeof e.cot_type !== 'string' || !e.cot_type.startsWith('a-')) return

      // Drop our own announce echo only when no manual location is set.
      // Without a location the announce broadcasts at lat/lon (0, 0) as a
      // presence-only beacon and self-echoing it would pin a phantom
      // track at Null Island. With a location set, the user expects to
      // see themselves on their own map and in the track list — same
      // place peers see them.
      if (
        settingsStore.selfUid &&
        e.uid === settingsStore.selfUid &&
        !settingsStore.selfLocation
      ) return

      const now = Date.now()
      const existing = tracks.value.get(e.uid)

      // Carry forward history, append current position, prune old entries.
      const history = existing?.history ?? []
      history.push({ lon: e.lon, lat: e.lat, t: now })
      const cutoff = now - MAX_HISTORY_MS
      // Prune in-place from the front to avoid allocating a new array each tick.
      while (history.length > 0 && history[0].t < cutoff) history.shift()

      // Clock-skew correction. See STALE_SKEW_THRESHOLD_MS comment above.
      let effectiveStale = e.stale
      const msgTime  = e.time  ? Date.parse(e.time)  : NaN
      const msgStale = e.stale ? Date.parse(e.stale) : NaN
      if (Number.isFinite(msgTime) && Math.abs(now - msgTime) > STALE_SKEW_THRESHOLD_MS) {
        const window = Number.isFinite(msgStale) && msgStale > msgTime
          ? msgStale - msgTime
          : DEFAULT_STALE_MS
        effectiveStale = new Date(now + window).toISOString()
      }

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
        stale: effectiveStale,
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
    if (hiddenIds.value.has(uid)) {
      const next = new Set(hiddenIds.value)
      next.delete(uid)
      hiddenIds.value = next
    }
  }

  function clearTracks() {
    tracks.value = new Map()
    hiddenIds.value = new Set()
  }

  function toggleVisibility(uid) {
    const next = new Set(hiddenIds.value)
    if (next.has(uid)) next.delete(uid)
    else next.add(uid)
    hiddenIds.value = next
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
    hiddenIds,
    toggleVisibility,
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
