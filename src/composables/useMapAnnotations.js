import { ref, computed, watch, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import { getDb } from '@/plugins/database'

// Operator-placed sticky notes pinned to map coordinates. Many per mission,
// persisted in the SQLite `annotations` table (migration v5). Rendered via
// a pair of GeoJSON circle layers so click-to-move uses the same proven
// map-layer pattern as shape vertices and manual tracks.
//
// See docs/annotations.md for the full feature contract.

const DEFAULT_COLOR = '#ffeb3b'

const POINTS_SOURCE      = 'annotations-points'
const PIN_LAYER          = 'annotations-pin'
const PIN_SELECTED_LAYER = 'annotations-pin-selected'
const PIN_ICON_LAYER     = 'annotations-pin-icon'
const NOTE_ICON_ID       = 'annotation-note-icon'
// mdi-note-text-outline codepoint (U+F11D7) from @mdi/font.
const NOTE_GLYPH         = String.fromCodePoint(0xF11D7)

export function useMapAnnotations(getMap, missionId = null, onRequestOpenPanel = null, suppress = { value: false }) {
  const persistEnabled = missionId != null

  const annotations = ref([])       // { id, lat, lon, text, color }
  const isSelecting = ref(false)
  const selectedId  = ref(null)

  const annotationSelecting = computed(() => isSelecting.value)
  const annotationCount     = computed(() => annotations.value.length)

  let clickHandler    = null
  let moveHandler     = null
  let keyHandler      = null
  let popup           = null
  let dragWired       = false
  let deselectHandler = null
  // Guards the post-drag click that the map fires on mouseup while the panel
  // is in add-mode — without it, releasing a drag would also drop a brand
  // new annotation at the release point.
  let suppressNextClick = false

  // ---- Source / layer lifecycle ----

  // Register the MDI note-text-outline glyph as a map image so it can be
  // drawn on top of each pin via a symbol layer. Rendered at 2x and passed
  // with pixelRatio: 2 so it stays crisp on retina displays — the same
  // pattern used by SIDC icons (see src/services/sidc.js::getOrCreateIcon).
  async function ensureAnnotationIcon(map) {
    if (map.hasImage(NOTE_ICON_ID)) return
    // Make sure the MDI font has loaded before rasterising; otherwise the
    // canvas draws a tofu box.
    try {
      await document.fonts.load("16px 'Material Design Icons'")
    } catch { /* ignore — fallback is the coloured circle */ }

    const size = 32                 // displayed pixel size after pixelRatio=2
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width  = size * scale
    canvas.height = size * scale
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)
    ctx.fillStyle    = '#111'
    ctx.font         = `${Math.round(size * 0.75)}px "Material Design Icons"`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(NOTE_GLYPH, size / 2, size / 2)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    map.addImage(
      NOTE_ICON_ID,
      { width: canvas.width, height: canvas.height, data: imageData.data },
      { pixelRatio: scale }
    )
  }

  function toFeatureCollection() {
    return {
      type: 'FeatureCollection',
      features: annotations.value.map(a => ({
        type: 'Feature',
        properties: {
          id:    a.id,
          color: a.color || DEFAULT_COLOR,
          text:  a.text || ''
        },
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] }
      }))
    }
  }

  function ensureLayers() {
    const map = getMap()
    if (!map || map.getSource(POINTS_SOURCE)) return
    map.addSource(POINTS_SOURCE, {
      type: 'geojson',
      data: toFeatureCollection()
    })
    // Unselected pin: coloured fill only. No stroke — the selected layer
    // adds a blue ring only when a pin is explicitly picked.
    map.addLayer({
      id: PIN_LAYER,
      type: 'circle',
      source: POINTS_SOURCE,
      paint: {
        'circle-radius': 10,
        'circle-color': ['get', 'color']
      }
    })
    // Selected pin: rendered on top with a brighter blue ring so picker
    // selection in the panel shows on the map without recolouring.
    map.addLayer({
      id: PIN_SELECTED_LAYER,
      type: 'circle',
      source: POINTS_SOURCE,
      filter: selectedFilter(),
      paint: {
        'circle-radius': 10,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#4a9ade',
        'circle-stroke-width': 3
      }
    })
    // Note-text glyph centred on each pin — registered asynchronously
    // (font load) and attached once ready. allow-overlap / ignore-placement
    // keep it visible even when pins crowd together.
    ensureAnnotationIcon(map).then(() => {
      if (!getMap() || map.getLayer(PIN_ICON_LAYER)) return
      map.addLayer({
        id: PIN_ICON_LAYER,
        type: 'symbol',
        source: POINTS_SOURCE,
        layout: {
          'icon-image':             NOTE_ICON_ID,
          'icon-size':              0.6,
          'icon-allow-overlap':     true,
          'icon-ignore-placement':  true
        }
      })
    }).catch(err => console.error('Failed to register annotation icon:', err))
    setupAnnotationDrag(map)
    setupHoverPopup(map)
    setupDeselectOnMapClick(map)
  }

  // Click-away deselection: a generic map click with no pin hit clears the
  // active selection. Mirrors how draw features drop their selection when
  // you click empty map. `suppressNextClick` keeps drag-release clicks from
  // being interpreted as click-away.
  function setupDeselectOnMapClick(map) {
    if (deselectHandler) return
    deselectHandler = (e) => {
      if (suppressNextClick) return
      if (selectedId.value == null) return
      if (isSelecting.value) return  // click-to-place handles its own flow
      const hits = map.queryRenderedFeatures(e.point, { layers: [PIN_LAYER] })
      if (hits.length > 0) return    // click landed on a pin — let mousedown handle it
      selectedId.value = null
    }
    map.on('click', deselectHandler)
  }

  function selectedFilter() {
    // -1 is a safe non-matching id — annotation ids are SQLite rowids,
    // always >= 1.
    return ['==', ['get', 'id'], selectedId.value ?? -1]
  }

  function refreshSource() {
    ensureLayers()
    const map = getMap()
    map?.getSource(POINTS_SOURCE)?.setData(toFeatureCollection())
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c])
  }

  // ---- Hover popup ----

  function setupHoverPopup(map) {
    popup = new maplibregl.Popup({
      closeButton:  false,
      closeOnClick: false,
      offset:       14,
      className:    'annotation-popup'
    })
    map.on('mouseenter', PIN_LAYER, (e) => {
      const f = e.features?.[0]
      if (!f) return
      const text = f.properties?.text || ''
      if (!text) return
      popup
        .setLngLat(f.geometry.coordinates)
        .setHTML(`<div class="annotation-popup-body">${escapeHtml(text)}</div>`)
        .addTo(map)
    })
    map.on('mouseleave', PIN_LAYER, () => { popup?.remove() })
  }

  // ---- Drag-to-move ----
  //
  // Mirrors setupTrackDrag in useMapManualTracks and the vertex handle drag
  // in useMapDraw: map-layer mousedown → disable dragPan → window-level
  // mousemove/mouseup. Live preview patches POINTS_SOURCE; the DB write
  // happens once on release via updateAnnotation.

  function setupAnnotationDrag(map) {
    if (dragWired) return
    dragWired = true
    const canvas = map.getCanvasContainer()

    // Context-aware cursor: `pointer` on an unselected pin (first click
    // selects), `grab` on the selected pin (second mousedown drags). Wired
    // on `mousemove` so the cursor flips the moment `selectedId` changes
    // without needing to leave/re-enter the pin.
    map.on('mousemove', PIN_LAYER, (e) => {
      if (isSelecting.value || suppress.value) return
      const id = e.features?.[0]?.properties?.id
      canvas.style.cursor = selectedId.value === id ? 'grab' : 'pointer'
    })
    map.on('mouseleave', PIN_LAYER, () => {
      if (!isSelecting.value && !suppress.value) canvas.style.cursor = ''
    })

    map.on('mousedown', PIN_LAYER, (e) => {
      if (suppress.value || isSelecting.value) return
      if (e.originalEvent?.button !== 0) return
      const id = e.features?.[0]?.properties?.id
      if (id == null) return
      const prev = annotations.value.find(a => a.id === id)
      if (!prev) return

      // Two-step interaction — matches draw-feature behaviour: the first
      // click on an unselected pin just selects it and opens the panel; only
      // an already-selected pin starts a drag. Forces the user to confirm
      // intent before moving, which is why shapes have the same flow.
      if (selectedId.value !== id) {
        e.preventDefault()
        popup?.remove()
        selectedId.value = id
        if (typeof onRequestOpenPanel === 'function') onRequestOpenPanel()
        return
      }

      e.preventDefault()
      map.dragPan.disable()
      canvas.style.cursor = 'grabbing'
      popup?.remove()

      let hasMoved = false
      let lastLngLat = null

      function onWindowMouseMove(me) {
        hasMoved = true
        // Unproject expects screen coords in the canvas's frame, not the
        // outer container's, otherwise the pin jumps by any toolbar/chrome
        // offset above the canvas.
        const rect = canvas.getBoundingClientRect()
        lastLngLat = map.unproject([me.clientX - rect.left, me.clientY - rect.top])
        const src = map.getSource(POINTS_SOURCE)
        if (!src) return
        const fc = toFeatureCollection()
        src.setData({
          ...fc,
          features: fc.features.map(f =>
            f.properties.id === id
              ? { ...f, geometry: { type: 'Point', coordinates: [lastLngLat.lng, lastLngLat.lat] } }
              : f
          )
        })
      }

      async function finish(commit) {
        window.removeEventListener('mousemove', onWindowMouseMove)
        window.removeEventListener('mouseup', onWindowMouseUp)
        window.removeEventListener('keydown', onWindowKeyDown)
        map.dragPan.enable()
        canvas.style.cursor = ''

        if (commit && hasMoved && lastLngLat) {
          // Swallow the trailing click so add-mode doesn't also drop a
          // second annotation at the release point.
          suppressNextClick = true
          setTimeout(() => { suppressNextClick = false }, 0)
          await updateAnnotation(id, { lat: lastLngLat.lat, lon: lastLngLat.lng })
        } else {
          // Escape mid-drag or zero-movement release on an already-selected
          // pin — revert preview to committed state.
          refreshSource()
        }
      }

      function onWindowMouseUp()   { finish(true) }
      function onWindowKeyDown(ke) { if (ke.key === 'Escape') finish(false) }

      window.addEventListener('mousemove', onWindowMouseMove)
      window.addEventListener('mouseup', onWindowMouseUp)
      window.addEventListener('keydown', onWindowKeyDown)
    })
  }

  // ---- Selection mode (click-to-place) ----

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

    clickHandler = async (e) => {
      if (suppressNextClick) return
      await addAnnotation({
        lat: e.lngLat.lat,
        lon: e.lngLat.lng,
        text: 'New note',
        color: DEFAULT_COLOR
      })
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
    ensureLayers()
    if (!isSelecting.value) {
      ensureKeyHandler()
      startSelecting()
    } else {
      exitSelecting()
    }
  }

  // ---- Persistence ----

  function rowToAnnotation(row) {
    return {
      id:    row.id,
      lat:   Number(row.lat),
      lon:   Number(row.lon),
      text:  row.text ?? '',
      color: row.color ?? DEFAULT_COLOR
    }
  }

  async function addAnnotation(patch) {
    if (!persistEnabled) return null
    const lat = Number(patch.lat)
    const lon = Number(patch.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    const text  = String(patch.text ?? '')
    const color = patch.color || DEFAULT_COLOR
    try {
      const db = await getDb()
      const res = await db.execute(
        `INSERT INTO annotations (mission_id, lat, lon, text, color)
         VALUES ($1, $2, $3, $4, $5)`,
        [missionId, lat, lon, text, color]
      )
      const created = { id: res.lastInsertId, lat, lon, text, color }
      annotations.value = [...annotations.value, created]
      refreshSource()
      return created
    } catch (err) {
      console.error('Failed to add annotation:', err)
      return null
    }
  }

  async function updateAnnotation(id, patch) {
    if (!persistEnabled) return null
    const idx = annotations.value.findIndex(a => a.id === id)
    if (idx < 0) return null
    const prev = annotations.value[idx]
    const next = {
      ...prev,
      ...(patch.lat   !== undefined ? { lat:   Number(patch.lat) } : null),
      ...(patch.lon   !== undefined ? { lon:   Number(patch.lon) } : null),
      ...(patch.text  !== undefined ? { text:  String(patch.text) } : null),
      ...(patch.color !== undefined ? { color: String(patch.color) } : null)
    }
    if (!Number.isFinite(next.lat) || !Number.isFinite(next.lon)) return null
    try {
      const db = await getDb()
      await db.execute(
        `UPDATE annotations
            SET lat = $1, lon = $2, text = $3, color = $4,
                updated_at = datetime('now')
          WHERE id = $5`,
        [next.lat, next.lon, next.text, next.color, id]
      )
      const copy = [...annotations.value]
      copy[idx] = next
      annotations.value = copy
      refreshSource()
      return next
    } catch (err) {
      console.error('Failed to update annotation:', err)
      return null
    }
  }

  async function removeAnnotation(id) {
    if (!persistEnabled) return
    try {
      const db = await getDb()
      await db.execute('DELETE FROM annotations WHERE id = $1', [id])
      annotations.value = annotations.value.filter(a => a.id !== id)
      refreshSource()
      if (selectedId.value === id) selectedId.value = null
    } catch (err) {
      console.error('Failed to delete annotation:', err)
    }
  }

  async function clearAnnotations() {
    if (!persistEnabled) return
    try {
      const db = await getDb()
      await db.execute('DELETE FROM annotations WHERE mission_id = $1', [missionId])
      annotations.value = []
      refreshSource()
      selectedId.value = null
    } catch (err) {
      console.error('Failed to clear annotations:', err)
    }
  }

  async function init() {
    if (!persistEnabled) return
    try {
      const db = await getDb()
      const rows = await db.select(
        `SELECT id, lat, lon, text, color
           FROM annotations
          WHERE mission_id = $1
          ORDER BY id ASC`,
        [missionId]
      )
      annotations.value = rows.map(rowToAnnotation)
      ensureLayers()
      refreshSource()
    } catch (err) {
      console.error('Failed to load annotations:', err)
    }
  }

  // Repaint the selected-pin filter when panel selection changes.
  const stopSelectedWatch = watch(selectedId, () => {
    const map = getMap()
    if (map?.getLayer(PIN_SELECTED_LAYER)) map.setFilter(PIN_SELECTED_LAYER, selectedFilter())
  })

  onUnmounted(() => {
    stopSelectedWatch()
    removeClickHandler()
    removeKeyHandler()
    popup?.remove()
    popup = null
    const map = getMap()
    if (!map) return
    if (deselectHandler)                  map.off('click', deselectHandler)
    deselectHandler = null
    if (map.getLayer(PIN_ICON_LAYER))     map.removeLayer(PIN_ICON_LAYER)
    if (map.getLayer(PIN_SELECTED_LAYER)) map.removeLayer(PIN_SELECTED_LAYER)
    if (map.getLayer(PIN_LAYER))          map.removeLayer(PIN_LAYER)
    if (map.getSource(POINTS_SOURCE))     map.removeSource(POINTS_SOURCE)
    if (map.hasImage?.(NOTE_ICON_ID))     map.removeImage(NOTE_ICON_ID)
  })

  return {
    annotations,
    annotationCount,
    annotationSelecting,
    selectedId,
    toggleSelecting,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations,
    init
  }
}
