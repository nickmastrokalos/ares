import { ref, computed, onUnmounted, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { circlePolygon, destinationPoint, formatDistance } from '@/services/geometry'
import { useSettingsStore } from '@/stores/settings'
import { getDb } from '@/plugins/database'
import { getStore } from '@/plugins/store'

// Operator-placed reference point with concentric range rings and optional
// cardinal spokes. Used for classic tactical bullseye calls ("bullseye
// 090/10nm") — see docs/bullseye.md. Single active bullseye at a time;
// placing again replaces the previous one.
//
// Bearing reference is true north. Magnetic/declination is not modelled.
//
// Persistence: per-mission, stored in the SQLite `bullseyes` table
// (migration v4). One row per mission, keyed on mission_id. `init()` must
// be called from `map.on('load')` once the style is ready, so restoring a
// persisted bullseye can add its sources and layers without racing the
// style. `init()` also performs a one-time migration from the earlier
// `@tauri-apps/plugin-store` key (`bullseye:${missionId}`) so existing dev
// data is not lost.

const RINGS_SOURCE      = 'bullseye-rings'
const RINGS_LAYER       = 'bullseye-rings-line'
const CARDINALS_SOURCE  = 'bullseye-cardinals'
const CARDINALS_LAYER   = 'bullseye-cardinals-line'
const HANDLE_SOURCE     = 'bullseye-handle'
const HANDLE_LAYER      = 'bullseye-handle-layer'
// Invisible click target so the user can select the bullseye anywhere near
// its centre, not just on the tiny handle dot. Shares HANDLE_SOURCE so it
// tracks the rendered centre automatically.
const HIT_TARGET_LAYER  = 'bullseye-hit-target-layer'

const RING_COLOR        = '#8a92a8'
const CARDINAL_COLOR    = '#6c7489'

const DEFAULTS = {
  name: 'BULLSEYE',
  ringInterval: 1852,  // 1 nautical mile
  ringCount: 5,
  showCardinals: true
}

export function useMapBullseye(getMap, missionId = null, onRequestOpenPanel = null, suppress = { value: false }) {
  const settingsStore = useSettingsStore()

  const persistEnabled = missionId != null

  const bullseyeRef   = ref(null)  // { lat, lon, name, ringInterval, ringCount, showCardinals }
  const isSelecting   = ref(false)
  // Two-step select-then-drag gate. The white handle dot stays hidden until
  // the operator clicks the bullseye once; a click elsewhere hides it again.
  // Mirrors the selection pattern used by annotations and manual tracks,
  // except the bullseye card deliberately stays open across deselection
  // (user requested this so settings edits aren't interrupted by stray
  // clicks).
  const isHandleShown = ref(false)
  // Live drag broadcast: { lng, lat } while a drag is in progress, null
  // otherwise. `BullseyePanel.vue` reads this to keep the centre coord field
  // in sync with the cursor during a drag — same pattern as the
  // `draggingTrack` broadcast used by manual tracks.
  const draggingBullseye = ref(null)

  const bullseye           = computed(() => bullseyeRef.value)
  const bullseyeSelecting  = computed(() => isSelecting.value)
  const bullseyeCount      = computed(() => bullseyeRef.value ? 1 : 0)

  let clickHandler         = null
  let moveHandler          = null
  let keyHandler           = null
  let nameLabelMarker      = null
  let ringLabelMarkers     = []  // ring distance labels (one per ring)
  let cardinalLabelMarkers = []  // N / E / S / W letters
  let zoomHandler          = null
  let dragWired            = false
  let deselectHandler      = null
  // Guards the post-drag click that the map fires on mouseup while the panel
  // is in Set/Move mode — without it, releasing a drag would also drop a new
  // bullseye at that location, and the click-away handler would hide the
  // handle the user just moved.
  let suppressNextClick    = false

  // Flip the visible handle layer whenever the selection gate changes. The
  // layer is created with `layout.visibility: 'none'` so it only appears
  // after the first click.
  const stopHandleVisibilityWatch = watch(isHandleShown, (shown) => {
    const map = getMap()
    if (!map?.getLayer(HANDLE_LAYER)) return
    map.setLayoutProperty(HANDLE_LAYER, 'visibility', shown ? 'visible' : 'none')
  })

  // ---- Map source / layer setup ----

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
          'line-color': RING_COLOR,
          'line-width': 1,
          'line-dasharray': [3, 3],
          'line-opacity': 0.8
        }
      })
    }
    if (!map.getSource(CARDINALS_SOURCE)) {
      map.addSource(CARDINALS_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: CARDINALS_LAYER,
        type: 'line',
        source: CARDINALS_SOURCE,
        paint: {
          'line-color': CARDINAL_COLOR,
          'line-width': 0.8,
          'line-dasharray': [2, 3],
          'line-opacity': 0.6
        }
      })
    }
    if (!map.getSource(HANDLE_SOURCE)) {
      map.addSource(HANDLE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      // Invisible hit target — a wider transparent circle so clicks anywhere
      // near the centre count, not just on the tiny handle dot. Also used
      // for the hover cursor and the click-away query. Sits below the
      // visible handle so the handle still renders on top when shown.
      map.addLayer({
        id: HIT_TARGET_LAYER,
        type: 'circle',
        source: HANDLE_SOURCE,
        paint: {
          'circle-radius': 18,
          'circle-color': '#ffffff',
          'circle-opacity': 0
        }
      })
      // Same visual language as the shape-vertex handles in useMapDraw: a
      // white dot with a blue ring sits exactly on the projected centre,
      // giving the operator a distinct grab target that stays aligned at
      // every zoom level and projection. Hidden by default — the
      // isHandleShown watch toggles visibility once the bullseye is
      // selected.
      map.addLayer({
        id: HANDLE_LAYER,
        type: 'circle',
        source: HANDLE_SOURCE,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#4a9ade',
          'circle-stroke-width': 2
        }
      })
    }
    setupBullseyeDrag(map)
    setupDeselectOnMapClick(map)
  }

  // ---- Label markers ----
  //
  // Ring-distance / name / cardinal letters stay as HTML markers so they
  // render reliably without depending on the glyph server being reachable
  // (same approach as measure / perimeter).

  function labelEl(text, opts = {}) {
    const el = document.createElement('div')
    el.style.cssText =
      'background:rgba(22,22,22,0.75);color:#d0d4de;font-size:10px;' +
      'padding:1px 4px;border-radius:2px;white-space:nowrap;pointer-events:none;' +
      'font-family:sans-serif;letter-spacing:0.04em;' + (opts.extra ?? '')
    el.textContent = text
    return el
  }

  function clearLabelMarkers() {
    if (nameLabelMarker) { nameLabelMarker.remove(); nameLabelMarker = null }
    for (const m of ringLabelMarkers) m.remove()
    for (const m of cardinalLabelMarkers) m.remove()
    ringLabelMarkers = []
    cardinalLabelMarkers = []
  }

  // ---- Geometry helpers (shared by rebuild and live-drag preview) ----

  function ringFeaturesFor(center, b) {
    const out = []
    for (let i = 1; i <= b.ringCount; i++) {
      out.push({
        type: 'Feature',
        properties: { step: i },
        geometry: circlePolygon(center, b.ringInterval * i, 96)
      })
    }
    return out
  }

  function cardinalFeaturesFor(center, b) {
    if (!b.showCardinals) return []
    const outerR = b.ringInterval * b.ringCount
    const out = []
    for (const bearing of [0, 90, 180, 270]) {
      out.push({
        type: 'Feature',
        properties: { bearing },
        geometry: {
          type: 'LineString',
          coordinates: [center, destinationPoint(center, outerR, bearing)]
        }
      })
    }
    return out
  }

  function nameAnchorFor(center, b) {
    return destinationPoint(center, Math.max(b.ringInterval * 0.15, 50), 0)
  }

  function ringLabelPosFor(center, b, i) {
    return destinationPoint(center, b.ringInterval * i, 0)
  }

  const CARDINAL_SPECS = [
    { bearing: 0,   text: 'N', anchor: 'bottom' },
    { bearing: 90,  text: 'E', anchor: 'left'   },
    { bearing: 180, text: 'S', anchor: 'top'    },
    { bearing: 270, text: 'W', anchor: 'right'  }
  ]

  function cardinalLabelPosFor(center, b, bearing) {
    const outerR = b.ringInterval * b.ringCount
    return destinationPoint(center, outerR + b.ringInterval * 0.25, bearing)
  }

  // ---- Label declutter ----
  //
  // At wide zooms the rings collapse to a few pixels across and the text
  // labels stack on top of each other. Hide them below a pixel-spacing
  // threshold (projected through the current view so both zoom AND latitude
  // are accounted for — 1 nm looks much smaller on a polar globe pitch).

  const MIN_RING_SPACING_PX = 28
  const MIN_OUTER_RADIUS_PX = 48

  function updateLabelVisibility() {
    const map = getMap()
    const b = bullseyeRef.value
    if (!map || !b) return
    const center = [b.lon, b.lat]
    const pCenter = map.project(center)
    const pRing   = map.project(destinationPoint(center, b.ringInterval, 0))
    const pOuter  = map.project(destinationPoint(center, b.ringInterval * b.ringCount, 0))
    const ringPx  = Math.hypot(pRing.x  - pCenter.x, pRing.y  - pCenter.y)
    const outerPx = Math.hypot(pOuter.x - pCenter.x, pOuter.y - pCenter.y)
    const showRings     = ringPx  >= MIN_RING_SPACING_PX
    const showCardinals = outerPx >= MIN_OUTER_RADIUS_PX
    if (nameLabelMarker) nameLabelMarker.getElement().style.display = showRings ? '' : 'none'
    for (const m of ringLabelMarkers)     m.getElement().style.display = showRings     ? '' : 'none'
    for (const m of cardinalLabelMarkers) m.getElement().style.display = showCardinals ? '' : 'none'
  }

  function ensureZoomHandler() {
    const map = getMap()
    if (!map || zoomHandler) return
    zoomHandler = () => updateLabelVisibility()
    map.on('zoom', zoomHandler)
    map.on('move', zoomHandler)
  }

  function removeZoomHandler() {
    const map = getMap()
    if (map && zoomHandler) {
      map.off('zoom', zoomHandler)
      map.off('move', zoomHandler)
    }
    zoomHandler = null
  }

  // ---- Render ----

  function rebuild() {
    const map = getMap()
    if (!map) return
    ensureSourcesAndLayers()
    clearLabelMarkers()

    const b = bullseyeRef.value
    if (!b) {
      map.getSource(RINGS_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
      map.getSource(CARDINALS_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
      map.getSource(HANDLE_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
      return
    }

    const center = [b.lon, b.lat]

    map.getSource(RINGS_SOURCE).setData({
      type: 'FeatureCollection', features: ringFeaturesFor(center, b)
    })
    map.getSource(CARDINALS_SOURCE).setData({
      type: 'FeatureCollection', features: cardinalFeaturesFor(center, b)
    })
    map.getSource(HANDLE_SOURCE).setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: center }
      }]
    })

    // Name label just above center
    nameLabelMarker = new maplibregl.Marker({
      element: labelEl(b.name, { extra: 'font-weight:600;color:#e3e6ee;' }),
      anchor: 'bottom'
    }).setLngLat(nameAnchorFor(center, b)).addTo(map)

    // Ring distance labels — one at 0° on each ring (same spoke as the north
    // cardinal so the labels form a neat vertical column).
    const units = settingsStore.distanceUnits
    for (let i = 1; i <= b.ringCount; i++) {
      const marker = new maplibregl.Marker({
        element: labelEl(formatDistance(b.ringInterval * i, units)),
        anchor: 'bottom'
      }).setLngLat(ringLabelPosFor(center, b, i)).addTo(map)
      // Stashed on the marker so the drag handler can reposition each
      // label without recomputing ring indices on every frame.
      marker._ringIndex = i
      ringLabelMarkers.push(marker)
    }

    // Cardinal letters just beyond the outer ring at 0/90/180/270.
    if (b.showCardinals) {
      for (const { bearing, text, anchor } of CARDINAL_SPECS) {
        const marker = new maplibregl.Marker({
          element: labelEl(text, { extra: 'font-weight:700;color:#e3e6ee;' }),
          anchor
        }).setLngLat(cardinalLabelPosFor(center, b, bearing)).addTo(map)
        marker._bearing = bearing
        cardinalLabelMarkers.push(marker)
      }
    }

    ensureZoomHandler()
    updateLabelVisibility()
  }

  // ---- Drag-to-move ----
  //
  // Same map-layer mousedown + window-listener pattern used for shape
  // vertex handles and manual tracks. The handle circle is the grab
  // target; during drag we repaint every bullseye source + reposition
  // every label marker in-place (no marker teardown per frame). On
  // release we hand the final coord to setBullseye, which reruns rebuild
  // and persists.

  function setupBullseyeDrag(map) {
    if (dragWired) return
    dragWired = true
    const canvas = map.getCanvasContainer()

    // Context-aware cursor: `pointer` hints "this is selectable" while the
    // handle is hidden (first click reveals it), `grab` hints "this is
    // draggable" once the handle is visible. Wired on `mousemove` so the
    // cursor flips the moment `isHandleShown` changes without needing to
    // leave/re-enter the hit target.
    map.on('mousemove', HIT_TARGET_LAYER, () => {
      if (isSelecting.value || suppress.value) return
      canvas.style.cursor = isHandleShown.value ? 'grab' : 'pointer'
    })
    map.on('mouseleave', HIT_TARGET_LAYER, () => {
      if (!isSelecting.value && !suppress.value) canvas.style.cursor = ''
    })

    map.on('mousedown', HIT_TARGET_LAYER, (e) => {
      if (suppress.value || isSelecting.value) return
      if (e.originalEvent?.button !== 0) return
      const b = bullseyeRef.value
      if (!b) return

      // Two-step select-then-drag: the first click reveals the handle and
      // opens the panel without moving anything. Only an already-selected
      // bullseye starts a drag. Forces the user to confirm intent before
      // moving — same flow as annotations and manual tracks.
      if (!isHandleShown.value) {
        e.preventDefault()
        isHandleShown.value = true
        if (typeof onRequestOpenPanel === 'function') onRequestOpenPanel()
        return
      }

      e.preventDefault()
      map.dragPan.disable()
      canvas.style.cursor = 'grabbing'

      let hasMoved = false
      let lastLngLat = null

      function onWindowMouseMove(me) {
        hasMoved = true
        // getCanvasContainer (not getContainer) — unproject expects coords
        // in the canvas's frame, not the outer container's, otherwise the
        // drag shifts by any toolbar/chrome offset above the canvas.
        const rect = canvas.getBoundingClientRect()
        lastLngLat = map.unproject([me.clientX - rect.left, me.clientY - rect.top])
        draggingBullseye.value = { lng: lastLngLat.lng, lat: lastLngLat.lat }
        const newCenter = [lastLngLat.lng, lastLngLat.lat]
        map.getSource(HANDLE_SOURCE)?.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: newCenter }
          }]
        })
        map.getSource(RINGS_SOURCE)?.setData({
          type: 'FeatureCollection', features: ringFeaturesFor(newCenter, b)
        })
        map.getSource(CARDINALS_SOURCE)?.setData({
          type: 'FeatureCollection', features: cardinalFeaturesFor(newCenter, b)
        })
        if (nameLabelMarker) nameLabelMarker.setLngLat(nameAnchorFor(newCenter, b))
        for (const m of ringLabelMarkers)     m.setLngLat(ringLabelPosFor(newCenter, b, m._ringIndex))
        for (const m of cardinalLabelMarkers) m.setLngLat(cardinalLabelPosFor(newCenter, b, m._bearing))
      }

      function finish(commit) {
        window.removeEventListener('mousemove', onWindowMouseMove)
        window.removeEventListener('mouseup', onWindowMouseUp)
        window.removeEventListener('keydown', onWindowKeyDown)
        map.dragPan.enable()
        canvas.style.cursor = ''
        draggingBullseye.value = null

        if (commit && hasMoved && lastLngLat) {
          // Swallow the trailing click so Set/Move mode doesn't drop a new
          // bullseye at the release point, and the click-away handler
          // doesn't hide the handle we just dragged.
          suppressNextClick = true
          setTimeout(() => { suppressNextClick = false }, 0)
          setBullseye({ lat: lastLngLat.lat, lon: lastLngLat.lng })
        } else {
          // Escape mid-drag or zero-movement release on an already-selected
          // bullseye — revert preview to committed state. The handle stays
          // visible either way.
          rebuild()
        }
      }

      function onWindowMouseUp()   { finish(true) }
      function onWindowKeyDown(ke) { if (ke.key === 'Escape') finish(false) }

      window.addEventListener('mousemove', onWindowMouseMove)
      window.addEventListener('mouseup', onWindowMouseUp)
      window.addEventListener('keydown', onWindowKeyDown)
    })
  }

  // Click-away: a click anywhere on the map that doesn't hit the bullseye
  // hit target hides the handle again. The card deliberately stays open —
  // unlike annotations, the user wants the bullseye panel to persist across
  // handle deselection.
  function setupDeselectOnMapClick(map) {
    if (deselectHandler) return
    deselectHandler = (e) => {
      if (suppressNextClick) return
      if (!isHandleShown.value) return
      if (isSelecting.value || suppress.value) return
      const hits = map.queryRenderedFeatures(e.point, { layers: [HIT_TARGET_LAYER] })
      if (hits.length > 0) return  // click landed on the bullseye — mousedown handles it
      isHandleShown.value = false
    }
    map.on('click', deselectHandler)
  }

  // ---- Selection (click-to-place) ----

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
    map.getCanvasContainer().style.cursor = 'crosshair'
    removeClickHandler()

    moveHandler = () => {
      map.getCanvasContainer().style.cursor = 'crosshair'
    }

    clickHandler = (e) => {
      if (suppressNextClick) return
      setBullseye({ lat: e.lngLat.lat, lon: e.lngLat.lng })
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

  // ---- Persistence ----

  function rowToBullseye(row) {
    if (!row) return null
    const lat = Number(row.lat)
    const lon = Number(row.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return {
      name:          row.name          ?? DEFAULTS.name,
      ringInterval:  Number(row.ring_interval) || DEFAULTS.ringInterval,
      ringCount:     Number(row.ring_count)    || DEFAULTS.ringCount,
      showCardinals: row.show_cardinals === 1 || row.show_cardinals === true,
      lat, lon
    }
  }

  async function persist() {
    if (!persistEnabled) return
    try {
      const db = await getDb()
      const b = bullseyeRef.value
      if (b) {
        await db.execute(
          `INSERT INTO bullseyes (mission_id, lat, lon, name, ring_interval, ring_count, show_cardinals, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, datetime('now'))
           ON CONFLICT(mission_id) DO UPDATE SET
             lat            = excluded.lat,
             lon            = excluded.lon,
             name           = excluded.name,
             ring_interval  = excluded.ring_interval,
             ring_count     = excluded.ring_count,
             show_cardinals = excluded.show_cardinals,
             updated_at     = datetime('now')`,
          [missionId, b.lat, b.lon, b.name, b.ringInterval, b.ringCount, b.showCardinals ? 1 : 0]
        )
      } else {
        await db.execute('DELETE FROM bullseyes WHERE mission_id = $1', [missionId])
      }
    } catch (err) {
      console.error('Failed to persist bullseye:', err)
    }
  }

  // One-time migration from the earlier kv-store layout. If a row already
  // exists in SQLite, SQLite wins and the kv entry is simply dropped.
  async function migrateFromKvStore(db) {
    const storageKey = `bullseye:${missionId}`
    try {
      const store = await getStore()
      const data = await store.get(storageKey)
      if (!data || typeof data !== 'object') return
      const lat = Number(data.lat)
      const lon = Number(data.lon)
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const existing = await db.select(
          'SELECT mission_id FROM bullseyes WHERE mission_id = $1',
          [missionId]
        )
        if (existing.length === 0) {
          await db.execute(
            `INSERT INTO bullseyes (mission_id, lat, lon, name, ring_interval, ring_count, show_cardinals)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              missionId, lat, lon,
              data.name ?? DEFAULTS.name,
              Number(data.ringInterval) || DEFAULTS.ringInterval,
              Number(data.ringCount)    || DEFAULTS.ringCount,
              data.showCardinals ? 1 : 0
            ]
          )
        }
      }
      await store.delete(storageKey)
    } catch (err) {
      console.error('Failed to migrate bullseye from kv store:', err)
    }
  }

  // Restore a persisted bullseye for this mission. Called from MapView's
  // `map.on('load')` so the style is ready when `rebuild` adds sources.
  async function init() {
    if (!persistEnabled) return
    try {
      const db = await getDb()
      await migrateFromKvStore(db)
      const rows = await db.select(
        `SELECT lat, lon, name, ring_interval, ring_count, show_cardinals
           FROM bullseyes WHERE mission_id = $1`,
        [missionId]
      )
      const restored = rowToBullseye(rows[0])
      // Wire the layers + drag handler up front so the handle is ready to
      // go the instant a bullseye is placed (even if none is persisted).
      ensureSourcesAndLayers()
      if (!restored) return
      bullseyeRef.value = restored
      rebuild()
    } catch (err) {
      console.error('Failed to load bullseye:', err)
    }
  }

  // ---- Public programmatic API ----

  function setBullseye(patch) {
    const prev = bullseyeRef.value
    const next = {
      name:          patch.name          ?? prev?.name          ?? DEFAULTS.name,
      ringInterval:  Number(patch.ringInterval  ?? prev?.ringInterval)  || DEFAULTS.ringInterval,
      ringCount:     Number(patch.ringCount     ?? prev?.ringCount)     || DEFAULTS.ringCount,
      showCardinals: patch.showCardinals ?? prev?.showCardinals ?? DEFAULTS.showCardinals,
      lat: Number(patch.lat ?? prev?.lat),
      lon: Number(patch.lon ?? prev?.lon)
    }
    if (!Number.isFinite(next.lat) || !Number.isFinite(next.lon)) return null
    bullseyeRef.value = next
    rebuild()
    persist()
    return next
  }

  function updateBullseye(patch) {
    if (!bullseyeRef.value) return null
    return setBullseye({ ...bullseyeRef.value, ...patch })
  }

  function clearBullseye() {
    exitSelecting()
    bullseyeRef.value = null
    isHandleShown.value = false
    rebuild()
    removeZoomHandler()
    persist()
  }

  onUnmounted(() => {
    stopHandleVisibilityWatch()
    removeClickHandler()
    removeKeyHandler()
    removeZoomHandler()
    clearLabelMarkers()
    const map = getMap()
    if (!map) return
    if (deselectHandler) map.off('click', deselectHandler)
    deselectHandler = null
    if (map.getLayer(HANDLE_LAYER))      map.removeLayer(HANDLE_LAYER)
    if (map.getLayer(HIT_TARGET_LAYER))  map.removeLayer(HIT_TARGET_LAYER)
    if (map.getLayer(CARDINALS_LAYER))   map.removeLayer(CARDINALS_LAYER)
    if (map.getLayer(RINGS_LAYER))       map.removeLayer(RINGS_LAYER)
    if (map.getSource(HANDLE_SOURCE))    map.removeSource(HANDLE_SOURCE)
    if (map.getSource(CARDINALS_SOURCE)) map.removeSource(CARDINALS_SOURCE)
    if (map.getSource(RINGS_SOURCE))     map.removeSource(RINGS_SOURCE)
  })

  return {
    bullseye,
    bullseyeCount,
    bullseyeSelecting,
    draggingBullseye,
    toggleSelecting,
    setBullseye,
    updateBullseye,
    clearBullseye,
    init
  }
}
