<script setup>
import { useAssistantConfirmStore } from '@/stores/assistantConfirm'

defineProps({
  call: { type: Object, required: true }
})

const confirmStore = useAssistantConfirmStore()
</script>

<template>
  <div class="confirm-card">
    <div class="confirm-header">
      <v-icon size="12" class="text-medium-emphasis">mdi-function-variant</v-icon>
      <span class="confirm-tool-name">{{ call.toolName }}</span>
    </div>
    <div class="confirm-preview">{{ call.previewText }}</div>
    <div class="confirm-actions">
      <v-btn
        size="x-small"
        variant="text"
        class="text-medium-emphasis"
        :disabled="call.status !== 'pending'"
        @click="confirmStore.cancel(call.id)"
      >
        Cancel
      </v-btn>
      <v-btn
        size="x-small"
        variant="tonal"
        color="primary"
        :disabled="call.status !== 'pending'"
        @click="confirmStore.confirm(call.id)"
      >
        Confirm
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.confirm-card {
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 6px;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
}

.confirm-tool-name {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: rgba(var(--v-theme-on-surface), 0.55);
  font-family: monospace;
}

.confirm-preview {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.87);
  margin-bottom: 8px;
  line-height: 1.4;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}
</style>
