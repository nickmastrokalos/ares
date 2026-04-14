import { ref, onMounted, onUnmounted } from 'vue'

/**
 * Makes a floating panel draggable by attaching a pointer-handle-based
 * drag to an arbitrary element. The consumer binds the returned
 * `onPointerDown` to the drag handle and `pos` to the panel's CSS offset.
 *
 * @param {{ x: number, y: number }} [initial] starting offset in px
 */
export function useDraggable(initial = { x: 12, y: 12 }) {
  const pos = ref({ x: initial.x, y: initial.y })
  const dragging = ref(false)
  let offset = { x: 0, y: 0 }

  function onPointerDown(e) {
    dragging.value = true
    offset.x = e.clientX - pos.value.x
    offset.y = e.clientY - pos.value.y
    e.preventDefault()
  }

  function onPointerMove(e) {
    if (!dragging.value) return
    pos.value.x = e.clientX - offset.x
    pos.value.y = e.clientY - offset.y
  }

  function onPointerUp() {
    dragging.value = false
  }

  onMounted(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  })

  onUnmounted(() => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  })

  return { pos, dragging, onPointerDown }
}
