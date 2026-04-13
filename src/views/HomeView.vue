<script setup>
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

const greeting = ref('')
const name = ref('')

async function greet() {
  greeting.value = await invoke('greet', { name: name.value })
}
</script>

<template>
  <v-container class="d-flex flex-column align-center justify-center fill-height">
    <h1 class="text-h3 mb-6">Ares</h1>

    <v-form class="d-flex align-center ga-3" @submit.prevent="greet">
      <v-text-field
        v-model="name"
        label="Enter a name"
        variant="outlined"
        density="compact"
        hide-details
      />
      <v-btn type="submit" color="primary">Greet</v-btn>
    </v-form>

    <p v-if="greeting" class="text-body-1 mt-4">{{ greeting }}</p>
  </v-container>
</template>
