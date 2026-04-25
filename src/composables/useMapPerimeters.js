import { ref, computed, watch, onUnmounted } from 'vue'
import { circlePolygon, distanceBetween, geometryBounds } from '@/services/geometry'
import { useTracksStore } from '@/stores/tracks'
import { useAisStore } from '@/stores/ais'
import { useFeaturesStore } from '@/stores/features'

const RINGS_SOURCE = 'perimeter-rings'
const RINGS_LAYER  = 'perimeter-rings-line'
const HALOS_SOURCE = 'perimeter-halos'
const HALOS_LAYER  = 'perimeter-halos-circle'

// A perimeter is a standoff ring around a single track — dashed circle of a
// user-given radius that follows the track as it moves. If alert is on,
// any other track (CoT / AIS / manual) that falls inside the ring is flagged
// as a breach: the ring strokes red and each intruder gets a red halo.
//
// One perimeter per track (owner-keyed storage). Adding a perimeter to a
// track that already has one replaces the old radius/alert.
//
// Owner ref:
//   { kind: 'cot',     uid:       <string>, coord: [lng, lat] }
//   { kind: 'ais',     mmsi:      <string>, coord: [lng, lat] }
//   { kind: 'feature', featureId: <number>, coord: [lng, lat] }  // manual tracks
//
// Stored perimeter:
//   { owner, radius, alert, breached: Set<intruderKey> }

const SNAP_LAYERS = [
  'cot-tracks-points',
  'cot-tracks-symbols',
  'ais-vessels-points',
  'ais-vessels-arrows',
  'manual-tracks-points',
  'manual-tracks-symbols'
]

