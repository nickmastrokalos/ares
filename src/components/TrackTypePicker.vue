<script setup>
import { ref, computed } from 'vue'
import { cotTypeToSidc, sidcToDataUrl } from '@/services/sidc'
import { TRACK_TYPE_CATALOG } from '@/services/trackTypes'

const props = defineProps({
  affiliation: { type: String, default: 'u' },
  modelValue:  { type: String, default: null },
  disabled:    { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])

const activeTab = ref(TRACK_TYPE_CATALOG[0].key)

const activeTypes = computed(() =>
  TRACK_TYPE_CATALOG.find(c => c.key === activeTab.value)?.types ?? []
)

function cotType(suffix) {
  return `a-${props.affiliation}-${suffix}`
}

function iconUrl(suffix) {
  return sidcToDataUrl(cotTypeToSidc(cotType(suffix)))
}

function isSelected(suffix) {
  return props.modelValue === cotType(suffix)
}

function select(suffix) {
  if (props.disabled) return
  emit('update:modelValue', cotType(suffix))
}
</script>

<template>
  <div class="type-picker" :class="{ 'type-picker--disabled': disabled }">
    <!-- Category tabs -->
    <div class="tab-row" @pointerdown.stop>
      <button
        v-for="cat in TRACK_TYPE_CATALOG"
        :key="cat.key"
        class="tab-btn"
        :class="{ 'tab-btn--active': activeTab === cat.key }"
        :disabled="disabled"
        @click="activeTab = cat.key"
      >{{ cat.label }}</button>
    </div>

    <!-- Type grid -->
    <div class="type-grid" @pointerdown.stop>
      <button
        v-for="type in activeTypes"
        :key="type.suffix"
        class="type-cell"
        :class="{ 'type-cell--active': isSelected(type.suffix) }"
        :disabled="disabled"
        @click="select(type.suffix)"
      >
        <img
          class="type-icon"
          :src="iconUrl(type.suffix)"
          :alt="type.label"
          draggable="false"
        />
        <span class="type-label">{{ type.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.type-picker {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.type-picker--disabled {
  opacity: 0.35;
  pointer-events: none;
}

/* ---- Tabs ---- */

.tab-row {
  display: flex;
  gap: 3px;
}

.tab-btn {
  flex: 1;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 0;
  border-radius: 3px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: transparent;
  color: rgba(var(--v-theme-on-surface), 0.45);
  cursor: pointer;
  line-height: 14px;
  transition: color 0.1s, background 0.1s;
}

.tab-btn:hover:not(:disabled) {
  background: rgba(var(--v-theme-surface-variant), 0.5);
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.tab-btn--active {
  background: rgba(var(--v-theme-primary), 0.15);
  border-color: rgba(var(--v-theme-primary), 0.5);
  color: rgb(var(--v-theme-primary));
}

/* ---- Grid ---- */

.type-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.type-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px 2px;
  border-radius: 3px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: transparent;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
  min-height: 52px;
}

.type-cell:hover:not(:disabled) {
  background: rgba(var(--v-theme-surface-variant), 0.5);
}

.type-cell--active {
  background: rgba(var(--v-theme-primary), 0.12);
  border-color: rgba(var(--v-theme-primary), 0.5);
}

.type-icon {
  display: block;
  max-width: 46px;
  max-height: 32px;
  object-fit: contain;
  pointer-events: none;
}

.type-label {
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: rgba(var(--v-theme-on-surface), 0.6);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
</style>
