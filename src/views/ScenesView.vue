<script setup>
defineProps({
  sceneId: { type: Number, default: null }
})
</script>

<template>
  <div class="stub-view">
    <v-icon size="40" class="text-medium-emphasis mb-3">mdi-view-dashboard-outline</v-icon>
    <div class="text-body-1 font-weight-medium mb-1">Scenes</div>
    <div class="text-caption text-medium-emphasis">
      Compose dashboards from cards to monitor network telemetry and situational data.
    </div>
    <div class="text-caption text-disabled mt-1">Coming in a later phase.</div>
  </div>
</template>

<style scoped>
.stub-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 32px;
  text-align: center;
}
</style>