export function useMapPerimeters(getMap) {
  const tracksStore   = useTracksStore()
  const aisStore      = useAisStore()
  const featuresStore = useFeaturesStore()

  const perimeters      = new Map()  // ownerKey -> perimeter
  const perimeterCount  = ref(0)
  const bumpTick        = ref(0)
  const defaultRadius   = ref(500)   // meters
  const isSelecting     = ref(false)

  const perimeterSelecting = computed(() => isSelecting.value)

  let clickHandler = null
  let moveHandler  = null
  let keyHandler   = null
  let stopTrackWatch        = null
  let stopTrackHiddenWatch  = null
  let stopAisWatch          = null
  let stopAisVisibleWatch   = null
  let stopFeatureWatch      = null
  let stopManualHiddenWatch = null

  // Reactive list for panel + assistant tools. Rebuilds on add/remove/clear
  // (perimeterCount bump) and on re-resolve ticks (bumpTick).
  const perimeterList = computed(() => {
    void perimeterCount.value
    void bumpTick.value
    return [...perimeters.entries()].map(([ownerKey, p]) => ({
      ownerKey,
      owner: { ...p.owner, label: labelForOwner(p.owner) },
      radius: p.radius,
      alert:  p.alert,
      breached: [...p.breached].map(k => {
        const [kind, id] = splitKey(k)
        const ep = makeEndpointFromKey(kind, id)
        return {
          kind,
          id,
          label: ep ? labelForOwner(ep) : id,
          coord: ep?.coord ?? null
        }
      })
    }))
  })

  function ownerKeyOf(owner) {
    if (owner.kind === 'cot')     return `cot:${owner.uid}`
    if (owner.kind === 'ais')     return `ais:${owner.mmsi}`
    if (owner.kind === 'feature') return `feature:${owner.featureId}`
    return `point:${owner.coord[0]},${owner.coord[1]}`
  }

  function splitKey(key) {
    const i = key.indexOf(':')
    return [key.slice(0, i), key.slice(i + 1)]
  }

  function makeEndpointFromKey(kind, id) {
    if (kind === 'cot') {
      const t = tracksStore.tracks.get(id)
      return t ? { kind: 'cot', uid: id, coord: [t.lon, t.lat] } : null
    }
    if (kind === 'ais') {
      const v = aisStore.vessels.get(id)
      return v ? { kind: 'ais', mmsi: id, coord: [v.longitude, v.latitude] } : null
    }
    if (kind === 'feature') {
      const fid = Number(id)
      const coord = featureCentroid(fid)
      return coord ? { kind: 'feature', featureId: fid, coord } : null
    }
    return null
  }

  // ---- Owner coord resolution ----

  function resolveCoord(owner) {
    if (owner.kind === 'cot') {
      const t = tracksStore.tracks.get(owner.uid)
      return t ? [t.lon, t.lat] : null
    }
    if (owner.kind === 'ais') {
      const v = aisStore.vessels.get(owner.mmsi)
      return v ? [v.longitude, v.latitude] : null
    }
    if (owner.kind === 'feature') {
      return featureCentroid(owner.featureId)
    }
    return null
  }

  function featureCentroid(featureId) {
    const row = featuresStore.features.find(f => f.id === featureId)
    if (!row) return null
    const props = JSON.parse(row.properties)
    if (props.center) return props.center
    if (row.type === 'box' && props.sw && props.ne) {
      return [(props.sw[0] + props.ne[0]) / 2, (props.sw[1] + props.ne[1]) / 2]
    }
    const geom = JSON.parse(row.geometry)
    if (geom.type === 'Point') return geom.coordinates
    const bounds = geometryBounds(geom)
    if (!bounds) return null
    const [[w, s], [e, n]] = bounds
    return [(w + e) / 2, (s + n) / 2]
  }

  function labelForOwner(owner) {
    if (owner.kind === 'cot') {
      const t = tracksStore.tracks.get(owner.uid)
      return t?.callsign ?? owner.uid
    }
    if (owner.kind === 'ais') {
      const v = aisStore.vessels.get(owner.mmsi)
      return v?.name ?? owner.mmsi
    }
    if (owner.kind === 'feature') {
      const row = featuresStore.features.find(f => f.id === owner.featureId)
      if (!row) return `#${owner.featureId}`
      const props = JSON.parse(row.properties)
      return props.callsign ?? props.name ?? `${row.type} #${owner.featureId}`
    }
    return `${owner.coord[1].toFixed(4)}, ${owner.coord[0].toFixed(4)}`
  }

  // ---- Map source / layer setup (lazy, idempotent) ----

  function ensureSourcesAndLayers() {
    const map = getMap()
    if (!map) return
    if (!map.getSource(RINGS_SOURCE)) {
      map.addSource(RINGS_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: RINGS_LAYER,
        type: 'line',
        source: RINGS_SOURCE,
        paint: {
          'line-color': ['case', ['==', ['get', 'breached'], true], '#e53935', '#4a9ade'],
          'line-width': 1.5,
          'line-dasharray': [4, 3],
          'line-opacity': 0.85,
          'line-blur': 0.4
        }
      })
    }
    if (!map.getSource(HALOS_SOURCE)) {
      map.addSource(HALOS_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: HALOS_LAYER,
        type: 'circle',
        source: HALOS_SOURCE,
        paint: {
          // Radius 22 matches the manual-track selection ring so the halo
          // wraps rectangular MIL-STD-2525 icons without clipping the frame.
          'circle-radius': 22,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#e53935'
        }
      })
    }
  }

  // ---- Breach + display loop ----

  // Iterates every live track and returns those inside the given perimeter,
  // keyed as `${kind}:${id}`. The owner itself is always excluded.
  //
  // Hidden AIS vessels are skipped: a breach halo / red ring over empty
  // map is confusing, and an operator who has explicitly hidden AIS has
  // opted out of AIS-driven alerting. Per-track hides (CoT uids in
  // `tracksStore.hiddenIds`, manual feature ids in `featuresStore.hiddenManualIds`)
  // are skipped for the same reason.
  function computeBreaches(p, ownerKey) {
    const breached = new Set()
    const center = p.owner.coord
    const r = p.radius

    for (const t of tracksStore.tracks.values()) {
      if (tracksStore.hiddenIds.has(t.uid)) continue
      const key = `cot:${t.uid}`
      if (key === ownerKey) continue
      if (distanceBetween([t.lon, t.lat], center) < r) breached.add(key)
    }
    if (aisStore.visible) {
      for (const v of aisStore.vessels.values()) {
        const key = `ais:${v.mmsi}`
        if (key === ownerKey) continue
        if (distanceBetween([v.longitude, v.latitude], center) < r) breached.add(key)
      }
    }
    for (const f of featuresStore.features) {
      if (f.type !== 'manual-track') continue
      if (featuresStore.hiddenManualIds.has(f.id)) continue
      const key = `feature:${f.id}`
      if (key === ownerKey) continue
      const geom = JSON.parse(f.geometry)
      if (geom.type !== 'Point') continue
      if (distanceBetween(geom.coordinates, center) < r) breached.add(key)
    }
    return breached
  }

  // Returns the current on-map coordinate of an intruder (for the halo layer).
  function intruderCoord(key) {
    const [kind, id] = splitKey(key)
    if (kind === 'cot') {
      const t = tracksStore.tracks.get(id)
      return t ? [t.lon, t.lat] : null
    }
    if (kind === 'ais') {
      const v = aisStore.vessels.get(id)
      return v ? [v.longitude, v.latitude] : null
    }
    if (kind === 'feature') {
      const fid = Number(id)
      const row = featuresStore.features.find(f => f.id === fid)
      if (!row) return null
      const geom = JSON.parse(row.geometry)
      return geom.type === 'Point' ? geom.coordinates : null
    }
    return null
  }

  function rebuildSources() {
    const map = getMap()
    if (!map) return

    const ringFeatures = []
    const haloFeatures = []

    for (const [ownerKey, p] of perimeters) {
      ringFeatures.push({
        type: 'Feature',
        properties: { ownerKey, breached: p.breached.size > 0 },
        geometry: circlePolygon(p.owner.coord, p.radius, 64)
      })
      for (const intruderKey of p.breached) {
        const coord = intruderCoord(intruderKey)
        if (!coord) continue
        haloFeatures.push({
          type: 'Feature',
          properties: { ownerKey, intruderKey },
          geometry: { type: 'Point', coordinates: coord }
        })
      }
    }

    map.getSource(RINGS_SOURCE)?.setData({ type: 'FeatureCollection', features: ringFeatures })
    map.getSource(HALOS_SOURCE)?.setData({ type: 'FeatureCollection', features: haloFeatures })
  }

  // Re-resolve every owner, recompute breaches, rebuild sources. Called from
  // store watchers and after direct API mutations (add/remove/setRadius/…).
  function reresolveAll() {
    if (!perimeters.size) return

    // 1. Drop perimeters whose feature owner was deleted. CoT/AIS disappearance
    //    freezes at last-known coord — matches bloodhound's compromise.
    for (const [ownerKey, p] of [...perimeters]) {
      if (p.owner.kind === 'feature' &&
          !featuresStore.features.some(f => f.id === p.owner.featureId)) {
        perimeters.delete(ownerKey)
      }
    }

    // 2. Re-resolve owner coord.
    for (const [, p] of perimeters) {
      const c = resolveCoord(p.owner)
      if (c) p.owner.coord = c
    }

    // 3. Recompute breaches for perimeters with alert on.
    for (const [ownerKey, p] of perimeters) {
      p.breached = p.alert ? computeBreaches(p, ownerKey) : new Set()
    }

    perimeterCount.value = perimeters.size
    rebuildSources()
    bumpTick.value++
  }

  // ---- Watcher lifecycle ----

  function ensureWatchers() {
    if (!stopTrackWatch) {
      stopTrackWatch = watch(() => tracksStore.tracks, reresolveAll, { deep: false })
    }
    if (!stopTrackHiddenWatch) {
      stopTrackHiddenWatch = watch(() => tracksStore.hiddenIds, reresolveAll)
    }
    if (!stopAisWatch) {
      stopAisWatch = watch(() => aisStore.vessels, reresolveAll, { deep: false })
    }
    if (!stopAisVisibleWatch) {
      stopAisVisibleWatch = watch(() => aisStore.visible, reresolveAll)
    }
    if (!stopFeatureWatch) {
      stopFeatureWatch = watch(() => featuresStore.features, reresolveAll, { deep: false })
    }
    if (!stopManualHiddenWatch) {
      stopManualHiddenWatch = watch(() => featuresStore.hiddenManualIds, reresolveAll)
    }
  }

  function stopWatchers() {
    if (stopTrackWatch)        { stopTrackWatch();        stopTrackWatch        = null }
    if (stopTrackHiddenWatch)  { stopTrackHiddenWatch();  stopTrackHiddenWatch  = null }
    if (stopAisWatch)          { stopAisWatch();          stopAisWatch          = null }
    if (stopAisVisibleWatch)   { stopAisVisibleWatch();   stopAisVisibleWatch   = null }
    if (stopFeatureWatch)      { stopFeatureWatch();      stopFeatureWatch      = null }
    if (stopManualHiddenWatch) { stopManualHiddenWatch(); stopManualHiddenWatch = null }
  }

  function ensureKeyHandler() {
    if (keyHandler) return
    keyHandler = (e) => {
      if (e.key === 'Escape' && isSelecting.value) exitSelecting()
    }
    window.addEventListener('keydown', keyHandler)
  }

  function removeKeyHandler() {
    if (keyHandler) window.removeEventListener('keydown', keyHandler)
    keyHandler = null
  }

  // ---- Selection (click-to-attach) ----

  function resolveOwnerAtClick(map, e) {
    const hits = map.queryRenderedFeatures(e.point, { layers: SNAP_LAYERS })
    if (!hits.length) return null

    const hit = hits[0]
    const layer = hit.layer.id

    if (layer === 'cot-tracks-points' || layer === 'cot-tracks-symbols') {
      const uid = hit.properties.uid
      const t = tracksStore.tracks.get(uid)
      if (t) return { kind: 'cot', uid, coord: [t.lon, t.lat] }
    }

    if (layer === 'ais-vessels-points' || layer === 'ais-vessels-arrows') {
      const mmsi = String(hit.properties.mmsi)
      const v = aisStore.vessels.get(mmsi)
      if (v) return { kind: 'ais', mmsi, coord: [v.longitude, v.latitude] }
      // Fall back to rendered geometry if the store just refreshed — same
      // compromise the bloodhound composable makes.
      return { kind: 'ais', mmsi, coord: [hit.geometry.coordinates[0], hit.geometry.coordinates[1]] }
    }

    if (layer === 'manual-tracks-points' || layer === 'manual-tracks-symbols') {
      const featureId = hit.properties._dbId
      if (featureId != null) {
        const coord = featureCentroid(featureId)
        if (coord) return { kind: 'feature', featureId, coord }
      }
    }

    return null
  }

  function removeClickHandler() {
    const map = getMap()
    if (map && clickHandler) map.off('click', clickHandler)
    if (map && moveHandler)  map.off('mousemove', moveHandler)
    clickHandler = null
    moveHandler  = null
  }

  function startSelecting() {
    const map = getMap()
    if (!map) return

    isSelecting.value = true
    map.getCanvasContainer().style.cursor = 'default'
    removeClickHandler()

    moveHandler = (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: SNAP_LAYERS })
      map.getCanvasContainer().style.cursor = hits.length ? 'crosshair' : 'default'
    }

    clickHandler = (e) => {
      const owner = resolveOwnerAtClick(map, e)
      if (!owner) return
      addPerimeter(owner, defaultRadius.value, true)
      exitSelecting()
    }

    map.on('mousemove', moveHandler)
    map.on('click', clickHandler)
  }

  function exitSelecting() {
    removeClickHandler()
    isSelecting.value = false
    const map = getMap()
    if (map) map.getCanvasContainer().style.cursor = ''
  }

  function toggleSelecting() {
    ensureSourcesAndLayers()
    if (!isSelecting.value) {
      ensureKeyHandler()
      startSelecting()
    } else {
      exitSelecting()
    }
  }

  // ---- Public programmatic API ----

  // Add or replace the perimeter on a track. `owner` is a typed ref
  // ({kind, uid|mmsi|featureId, coord}). Returns the ownerKey or null if the
  // map isn't ready yet.
  function addPerimeter(owner, radius, alert = true) {
    const map = getMap()
    if (!map) return null
    ensureSourcesAndLayers()
    const key = ownerKeyOf(owner)
    perimeters.set(key, {
      owner: { ...owner },
      radius: Number(radius) || 0,
      alert:  Boolean(alert),
      breached: new Set()
    })
    ensureWatchers()
    ensureKeyHandler()
    reresolveAll()
    return key
  }

  function removePerimeter(ownerKey) {
    if (!perimeters.has(ownerKey)) return false
    perimeters.delete(ownerKey)
    perimeterCount.value = perimeters.size
    rebuildSources()
    bumpTick.value++
    if (!perimeters.size) {
      stopWatchers()
    }
    return true
  }

  function setRadius(ownerKey, radius) {
    const p = perimeters.get(ownerKey)
    if (!p) return false
    p.radius = Number(radius) || 0
    reresolveAll()
    return true
  }

  function setAlert(ownerKey, alert) {
    const p = perimeters.get(ownerKey)
    if (!p) return false
    p.alert = Boolean(alert)
    reresolveAll()
    return true
  }

  function setDefaultRadius(r) {
    defaultRadius.value = Number(r) || 0
  }

  function clearAll() {
    exitSelecting()
    perimeters.clear()
    perimeterCount.value = 0
    rebuildSources()
    bumpTick.value++
    stopWatchers()
    removeKeyHandler()
  }

  onUnmounted(() => {
    removeClickHandler()
    removeKeyHandler()
    stopWatchers()
    perimeters.clear()
    const map = getMap()
    if (!map) return
    if (map.getLayer(HALOS_LAYER)) map.removeLayer(HALOS_LAYER)
    if (map.getLayer(RINGS_LAYER)) map.removeLayer(RINGS_LAYER)
    if (map.getSource(HALOS_SOURCE)) map.removeSource(HALOS_SOURCE)
    if (map.getSource(RINGS_SOURCE)) map.removeSource(RINGS_SOURCE)
  })

  return {
    perimeterSelecting,
    perimeters: perimeterList,
    defaultRadius,
    toggleSelecting,
    addPerimeter,
    removePerimeter,
    setRadius,
    setAlert,
    setDefaultRadius,
    clearAll
  }
}
