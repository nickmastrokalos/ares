import { ref, watch, computed, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import { distanceBetween, formatDistance, geometryBounds } from '@/services/geometry'
import { useSettingsStore } from '@/stores/settings'
import { useTracksStore } from '@/stores/tracks'
import { useAisStore } from '@/stores/ais'
import { useFeaturesStore } from '@/stores/features'

const BH_SOURCE = 'bloodhound-line'
const BH_LAYER  = 'bloodhound-line-layer'

// Bloodhound — named after the scent dog. A bloodhound line ties two endpoints
// together; each endpoint may be a live source (CoT track, AIS vessel, mission
// feature) or a raw coordinate. Lines track their endpoints: as tracks/vessels
// move or features are dragged, the line and its distance label follow.
//
// Endpoint ref (stored on the line):
//   { kind: 'point',   coord: [lng, lat] }
//   { kind: 'cot',     uid:      <string>, coord: [lng, lat] }   // coord = last resolved
//   { kind: 'ais',     mmsi:     <string>, coord: [lng, lat] }
//   { kind: 'feature', featureId:<number>, coord: [lng, lat] }
//
// Line shape:
//   { id, epA, epB, markerMid, markerA, markerB }
//
// Flow:
//   Toolbar Bloodhound button → open panel.
//   Click "+ Add" in panel     → enter selecting (cursor = crosshair).
//     Click A, click B         → line committed, automatically reset for next pair.
//     Escape or click "+ Add"  → exit selecting; committed lines stay.
//   Remove individual line from panel list, or "Clear all".

export function useMapBloodhound(getMap) {
  const settingsStore = useSettingsStore()
  const tracksStore   = useTracksStore()
  const aisStore      = useAisStore()
  const featuresStore = useFeaturesStore()

  const isSelecting  = ref(false)
  const bloodhoundCount = ref(0)  // reactive mirror of committed.length

  // The toolbar button reflects selection mode only. Committed lines remain
  // visible after selection exits; the button dims so map clicks, draw, and
  // measure are fully restored.
  const bloodhounding = computed(() => isSelecting.value)

  const committed = []   // plain array, mutated directly; bloodhoundCount mirrors length
  let nextId     = 0
  let pendingEpA = null  // first endpoint in the in-progress pair

  // Reactive summary for the panel + assistant tools. Rebuilds on add/remove/
  // clear (bloodhoundCount bump) and on endpoint re-resolve (bumpTick).
  const bumpTick = ref(0)
  const bloodhounds = computed(() => {
    void bloodhoundCount.value
    void bumpTick.value
    return committed.map(r => ({
      id:   r.id,
      epA:  { ...r.epA, label: labelForEndpoint(r.epA) },
      epB:  { ...r.epB, label: labelForEndpoint(r.epB) },
      distanceMeters: distanceBetween(r.epA.coord, r.epB.coord)
    }))
  })

  let clickHandler = null
  let moveHandler  = null
  let keyHandler   = null
  let stopTrackWatch   = null
  let stopAisWatch     = null
  let stopFeatureWatch = null

  // Layers that can seed a bloodhound endpoint. The first topmost hit wins;
  // the layer id then routes to a typed endpoint (cot / ais / feature) or
  // falls back to a raw coordinate for misc hits.
  const SNAP_LAYERS = [
    'cot-tracks-points',
    'ais-vessels-points',
    'ais-vessels-arrows',
    'manual-tracks-points',
    'manual-tracks-symbols',
    'draw-features-points',
    'draw-features-line',
    'draw-features-fill',
    'route-dot'
  ]

  // ---- DOM helpers (match useMapMeasure label style) ----

  function makeLabelEl(text) {
    const el = document.createElement('div')
    el.style.cssText =
      'background:rgba(22,22,22,0.85);color:#e0e0e0;font-size:11px;' +
      'padding:2px 6px;border-radius:3px;white-space:nowrap;pointer-events:none;' +
      'font-family:sans-serif;line-height:1.4;'
    el.textContent = text
    return el
  }

  function makeDotEl() {
    const el = document.createElement('div')
    el.style.cssText =
      'width:8px;height:8px;background:#4a9ade;border:1px solid #000;' +
      'border-radius:50%;pointer-events:none;'
    return el
  }

  function placeMarker(lngLat, el) {
    const map = getMap()
    if (!map) return null
    return new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(map)
  }

  // ---- Source / layer (lazy, idempotent) ----

  function ensureSource() {
    const map = getMap()
    if (!map || map.getSource(BH_SOURCE)) return
    map.addSource(BH_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: BH_LAYER,
      type: 'line',
      source: BH_SOURCE,
      paint: {
        'line-color': '#4a9ade',
        'line-width': 2,
        'line-dasharray': [5, 3]
      }
    })
  }

  // ---- Endpoint resolution ----
  //
  // Returns the latest [lng, lat] for an endpoint ref, or null if the source
  // has disappeared (track pruned, feature deleted, vessel outside the AIS
  // fetch window). Callers decide how to handle null — today we freeze the
  // line at its last-known coord (ep.coord is not touched on null).
  function resolveCoord(ep) {
    if (ep.kind === 'point') return ep.coord
    if (ep.kind === 'cot') {
      const t = tracksStore.tracks.get(ep.uid)
      return t ? [t.lon, t.lat] : null
    }
    if (ep.kind === 'ais') {
      const v = aisStore.vessels.get(ep.mmsi)
      return v ? [v.longitude, v.latitude] : null
    }
    if (ep.kind === 'feature') {
      return featureCentroid(ep.featureId)
    }
    return null
  }

  // Bbox midpoint for a mission feature. Mirrors the shared "center" logic
  // used by assistant tools and cot.js — circle/ellipse/sector use stored
  // center; box uses sw/ne midpoint; everything else uses geometry bounds.
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
      const props = JSON.parse(row.properties)
      return props.name ?? `${row.type} #${ep.featureId}`
    }
    return `${ep.coord[1].toFixed(4)}, ${ep.coord[0].toFixed(4)}`
  }

  // ---- Display ----

  function rebuildSource() {
    const map = getMap()
    if (!map) return
    const features = committed.map(r => ({
      type: 'Feature',
      properties: { id: r.id },
      geometry: { type: 'LineString', coordinates: [r.epA.coord, r.epB.coord] }
    }))
    map.getSource(BH_SOURCE)?.setData({ type: 'FeatureCollection', features })
  }

  function syncLineMarkers(r) {
    const cA  = r.epA.coord
    const cB  = r.epB.coord
    const mid = [(cA[0] + cB[0]) / 2, (cA[1] + cB[1]) / 2]
    const label = formatDistance(distanceBetween(cA, cB), settingsStore.distanceUnits)

    if (r.markerMid) {
      r.markerMid.setLngLat(mid)
      r.markerMid.getElement().textContent = label
    } else {
      r.markerMid = placeMarker(mid, makeLabelEl(label))
    }

    if (r.markerA) r.markerA.setLngLat(cA)
    else           r.markerA = placeMarker(cA, makeDotEl())

    if (r.markerB) r.markerB.setLngLat(cB)
    else           r.markerB = placeMarker(cB, makeDotEl())
  }

  function updateAllDisplays() {
    rebuildSource()
    for (const r of committed) syncLineMarkers(r)
    bumpTick.value++
  }

  function removeLineMarkers(r) {
    if (r.markerMid) { r.markerMid.remove(); r.markerMid = null }
    if (r.markerA)   { r.markerA.remove();   r.markerA   = null }
    if (r.markerB)   { r.markerB.remove();   r.markerB   = null }
  }

  // Re-resolve every endpoint against the current source stores and update
  // the map + markers if anything moved. Called from the combined watcher.
  function reresolveAll() {
    if (!committed.length) return
    let changed = false
    for (let i = committed.length - 1; i >= 0; i--) {
      const r = committed[i]
      // If a feature endpoint's feature is gone, drop the line entirely —
      // the feature system already cleans up its own panels on deletion.
      if (r.epA.kind === 'feature' && !featuresStore.features.some(f => f.id === r.epA.featureId) ||
          r.epB.kind === 'feature' && !featuresStore.features.some(f => f.id === r.epB.featureId)) {
        removeLineMarkers(r)
        committed.splice(i, 1)
        changed = true
        continue
      }
      const cA = resolveCoord(r.epA)
      const cB = resolveCoord(r.epB)
      if (cA && (cA[0] !== r.epA.coord[0] || cA[1] !== r.epA.coord[1])) { r.epA.coord = cA; changed = true }
      if (cB && (cB[0] !== r.epB.coord[0] || cB[1] !== r.epB.coord[1])) { r.epB.coord = cB; changed = true }
    }
    if (changed) {
      bloodhoundCount.value = committed.length
      updateAllDisplays()
    }
  }

  // ---- Source watchers — keep endpoints live ----

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

  // ---- Handler management ----

  function removeClickHandler() {
    const map = getMap()
    if (map && clickHandler) map.off('click', clickHandler)
    if (map && moveHandler)  map.off('mousemove', moveHandler)
    clickHandler = null
    moveHandler  = null
  }

  function removeKeyHandler() {
    if (keyHandler) window.removeEventListener('keydown', keyHandler)
    keyHandler = null
  }

  // ---- Selection ----

  // Exits selection mode, releases handlers. Committed lines are untouched.
  function exitSelecting() {
    removeClickHandler()
    pendingEpA = null
    isSelecting.value = false
    const map = getMap()
    if (map) map.getCanvasContainer().style.cursor = ''
  }

  // Clears all committed lines and exits selection.
  function clearAll() {
    exitSelecting()
    for (const r of committed) removeLineMarkers(r)
    committed.length = 0
    bloodhoundCount.value = 0
    stopWatchers()
    removeKeyHandler()
    const map = getMap()
    map?.getSource(BH_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
  }

  // Resolve a click to a typed endpoint by snapping to the topmost hit feature.
  // Returns null for empty-space clicks — both endpoints must be snapped.
  function resolveEndpointAtClick(map, e) {
    const hits = map.queryRenderedFeatures(e.point, { layers: SNAP_LAYERS })
    if (!hits.length) return null

    const hit = hits[0]
    const layer = hit.layer.id

    if (layer === 'cot-tracks-points') {
      const uid = hit.properties.uid
      const t = tracksStore.tracks.get(uid)
      if (t) return { kind: 'cot', uid, coord: [t.lon, t.lat] }
    }

    if (layer === 'ais-vessels-points' || layer === 'ais-vessels-arrows') {
      const mmsi = String(hit.properties.mmsi)
      const v = aisStore.vessels.get(mmsi)
      if (v) return { kind: 'ais', mmsi, coord: [v.longitude, v.latitude] }
    }

    // All feature-backed layers (draw shapes, manual tracks, route dots)
    // expose _dbId; their centroid is the endpoint, not the click coord,
    // so the line follows if the feature is moved.
    const featureId = hit.properties._dbId
    if (featureId != null) {
      const coord = featureCentroid(featureId)
      if (coord) return { kind: 'feature', featureId, coord }
    }

    // Final fallback — should rarely trigger; keeps click interaction usable
    // if a layer returns no _dbId (e.g. future plugin overlays).
    return { kind: 'point', coord: [e.lngLat.lng, e.lngLat.lat] }
  }

  // Registers map handlers and enters selecting state. Clicks on empty space
  // are ignored; the handler resets pendingEpA after each pair and keeps
  // running so the user can place multiple lines in a row.
  function startSelecting() {
    const map = getMap()
    if (!map) return

    pendingEpA = null
    isSelecting.value = true
    map.getCanvasContainer().style.cursor = 'default'
    removeClickHandler()

    moveHandler = (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: SNAP_LAYERS })
      map.getCanvasContainer().style.cursor = hits.length ? 'crosshair' : 'default'
    }

    clickHandler = (e) => {
      const ep = resolveEndpointAtClick(map, e)
      if (!ep) return

      if (!pendingEpA) {
        pendingEpA = ep
      } else {
        commit(pendingEpA, ep)
        pendingEpA = null
      }
    }

    map.on('mousemove', moveHandler)
    map.on('click', clickHandler)
  }

  // ---- Shared commit ----

  function commit(epA, epB) {
    ensureSource()
    const r = {
      id: nextId++,
      epA: { ...epA },
      epB: { ...epB },
      markerMid: null,
      markerA:   null,
      markerB:   null
    }
    committed.push(r)
    bloodhoundCount.value = committed.length
    rebuildSource()
    syncLineMarkers(r)
    ensureWatchers()
    ensureKeyHandler()
    return r.id
  }

  // ---- Public programmatic API (assistant tools) ----

  function addBloodhound(epA, epB) {
    const map = getMap()
    if (!map) return null
    return commit(epA, epB)
  }

  function removeBloodhound(id) {
    const idx = committed.findIndex(r => r.id === id)
    if (idx < 0) return false
    removeLineMarkers(committed[idx])
    committed.splice(idx, 1)
    bloodhoundCount.value = committed.length
    rebuildSource()
    if (committed.length === 0) {
      stopWatchers()
      removeKeyHandler()
    }
    return true
  }

  function ensureKeyHandler() {
    if (keyHandler) return
    keyHandler = (e) => {
      if (e.key !== 'Escape') return
      if (isSelecting.value) exitSelecting()
    }
    window.addEventListener('keydown', keyHandler)
  }

  // ---- Public ----

  // Called by the panel "+ Add" button to toggle selection.
  //   • not selecting → enter selecting (cursor = crosshair on snap)
  //   • selecting     → exit selecting (cursor resets, lines stay)
  function toggleSelecting() {
    ensureSource()
    if (!isSelecting.value) {
      ensureKeyHandler()
      startSelecting()
    } else {
      exitSelecting()
    }
  }

  onUnmounted(() => {
    removeClickHandler()
    removeKeyHandler()
    stopWatchers()
    for (const r of committed) removeLineMarkers(r)
    committed.length = 0
    const map = getMap()
    if (!map) return
    if (map.getLayer(BH_LAYER))   map.removeLayer(BH_LAYER)
    if (map.getSource(BH_SOURCE)) map.removeSource(BH_SOURCE)
  })

  return {
    bloodhounding,
    bloodhounds,
    toggleSelecting,
    addBloodhound,
    removeBloodhound,
    clearAll
  }
}
