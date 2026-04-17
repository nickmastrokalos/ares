<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useNavigationStore } from '@/stores/navigation'
import { useScenesStore } from '@/stores/scenes'

const route      = useRoute()
const navStore   = useNavigationStore()
const scenesStore = useScenesStore()

onMounted(() => scenesStore.loadScenes())

const mapTarget  = computed(() =>
  navStore.activeMissionId
    ? { name: 'map', params: { missionId: navStore.activeMissionId } }
    : null
)

const mapTooltip = computed(() =>
  navStore.activeMissionId ? 'Map' : 'Map — select a mission first'
)

const globalItems = [
  { icon: 'mdi-hub-outline',            name: 'hub',    tooltip: 'Control Hub' },
  { icon: 'mdi-tune',                   name: 'config', tooltip: 'Configuration' },
  { icon: 'mdi-view-dashboard-outline', name: 'scenes', tooltip: 'My Scenes' }
]

function isActive(name) {
  if (name === 'map') return route.name === 'map'
  if (name === 'scenes') return route.name === 'scenes'
  return route.name === name
}

function isSceneActive(id) {
  return route.name === 'scene' && route.params.sceneId === id
}
</script>

<template>
  <v-navigation-drawer permanent rail color="surface">
    <div class="sidebar-layout">

      <!-- Primary navigation (fixed top) -->
      <div class="sidebar-top">

        <!-- Map (mission-scoped, disabled when no active mission) -->
        <v-tooltip :text="mapTooltip" location="right">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-map-outline"
              size="small"
              :to="mapTarget ?? undefined"
              :disabled="!mapTarget"
              :color="isActive('map') ? 'primary' : undefined"
              :class="{ 'text-medium-emphasis': !isActive('map') }"
            />
          </template>
        </v-tooltip>

        <!-- Global destinations -->
        <v-tooltip v-for="item in globalItems" :key="item.name" :text="item.tooltip" location="right">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              :icon="item.icon"
              size="small"
              :to="{ name: item.name }"
              :color="isActive(item.name) ? 'primary' : undefined"
              :class="{ 'text-medium-emphasis': !isActive(item.name) }"
            />
          </template>
        </v-tooltip>
      </div>

      <!-- Scene shortcuts (scrollable middle) -->
      <div class="sidebar-scenes">
        <template v-if="scenesStore.scenes.length">
          <v-divider class="sidebar-divider" />
          <v-tooltip
            v-for="scene in scenesStore.scenes"
            :key="scene.id"
            :text="scene.label"
            location="right"
          >
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                :icon="scene.icon || 'mdi-view-dashboard-outline'"
                size="small"
                :to="{ name: 'scene', params: { sceneId: scene.id } }"
                :color="isSceneActive(scene.id) ? 'primary' : undefined"
                :class="{ 'text-medium-emphasis': !isSceneActive(scene.id) }"
              />
            </template>
          </v-tooltip>
        </template>
      </div>

      <!-- Missions — fixed bottom, exits to mission picker -->
      <div class="sidebar-bottom">
        <v-tooltip text="Missions" location="right">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-flag-outline"
              size="small"
              :to="{ name: 'home' }"
              class="text-medium-emphasis"
            />
          </template>
        </v-tooltip>
      </div>

    </div>
  </v-navigation-drawer>
</template>

<style scoped>
.sidebar-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px 0;
}

.sidebar-top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.sidebar-scenes {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  scrollbar-width: none;
}

.sidebar-scenes::-webkit-scrollbar {
  display: none;
}

.sidebar-divider {
  width: 24px;
  margin: 6px 0;
  opacity: 0.4;
}

.sidebar-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  padding-top: 8px;
}
</style>
