import { ref, watch, computed, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import { distanceBetween, formatDistance, geometryBounds } from '@/services/geometry'
import { useSettingsStore } from '@/stores/settings'
import { useTracksStore } from '@/stores/tracks'
import { useAisStore } from '@/stores/ais'
import { useFeaturesStore } from '@/stores/features'
import { useBloodhoundsStore } from '@/stores/bloodhounds'

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

export function useMapBloodhound(getMap, pluginSnap = null) {
  const settingsStore    = useSettingsStore()
  const tracksStore      = useTracksStore()
  const aisStore         = useAisStore()
  const featuresStore    = useFeaturesStore()
  const bloodhoundsStore = useBloodhoundsStore()

  const isSelecting  = ref(false)

  // The toolbar button reflects selection mode only. Committed lines remain
  // visible after selection exits; the button dims so map clicks, draw, and
  // measure are fully restored.
  const bloodhounding = computed(() => isSelecting.value)

  // Persisted source-of-truth lives in `bloodhoundsStore.lines`
  // (Vue ref of `[{ id, epA, epB }]`). The MapLibre markers
  // themselves are tied to the live map and recreated each time
  // the composable mounts; we track them locally by id.
  const markersById = new Map()  // id -> { markerMid, markerA, markerB }
  let pendingEpA = null  // first endpoint in the in-progress pair

  // Reactive summary for the panel + assistant tools. Rebuilds when
  // store mutates and on endpoint re-resolve (bumpTick).
  const bumpTick = ref(0)
  const bloodhounds = computed(() => {
    void bumpTick.value
    return bloodhoundsStore.lines.map(r => ({
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
    'cot-tracks-symbols',
    'ais-vessels-points',
    'ais-vessels-arrows',
    'manual-tracks-points',
    'manual-tracks-symbols',
    'draw-features-points',
    'draw-features-line',
    'draw-features-fill',
    'draw-image-bounds-fill',
    'route-line',
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
    // Bloodhound is added lazily on first use — usually after
    // plugins have registered their map content. MapLibre would
    // paint a fresh bloodhound line over plugin sprites + their
    // LEDs / labels, which buries plugin-managed entities the
    // user is actively connecting to. Lift plugin layers back on
    // top so the line passes UNDER the boat / LED.
    pluginSnap?.liftPluginLayers?.()
  }

  // ---- Endpoint resolution ----
  //
  // Returns the latest [lng, lat] for an endpoint ref, or null if the source
  // has disappeared (track pruned, feature deleted, vessel outside the AIS
  // fetch window). When any endpoint disappears, `reresolveAll` drops the
  // bloodhound entirely — see `endpointGone` below. (`point` endpoints have
  // no upstream and never disappear.)
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
    const features = bloodhoundsStore.lines.map(r => ({
      type: 'Feature',
      properties: { id: r.id },
      geometry: { type: 'LineString', coordinates: [r.epA.coord, r.epB.coord] }
    }))
    map.getSource(BH_SOURCE)?.setData({ type: 'FeatureCollection', features })
  }

  // Sync the line's three MapLibre markers (mid label, two endpoint
  // dots) with its current endpoint coords. `r` is the persisted
  // record from the store; markers are looked up / created in the
  // composable-local `markersById` Map.
  function syncLineMarkers(r) {
    const cA  = r.epA.coord
    const cB  = r.epB.coord
    const mid = [(cA[0] + cB[0]) / 2, (cA[1] + cB[1]) / 2]
    const label = formatDistance(distanceBetween(cA, cB), settingsStore.distanceUnits)

    let m = markersById.get(r.id)
    if (!m) { m = { markerMid: null, markerA: null, markerB: null }; markersById.set(r.id, m) }

    if (m.markerMid) {
      m.markerMid.setLngLat(mid)
      m.markerMid.getElement().textContent = label
    } else {
      m.markerMid = placeMarker(mid, makeLabelEl(label))
    }

    if (m.markerA) m.markerA.setLngLat(cA)
    else           m.markerA = placeMarker(cA, makeDotEl())

    if (m.markerB) m.markerB.setLngLat(cB)
    else           m.markerB = placeMarker(cB, makeDotEl())
  }

  function updateAllDisplays() {
    rebuildSource()
    for (const r of bloodhoundsStore.lines) syncLineMarkers(r)
    bumpTick.value++
  }

  function removeLineMarkersById(id) {
    const m = markersById.get(id)
    if (!m) return
    if (m.markerMid) { m.markerMid.remove(); m.markerMid = null }
    if (m.markerA)   { m.markerA.remove();   m.markerA   = null }
    if (m.markerB)   { m.markerB.remove();   m.markerB   = null }
    markersById.delete(id)
  }

  function removeLineMarkersAll() {
    for (const id of [...markersById.keys()]) removeLineMarkersById(id)
  }

  // True if an endpoint's anchor entity is no longer present in its store —
  // a deleted manual / draw feature, a CoT track that was removed or pruned,
  // or an AIS vessel that aged out. `point` endpoints have no upstream.
  // Hidden anchors (track-list eye toggle) are still in the store, so this
  // returns false for them — visibility is not removal.
  function endpointGone(ep) {
    if (ep.kind === 'cot')     return !tracksStore.tracks.get(ep.uid)
    if (ep.kind === 'ais')     return !aisStore.vessels.get(ep.mmsi)
    if (ep.kind === 'feature') return !featuresStore.features.some(f => f.id === ep.featureId)
    return false
  }

  // Re-resolve every endpoint against the current source stores
  // and update the map + markers if anything moved. Lines whose
  // anchors disappeared are removed from the persisted store too.
  function reresolveAll() {
    if (!bloodhoundsStore.lines.length) return
    let changed = false
    // Iterate a snapshot so removing through the store mid-loop
    // doesn't skip entries.
    for (const r of [...bloodhoundsStore.lines]) {
      if (endpointGone(r.epA) || endpointGone(r.epB)) {
        removeLineMarkersById(r.id)
        bloodhoundsStore.remove(r.id)
        changed = true
        continue
      }
      const cA = resolveCoord(r.epA)
      const cB = resolveCoord(r.epB)
      const aMoved = cA && (cA[0] !== r.epA.coord[0] || cA[1] !== r.epA.coord[1])
      const bMoved = cB && (cB[0] !== r.epB.coord[0] || cB[1] !== r.epB.coord[1])
      if (aMoved || bMoved) {
        bloodhoundsStore.updateCoords(r.id, aMoved ? cA : null, bMoved ? cB : null)
        changed = true
      }
    }
    if (changed) updateAllDisplays()
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

  // Clears all committed lines and exits selection. Wipes the
  // persisted store too — the user explicitly asked for "clear".
  function clearAll() {
    exitSelecting()
    removeLineMarkersAll()
    bloodhoundsStore.clear()
    stopWatchers()
    removeKeyHandler()
    const map = getMap()
    map?.getSource(BH_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
  }

  // Resolve a click to a typed endpoint by snapping to the topmost hit feature.
  // Empty-space clicks fall through to a `point` endpoint anchored at the click
  // coord so the operator can measure to/from arbitrary locations.
  function resolveEndpointAtClick(map, e) {
    // Plugin layers that opted in via `api.map.addLayer({ snapResolver })`
    // join the snap query alongside the host layers. Lets clicks on a
    // plugin's custom sprite anchor to the bridged host entity (e.g.
    // Armada boat → corresponding CoT track).
    const pluginLayerIds = pluginSnap?.layerIds() ?? []
    const queryLayers = pluginLayerIds.length
      ? [...SNAP_LAYERS, ...pluginLayerIds]
      : SNAP_LAYERS
    const hits = map.queryRenderedFeatures(e.point, { layers: queryLayers })
    if (!hits.length) return { kind: 'point', coord: [e.lngLat.lng, e.lngLat.lat] }

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
      // Store lookup failed — the feature was rendered but the backing vessel
      // is no longer in the store (likely a poll rebuilt the map just after
      // render). Anchor to the clicked coord; the watcher will snap back to
      // live position on the next poll if the mmsi reappears.
      return { kind: 'ais', mmsi, coord: [hit.geometry.coordinates[0], hit.geometry.coordinates[1]] }
    }

    // Plugin-registered snap layer. Resolver returns a host endpoint
    // ref; coord is re-resolved through the matching store so the
    // line tracks live position.
    if (pluginSnap && pluginLayerIds.includes(layer)) {
      const ref = pluginSnap.resolve(layer, hit)
      if (ref) {
        const coord = resolveCoord(ref) ?? ref.coord ?? hit.geometry.coordinates
        if (coord) return { ...ref, coord }
      }
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

  // Registers map handlers and enters selecting state. Every click is valid —
  // snap hits produce typed endpoints, empty-space clicks produce point
  // endpoints. Handler resets pendingEpA after each pair and keeps running
  // so the user can place multiple lines in a row.
  function startSelecting() {
    const map = getMap()
    if (!map) return

    pendingEpA = null
    isSelecting.value = true
    map.getCanvasContainer().style.cursor = 'crosshair'
    removeClickHandler()

    moveHandler = () => {
      map.getCanvasContainer().style.cursor = 'crosshair'
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
    const id = bloodhoundsStore.add(epA, epB)
    const r  = bloodhoundsStore.lines.find(l => l.id === id)
    rebuildSource()
    if (r) syncLineMarkers(r)
    ensureWatchers()
    ensureKeyHandler()
    return id
  }

  // ---- Public programmatic API (assistant tools) ----

  function addBloodhound(epA, epB) {
    const map = getMap()
    if (!map) return null
    return commit(epA, epB)
  }

  function removeBloodhound(id) {
    if (!bloodhoundsStore.lines.some(l => l.id === id)) return false
    removeLineMarkersById(id)
    bloodhoundsStore.remove(id)
    rebuildSource()
    if (bloodhoundsStore.lines.length === 0) {
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

  // Hydrate from the persisted store. Called by MapView from the
  // `map.on('load', ...)` callback (the composable's `getMap()` is a
  // closure over a plain `let`, which Vue's `watch` can't track for
  // re-fire). When the user navigates back to the map after the
  // composable was torn down, the lines are still in
  // `bloodhoundsStore`; we re-attach markers + sources against the
  // new map.
  //
  // CRITICAL: do NOT call `reresolveAll()` here. That function
  // drops any line whose endpoint uid isn't currently in the
  // matching store — and on a fresh map mount, neither host
  // listeners nor plugin tracks have reconnected yet. The line
  // would get purged before its anchors had a chance to come back.
  // Instead: draw at the persisted last-known coords, then let the
  // regular watchers handle subsequent updates.
  function init() {
    const map = getMap()
    if (!map) return
    if (!bloodhoundsStore.lines.length) return
    ensureSource()
    ensureWatchers()
    ensureKeyHandler()
    rebuildSource()
    for (const r of bloodhoundsStore.lines) syncLineMarkers(r)
    bumpTick.value++
  }

  onUnmounted(() => {
    removeClickHandler()
    removeKeyHandler()
    stopWatchers()
    // Tear down per-map markers + the map source / layer; do NOT
    // clear `bloodhoundsStore.lines` so the lines come back when
    // the user navigates back to MapView.
    removeLineMarkersAll()
    const map = getMap()
    if (!map) return
    if (map.getLayer(BH_LAYER))   map.removeLayer(BH_LAYER)
    if (map.getSource(BH_SOURCE)) map.removeSource(BH_SOURCE)
  })

  return {
    init,
    bloodhounding,
    bloodhounds,
    toggleSelecting,
    addBloodhound,
    removeBloodhound,
    clearAll
  }
}
