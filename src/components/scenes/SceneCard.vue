<script setup>
import { ref } from 'vue'
import { useCardTypesStore } from '@/stores/cardTypes'
import SceneCardHost from './SceneCardHost.vue'

const props = defineProps({
  card:     { type: Object, required: true },
  selected: { type: Boolean, default: false },
})

const emit = defineEmits(['remove', 'drag-start', 'resize-start', 'update-controls'])

const cardTypesStore = useCardTypesStore()
const minimized = ref(false)
const menuOpen   = ref(false)

const cardType = cardTypesStore.getById(props.card.typeId)

const CORNERS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

function onDragHandlePointerDown(e) {
  e.stopPropagation()
  emit('drag-start', { cardId: props.card.id, event: e })
}

function onResizeHandlePointerDown(e, corner) {
  e.stopPropagation()
  emit('resize-start', { cardId: props.card.id, event: e, corner })
}
</script>

<template>
  <div class="scene-card" :class="{ 'scene-card--selected': selected }">

    <!-- Header -->
    <div class="scene-card__header" @pointerdown.stop="onDragHandlePointerDown">
      <v-icon size="14" class="text-disabled mr-1">{{ cardType?.icon || 'mdi-view-dashboard-outline' }}</v-icon>
      <span class="scene-card__title">{{ cardType?.label || card.typeId }}</span>

      <div class="scene-card__header-actions" @pointerdown.stop>
        <!-- Minimize -->
        <v-btn
          :icon="minimized ? 'mdi-chevron-down' : 'mdi-chevron-up'"
          size="x-small"
          variant="text"
          density="compact"
          class="text-medium-emphasis"
          @click="minimized = !minimized"
        />
        <!-- Menu -->
        <v-menu v-model="menuOpen" location="bottom end" :close-on-content-click="true">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              icon="mdi-dots-vertical"
              size="x-small"
              variant="text"
              density="compact"
              class="text-medium-emphasis"
            />
          </template>
          <v-list density="compact" nav>
            <v-list-item
              prepend-icon="mdi-delete-outline"
              title="Remove"
              @click="emit('remove', card.id)"
            />
          </v-list>
        </v-menu>
      </div>
    </div>

    <!-- Body -->
    <div v-show="!minimized" class="scene-card__body">
      <SceneCardHost
        :card="card"
        @update-controls="emit('update-controls', $event)"
      />
    </div>

    <!-- Resize handles -->
    <template v-if="selected && cardType?.resizable !== false">
      <div
        v-for="corner in CORNERS"
        :key="corner"
        class="scene-card__resize-handle"
        :class="`scene-card__resize-handle--${corner}`"
        @pointerdown.stop="onResizeHandlePointerDown($event, corner)"
      />
    </template>
  </div>
</template>

<style scoped>
.scene-card {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: rgba(var(--v-theme-surface), 0.92);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  border-radius: 6px;
  overflow: hidden;
  backdrop-filter: blur(4px);
  transition: border-color 0.15s, box-shadow 0.15s;
  user-select: none;
}

.scene-card--selected {
  border-color: rgba(var(--v-theme-primary), 0.6);
  box-shadow: 0 0 0 1px rgba(var(--v-theme-primary), 0.25);
}

.scene-card__header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 8px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  cursor: grab;
  flex-shrink: 0;
  min-height: 28px;
}

.scene-card__header:active { cursor: grabbing; }

.scene-card__title {
  flex: 1;
  font-size: 0.75rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.scene-card__header-actions {
  display: flex;
  align-items: center;
  gap: 0;
  flex-shrink: 0;
}

.scene-card__body {
  flex: 1;
  overflow: hidden;
  user-select: text;
}

/* Resize handles */
.scene-card__resize-handle {
  position: absolute;
  z-index: 10;
}

.scene-card__resize-handle--n  { top: -4px;  left:  6px; right:  6px; height: 8px; cursor: n-resize; }
.scene-card__resize-handle--s  { bottom: -4px; left: 6px; right:  6px; height: 8px; cursor: s-resize; }
.scene-card__resize-handle--e  { right: -4px; top:   6px; bottom: 6px; width:  8px; cursor: e-resize; }
.scene-card__resize-handle--w  { left:  -4px; top:   6px; bottom: 6px; width:  8px; cursor: w-resize; }
.scene-card__resize-handle--ne { top: -4px;  right: -4px; width: 12px; height: 12px; cursor: ne-resize; }
.scene-card__resize-handle--nw { top: -4px;  left:  -4px; width: 12px; height: 12px; cursor: nw-resize; }
.scene-card__resize-handle--se { bottom: -4px; right: -4px; width: 12px; height: 12px; cursor: se-resize; }
.scene-card__resize-handle--sw { bottom: -4px; left:  -4px; width: 12px; height: 12px; cursor: sw-resize; }
</style>
