<script setup>
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import { useCardTypesStore } from '@/stores/cardTypes'
import { useSceneDataStore } from '@/stores/sceneData'
import SceneNotesCard from './cards/SceneNotesCard.vue'

const CARD_COMPONENTS = {
  SceneNotesCard,
}

const props = defineProps({
  card: { type: Object, required: true },
})

const emit = defineEmits(['update-controls'])

const cardTypesStore = useCardTypesStore()
const sceneDataStore = useSceneDataStore()

const cardType = computed(() => cardTypesStore.getById(props.card.typeId))
const component = computed(() => {
  const name = cardType.value?.component
  return name ? (CARD_COMPONENTS[name] ?? null) : null
})

// sceneData subscription (only for non-self-managed cards)
let sub = null
const dataEntry = shallowRef(null)

function subscribe() {
  if (!cardType.value || cardType.value.selfManaged) return
  sub = sceneDataStore.subscribeQuery({
    cardTypeId: props.card.typeId,
    source: props.card.source ?? cardType.value.defaultSource,
    controls: props.card.controls ?? {},
  })
  watch(
    () => sceneDataStore.entries[sub.key],
    entry => { dataEntry.value = entry ?? null },
    { immediate: true }
  )
}

function unsubscribe() {
  if (sub) { sub.unsubscribe(); sub = null }
  dataEntry.value = null
}

onMounted(subscribe)
onUnmounted(unsubscribe)

watch(() => `${props.card.typeId}|${props.card.source}`, () => {
  unsubscribe()
  subscribe()
})
</script>

<template>
  <div class="card-host">
    <!-- Unknown card type -->
    <div v-if="!component" class="card-host__unknown">
      <v-icon size="20" class="text-disabled mb-1">mdi-help-circle-outline</v-icon>
      <span class="text-caption text-disabled">Unknown card: {{ card.typeId }}</span>
    </div>

    <!-- Self-managed card: pass controls, receive update-controls -->
    <component
      v-else-if="cardType?.selfManaged"
      :is="component"
      :controls="card.controls"
      @update-controls="emit('update-controls', $event)"
    />

    <!-- Data-driven card: also pass dataEntry -->
    <template v-else>
      <div v-if="!dataEntry || dataEntry.loading" class="card-host__loading">
        <v-progress-circular size="20" indeterminate />
      </div>
      <div v-else-if="dataEntry.status === 'error'" class="card-host__error">
        <v-icon size="16" class="text-error mb-1">mdi-alert-circle-outline</v-icon>
        <span class="text-caption text-disabled">{{ dataEntry.error || 'Error loading data' }}</span>
      </div>
      <component
        v-else
        :is="component"
        :controls="card.controls"
        :data="dataEntry.data"
        :meta="dataEntry.meta"
        @update-controls="emit('update-controls', $event)"
      />
    </template>
  </div>
</template>

<style scoped>
.card-host {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.card-host__unknown,
.card-host__loading,
.card-host__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 12px;
}
</style>
