<script setup>
import { useAssistantStore } from '@/stores/assistant'
import { useAppStore } from '@/stores/app'

const assistantStore = useAssistantStore()
const appStore       = useAppStore()
</script>

<template>
  <div class="app-footer">
    <div class="footer-left">
      <span v-if="appStore.footerInfo" class="footer-info">{{ appStore.footerInfo }}</span>
      <span v-if="appStore.footerDetail" class="footer-detail">{{ appStore.footerDetail }}</span>
    </div>
    <div class="footer-right">
      <v-progress-circular
        v-if="appStore.loading"
        indeterminate
        size="14"
        width="2"
        class="footer-spinner"
      />
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
  /* Start past the sidebar rail so content isn't hidden beneath it. */
  left: 56px;
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
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.footer-info {
  font-size: 11px;
  font-family: monospace;
  letter-spacing: 0.03em;
  color: rgba(var(--v-theme-on-surface), 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.footer-detail {
  font-size: 11px;
  font-family: monospace;
  letter-spacing: 0.03em;
  color: rgba(var(--v-theme-on-surface), 0.45);
  white-space: nowrap;
  flex-shrink: 0;
}

.footer-spinner {
  color: rgba(var(--v-theme-on-surface), 0.45);
  flex-shrink: 0;
}
</style>
