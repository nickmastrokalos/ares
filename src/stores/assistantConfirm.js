import { defineStore } from 'pinia'
import { ref } from 'vue'

// Confirmation queue for write-type assistant tool calls. The turn runner
// queues a call, awaits the user's decision through a Promise resolver kept
// in `_resolvers`, and then dequeues. UI components (AssistantPanel,
// AssistantConfirmCard) read `pending` and call `confirm` / `cancel`.
//
// Split out from `assistantStore` so the turn loop, message log, and the
// confirmation queue don't share a 260-line file.

export const useAssistantConfirmStore = defineStore('assistantConfirm', () => {
  const pending = ref([]) // { id, toolUseId, toolName, args, status, previewText }
  const _resolvers = {}

  function queue(call) {
    pending.value.push(call)
  }

  function awaitDecision(id) {
    return new Promise(resolve => {
      _resolvers[id] = resolve
    })
  }

  function confirm(id) {
    const call = pending.value.find(c => c.id === id)
    if (!call) return
    call.status = 'confirmed'
    const resolver = _resolvers[id]
    if (resolver) {
      delete _resolvers[id]
      resolver(true)
    }
  }

  function cancel(id) {
    const call = pending.value.find(c => c.id === id)
    if (!call) return
    call.status = 'cancelled'
    const resolver = _resolvers[id]
    if (resolver) {
      delete _resolvers[id]
      resolver(false)
    }
  }

  function dequeue(id) {
    pending.value = pending.value.filter(c => c.id !== id)
  }

  function clear() {
    // Resolve any dangling promises as cancelled so the turn loop doesn't
    // hang on a closed panel.
    for (const id of Object.keys(_resolvers)) {
      const resolver = _resolvers[id]
      delete _resolvers[id]
      resolver(false)
    }
    pending.value = []
  }

  return { pending, queue, awaitDecision, confirm, cancel, dequeue, clear }
})
