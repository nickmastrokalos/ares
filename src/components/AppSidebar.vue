<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

// The map isn't a standalone destination — it's reached by picking a
// mission on the home page. So the sidebar only needs the missions entry.
const navItems = [
  { icon: 'mdi-flag-outline', to: '/', tooltip: 'Missions' }
]

function isActive(path) {
  return route.path === path
}
</script>

<template>
  <v-navigation-drawer permanent rail color="surface">
    <div class="d-flex flex-column align-center py-3 fill-height">
      <div class="d-flex flex-column align-center ga-1">
        <v-tooltip v-for="item in navItems" :key="item.to" :text="item.tooltip" location="right">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              :icon="item.icon"
              :to="item.to"
              :color="isActive(item.to) ? 'primary' : undefined"
              :class="{ 'text-medium-emphasis': !isActive(item.to) }"
              size="small"
            />
          </template>
        </v-tooltip>
      </div>
    </div>
  </v-navigation-drawer>
</template>
