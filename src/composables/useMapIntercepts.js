import { ref, computed, watch, onUnmounted } from 'vue'
import { circlePolygon, destinationPoint } from '@/services/geometry'
import { solve } from '@/services/intercept'
import { useTracksStore } from '@/stores/tracks'
import { useAisStore } from '@/stores/ais'
import { useFeaturesStore } from '@/stores/features'

const LINES_SOURCE  = 'intercept-lines'
const LINES_LAYER   = 'intercept-lines-line'
const HOST_SOURCE   = 'intercept-host-paths'
const HOST_LAYER    = 'intercept-host-paths-line'
const RINGS_SOURCE  = 'intercept-aim-rings'
const RINGS_LAYER   = 'intercept-aim-rings-line'
const MARKS_SOURCE  = 'intercept-aim-markers'
const MARKS_LAYER   = 'intercept-aim-markers-symbol'

const ICON_INTERCEPT = 'intercept-aim-icon-intercept'
const ICON_CPA       = 'intercept-aim-icon-cpa'

const COLOR_INTERCEPT = '#4a9ade'
const COLOR_CPA       = '#ffb300'
const COLOR_HOST      = '#e53935'

function ensureAimIcon(map, name, color) {
  if (map.hasImage(name)) return
  const size = 24
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.strokeStyle = color
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  const pad = 4
  ctx.beginPath()
  ctx.moveTo(pad, pad)
  ctx.lineTo(size - pad, size - pad)
  ctx.moveTo(size - pad, pad)
  ctx.lineTo(pad, size - pad)
  ctx.stroke()
  map.addImage(name, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 })
}

// Endpoint ref (hostile or friendly):
//   { kind: 'cot',     uid:       <string>, coord, course?, speedMs, label }
//   { kind: 'ais',     mmsi:      <string>, coord, course?, speedMs, label }
//   { kind: 'feature', featureId: <number>, coord, course?, speedMs, label }
//
// Stored intercept:
//   { id, hostile, friendly, mode, offsetRange?, offsetBearing?, solution }
//
// solution = { type, heading, tti, aimCoord, missDistance?, closingSpeedMs } | { error }

