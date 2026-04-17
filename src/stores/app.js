import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAppStore = defineStore('app', () => {
  // Counter-based so concurrent async operations don't prematurely hide the
  // spinner. Each caller increments on start and decrements in a finally block.
  const _count = ref(0)

  const loading = computed(() => _count.value > 0)

  // Per-view status string rendered on the left of AppFooter (e.g. the map's
  // cursor coordinate). Views set this on mount / update and clear on unmount.
  const footerInfo = ref(null)

  function beginLoad() {
    _count.value++
  }

  function endLoad() {
    if (_count.value > 0) _count.value--
  }

  return { loading, beginLoad, endLoad, footerInfo }
})
