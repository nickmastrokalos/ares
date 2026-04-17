<script setup>
import { useAssistantStore } from '@/stores/assistant'

const assistantStore = useAssistantStore()
</script>

<template>
  <div class="app-footer">
    <div class="footer-left" />
    <div class="footer-right">
      <v-tooltip text="Assistant" location="top">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            :icon="assistantStore.open ? 'mdi-robot' : 'mdi-robot-outline'"
            size="x-small"
            variant="text"
            :color="assistantStore.open ? 'primary' : undefined"
            :class="{ 'text-medium-emphasis': !assistantStore.open }"
            @click="assistantStore.toggle()"
          />
        </template>
      </v-tooltip>
    </div>
  </div>
</template>

<style scoped>
.app-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 28px;
  background: rgb(var(--v-theme-surface));
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  z-index: 100;
  flex-shrink: 0;
}

.footer-left {
  flex: 1;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 2px;
}
</style>