export function useMapIntercepts(getMap) {
  const tracksStore   = useTracksStore()
  const aisStore      = useAisStore()
  const featuresStore = useFeaturesStore()

  const intercepts      = new Map()  // id -> intercept
  const interceptCount  = ref(0)
  const bumpTick        = ref(0)
  const aimRingRadius   = ref(150)   // meters
  let nextId = 1

  const interceptList = computed(() => {
    void interceptCount.value
    void bumpTick.value
    return [...intercepts.entries()].map(([id, ix]) => ({
      id,
      hostile:  { ...ix.hostile,  label: labelForEndpoint(ix.hostile) },
      friendly: { ...ix.friendly, label: labelForEndpoint(ix.friendly) },
      mode: ix.mode,
      offsetRange:   ix.offsetRange,
      offsetBearing: ix.offsetBearing,
      aimRingRadius: ix.aimRingRadius,
      solution: ix.solution
    }))
  })

  // ---- Endpoint resolution ----

  function resolveEndpoint(ep) {
    if (ep.kind === 'cot') {
      const t = tracksStore.tracks.get(ep.uid)
      if (!t) return null
      const cotType = t.cotType ?? ''
      const char = cotType[2] ?? 'u'
      const affil = ['f', 'h', 'n'].includes(char) ? char : 'u'
      return {
        kind: 'cot',
        uid: ep.uid,
        coord: [t.lon, t.lat],
        course:  t.course ?? null,
        speedMs: t.speed ?? null,
        affil
      }
    }
    if (ep.kind === 'ais') {
      const v = aisStore.vessels.get(ep.mmsi)
      if (!v) return null
      return {
        kind: 'ais',
        mmsi: ep.mmsi,
        coord: [v.longitude, v.latitude],
        course:  (v.COG >= 0) ? v.COG : null,
        speedMs: (v.SOG ?? 0) * (1852 / 3600),
        affil: 'u'
      }
    }
    if (ep.kind === 'feature') {
      const row = featuresStore.features.find(f => f.id === ep.featureId)
      if (!row) return null
      let geom, props
      try { geom = JSON.parse(row.geometry) } catch { return null }
      try { props = JSON.parse(row.properties) } catch { props = {} }
      if (!geom?.coordinates) return null
      const speedKnots = props.speed ?? null
      const speedMs = speedKnots != null ? speedKnots * (1852 / 3600) : null
      return {
        kind: 'feature',
        featureId: ep.featureId,
        coord: geom.coordinates,
        course:  props.course ?? null,
        speedMs,
        affil: props.affiliation ?? 'u'
      }
    }
    return null
  }

  function labelForEndpoint(ep) {
    if (ep.kind === 'cot') {
      const t = tracksStore.tracks.get(ep.uid)
      return t?.callsign ?? ep.uid
    }
    if (ep.kind === 'ais') {
      const v = aisStore.vessels.get(ep.mmsi)
      return v?.name ?? ep.mmsi
    }
    if (ep.kind === 'feature') {
      const row = featuresStore.features.find(f => f.id === ep.featureId)
      if (!row) return `#${ep.featureId}`
      try {
        const props = JSON.parse(row.properties)
        return props.callsign ?? props.name ?? `Track ${ep.featureId}`
      } catch {
        return `#${ep.featureId}`
      }
    }
    return '?'
  }

  // ---- Map source / layer setup (lazy, idempotent) ----

  function ensureSourcesAndLayers() {
    const map = getMap()
    if (!map) return

    if (!map.getSource(HOST_SOURCE)) {
      map.addSource(HOST_SOURCE, { type: 'geojson', data: emptyFC() })
      map.addLayer({
        id: HOST_LAYER,
        type: 'line',
        source: HOST_SOURCE,
        paint: {
          'line-color': COLOR_HOST,
          'line-width': 1.5,
          'line-dasharray': [3, 3]
        }
      })
    }

    if (!map.getSource(RINGS_SOURCE)) {
      map.addSource(RINGS_SOURCE, { type: 'geojson', data: emptyFC() })
      map.addLayer({
        id: RINGS_LAYER,
        type: 'line',
        source: RINGS_SOURCE,
        paint: {
          'line-color': ['case', ['==', ['get', 'type'], 'cpa'], COLOR_CPA, COLOR_INTERCEPT],
          'line-width': 1.5,
          'line-dasharray': [4, 3]
        }
      })
    }

    if (!map.getSource(LINES_SOURCE)) {
      map.addSource(LINES_SOURCE, { type: 'geojson', data: emptyFC() })
      map.addLayer({
        id: LINES_LAYER,
        type: 'line',
        source: LINES_SOURCE,
        paint: {
          'line-color': ['case', ['==', ['get', 'type'], 'cpa'], COLOR_CPA, COLOR_INTERCEPT],
          'line-width': 1.5,
          'line-opacity': 0.55,
          'line-blur': 0.5
        }
      })
    }

    ensureAimIcon(map, ICON_INTERCEPT, COLOR_INTERCEPT)
    ensureAimIcon(map, ICON_CPA,       COLOR_CPA)

    if (!map.getSource(MARKS_SOURCE)) {
      map.addSource(MARKS_SOURCE, { type: 'geojson', data: emptyFC() })
      map.addLayer({
        id: MARKS_LAYER,
        type: 'symbol',
        source: MARKS_SOURCE,
        layout: {
          'icon-image': ['case', ['==', ['get', 'type'], 'cpa'], ICON_CPA, ICON_INTERCEPT],
          'icon-size': 1,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        }
      })
    }
  }

  function emptyFC() {
    return { type: 'FeatureCollection', features: [] }
  }

  // ---- Solve + rebuild loop ----

  function solveFor(ix) {
    const f = ix.friendly
    const h = ix.hostile
    if (!f || !h) return { error: 'Endpoint not resolved' }
    if (f.speedMs == null || f.speedMs <= 0) return { error: 'No friendly speed' }

    return solve({
      fLon: f.coord[0], fLat: f.coord[1], fSpeedMs: f.speedMs,
      hLon: h.coord[0], hLat: h.coord[1],
      hSpeedMs: h.speedMs ?? 0,
      hCourse:  h.course ?? 0,
      mode: ix.mode,
      offsetRange:   ix.offsetRange,
      offsetBearing: ix.offsetBearing
    })
  }

  function rebuildSources() {
    const map = getMap()
    if (!map) return

    const lines = []
    const hostPaths = []
    const rings = []
    const marks = []

    for (const [id, ix] of intercepts) {
      const sol = ix.solution
      if (!sol || sol.error) continue

      const type = sol.type
      const aim = sol.aimCoord
      const fCoord = ix.friendly.coord
      const hCoord = ix.hostile.coord

      lines.push({
        type: 'Feature',
        properties: { id, type },
        geometry: { type: 'LineString', coordinates: [fCoord, aim] }
      })

      // Hostile projected path: current pos → pos at TTI (straight line at hCourse/speed).
      // Covers both intercept (aim = hostile position) and offset (aim is offset
      // from the hostile's TTI position — we still render the hostile's own track).
      const hEnd = destinationPoint(hCoord, (ix.hostile.speedMs ?? 0) * sol.tti, ix.hostile.course ?? 0)
      hostPaths.push({
        type: 'Feature',
        properties: { id },
        geometry: { type: 'LineString', coordinates: [hCoord, hEnd] }
      })

      rings.push({
        type: 'Feature',
        properties: { id, type },
        geometry: circlePolygon(aim, ix.aimRingRadius, 64)
      })

      marks.push({
        type: 'Feature',
        properties: { id, type },
        geometry: { type: 'Point', coordinates: aim }
      })
    }

    map.getSource(LINES_SOURCE)?.setData({ type: 'FeatureCollection', features: lines })
    map.getSource(HOST_SOURCE)?.setData({ type: 'FeatureCollection', features: hostPaths })
    map.getSource(RINGS_SOURCE)?.setData({ type: 'FeatureCollection', features: rings })
    map.getSource(MARKS_SOURCE)?.setData({ type: 'FeatureCollection', features: marks })
  }

  // Re-resolve every endpoint, re-solve, rebuild sources.
  function reresolveAll() {
    if (!intercepts.size) return

    // 1. Drop intercepts whose feature endpoint was deleted. CoT/AIS disappearance
    //    freezes at last-known coord — matches perimeter/bloodhound compromise.
    for (const [id, ix] of [...intercepts]) {
      if (ix.hostile.kind === 'feature' &&
          !featuresStore.features.some(f => f.id === ix.hostile.featureId)) {
        intercepts.delete(id)
        continue
      }
      if (ix.friendly.kind === 'feature' &&
          !featuresStore.features.some(f => f.id === ix.friendly.featureId)) {
        intercepts.delete(id)
      }
    }

    // 2. Re-resolve live endpoints.
    for (const [, ix] of intercepts) {
      const h = resolveEndpoint(ix.hostile)
      if (h) ix.hostile = { ...ix.hostile, ...h }
      const f = resolveEndpoint(ix.friendly)
      if (f) ix.friendly = { ...ix.friendly, ...f }
    }

    // 3. Re-solve.
    for (const [, ix] of intercepts) {
      ix.solution = solveFor(ix)
    }

    interceptCount.value = intercepts.size
    rebuildSources()
    bumpTick.value++
  }

  // ---- Watcher lifecycle ----

  let stopTrackWatch   = null
  let stopAisWatch     = null
  let stopFeatureWatch = null

  function ensureWatchers() {
    if (!stopTrackWatch) {
      stopTrackWatch = watch(() => tracksStore.tracks, reresolveAll, { deep: false })
    }
    if (!stopAisWatch) {
      stopAisWatch = watch(() => aisStore.vessels, reresolveAll, { deep: false })
    }
    if (!stopFeatureWatch) {
      stopFeatureWatch = watch(() => featuresStore.features, reresolveAll, { deep: false })
    }
  }

  function stopWatchers() {
    if (stopTrackWatch)   { stopTrackWatch();   stopTrackWatch   = null }
    if (stopAisWatch)     { stopAisWatch();     stopAisWatch     = null }
    if (stopFeatureWatch) { stopFeatureWatch(); stopFeatureWatch = null }
  }

  // ---- Public programmatic API ----

  // spec = {
  //   hostile:  { kind, uid|mmsi|featureId, speedOverrideMs? },
  //   friendly: { kind, uid|mmsi|featureId, speedOverrideMs? },
  //   mode: 'direct' | 'offset',
  //   offsetRange?: number, offsetBearing?: number
  // }
  // Returns the new intercept id, or null if endpoints can't be resolved or map
  // isn't ready.
  function addIntercept(spec) {
    const map = getMap()
    if (!map) return null
    ensureSourcesAndLayers()

    const hostile  = resolveEndpoint(spec.hostile)
    const friendly = resolveEndpoint(spec.friendly)
    if (!hostile || !friendly) return null

    // Allow callers to override friendly speed (e.g. panel's speed-override UX).
    if (spec.friendly.speedOverrideMs != null) {
      friendly.speedMs = spec.friendly.speedOverrideMs
    }

    const id = nextId++
    const ix = {
      id,
      hostile:  { ...spec.hostile, ...hostile },
      friendly: { ...spec.friendly, ...friendly },
      mode: spec.mode === 'offset' ? 'offset' : 'direct',
      offsetRange:   spec.mode === 'offset' ? Number(spec.offsetRange)   || 0 : 0,
      offsetBearing: spec.mode === 'offset' ? Number(spec.offsetBearing) || 0 : 0,
      aimRingRadius: aimRingRadius.value,
      solution: null
    }
    ix.solution = solveFor(ix)

    intercepts.set(id, ix)
    ensureWatchers()
    interceptCount.value = intercepts.size
    rebuildSources()
    bumpTick.value++
    return id
  }

  function removeIntercept(id) {
    if (!intercepts.has(id)) return false
    intercepts.delete(id)
    interceptCount.value = intercepts.size
    rebuildSources()
    bumpTick.value++
    if (!intercepts.size) stopWatchers()
    return true
  }

  function setAimRingRadius(r) {
    const n = Number(r) || 0
    if (n <= 0) return
    aimRingRadius.value = n
  }

  function clearAll() {
    intercepts.clear()
    interceptCount.value = 0
    rebuildSources()
    bumpTick.value++
    stopWatchers()
  }

  onUnmounted(() => {
    stopWatchers()
    intercepts.clear()
    const map = getMap()
    if (!map) return
    for (const icon of [ICON_INTERCEPT, ICON_CPA]) {
      if (map.hasImage(icon)) map.removeImage(icon)
    }
    for (const [layer, source] of [
      [MARKS_LAYER, MARKS_SOURCE],
      [LINES_LAYER, LINES_SOURCE],
      [RINGS_LAYER, RINGS_SOURCE],
      [HOST_LAYER,  HOST_SOURCE]
    ]) {
      if (map.getLayer(layer))   map.removeLayer(layer)
      if (map.getSource(source)) map.removeSource(source)
    }
  })

  return {
    intercepts: interceptList,
    aimRingRadius,
    addIntercept,
    removeIntercept,
    setAimRingRadius,
    clearAll
  }
}
