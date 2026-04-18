import { ref, computed, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import { getDb } from '@/plugins/database'

// Operator-placed sticky notes pinned to map coordinates. Many per mission,
// persisted in the SQLite `annotations` table (migration v5). Rendered as
// HTML markers so text content / drag interaction / colour are handled by
// normal DOM APIs rather than a symbol layer.
//
// See docs/annotations.md for the full feature contract.

const DEFAULT_COLOR = '#ffeb3b'

export function useMapAnnotations(getMap, missionId = null, onRequestOpenPanel = null) {
  const persistEnabled = missionId != null

  const annotations = ref([])       // { id, lat, lon, text, color }
  const isSelecting = ref(false)
  const selectedId  = ref(null)

  const annotationSelecting = computed(() => isSelecting.value)
  const annotationCount     = computed(() => annotations.value.length)

  // Map<id, { marker, root }> so `updateAnnotation` can mutate an existing
  // marker in place rather than tearing down / rebuilding every time.
  const markers = new Map()

  let clickHandler = null
  let moveHandler  = null
  let keyHandler   = null

  // ---- Marker DOM ----
  //
  // Each annotation renders as a compact coloured pin with the MDI note
  // glyph. The full text appears in a hover tooltip rather than on the map
  // — the icon keeps the map legible even with dozens of notes placed.
  //
  // Structure:
  //   <div .annotation-marker-root>            ← positioned by MapLibre
  //     <div .annotation-marker-pin>           ← coloured circle + icon
  //     <div .annotation-marker-tip>           ← hover tooltip (hidden by default)

  function buildMarkerEl(a) {
    const root = document.createElement('div')
    root.className = 'annotation-marker-root'
    root.style.cssText =
      'position:relative;width:22px;height:22px;user-select:none;'
    root.dataset.annotationId = String(a.id)

    const pin = document.createElement('div')
    pin.className = 'annotation-marker-pin'
    pin.style.cssText =
      'width:22px;height:22px;border-radius:50%;' +
      'display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 1px 3px rgba(0,0,0,0.45);cursor:grab;' +
      'border:1px solid rgba(0,0,0,0.35);' +
      `background:${a.color || DEFAULT_COLOR};`
    // Using an <i> with the MDI font keeps this consistent with the rest of
    // the app without pulling a Vue renderer into the composable.
    pin.innerHTML = '<i class="mdi mdi-note-text-outline" style="font-size:14px;color:#111;line-height:1"></i>'
    root.appendChild(pin)

    const tip = document.createElement('div')
    tip.className = 'annotation-marker-tip'
    // `width:max-content` + `max-width:240px` lets the bubble shrink-wrap to
    // its text up to 240px, then wrap normally. Without max-content the
    // absolute-positioned tip inherits the 22px root width and wraps one
    // character per line.
    tip.style.cssText =
      'position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);' +
      'width:max-content;max-width:240px;padding:4px 8px;border-radius:3px;' +
      'background:rgba(22,22,22,0.92);color:#e3e6ee;' +
      'font-size:11px;line-height:1.4;font-family:sans-serif;' +
      'white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;' +
      'box-shadow:0 2px 6px rgba(0,0,0,0.5);opacity:0;transition:opacity 120ms;'
    tip.textContent = a.text || ''
    root.appendChild(tip)

    // Hover reveal — native hover without :hover so we can suppress it while
    // dragging (where the pin stays under the cursor the whole time).
    root.addEventListener('pointerenter', () => {
      if (root.dataset.dragging === '1') return
      if (tip.textContent) tip.style.opacity = '1'
    })
    root.addEventListener('pointerleave', () => { tip.style.opacity = '0' })

    return root
  }

  function applyToEl(root, a) {
    const pin = root.querySelector('.annotation-marker-pin')
    const tip = root.querySelector('.annotation-marker-tip')
    if (pin) pin.style.background = a.color || DEFAULT_COLOR
    if (tip) tip.textContent = a.text || ''
  }

  // ---- Render ----

  function placeMarker(a) {
    const map = getMap()
    if (!map) return
    const root = buildMarkerEl(a)
    const marker = new maplibregl.Marker({ element: root, anchor: 'center' })
      .setLngLat([a.lon, a.lat])
      .addTo(map)

    wireMarkerInteractions(root, a.id)
    markers.set(a.id, { marker, root })
  }

  function removeMarker(id) {
    const entry = markers.get(id)
    if (!entry) return
    entry.marker.remove()
    markers.delete(id)
  }

  function syncMarker(a) {
    const entry = markers.get(a.id)
    if (!entry) { placeMarker(a); return }
    entry.marker.setLngLat([a.lon, a.lat])
    applyToEl(entry.root, a)
  }

  function rebuildAll() {
    for (const id of [...markers.keys()]) removeMarker(id)
    for (const a of annotations.value) placeMarker(a)
  }

  // ---- Marker interactions (click + drag) ----

  function wireMarkerInteractions(root, id) {
    const pin = root.querySelector('.annotation-marker-pin')
    const tip = root.querySelector('.annotation-marker-tip')
    let startX = 0, startY = 0
    let dragging = false
    let dragLngLat = null

    const map = getMap()

    root.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      startX = e.clientX
      startY = e.clientY
      dragging = false
      root.setPointerCapture(e.pointerId)
      if (pin) pin.style.cursor = 'grabbing'
      if (tip) tip.style.opacity = '0'
      root.dataset.dragging = '1'
    })

    root.addEventListener('pointermove', (e) => {
      if (!root.hasPointerCapture(e.pointerId)) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (!dragging && Math.hypot(dx, dy) < 4) return  // below drag threshold
      dragging = true
      const rect = map.getContainer().getBoundingClientRect()
      dragLngLat = map.unproject([e.clientX - rect.left, e.clientY - rect.top])
      const entry = markers.get(id)
      if (entry) entry.marker.setLngLat(dragLngLat)
    })

    root.addEventListener('pointerup', (e) => {
      root.releasePointerCapture(e.pointerId)
      if (pin) pin.style.cursor = 'grab'
      root.dataset.dragging = '0'
      if (dragging && dragLngLat) {
        updateAnnotation(id, { lat: dragLngLat.lat, lon: dragLngLat.lng })
      } else {
        selectedId.value = id
        // Clicking the pin is the user reaching for the panel editor —
        // if it's closed, open it. The panel's own `selectedId` watch then
        // scrolls the matching row into view.
        if (typeof onRequestOpenPanel === 'function') onRequestOpenPanel()
      }
      dragging = false
      dragLngLat = null
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
      const created = await addAnnotation({
        lat: e.lngLat.lat,
        lon: e.lngLat.lng,
        text: 'New note',
        color: DEFAULT_COLOR
      })
      if (created) selectedId.value = created.id
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
      placeMarker(created)
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
      syncMarker(next)
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
      removeMarker(id)
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
      for (const id of [...markers.keys()]) removeMarker(id)
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
      rebuildAll()
    } catch (err) {
      console.error('Failed to load annotations:', err)
    }
  }

  onUnmounted(() => {
    removeClickHandler()
    removeKeyHandler()
    for (const id of [...markers.keys()]) removeMarker(id)
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
