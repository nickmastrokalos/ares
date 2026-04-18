import { chat as defaultChat } from '@/services/assistant/client'
import { list as listTools, getByName } from '@/services/assistant/toolRegistry'

// Pure orchestration for a single assistant "turn" — a loop of chat(),
// tool dispatch, and tool_result append — until the model stops calling
// tools. No Vue/Pinia imports; the caller wires message append, the
// confirmation queue, and an id generator via the options bag.
//
// This split lets the assistant store remain a thin state container and
// keeps the loop testable in isolation.

function buildAnthropicTools() {
  return listTools().map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }))
}

function buildConversationMessages(messages) {
  const out = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      // msg.blocks may be a string (plain text) or an array of content blocks
      // (tool_result blocks from a prior turn).
      out.push({ role: 'user', content: msg.blocks })
    } else if (msg.role === 'assistant') {
      out.push({ role: 'assistant', content: msg.blocks })
    }
  }
  return out
}

async function dispatchTool(block, { confirm }) {
  const toolDef = getByName(block.name)
  if (!toolDef) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Tool "${block.name}" is not registered in the current context.`
    }
  }

  if (toolDef.readonly) {
    let result
    try {
      result = await toolDef.handler(block.input ?? {})
    } catch (e) {
      result = { error: e?.message ?? String(e) }
    }
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify(result)
    }
  }

  // Write tool → queue for user confirmation
  const result = await confirm(toolDef, block)
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content: JSON.stringify(result)
  }
}

export async function runTurnLoop({
  provider,
  model,
  apiKey,
  system,
  getMessages,
  appendMessage,
  confirmWrite,       // (toolDef, block) => Promise<result>
  chatFn = defaultChat
}) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tools = buildAnthropicTools()
    const conversationMessages = buildConversationMessages(getMessages())

    const response = await chatFn({
      provider,
      model,
      apiKey,
      system,
      messages: conversationMessages,
      tools
    })

    const assistantBlocks = response.content ?? []
    appendMessage('assistant', assistantBlocks)

    const toolUseBlocks = assistantBlocks.filter(b => b.type === 'tool_use')
    if (toolUseBlocks.length === 0) break

    const toolResults = []
    for (const block of toolUseBlocks) {
      toolResults.push(await dispatchTool(block, { confirm: confirmWrite }))
    }

    appendMessage('user', toolResults)

    if (response.stop_reason !== 'tool_use') break
  }
}
