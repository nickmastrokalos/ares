<script setup>
import { ref, provide, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useMapStore } from '@/stores/map'
import { useFeaturesStore } from '@/stores/features'
import { useSettingsStore } from '@/stores/settings'
import { useMapDraw } from '@/composables/useMapDraw'
import { useMapMeasure } from '@/composables/useMapMeasure'
import { getBasemap } from '@/services/basemaps'
import MapToolbar from '@/components/MapToolbar.vue'
import DrawPanel from '@/components/DrawPanel.vue'
import AttributesPanel from '@/components/AttributesPanel.vue'
import LayersPanel from '@/components/LayersPanel.vue'
import ListenersDialog from '@/components/ListenersDialog.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import MapFooter from '@/components/MapFooter.vue'

const props = defineProps({
  missionId: { type: Number, required: true }
})

const router = useRouter()
const mapContainer = ref(null)
const mapStore = useMapStore()
const featuresStore = useFeaturesStore()
const settingsStore = useSettingsStore()
const drawPanelOpen = ref(false)
const layersPanelOpen = ref(false)
const listenersDialogOpen = ref(false)
const settingsDialogOpen = ref(false)
const mouseCoord = ref(null)
let map = null

const { setTool, cancel, initLayers, flyToGeometry, moveFeature } = useMapDraw(() => map)
const { measuring, startMeasure, cancelMeasure } = useMapMeasure(() => map)

// Expose map-centric helpers to descendant components (OverlaysDialog,
// AttributesPanel, etc.) without prop-drilling through DrawPanel.
provide('flyToGeometry', flyToGeometry)
provide('moveFeature', (id) => moveFeature(id))

async function switchBasemap(id) {
  const basemap = getBasemap(id)
  if (map) {
    const source = map.getSource('basemap')
    if (source) source.setTiles(basemap.tiles)
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
  const basemap = getBasemap(settingsStore.selectedBasemap)

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
        basemap: {
          type: 'raster',
          tiles: basemap.tiles,
          tileSize: basemap.tileSize
        }
      },
      layers: [
        {
          id: 'basemap-tiles',
          type: 'raster',
          source: 'basemap',
          minzoom: 0,
          maxzoom: basemap.maxzoom
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

  map.on('load', () => {
    initLayers()
  })
})

onUnmounted(() => {
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
      :measuring="measuring"
      :mission-name="featuresStore.activeMission?.name || ''"
      @toggle-draw="toggleDrawPanel"
      @toggle-layers="toggleLayersPanel"
      @toggle-measure="toggleMeasure"
      @toggle-listeners="listenersDialogOpen = true"
      @toggle-settings="settingsDialogOpen = true"
      @exit-mission="exitMission"
    />
    <div class="map-body">
      <div ref="mapContainer" class="map-container">
        <DrawPanel v-if="drawPanelOpen" @tool-select="onToolSelect" />
        <LayersPanel v-if="layersPanelOpen" />
        <AttributesPanel v-if="featuresStore.selectedFeature" />
        <ListenersDialog v-model="listenersDialogOpen" />
        <SettingsDialog v-model="settingsDialogOpen" />
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
