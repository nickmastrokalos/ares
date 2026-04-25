<script setup>
import { ref, computed, watch, provide, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { invoke } from '@tauri-apps/api/core'
import { useMapStore } from '@/stores/map'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { useTracksStore } from '@/stores/tracks'
import { useGhostsStore } from '@/stores/ghosts'
import { useAisStore } from '@/stores/ais'
import { useTileserverStore } from '@/stores/tileserver'
import { useClickDispatcher } from '@/composables/useClickDispatcher'
import { useMapDraw } from '@/composables/useMapDraw'
import { useMapMeasure } from '@/composables/useMapMeasure'
import { useMapBloodhound } from '@/composables/useMapBloodhound'
import { useMapPerimeters } from '@/composables/useMapPerimeters'
import { useMapBullseye } from '@/composables/useMapBullseye'
import { useMapAnnotations } from '@/composables/useMapAnnotations'
import { useMapIntercepts } from '@/composables/useMapIntercepts'
import { useMapAlerts } from '@/composables/useMapAlerts'
import { useMapSnapshot } from '@/composables/useMapSnapshot'
import { useMapRoute } from '@/composables/useMapRoute'
import { useMapTracks } from '@/composables/useMapTracks'
import { useMapManualTracks } from '@/composables/useMapManualTracks'
import { useMapGhosts } from '@/composables/useMapGhosts'
import { useMapAis } from '@/composables/useMapAis'
import { getBasemap } from '@/services/basemaps'
import { usePluginRegistry } from '@/composables/usePluginRegistry'
import { loadPlugins } from '@/services/pluginLoader'
import { useNavigationStore } from '@/stores/navigation'
import { useAppStore } from '@/stores/app'
import { formatCoordinate } from '@/services/coordinates'
import neCountries from '@/assets/ne-countries-110m.json'
import MapToolbar from '@/components/MapToolbar.vue'
import DrawPanel from '@/components/DrawPanel.vue'
import AttributesPanel from '@/components/AttributesPanel.vue'
import LayersPanel from '@/components/LayersPanel.vue'
import ListenersDialog from '@/components/ListenersDialog.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import MapContextMenu from '@/components/MapContextMenu.vue'
import MapFeaturePicker from '@/components/MapFeaturePicker.vue'
import TrackPanel from '@/components/TrackPanel.vue'
import RoutePanel from '@/components/RoutePanel.vue'
import TrackDropPanel from '@/components/TrackDropPanel.vue'
import ManualTrackPanel from '@/components/ManualTrackPanel.vue'
import TrackListPanel from '@/components/TrackListPanel.vue'
import GhostPanel from '@/components/GhostPanel.vue'
import CallInterceptorPanel from '@/components/CallInterceptorPanel.vue'
import BloodhoundPanel from '@/components/BloodhoundPanel.vue'
import PerimeterPanel from '@/components/PerimeterPanel.vue'
import BullseyePanel from '@/components/BullseyePanel.vue'
import AnnotationsPanel from '@/components/AnnotationsPanel.vue'
import MapAlertChip from '@/components/MapAlertChip.vue'
import AisPanel from '@/components/AisPanel.vue'
import AisTrackPanel from '@/components/AisTrackPanel.vue'
import ImportExportDialog from '@/components/ImportExportDialog.vue'
import OverlaysDialog from '@/components/OverlaysDialog.vue'
import { useAssistantTools } from '@/composables/useAssistantTools'
import { buildMapToolBundles } from '@/services/assistant/toolBundles'

const props = defineProps({
  missionId: { type: Number, required: true }
})

const router = useRouter()
const mapContainer = ref(null)
const mapStore = useMapStore()
const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()
function flyTo({ coordinate, zoom }) {
  if (!map || !coordinate) return
  map.flyTo({ center: coordinate, zoom: zoom ?? 11, duration: 800 })
}
const tracksStore = useTracksStore()
const ghostsStore = useGhostsStore()
const aisStore          = useAisStore()
const tileserverStore   = useTileserverStore()
const navStore          = useNavigationStore()
const appStore          = useAppStore()
const drawPanelOpen = ref(false)
const layersPanelOpen = ref(false)
const listenersDialogOpen = ref(false)
const settingsDialogOpen = ref(false)
const ioDialogOpen = ref(false)
const overlaysDialogOpen = ref(false)
const trackDropPanelOpen = ref(false)
const trackListOpen      = ref(false)
const ghostPanelOpen     = ref(false)
const interceptPanelOpen = ref(false)
const aisPanelOpen       = ref(false)
const bloodhoundPanelOpen = ref(false)
const perimeterPanelOpen  = ref(false)
const bullseyePanelOpen   = ref(false)
const annotationsPanelOpen = ref(false)
const mouseCoord = ref(null)
const contextMenu = ref(null)  // { x, y, lngLat } | null
let map = null

const dispatcher = useClickDispatcher()
const bloodhoundApi = useMapBloodhound(() => map)
const { bloodhounding } = bloodhoundApi
const perimeterApi = useMapPerimeters(() => map)
const { perimeterSelecting } = perimeterApi
// Proxy ref pattern: bullseye + annotations need `suppressEntityClicks` to
// guard their drag handlers, but that computed can only be defined after
// their own `*Selecting` refs exist. We hand them a shared ref now and keep
// it in sync with the computed below via watch().
const entitySuppressRef = ref(false)
const bullseyeApi  = useMapBullseye(() => map, props.missionId, () => { bullseyePanelOpen.value = true }, entitySuppressRef)
const { bullseyeSelecting } = bullseyeApi
const annotationsApi = useMapAnnotations(() => map, props.missionId, () => { annotationsPanelOpen.value = true }, entitySuppressRef)
const { annotationSelecting } = annotationsApi
// Selection-driven panel close: when the composable clears `selectedId`
// (click-away on the map), close the panel too. Panel-close also clears
// `selectedId` — the two directions don't loop because setting the panel
// boolean to its current value is a no-op.
watch(annotationsApi.selectedId, (id) => {
  if (id == null && annotationsPanelOpen.value) annotationsPanelOpen.value = false
})
const interceptApi = useMapIntercepts(() => map)
const mapAlerts    = useMapAlerts()
const { capture: captureSnapshotRaw } = useMapSnapshot({
  getMap: () => map,
  featuresStore
})

async function captureSnapshot() {
  const res = await captureSnapshotRaw({ destination: 'dialog' })
  if (res.ok || res.cancelled) return
  mapAlerts.setAlert('snapshot-err', {
    source: 'snapshot', level: 'critical',
    message: `Snapshot failed: ${res.error}`,
    timestamp: Date.now()
  })
  setTimeout(() => mapAlerts.clearAlert('snapshot-err'), 6000)
}

// Assistant entry point — saves directly to the Desktop with no native
// dialog. The user has already approved the call via the confirm card.
// `filename` is optional and falls through to the default
// `ares_screen_capture_<stamp>.png` when not supplied.
async function captureSnapshotToDesktop({ filename } = {}) {
  return captureSnapshotRaw({ destination: 'desktop', filename })
}

// Perimeter breaches are aggregated into a single alert so the chip stays
// compact regardless of how many perimeters are breached. Each breaching
// perimeter contributes one line to the aggregate message; the chip's
// expand UI surfaces the full list when needed.
watch(
  () => perimeterApi.perimeters.value,
  (list) => {
    const breaching = list.filter(p => p.alert && p.breached.length > 0)
    if (breaching.length === 0) {
      mapAlerts.clearAlert('perimeter-breach')
      return
    }
    // One detail entry per (perimeter, intruder) so the flyTo action on
    // each line targets the actual intruder, not the ring owner.
    const details = []
    for (const p of breaching) {
      for (const b of p.breached) {
        details.push({
          label: `${b.label} in ${p.owner.label}`,
          coord: b.coord
        })
      }
    }
    const summary = breaching.length === 1 && breaching[0].breached.length === 1
      ? `Perimeter breach: ${details[0].label}`
      : `${details.length} perimeter ${details.length === 1 ? 'breach' : 'breaches'}`
    mapAlerts.setAlert('perimeter-breach', {
      source:  'perimeter',
      level:   'critical',
      message: summary,
      details
    })
  },
  { deep: true }
)
const entitySelecting = computed(() => bloodhounding.value || perimeterSelecting.value || bullseyeSelecting.value || annotationSelecting.value)
const { setTool, cancel, initLayers, flyToGeometry, moveFeature, draggingFeature, previewFeatureColor } = useMapDraw(() => map, dispatcher, entitySelecting)
const { measuring, startMeasure, cancelMeasure } = useMapMeasure(() => map)
const { routing, appending, appendingRouteId, openRouteList, openRoutePanel, closeRoutePanel, startAppendMode, toggleRoute: toggleRouteRaw, initLayers: initRouteLayers, previewRouteColor } = useMapRoute(() => map, dispatcher, entitySelecting)
const suppressEntityClicks = computed(
  () => bloodhounding.value || perimeterSelecting.value || bullseyeSelecting.value || annotationSelecting.value || routing.value || appending.value || placing.value != null
)
const { placing, setPlacing, openPanelList: manualTrackPanelList, openPanel: openManualTrackPanel, closePanel: closeManualTrackPanel, focusedId: manualFocusedId, draggingTrack, initLayers: initManualTrackLayers } = useMapManualTracks(() => map, suppressEntityClicks, dispatcher)
// Back-fill the proxy ref handed to bullseye/annotations at construction —
// must run after `useMapManualTracks` since `suppressEntityClicks` reads
// `placing.value`, which only exists past that destructure.
watch(suppressEntityClicks, (val) => { entitySuppressRef.value = val }, { immediate: true })
const pluginRegistry = usePluginRegistry({ flyToGeometry })
const { initLayers: initTrackLayers } = useMapTracks(() => map, suppressEntityClicks, dispatcher)
const { initLayers: initGhostLayers } = useMapGhosts(() => map)
const { initLayers: initAisLayers }   = useMapAis(() => map, dispatcher, suppressEntityClicks)

// Register assistant tool bundles. Factories run once on mount, after the
// stores above are created — so the closures capture live store instances.
useAssistantTools(
  () => buildMapToolBundles({
    featuresStore, tracksStore, aisStore, ghostsStore, settingsStore,
    flyToGeometry, flyTo, switchBasemap,
    bloodhoundApi, perimeterApi, annotationsApi, bullseyeApi,
    captureSnapshotToDesktop
  }),
  'Map assistant'
)

// Expose map-centric helpers to descendant components (OverlaysDialog,
// AttributesPanel, etc.) without prop-drilling through DrawPanel.
provide('flyToGeometry', flyToGeometry)
provide('moveFeature', (id) => moveFeature(id))
provide('draggingFeature', draggingFeature)
provide('draggingTrack', draggingTrack)
provide('previewFeatureColor', previewFeatureColor)
provide('openManualTrackPanel', (id) => openManualTrackPanel(id))
provide('previewRouteColor', (id, color) => previewRouteColor(id, color))
provide('bloodhoundApi', bloodhoundApi)
provide('perimeterApi', perimeterApi)
provide('bullseyeApi', bullseyeApi)
provide('annotationsApi', annotationsApi)
provide('interceptApi', interceptApi)

provide('pluginRegistry', pluginRegistry)

function resolveBasemapTiles(id) {
  if (id?.startsWith('offline:')) {
    const name = id.slice(8)
    const ts   = tileserverStore.tilesets.find(t => t.name === name)
    if (ts) return { tiles: [ts.tile_url], tileSize: 256, maxzoom: ts.maxzoom }
  }
  return getBasemap(id)
}

async function switchBasemap(id) {
  if (map) {
    const source   = map.getSource('basemap')
    const resolved = resolveBasemapTiles(id)
    if (source) source.setTiles(resolved.tiles)
  }
  await settingsStore.setSetting('selectedBasemap', id)
}
provide('switchBasemap', switchBasemap)

// Disarm every "active" tool except the named one. Called from each
// toolbar-driven entry point so picking a new tool always replaces
// whatever was previously armed (route building, draw shape, measure,
// manual-track placement, bloodhound/perimeter/bullseye/annotations
// selection, …) and the open tool panels that own those armed states.
// Passive panels (track list, AIS, ghost, settings, IO, layers,
// listeners, intercept) are left alone — they don't interact with map
// clicks, so they're safe to coexist with anything.
function exitOtherTools(keep) {
  if (keep !== 'route' && routing.value) toggleRouteRaw()

  if (keep !== 'draw') {
    cancel()
    if (drawPanelOpen.value) drawPanelOpen.value = false
  }

  if (keep !== 'measure' && measuring.value) cancelMeasure()

  if (keep !== 'trackDrop') {
    if (placing.value != null) setPlacing(null)
    if (trackDropPanelOpen.value) trackDropPanelOpen.value = false
  }

  if (keep !== 'bloodhound') {
    if (bloodhounding.value) bloodhoundApi.toggleSelecting()
    if (bloodhoundPanelOpen.value) bloodhoundPanelOpen.value = false
  }

  if (keep !== 'perimeter') {
    if (perimeterSelecting.value) perimeterApi.toggleSelecting()
    if (perimeterPanelOpen.value) perimeterPanelOpen.value = false
  }

  if (keep !== 'bullseye') {
    if (bullseyeSelecting.value) bullseyeApi.toggleSelecting()
    if (bullseyePanelOpen.value) bullseyePanelOpen.value = false
  }

  if (keep !== 'annotations') {
    if (annotationSelecting.value) annotationsApi.toggleSelecting()
    if (annotationsPanelOpen.value) annotationsPanelOpen.value = false
  }
}

function toggleRoute() {
  // Entering build mode kicks every other armed tool; cancelling does nothing
  // to others (toggleRouteRaw flips routing.value off when already on).
  if (!routing.value) exitOtherTools('route')
  toggleRouteRaw()
}

function toggleDrawPanel() {
  const opening = !drawPanelOpen.value
  if (opening) exitOtherTools('draw')
  drawPanelOpen.value = !drawPanelOpen.value
  if (!drawPanelOpen.value) cancel()
}

function toggleLayersPanel() {
  layersPanelOpen.value = !layersPanelOpen.value
}

function toggleMeasure() {
  if (measuring.value) {
    cancelMeasure()
  } else {
    exitOtherTools('measure')
    startMeasure()
  }
}

function toggleTrackDrop() {
  const opening = !trackDropPanelOpen.value
  if (opening) exitOtherTools('trackDrop')
  trackDropPanelOpen.value = !trackDropPanelOpen.value
  if (!trackDropPanelOpen.value) setPlacing(null)
}

function toggleTrackList() {
  trackListOpen.value = !trackListOpen.value
}

function toggleGhostPanel() {
  ghostPanelOpen.value = !ghostPanelOpen.value
}

function toggleAisPanel() {
  aisPanelOpen.value = !aisPanelOpen.value
}

function toggleBloodhoundPanel() {
  const isOpen = bloodhoundPanelOpen.value
  // Closing while selecting → drop the crosshair (matches the panel's X
  // button). Opening → kick every other armed tool first.
  if (isOpen && bloodhounding.value) bloodhoundApi.toggleSelecting()
  if (!isOpen) exitOtherTools('bloodhound')
  bloodhoundPanelOpen.value = !isOpen
}

function togglePerimeterPanel() {
  const isOpen = perimeterPanelOpen.value
  if (isOpen && perimeterSelecting.value) perimeterApi.toggleSelecting()
  if (!isOpen) exitOtherTools('perimeter')
  perimeterPanelOpen.value = !isOpen
}

function toggleBullseyePanel() {
  const isOpen = bullseyePanelOpen.value
  if (isOpen && bullseyeSelecting.value) bullseyeApi.toggleSelecting()
  if (!isOpen) exitOtherTools('bullseye')
  bullseyePanelOpen.value = !isOpen
}

function toggleAnnotationsPanel() {
  const isOpen = annotationsPanelOpen.value
  if (isOpen && annotationSelecting.value) annotationsApi.toggleSelecting()
  if (!isOpen) exitOtherTools('annotations')
  annotationsPanelOpen.value = !isOpen
}

function toggleInterceptPanel() {
  interceptPanelOpen.value = !interceptPanelOpen.value
}

function onToolSelect(toolId) {
  // Selecting a draw tool disarms every other tool. Deselecting (toolId
  // null) doesn't need to disarm anything else.
  if (toolId != null) exitOtherTools('draw')
  setTool(toolId)
}

function exitMission() {
  navStore.clearActiveMission()
  router.push({ name: 'home' })
}


onMounted(async () => {
  // Resolve the mission from the URL before the map starts loading tiles.
  // Unknown ids bounce back to the picker — no point booting the map for a
  // mission that doesn't exist.
  let mission = null
  try {
    mission = await featuresStore.setActiveMission(props.missionId)
  } catch (err) {
    console.error('Failed to load mission:', err)
  }
  if (!mission) {
    router.replace({ name: 'home' })
    return
  }
  navStore.setActiveMission(props.missionId)

  await settingsStore.load()
  loadPlugins(pluginRegistry)
  await tileserverStore.load()
  await aisStore.load()
  const basemap = resolveBasemapTiles(settingsStore.selectedBasemap)

  map = new maplibregl.Map({
    container: mapContainer.value,
    style: {
      version: 8,
      projection: { type: 'globe' },
      // MapLibre requires a glyphs URL to render any symbol-layer text
      // (feature-name labels live at `draw-features-labels`). Using the
      // MapLibre demotiles font server for now; TODO: self-host glyphs so
      // labels work offline.
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        'world-land': { type: 'geojson', data: neCountries },
        basemap: {
          type: 'raster',
          tiles: basemap.tiles,
          tileSize: basemap.tileSize
        }
      },
      layers: [
        // ---- World reference (always visible, renders behind raster tiles) ----
        {
          id: 'world-ocean',
          type: 'background',
          paint: { 'background-color': '#141820' }
        },
        {
          id: 'world-land',
          type: 'fill',
          source: 'world-land',
          paint: { 'fill-color': '#1e2330', 'fill-opacity': 1 }
        },
        {
          id: 'world-borders',
          type: 'line',
          source: 'world-land',
          paint: { 'line-color': '#353c50', 'line-width': 0.5 }
        },
        // ---- Basemap tiles on top — offline areas fall through to above ----
        {
          id: 'basemap-tiles',
          type: 'raster',
          source: 'basemap',
          minzoom: 0,
          maxzoom: basemap.maxzoom,
          paint: { 'raster-opacity': settingsStore.basemapOpacity }
        }
      ]
    },
    center: mapStore.center,
    zoom: mapStore.zoom,
    bearing: mapStore.bearing,
    pitch: mapStore.pitch,
    attributionControl: false,
    maplibreLogo: false,
    // Required so the map canvas can be read back for snapshot export.
    // Default is `false`, which clears the WebGL drawing buffer after each
    // paint — reading pixels after that yields a blank image.
    preserveDrawingBuffer: true
  })

  map.addControl(new maplibregl.NavigationControl(), 'top-right')

  map.on('mousemove', (e) => { mouseCoord.value = e.lngLat })
  map.on('mouseout', () => { mouseCoord.value = null })

  // Mirror the cursor coordinate into the global footer info.
  watch(
    [mouseCoord, () => settingsStore.coordinateFormat],
    ([coord, fmt]) => {
      appStore.footerInfo = coord ? formatCoordinate(coord.lng, coord.lat, fmt) : null
    }
  )

  const updateFooterZoom = () => { appStore.footerDetail = `z ${map.getZoom().toFixed(2)}` }
  updateFooterZoom()
  map.on('zoom', updateFooterZoom)

  map.on('contextmenu', (e) => {
    e.originalEvent.preventDefault()
    // Clamp so the menu doesn't overflow the right or bottom edge.
    const container = mapContainer.value
    const menuWidth = 250
    const menuHeight = 90  // approximate
    const x = Math.min(e.point.x, container.clientWidth  - menuWidth)
    const y = Math.min(e.point.y, container.clientHeight - menuHeight)
    contextMenu.value = { x, y, lngLat: e.lngLat }
  })

  map.on('movestart', () => { contextMenu.value = null; dispatcher.dismiss() })
  map.on('click', () => { contextMenu.value = null })

  map.on('load', async () => {
    dispatcher.install(map)
    initLayers()
    initRouteLayers()
    initGhostLayers()
    initTrackLayers()
    initManualTrackLayers()
    initAisLayers()
    bullseyeApi.init()
    annotationsApi.init()

    // Start any CoT listeners that were enabled at the time the map loaded.
    for (const listener of settingsStore.cotListeners) {
      if (listener.enabled) {
        try {
          await invoke('start_listener', {
            address: listener.address,
            port: listener.port,
            protocol: listener.protocol ?? 'udp'
          })
        } catch (err) {
          console.error('Failed to start listener:', err)
        }
      }
    }
    await tracksStore.startListening()

    // Apply basemap opacity live when the setting changes.
    watch(
      () => settingsStore.basemapOpacity,
      (val) => {
        if (map?.getLayer('basemap-tiles')) {
          map.setPaintProperty('basemap-tiles', 'raster-opacity', val)
        }
      }
    )
  })
})

