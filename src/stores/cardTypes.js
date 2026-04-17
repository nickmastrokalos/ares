import { defineStore } from 'pinia'
import { computed } from 'vue'

const CARD_TYPES = {
  'scene-notes': {
    id: 'scene-notes',
    label: 'Notes',
    description: 'Freeform text notes for this scene.',
    icon: 'mdi-note-text-outline',
    category: 'general',
    component: 'SceneNotesCard',
    resizable: true,
    defaultWidth: 3,
    defaultHeight: 2,
    defaultControls: { text: '' },
    selfManaged: true,
    sourceOptions: [],
    defaultSource: null,
  },
}

export const useCardTypesStore = defineStore('cardTypes', () => {
  const list = computed(() => Object.values(CARD_TYPES))

  function getById(id) {
    return CARD_TYPES[id] ?? null
  }

  return { list, getById }
})
