<script setup>
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import AppSidebar from '@/components/AppSidebar.vue'
import AppFooter from '@/components/AppFooter.vue'
import AssistantPanel from '@/components/assistant/AssistantPanel.vue'
import ReleaseNotesDialog from '@/components/ReleaseNotesDialog.vue'
import { useSettingsStore } from '@/stores/settings'
import { compareSemver } from '@/services/version'
import { version as currentVersion } from '../package.json'

const route        = useRoute()
const settingsStore = useSettingsStore()

const showReleaseNotes = ref(false)
const releaseNotesSince = ref(null)

// Kick off persisted-settings load as early as possible so map layers,
// dialogs, etc. don't see default values on first paint. Consumers that
// truly need the values before proceeding can `await settingsStore.load()`
// themselves — the store caches the in-flight promise.
//
// Once settings are loaded we check `lastSeenVersion` against the current
// app version and show the "what's new" overlay on first launch after an
// update. Fresh installs (lastSeenVersion === null) get no overlay — we
// just record the current version so future updates have a baseline.
onMounted(async () => {
  await settingsStore.load()
  const seen = settingsStore.lastSeenVersion
  if (seen === null) {
    settingsStore.setSetting('lastSeenVersion', currentVersion)
  } else if (compareSemver(seen, currentVersion) < 0) {
    releaseNotesSince.value = seen
    showReleaseNotes.value = true
  }
})

function onReleaseNotesClosed(v) {
  showReleaseNotes.value = v
  if (!v) settingsStore.setSetting('lastSeenVersion', currentVersion)
}
</script>

<template>
  <v-app>
    <AppSidebar v-if="route.name !== 'home'" />
    <v-main :style="route.name !== 'home' ? 'padding-bottom: 28px' : undefined">
      <router-view />
    </v-main>
    <template v-if="route.name !== 'home'">
      <AppFooter />
      <AssistantPanel />
    </template>
    <ReleaseNotesDialog
      :model-value="showReleaseNotes"
      :since-version="releaseNotesSince"
      :current-version="currentVersion"
      @update:model-value="onReleaseNotesClosed"
    />
  </v-app>
</template>
