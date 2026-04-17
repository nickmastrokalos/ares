<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useNavigationStore } from '@/stores/navigation'

const route      = useRoute()
const navStore   = useNavigationStore()

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
  { icon: 'mdi-view-dashboard-outline', name: 'scenes', tooltip: 'Scenes' }
]

function isActive(name) {
  if (name === 'map') return route.name === 'map'
  if (name === 'scenes') return route.name === 'scenes' || route.name === 'scene'
  return route.name === name
}
</script>

<template>
  <v-navigation-drawer permanent rail color="surface">
    <div class="d-flex flex-column align-center py-3 fill-height">

      <!-- Primary navigation -->
      <div class="d-flex flex-column align-center ga-1">

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

      <v-spacer />

      <!-- Missions — exits to the mission picker -->
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
  </v-navigation-drawer>
</template>
