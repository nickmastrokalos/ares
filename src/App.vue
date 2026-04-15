<script setup>
import { onMounted } from 'vue'
import AppSidebar from '@/components/AppSidebar.vue'
import { useSettingsStore } from '@/stores/settings'

// Kick off persisted-settings load as early as possible so map layers,
// dialogs, etc. don't see default values on first paint. Consumers that
// truly need the values before proceeding can `await settingsStore.load()`
// themselves — the store caches the in-flight promise.
const settingsStore = useSettingsStore()
onMounted(() => { settingsStore.load() })
</script>

<template>
  <v-app>
    <AppSidebar />
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>
