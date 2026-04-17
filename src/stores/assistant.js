import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chat } from '@/services/assistant/client'
import { list as listTools, getByName } from '@/services/assistant/toolRegistry'
import { useSettingsStore } from '@/stores/settings'

export const useAssistantStore = defineStore('assistant', () => {
  const settingsStore = useSettingsStore()

  const open      = ref(false)
  const minimized = ref(false)
  const busy      = ref(false)
  const error     = ref(null)
  const messages  = ref([])   // { id, role, blocks, ts }
  const pendingCalls = ref([]) // { id, toolUseId, toolName, args, resolve }
  const contextLabel = ref('Assistant')

  // Resolvers for pending confirmations — keyed by pendingCall.id
  const _resolvers = {}

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
    pendingCalls.value = []
    error.value = null
    busy.value = false
  }

  function setContext(label) {
    contextLabel.value = label
  }

  function clearContext() {
    contextLabel.value = 'Assistant'
  }

  function _nextId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  }

  function _appendMessage(role, blocks) {
    messages.value.push({ id: _nextId(), role, blocks, ts: Date.now() })
  }

  function _buildAnthropicTools() {
    return listTools().map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }))
  }

  function _buildConversationMessages() {
    const out = []
    for (const msg of messages.value) {
      if (msg.role === 'user') {
        // blocks may be string (plain text) or array of content blocks
        const content = typeof msg.blocks === 'string'
          ? msg.blocks
          : msg.blocks
        out.push({ role: 'user', content })
      } else if (msg.role === 'assistant') {
        out.push({ role: 'assistant', content: msg.blocks })
      }
    }
    return out
  }

  // Waits for the user to confirm or cancel a pending call.
  // Returns true if confirmed, false if cancelled.
  function _awaitDecision(callId) {
    return new Promise(resolve => {
      _resolvers[callId] = resolve
    })
  }

  async function confirmCall(id) {
    const call = pendingCalls.value.find(c => c.id === id)
    if (!call) return
    call.status = 'confirmed'
    const resolver = _resolvers[id]
    if (resolver) {
      delete _resolvers[id]
      resolver(true)
    }
  }

  async function cancelCall(id) {
    const call = pendingCalls.value.find(c => c.id === id)
    if (!call) return
    call.status = 'cancelled'
    const resolver = _resolvers[id]
    if (resolver) {
      delete _resolvers[id]
      resolver(false)
    }
  }

  async function send(text) {
    if (busy.value || !text?.trim()) return
    error.value = null
    busy.value = true

    // Append the user message
    _appendMessage('user', text.trim())

    try {
      await _runTurnLoop()
    } catch (e) {
      error.value = e?.message ?? String(e)
    } finally {
      busy.value = false
    }
  }

  async function _runTurnLoop() {
    const { assistantProvider, assistantModel, assistantApiKey } = settingsStore
    if (!assistantApiKey) {
      error.value = 'No API key configured. Open Settings → Assistant and paste your key.'
      return
    }

    const mapHint = contextLabel.value === 'Map assistant'
      ? ' When placing tracks, always infer the affiliation (friendly/hostile/neutral/unknown) from the user\'s phrasing and pass it as the `affiliation` parameter — never embed it in the callsign.'
      : ''

    const systemPrompt =
      `You are a helpful assistant embedded in Ares, a Tauri desktop application for mission planning and situational awareness. ` +
      `The current context is: ${contextLabel.value}.` +
      mapHint +
      ` Use the provided tools to read data and take actions. Always confirm your understanding before making irreversible changes when possible.`

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const tools = _buildAnthropicTools()
      const conversationMessages = _buildConversationMessages()

      let response
      try {
        response = await chat({
          provider: assistantProvider,
          model: assistantModel,
          apiKey: assistantApiKey,
          system: systemPrompt,
          messages: conversationMessages,
          tools
        })
      } catch (e) {
        error.value = e?.message ?? String(e)
        return
      }

      const assistantBlocks = response.content ?? []
      _appendMessage('assistant', assistantBlocks)

      const toolUseBlocks = assistantBlocks.filter(b => b.type === 'tool_use')

      // No tool calls → done
      if (toolUseBlocks.length === 0) break

      // Process each tool_use block
      const toolResults = []

      for (const block of toolUseBlocks) {
        const toolDef = getByName(block.name)

        if (!toolDef) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Tool "${block.name}" is not registered in the current context.`
          })
          continue
        }

        if (toolDef.readonly) {
          // Run immediately
          let result
          try {
            result = await toolDef.handler(block.input ?? {})
          } catch (e) {
            result = { error: e?.message ?? String(e) }
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          })
        } else {
          // Queue for user confirmation
          const callId = _nextId()
          pendingCalls.value.push({
            id: callId,
            toolUseId: block.id,
            toolName: block.name,
            args: block.input ?? {},
            status: 'pending',
            previewText: toolDef.previewRender ? toolDef.previewRender(block.input ?? {}) : block.name
          })

          const confirmed = await _awaitDecision(callId)

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

          // Remove from pendingCalls after resolving
          pendingCalls.value = pendingCalls.value.filter(c => c.id !== callId)

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          })
        }
      }

      // Append a user turn with all tool results so the model can continue
      _appendMessage('user', toolResults)

      // If the model stopped for tools, loop again; otherwise stop
      if (response.stop_reason !== 'tool_use') break
    }
  }

  return {
    open,
    minimized,
    busy,
    error,
    messages,
    pendingCalls,
    contextLabel,
    toggle,
    minimize,
    close,
    setContext,
    clearContext,
    send,
    confirmCall,
    cancelCall
  }
})
