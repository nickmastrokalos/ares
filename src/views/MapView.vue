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
import { useMapDraw } from '@/composables/useMapDraw'
import { useMapMeasure } from '@/composables/useMapMeasure'
import { useMapRange } from '@/composables/useMapRange'
import { useMapRoute } from '@/composables/useMapRoute'
import { useMapTracks } from '@/composables/useMapTracks'
import { useMapManualTracks } from '@/composables/useMapManualTracks'
import { useMapGhosts } from '@/composables/useMapGhosts'
import { useMapAis } from '@/composables/useMapAis'
import { getBasemap } from '@/services/basemaps'
import neCountries from '@/assets/ne-countries-110m.json'
import MapToolbar from '@/components/MapToolbar.vue'
import DrawPanel from '@/components/DrawPanel.vue'
import AttributesPanel from '@/components/AttributesPanel.vue'
import LayersPanel from '@/components/LayersPanel.vue'
import ListenersDialog from '@/components/ListenersDialog.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import MapContextMenu from '@/components/MapContextMenu.vue'
import TrackPanel from '@/components/TrackPanel.vue'
import RoutePanel from '@/components/RoutePanel.vue'
import TrackDropPanel from '@/components/TrackDropPanel.vue'
import ManualTrackPanel from '@/components/ManualTrackPanel.vue'
import TrackListPanel from '@/components/TrackListPanel.vue'
import GhostPanel from '@/components/GhostPanel.vue'
import CallInterceptorPanel from '@/components/CallInterceptorPanel.vue'
import AisPanel from '@/components/AisPanel.vue'
import AisTrackPanel from '@/components/AisTrackPanel.vue'
import MapFooter from '@/components/MapFooter.vue'
import ImportExportDialog from '@/components/ImportExportDialog.vue'
import OverlaysDialog from '@/components/OverlaysDialog.vue'

const props = defineProps({
  missionId: { type: Number, required: true }
})

const router = useRouter()
const mapContainer = ref(null)
const mapStore = useMapStore()
const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()
const tracksStore = useTracksStore()
const ghostsStore = useGhostsStore()
const aisStore          = useAisStore()
const tileserverStore   = useTileserverStore()
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
let interceptMarker = null
const mouseCoord = ref(null)
const contextMenu = ref(null)  // { x, y, lngLat } | null
let map = null

const { setTool, cancel, initLayers, flyToGeometry, moveFeature, draggingFeature, previewFeatureColor } = useMapDraw(() => map)
const { measuring, startMeasure, cancelMeasure } = useMapMeasure(() => map)
const { ranging, toggleRange } = useMapRange(() => map)
const { routing, appending, appendingRouteId, openRouteList, openRoutePanel, closeRoutePanel, startAppendMode, toggleRoute, initLayers: initRouteLayers } = useMapRoute(() => map)
const externalSuppress = computed(() => ranging.value || routing.value)
const { placing, setPlacing, openPanelList: manualTrackPanelList, openPanel: openManualTrackPanel, closePanel: closeManualTrackPanel, focusedId: manualFocusedId, initLayers: initManualTrackLayers } = useMapManualTracks(() => map, externalSuppress)
const suppressTrackPanel = computed(() => ranging.value || routing.value || placing.value != null)
const { initLayers: initTrackLayers } = useMapTracks(() => map, suppressTrackPanel)
const { initLayers: initGhostLayers } = useMapGhosts(() => map)
const { initLayers: initAisLayers }   = useMapAis(() => map)

// Expose map-centric helpers to descendant components (OverlaysDialog,
// AttributesPanel, etc.) without prop-drilling through DrawPanel.
provide('flyToGeometry', flyToGeometry)
provide('moveFeature', (id) => moveFeature(id))
provide('draggingFeature', draggingFeature)
provide('previewFeatureColor', previewFeatureColor)
provide('openManualTrackPanel', (id) => openManualTrackPanel(id))

provide('setInterceptMarker', (lon, lat) => {
  if (!map) return
  if (interceptMarker) interceptMarker.remove()
  const el = document.createElement('div')
  el.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#4fc3f7;border:2px solid #ffffff;box-shadow:0 0 6px rgba(0,0,0,0.6);pointer-events:none'
  interceptMarker = new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat])
    .addTo(map)
})

provide('clearInterceptMarker', () => {
  if (interceptMarker) {
    interceptMarker.remove()
    interceptMarker = null
  }
})

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

function toggleDrawPanel() {
  cancelMeasure()
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
    cancel()
    drawPanelOpen.value = false
    startMeasure()
  }
}

function toggleTrackDrop() {
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

function toggleInterceptPanel() {
  interceptPanelOpen.value = !interceptPanelOpen.value
  if (!interceptPanelOpen.value && interceptMarker) {
    interceptMarker.remove()
    interceptMarker = null
  }
}

function onToolSelect(toolId) {
  setTool(toolId)
}

function exitMission() {
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

  await settingsStore.load()
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
    maplibreLogo: false
  })

  map.addControl(new maplibregl.NavigationControl(), 'top-right')

  map.on('mousemove', (e) => { mouseCoord.value = e.lngLat })
  map.on('mouseout', () => { mouseCoord.value = null })

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

  map.on('movestart', () => { contextMenu.value = null })
  map.on('click', () => { contextMenu.value = null })

  map.on('load', async () => {
    initLayers()
    initRouteLayers()
    initGhostLayers()
    initTrackLayers()
    initManualTrackLayers()
    initAisLayers()

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
  if (interceptMarker) { interceptMarker.remove(); interceptMarker = null }
  if (map) {
    mapStore.saveView(map)
    map.remove()
    map = null
  }
})
</script>

<template>
  <div class="map-wrapper">
    <MapToolbar
      :draw-panel-open="drawPanelOpen"
      :layers-panel-open="layersPanelOpen"
      :overlays-dialog-open="overlaysDialogOpen"
      :measuring="measuring"
      :ranging="ranging"
      :routing="routing"
      :track-drop-panel-open="trackDropPanelOpen"
      :track-list-open="trackListOpen"
      :ghost-panel-open="ghostPanelOpen"
      :intercept-panel-open="interceptPanelOpen"
      :ais-panel-open="aisPanelOpen"
      :mission-name="featuresStore.activeMission?.name || ''"
      @toggle-draw="toggleDrawPanel"
      @toggle-layers="toggleLayersPanel"
      @toggle-measure="toggleMeasure"
      @toggle-range="toggleRange"
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
        <MapFooter :coord="mouseCoord" />
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
