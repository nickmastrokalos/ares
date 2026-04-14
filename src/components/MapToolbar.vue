<script setup>
const emit = defineEmits(['toggle-draw', 'toggle-layers', 'toggle-measure', 'toggle-listeners', 'toggle-settings', 'exit-mission'])

defineProps({
  drawPanelOpen: Boolean,
  layersPanelOpen: Boolean,
  measuring: Boolean,
  missionName: { type: String, default: '' }
})
</script>

<template>
  <v-toolbar density="compact" color="surface">
    <div class="d-flex align-center ga-1 px-2">
      <v-tooltip text="Missions" location="bottom">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-chevron-left"
            size="small"
            class="text-medium-emphasis"
            @click="emit('exit-mission')"
          />
        </template>
      </v-tooltip>

      <span v-if="missionName" class="text-body-2 text-medium-emphasis mission-name">
        {{ missionName }}
      </span>

      <v-divider vertical class="mx-2" />

      <v-tooltip text="Draw" location="bottom">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-pencil-outline"
            size="small"
            :color="drawPanelOpen ? 'primary' : undefined"
            :class="[drawPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
            @click="emit('toggle-draw')"
          />
        </template>
      </v-tooltip>

      <v-tooltip text="Layers" location="bottom">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-layers-outline"
            size="small"
            :color="layersPanelOpen ? 'primary' : undefined"
            :class="[layersPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
            @click="emit('toggle-layers')"
          />
        </template>
      </v-tooltip>

      <v-tooltip text="Measure" location="bottom">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-ruler"
            size="small"
            :color="measuring ? 'primary' : undefined"
            :class="[measuring ? 'toolbar-active' : 'text-medium-emphasis']"
            @click="emit('toggle-measure')"
          />
        </template>
      </v-tooltip>
    </div>

    <v-spacer />

    <div class="d-flex align-center ga-1 px-2">
      <v-tooltip text="Listeners" location="bottom">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-access-point"
            size="small"
            class="text-medium-emphasis"
            @click="emit('toggle-listeners')"
          />
        </template>
      </v-tooltip>

      <v-tooltip text="Settings" location="bottom">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-cog-outline"
            size="small"
            class="text-medium-emphasis"
            @click="emit('toggle-settings')"
          />
        </template>
      </v-tooltip>
    </div>
  </v-toolbar>
</template>

<style scoped>
.toolbar-active {
  background: rgba(var(--v-theme-surface-light), 0.6);
}

.mission-name {
  max-width: 240px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
