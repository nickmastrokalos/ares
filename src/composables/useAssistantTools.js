import { onMounted, onBeforeUnmount } from 'vue'
import { register, unregister } from '@/services/assistant/toolRegistry'
import { useAssistantStore } from '@/stores/assistant'

export function useAssistantTools(defsFactory, label) {
  const store = useAssistantStore()
  let token

  onMounted(() => {
    token = register(defsFactory())
    store.setContext(label)
  })

  onBeforeUnmount(() => {
    if (token !== undefined) unregister(token)
    store.clearContext()
  })
}
