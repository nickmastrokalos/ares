import { defineStore } from 'pinia'
import { ref } from 'vue'
import { runTurnLoop } from '@/services/assistant/turnRunner'
import { useSettingsStore } from '@/stores/settings'
import { useAssistantConfirmStore } from '@/stores/assistantConfirm'

// Assistant store: panel visibility, message log, and the `send()` entry
// point. The turn loop lives in `services/assistant/turnRunner.js` and the
// write-confirmation queue lives in `stores/assistantConfirm.js`.

function nextId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export const useAssistantStore = defineStore('assistant', () => {
  const settingsStore = useSettingsStore()
  const confirmStore  = useAssistantConfirmStore()

  const open      = ref(false)
  const minimized = ref(false)
  const busy      = ref(false)
  const error     = ref(null)
  const messages  = ref([])   // { id, role, blocks, ts }
  const contextLabel = ref('Assistant')

  function toggle() {
    if (open.value) {
      close()
    } else {
      open.value = true
      minimized.value = false
    }
  }

  function minimize() {
    minimized.value = !minimized.value
  }

  function close() {
    open.value = false
    messages.value = []
    confirmStore.clear()
    error.value = null
    busy.value = false
  }

  function setContext(label) {
    contextLabel.value = label
  }

  function clearContext() {
    contextLabel.value = 'Assistant'
  }

  function appendMessage(role, blocks) {
    messages.value.push({ id: nextId(), role, blocks, ts: Date.now() })
  }

  // Queues a write tool for user confirmation, awaits the decision, runs the
  // handler (or returns a cancel envelope), and cleans up the pending entry.
  async function confirmWrite(toolDef, block) {
    const callId = nextId()
    confirmStore.queue({
      id: callId,
      toolUseId: block.id,
      toolName: block.name,
      args: block.input ?? {},
      status: 'pending',
      previewText: toolDef.previewRender ? toolDef.previewRender(block.input ?? {}) : block.name
    })

    const confirmed = await confirmStore.awaitDecision(callId)

    let result
    if (confirmed) {
      try {
        result = await toolDef.handler(block.input ?? {})
      } catch (e) {
        result = { error: e?.message ?? String(e) }
      }
    } else {
      result = { cancelled: true, message: 'User declined this action.' }
    }

    confirmStore.dequeue(callId)
    return result
  }

  async function send(text) {
    if (busy.value || !text?.trim()) return
    error.value = null
    busy.value = true

    appendMessage('user', text.trim())

    try {
      const { assistantProvider, assistantModel, assistantApiKey } = settingsStore
      if (!assistantApiKey) {
        error.value = 'No API key configured. Open Settings → Assistant and paste your key.'
        return
      }

      const system =
        `You are a helpful assistant embedded in Ares, a Tauri desktop application for mission planning and situational awareness. ` +
        `The current context is: ${contextLabel.value}. ` +
        `Use the provided tools to read data and take actions. Always confirm your understanding before making irreversible changes when possible. ` +
        `Some capabilities (specialised data lookups, environmental routing constraints, vehicle telemetry, etc.) are provided by plugins that the operator individually enables or disables in Settings → Plugins. ` +
        `BEFORE telling the user you can't do something — especially when the request mentions weather, sea state, illumination, terrain, telemetry, specific vehicles, or any other domain-specific data — call \`plugin_capabilities_list\` to see if a disabled plugin would unlock it. ` +
        `If a relevant capability appears under \`disabled\`, tell the user which plugin to enable (by \`plugin.name\`) and ask them to re-prompt; do not refuse.`

      await runTurnLoop({
        provider: assistantProvider,
        model: assistantModel,
        apiKey: assistantApiKey,
        system,
        getMessages: () => messages.value,
        appendMessage,
        confirmWrite
      })
    } catch (e) {
      error.value = e?.message ?? String(e)
    } finally {
      busy.value = false
    }
  }

  return {
    open,
    minimized,
    busy,
    error,
    messages,
    contextLabel,
    toggle,
    minimize,
    close,
    setContext,
    clearContext,
    send
  }
})
