import { ref } from 'vue'

// Module-level counter shared across all panel instances.
// Starts at 100 to sit above static map UI (z-index 1–2).
let _counter = 100

export function useZIndex() {
  const zIndex = ref(_counter)

  function bringToFront() {
    zIndex.value = ++_counter
  }

  // Each panel starts at the current top so newly opened panels are already
  // in front of any existing ones.
  bringToFront()

  return { zIndex, bringToFront }
}
