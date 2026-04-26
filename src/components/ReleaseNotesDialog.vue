<script setup>
import { computed } from 'vue'
import ReleaseNotesList from './ReleaseNotesList.vue'

const props = defineProps({
  modelValue: Boolean,
  // Show only entries newer than this version.
  sinceVersion: { type: String, default: null },
  // Current app version — displayed in the header.
  currentVersion: { type: String, default: '' }
})

const emit = defineEmits(['update:modelValue'])

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})
</script>

<template>
  <v-dialog v-model="open" max-width="560" persistent>
    <v-card color="surface" rounded="sm" flat>
      <v-card-title class="d-flex align-center pa-3">
        <v-icon icon="mdi-rocket-launch-outline" size="20" class="me-2 text-medium-emphasis" />
        <span class="text-body-1">What's new</span>
        <span v-if="currentVersion" class="text-caption text-medium-emphasis ms-2">
          v{{ currentVersion }}
        </span>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          class="text-medium-emphasis"
          @click="open = false"
        />
      </v-card-title>

      <v-divider />

      <div class="notes-body pa-4">
        <ReleaseNotesList :since-version="sinceVersion" />
      </div>

      <v-divider />

      <v-card-actions class="pa-3">
        <v-spacer />
        <v-btn
          variant="tonal"
          size="small"
          @click="open = false"
        >
          Got it
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.notes-body {
  max-height: 60vh;
  overflow-y: auto;
}
</style>
