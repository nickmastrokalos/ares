<script setup>
import { useCardTypesStore } from '@/stores/cardTypes'

const emit = defineEmits(['pick', 'close'])

const cardTypesStore = useCardTypesStore()
</script>

<template>
  <v-card min-width="240">
    <v-card-title class="text-body-2 font-weight-medium pa-3 pb-2">Add card</v-card-title>
    <v-divider />
    <v-list density="compact" nav>
      <v-list-item
        v-for="type in cardTypesStore.list"
        :key="type.id"
        :prepend-icon="type.icon"
        :title="type.label"
        :subtitle="type.description"
        @click="emit('pick', type); emit('close')"
      />
    </v-list>
  </v-card>
</template>
