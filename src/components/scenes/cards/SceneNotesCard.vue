<script setup>
const props = defineProps({
  controls: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['update-controls'])

function onInput(e) {
  emit('update-controls', { ...props.controls, text: e.target.value })
}
</script>

<template>
  <textarea
    class="notes-textarea"
    :value="controls.text || ''"
    placeholder="Type your notes here…"
    @input="onInput"
  />
</template>

<style scoped>
.notes-textarea {
  width: 100%;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  padding: 10px 12px;
  font-family: inherit;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: rgba(var(--v-theme-on-surface), 0.87);
  box-sizing: border-box;
}

.notes-textarea::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.35);
}
</style>