onUnmounted(async () => {
  ghostsStore.stopAll()
  tracksStore.stopListening()
  try {
    await invoke('stop_all_listeners')
  } catch (err) {
    console.error('Failed to stop listeners:', err)
  }
  if (map) {
    mapStore.saveView(map)
    map.remove()
    map = null
  }
  appStore.footerInfo = null
  appStore.footerDetail = null
})
</script>

<template>
  <div class="map-wrapper">
    <MapToolbar
      :draw-panel-open="drawPanelOpen"
      :layers-panel-open="layersPanelOpen"
      :overlays-dialog-open="overlaysDialogOpen"
      :measuring="measuring"
      :bloodhound-panel-open="bloodhoundPanelOpen"
      :perimeter-panel-open="perimeterPanelOpen"
      :bullseye-panel-open="bullseyePanelOpen"
      :annotations-panel-open="annotationsPanelOpen"
      :routing="routing"
      :track-drop-panel-open="trackDropPanelOpen"
      :track-list-open="trackListOpen"
      :ghost-panel-open="ghostPanelOpen"
      :intercept-panel-open="interceptPanelOpen"
      :ais-panel-open="aisPanelOpen"
      :mission-name="featuresStore.activeMission?.name || ''"
      :plugin-buttons="pluginRegistry.allToolbarButtons.value"
      @toggle-draw="toggleDrawPanel"
      @toggle-layers="toggleLayersPanel"
      @toggle-measure="toggleMeasure"
      @toggle-bloodhound="toggleBloodhoundPanel"
      @toggle-perimeter="togglePerimeterPanel"
      @toggle-bullseye="toggleBullseyePanel"
      @toggle-annotations="toggleAnnotationsPanel"
      @toggle-route="toggleRoute"
      @toggle-track-drop="toggleTrackDrop"
      @toggle-track-list="toggleTrackList"
      @toggle-ghost="toggleGhostPanel"
      @toggle-intercept="toggleInterceptPanel"
      @toggle-ais="toggleAisPanel"
      @toggle-overlays="overlaysDialogOpen = true"
      @toggle-listeners="listenersDialogOpen = true"
      @toggle-settings="settingsDialogOpen = true"
      @exit-mission="exitMission"
      @toggle-io="ioDialogOpen = true"
      @snapshot="captureSnapshot"
    />
    <div class="map-body">
      <div ref="mapContainer" class="map-container">
        <DrawPanel v-if="drawPanelOpen" @tool-select="onToolSelect" />
        <LayersPanel v-if="layersPanelOpen" />
        <AttributesPanel v-if="featuresStore.selectedFeature" />
        <TrackPanel
          v-for="uid in tracksStore.openPanelList"
          :key="uid"
          :uid="uid"
        />
        <RoutePanel
          v-for="id in openRouteList"
          :key="id"
          :route-id="id"
          :appending="appendingRouteId === id"
          @close="closeRoutePanel(id)"
          @append-waypoint="startAppendMode(id)"
        />
        <TrackListPanel
          v-if="trackListOpen"
          @close="trackListOpen = false"
        />
        <GhostPanel
          v-if="ghostPanelOpen"
          @close="ghostPanelOpen = false"
        />
        <CallInterceptorPanel
          v-if="interceptPanelOpen"
          @close="interceptPanelOpen = false"
        />
        <AisPanel
          v-if="aisPanelOpen"
          @close="aisPanelOpen = false"
        />
        <BloodhoundPanel
          v-if="bloodhoundPanelOpen"
          @close="bloodhoundPanelOpen = false"
        />
        <PerimeterPanel
          v-if="perimeterPanelOpen"
          @close="perimeterPanelOpen = false"
        />
        <BullseyePanel
          v-if="bullseyePanelOpen"
          @close="bullseyePanelOpen = false"
        />
        <AnnotationsPanel
          v-if="annotationsPanelOpen"
          @close="annotationsPanelOpen = false; annotationsApi.selectedId.value = null"
        />
        <AisTrackPanel
          v-for="mmsi in aisStore.openPanelList"
          :key="mmsi"
          :mmsi="mmsi"
        />
        <TrackDropPanel
          v-if="trackDropPanelOpen"
          :placing="placing"
          @close="toggleTrackDrop"
          @set-placing="setPlacing"
        />
        <ManualTrackPanel
          v-for="id in manualTrackPanelList"
          :key="id"
          :feature-id="id"
          :focused-id="manualFocusedId"
          @close="closeManualTrackPanel(id)"
        />
        <ImportExportDialog v-model="ioDialogOpen" />
        <OverlaysDialog v-model="overlaysDialogOpen" />
        <ListenersDialog v-model="listenersDialogOpen" />
        <SettingsDialog v-model="settingsDialogOpen" />
        <MapContextMenu
          v-if="contextMenu"
          :x="contextMenu.x"
          :y="contextMenu.y"
          :lng-lat="contextMenu.lngLat"
          @close="contextMenu = null"
        />
        <MapFeaturePicker
          v-if="dispatcher.pickerState.value"
          :x="dispatcher.pickerState.value.x"
          :y="dispatcher.pickerState.value.y"
          :items="dispatcher.pickerState.value.items"
          @select="dispatcher.selectItem($event)"
          @close="dispatcher.dismiss()"
        />
        <MapAlertChip :alerts="mapAlerts.alerts.value" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.map-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.map-container {
  flex: 1;
  min-width: 0;
  position: relative;
}
</style>
