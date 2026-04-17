<script setup>
import { ref, computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'

const settingsStore = useSettingsStore()

const TABS = [
  { id: 'assistant', label: 'Assistant', icon: 'mdi-robot-outline' }
]

const activeTab = ref(TABS[0].id)

// ---- Assistant ----

const ASSISTANT_PROVIDERS = [
  { title: 'Anthropic', value: 'anthropic' },
  { title: 'OpenAI (coming soon)', value: 'openai', props: { disabled: true } }
]

const assistantProvider = computed({
  get: () => settingsStore.assistantProvider,
  set: (v) => settingsStore.setSetting('assistantProvider', v)
})

const assistantModel = computed({
  get: () => settingsStore.assistantModel,
  set: (v) => settingsStore.setSetting('assistantModel', v)
})

const assistantApiKey = computed({
  get: () => settingsStore.assistantApiKey,
  set: (v) => settingsStore.setSetting('assistantApiKey', v)
})

const showApiKey = ref(false)
</script>

<template>
  <div class="settings-view">

    <!-- Header -->
    <div class="settings-header">
      <div class="d-flex align-center ga-2">
        <v-icon size="20" class="text-medium-emphasis">mdi-cog-outline</v-icon>
        <span class="text-body-2 font-weight-medium">Settings</span>
      </div>
    </div>

    <!-- Tab rail + content -->
    <div class="settings-body">

      <v-tabs
        v-model="activeTab"
        direction="vertical"
        color="primary"
        class="settings-tabs"
      >
        <v-tab
          v-for="tab in TABS"
          :key="tab.id"
          :value="tab.id"
          :prepend-icon="tab.icon"
          class="tab-item"
        >
          {{ tab.label }}
        </v-tab>
      </v-tabs>

      <v-divider vertical />

      <v-window v-model="activeTab" class="settings-window">

        <!-- ---- Assistant ---- -->
        <v-window-item value="assistant">
          <div class="tab-content">
            <div class="section-label">AI Provider</div>

            <div class="setting-row">
              <div class="setting-info">
                <div class="text-body-2">Provider</div>
                <div class="text-caption text-medium-emphasis">Cloud LLM provider for the in-app assistant.</div>
              </div>
              <v-select
                v-model="assistantProvider"
                :items="ASSISTANT_PROVIDERS"
                density="compact"
                variant="outlined"
                rounded="sm"
                hide-details
                style="max-width: 200px"
              />
            </div>

            <v-divider class="my-3" />

            <div class="setting-row">
              <div class="setting-info">
                <div class="text-body-2">Model</div>
                <div class="text-caption text-medium-emphasis">Model identifier sent to the provider API.</div>
              </div>
              <v-text-field
                v-model="assistantModel"
                density="compact"
                variant="outlined"
                rounded="sm"
                hide-details
                style="max-width: 240px"
              />
            </div>

            <v-divider class="my-3" />

            <div class="section-label mt-4">API Key</div>

            <div class="setting-row align-start">
              <div class="setting-info">
                <div class="text-body-2">API key</div>
                <div class="text-caption text-medium-emphasis">Your personal key for the selected provider.</div>
              </div>
              <v-text-field
                v-model="assistantApiKey"
                :type="showApiKey ? 'text' : 'password'"
                :append-inner-icon="showApiKey ? 'mdi-eye-off' : 'mdi-eye'"
                density="compact"
                variant="outlined"
                rounded="sm"
                hide-details
                style="max-width: 240px"
                @click:append-inner="showApiKey = !showApiKey"
              />
            </div>
            <div class="text-caption text-disabled mt-2 ms-1">
              Stored locally in app data and sent only to the selected provider. Not encrypted on disk.
            </div>
          </div>
        </v-window-item>

      </v-window>

    </div>
  </div>
</template>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgb(var(--v-theme-background));
}

.settings-header {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  flex-shrink: 0;
}

.settings-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.settings-tabs {
  width: 160px;
  flex-shrink: 0;
  padding: 8px 0;
}

.tab-item {
  justify-content: flex-start;
  font-size: 0.8125rem;
  letter-spacing: 0.01em;
  min-height: 36px;
  padding: 0 12px;
}

.settings-window {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.tab-content {
  padding: 20px 24px;
  max-width: 680px;
}

.section-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.38);
  margin-bottom: 12px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.setting-row.align-start {
  align-items: flex-start;
}

.setting-info {
  flex: 1;
  min-width: 0;
}
</style>
