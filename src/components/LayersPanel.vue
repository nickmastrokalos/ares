<script setup>
import { ref, inject } from 'vue'
import { BASEMAPS } from '@/services/basemaps'
import { useSettingsStore } from '@/stores/settings'
import { useTileserverStore } from '@/stores/tileserver'
import { useDraggable } from '@/composables/useDraggable'

const settingsStore   = useSettingsStore()
const tileserverStore = useTileserverStore()
const switchBasemap   = inject('switchBasemap')
const { pos, onPointerDown } = useDraggable({ x: 148, y: 12 })

const activeTab = ref('online')

function selectBasemap(id) {
  switchBasemap(id)
}

function offlineId(ts) {
  return `offline:${ts.name}`
}
</script>

<template>
  <div
    class="layers-panel"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
  >
    <div class="drag-handle" @pointerdown="onPointerDown">
      <v-icon icon="mdi-drag-horizontal" size="16" class="text-medium-emphasis" />
    </div>

    <div class="tab-bar d-flex px-2">
      <button
        class="tab-btn text-caption"
        :class="{ active: activeTab === 'online' }"
        @click="activeTab = 'online'"
      >
        Online
      </button>
      <button
        class="tab-btn text-caption"
        :class="{ active: activeTab === 'offline' }"
        @click="activeTab = 'offline'"
      >
        Offline
      </button>
    </div>

    <v-divider class="mx-2" />

    <div v-if="activeTab === 'online'" class="pa-1">
      <v-list density="compact" bg-color="transparent" class="pa-0">
        <v-list-item
          v-for="basemap in BASEMAPS"
          :key="basemap.id"
          :prepend-icon="basemap.icon"
          :title="basemap.name"
          :active="settingsStore.selectedBasemap === basemap.id"
          active-color="primary"
          rounded="sm"
          @click="selectBasemap(basemap.id)"
        />
      </v-list>
    </div>

    <div v-else-if="tileserverStore.tilesets.length > 0" class="pa-1">
      <v-list density="compact" bg-color="transparent" class="pa-0">
        <v-list-item
          v-for="ts in tileserverStore.tilesets"
          :key="ts.name"
          prepend-icon="mdi-map"
          :title="ts.display_name"
          :subtitle="`z${ts.minzoom}–${ts.maxzoom}`"
          :active="settingsStore.selectedBasemap === offlineId(ts)"
          active-color="primary"
          rounded="sm"
          @click="selectBasemap(offlineId(ts))"
        />
      </v-list>
    </div>

    <div v-else class="offline-placeholder pa-4 d-flex flex-column align-center ga-2">
      <v-icon icon="mdi-cloud-off-outline" size="28" class="text-medium-emphasis" />
      <span class="text-caption text-medium-emphasis text-center">
        Add .mbtiles folders in Settings → Maps
      </span>
    </div>
  </div>
</template>

<style scoped>
.layers-panel {
  position: absolute;
  z-index: 1;
  width: 200px;
  background: rgba(var(--v-theme-surface), 0.92);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  user-select: none;
}

.drag-handle {
  display: flex;
  justify-content: center;
  padding: 4px 0 2px;
  cursor: grab;
}

.drag-handle:active {
  cursor: grabbing;
}

.tab-bar {
  gap: 4px;
  padding-bottom: 6px;
}

.tab-btn {
  flex: 1;
  padding: 4px 0;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.5;
  cursor: pointer;
  transition: opacity 0.15s, border-color 0.15s;
}

.tab-btn.active {
  opacity: 1;
  border-bottom-color: rgb(var(--v-theme-primary));
}

.tab-btn:hover:not(.active) {
  opacity: 0.7;
}

.offline-placeholder {
  min-height: 100px;
}
</style>
