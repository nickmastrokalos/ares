import { ref, computed, onUnmounted } from 'vue'
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

const RING_COLOR        = '#8a92a8'
const CARDINAL_COLOR    = '#6c7489'

const DEFAULTS = {
  name: 'BULLSEYE',
  ringInterval: 1852,  // 1 nautical mile
  ringCount: 5,
  showCardinals: true
}

export function useMapBullseye(getMap, missionId = null, onRequestOpenPanel = null) {
  const settingsStore = useSettingsStore()

  const persistEnabled = missionId != null

  const bullseyeRef = ref(null)  // { lat, lon, name, ringInterval, ringCount, showCardinals }
  const isSelecting = ref(false)

  const bullseye           = computed(() => bullseyeRef.value)
  const bullseyeSelecting  = computed(() => isSelecting.value)
  const bullseyeCount      = computed(() => bullseyeRef.value ? 1 : 0)

  let clickHandler   = null
  let moveHandler    = null
  let keyHandler     = null
  let centerMarker   = null
  let ringLabelMarkers     = []  // name + ring distances
  let cardinalLabelMarkers = []  // N / E / S / W letters
  let zoomHandler    = null

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
  }

  // ---- Markers (center cross + labels) ----
  //
  // We use HTML markers rather than a symbol-layer so ring / cardinal labels
  // render reliably without depending on the glyph server being reachable.

  function labelEl(text, opts = {}) {
    const el = document.createElement('div')
    el.style.cssText =
      'background:rgba(22,22,22,0.75);color:#d0d4de;font-size:10px;' +
      'padding:1px 4px;border-radius:2px;white-space:nowrap;pointer-events:none;' +
      'font-family:sans-serif;letter-spacing:0.04em;' + (opts.extra ?? '')
    el.textContent = text
    return el
  }

  function centerEl() {
    // 22 px hit target so the cross is comfortable to click; the visible
    // cross is a 14 px core centred within. Without this pad the 14 px
    // target is tiny on hi-DPI displays.
    const el = document.createElement('div')
    el.style.cssText =
      'width:22px;height:22px;position:relative;cursor:grab;' +
      'background:transparent;user-select:none;'
    el.innerHTML =
      `<div style="position:absolute;left:50%;top:4px;bottom:4px;width:1px;background:${RING_COLOR};transform:translateX(-50%);pointer-events:none"></div>` +
      `<div style="position:absolute;top:50%;left:4px;right:4px;height:1px;background:${RING_COLOR};transform:translateY(-50%);pointer-events:none"></div>`

    // Click (without drag) opens the panel. Drag handling is delegated to
    // MapLibre's native draggable Marker — see `rebuild()`. stopPropagation
    // keeps the click from also hitting the map (which in selecting-mode
    // would re-place the bullseye).
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      if (typeof onRequestOpenPanel === 'function') onRequestOpenPanel()
    })
    return el
  }

  function clearMarkers() {
    if (centerMarker) { centerMarker.remove(); centerMarker = null }
    for (const m of ringLabelMarkers) m.remove()
    for (const m of cardinalLabelMarkers) m.remove()
    ringLabelMarkers = []
    cardinalLabelMarkers = []
  }

  // ---- Label declutter ----
  //
  // At wide zooms the rings collapse to a few pixels across and the text
  // labels stack on top of each other. Hide them below a pixel-spacing
  // threshold (projected through the current view so both zoom AND latitude
  // are accounted for — 1 nm looks much smaller on a polar globe pitch).

  const MIN_RING_SPACING_PX = 28   // hide name + ring distances below this
  const MIN_OUTER_RADIUS_PX = 48   // hide N/E/S/W letters below this

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
    clearMarkers()

    const b = bullseyeRef.value
    if (!b) {
      map.getSource(RINGS_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
      map.getSource(CARDINALS_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
      return
    }

    const center = [b.lon, b.lat]
    const outerR = b.ringInterval * b.ringCount

    // Rings
    const ringFeatures = []
    for (let i = 1; i <= b.ringCount; i++) {
      ringFeatures.push({
        type: 'Feature',
        properties: { step: i },
        geometry: circlePolygon(center, b.ringInterval * i, 96)
      })
    }
    map.getSource(RINGS_SOURCE).setData({ type: 'FeatureCollection', features: ringFeatures })

    // Cardinal spokes
    const cardinalFeatures = []
    if (b.showCardinals) {
      for (const bearing of [0, 90, 180, 270]) {
        cardinalFeatures.push({
          type: 'Feature',
          properties: { bearing },
          geometry: {
            type: 'LineString',
            coordinates: [center, destinationPoint(center, outerR, bearing)]
          }
        })
      }
    }
    map.getSource(CARDINALS_SOURCE).setData({ type: 'FeatureCollection', features: cardinalFeatures })

    // Center cross marker — draggable so the operator can reposition the
    // bullseye by dragging the cross. MapLibre handles the pointer math and
    // stops map panning for us; on release we commit the new centre through
    // `setBullseye` which rebuilds rings and persists.
    centerMarker = new maplibregl.Marker({
      element: centerEl(),
      anchor: 'center',
      draggable: true
    })
      .setLngLat(center)
      .addTo(map)
    centerMarker.on('dragend', () => {
      const l = centerMarker.getLngLat()
      setBullseye({ lat: l.lat, lon: l.lng })
    })

    // Name label just above center
    const nameAnchor = destinationPoint(center, Math.max(b.ringInterval * 0.15, 50), 0)
    ringLabelMarkers.push(new maplibregl.Marker({
      element: labelEl(b.name, { extra: 'font-weight:600;color:#e3e6ee;' }),
      anchor: 'bottom'
    }).setLngLat(nameAnchor).addTo(map))

    // Ring distance labels — one at 0° on each ring (same spoke as the north
    // cardinal so the labels form a neat vertical column).
    const units = settingsStore.distanceUnits
    for (let i = 1; i <= b.ringCount; i++) {
      const r = b.ringInterval * i
      const pos = destinationPoint(center, r, 0)
      ringLabelMarkers.push(new maplibregl.Marker({
        element: labelEl(formatDistance(r, units)),
        anchor: 'bottom'
      }).setLngLat(pos).addTo(map))
    }

    // Cardinal letters just beyond the outer ring at 0/90/180/270.
    if (b.showCardinals) {
      const pad = b.ringInterval * 0.25
      const labels = [
        { bearing: 0,   text: 'N', anchor: 'bottom' },
        { bearing: 90,  text: 'E', anchor: 'left'   },
        { bearing: 180, text: 'S', anchor: 'top'    },
        { bearing: 270, text: 'W', anchor: 'right'  }
      ]
      for (const { bearing, text, anchor } of labels) {
        const pos = destinationPoint(center, outerR + pad, bearing)
        cardinalLabelMarkers.push(new maplibregl.Marker({
          element: labelEl(text, { extra: 'font-weight:700;color:#e3e6ee;' }),
          anchor
        }).setLngLat(pos).addTo(map))
      }
    }

    ensureZoomHandler()
    updateLabelVisibility()
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
    rebuild()
    removeZoomHandler()
    persist()
  }

  onUnmounted(() => {
    removeClickHandler()
    removeKeyHandler()
    removeZoomHandler()
    clearMarkers()
    const map = getMap()
    if (!map) return
    if (map.getLayer(CARDINALS_LAYER)) map.removeLayer(CARDINALS_LAYER)
    if (map.getLayer(RINGS_LAYER))     map.removeLayer(RINGS_LAYER)
    if (map.getSource(CARDINALS_SOURCE)) map.removeSource(CARDINALS_SOURCE)
    if (map.getSource(RINGS_SOURCE))     map.removeSource(RINGS_SOURCE)
  })

  return {
    bullseye,
    bullseyeCount,
    bullseyeSelecting,
    toggleSelecting,
    setBullseye,
    updateBullseye,
    clearBullseye,
    init
  }
}
