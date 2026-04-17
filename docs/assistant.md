# Assistant

> In-app AI assistant — natural-language interface backed by a cloud LLM.

## Overview

The assistant exposes Ares's data and actions as tools to a cloud LLM (Anthropic Claude by default). The user types natural language; the model decides which tools to call; Ares executes them and returns results; the model synthesises a final answer. The loop repeats until the model produces a turn with no tool calls.

Examples:
- Map: *"draw a 500 m red circle at 34.05, -118.25"* → model calls `map_draw_circle` → Ares shows a confirm card → user confirms → circle is drawn.
- Scenes: *"create a scene called Ops Board"* → model calls `scenes_create_scene` → confirm → scene is added to the sidebar.

## Architecture

```
User input
    ↓
stores/assistant.js  (turn loop, pendingCalls, messages)
    ↓ invoke
src-tauri/src/assistant/commands.rs  (assistant_chat Tauri command)
    ↓ reqwest HTTPS
Anthropic API  (cloud LLM)
    ↑ response JSON (content blocks with text / tool_use)
    ↓
Turn loop resolves tool_use blocks via toolRegistry
    ├─ readonly → execute immediately, feed tool_result back to LLM
    └─ write   → queue as pendingCall; AssistantConfirmCard in UI;
                  on confirm → execute + feed tool_result; on cancel → "user declined"
```

The Rust command is the only thing that touches the network. The API key travels from the settings store to the command invocation and is used only as an HTTP header — it is never logged.

## UI

- **`AppFooter.vue`** — thin fixed strip (28 px) on all non-home routes. Right side holds the assistant toggle button (`mdi-robot-outline` / `mdi-robot`). Left side is a reserved slot for future status indicators.
- **`AssistantPanel.vue`** — docked card anchored `bottom: 40px; right: 12px; width: 360px`. Styled identically to `RoutePanel.vue` (`rgba(surface, 0.97)`, surface-variant border, 4 px radius). Header: icon + per-route context label + minimize + close. Body: message log + input row. Panel is not draggable (v1).
- **`AssistantMessage.vue`** — renders one message. User messages: right-aligned rgba bubble. Assistant text: left-aligned plain text. Tool calls: inline monospace chips (`• map_draw_circle`).
- **`AssistantConfirmCard.vue`** — inline card for each pending write. Shows the tool name + `previewRender` output. Confirm / Cancel buttons.

The panel opens from the footer button and stays open across route changes. Closing it clears the conversation (v1 — no persistence across app restarts).

## Safety model

| Tool kind | Execution |
|-----------|-----------|
| `readonly: true` | Runs immediately when the model requests it. No user interaction needed. |
| `readonly: false` | Queued as a `pendingCall`. The UI renders an `AssistantConfirmCard`. The turn loop is suspended until the user clicks **Confirm** (executes the handler, feeds `tool_result`) or **Cancel** (feeds `"user declined"` tool_result; model continues gracefully). |

Multiple write tools in a single model turn each get their own confirm card and resolve in order.

## Tool registry

`src/services/assistant/toolRegistry.js` — a module-level `Map<token, ToolDef[]>` that supports per-route registration.

### `ToolDef` shape

```js
{
  name: String,            // snake_case, globally unique
  description: String,     // shown to the LLM in the tools parameter
  inputSchema: Object,     // JSON Schema for the tool's input (Anthropic format)
  handler: async (args) => any,  // called on execution; return value is stringified as tool_result
  readonly: Boolean,       // true → auto-execute; false → confirm card
  previewRender: (args) => String  // required for write tools; shown in confirm card body
}
```

### API

```js
import { register, unregister, list, getByName } from '@/services/assistant/toolRegistry'

const token = register(myToolDefs)  // returns a Symbol
unregister(token)                   // removes the bundle
list()                              // returns union of all registered defs (current route context)
getByName('map_draw_circle')        // lookup by name
```

## Per-route tool bundles

Each view registers its own tool bundle on mount and unregisters on unmount. The assistant sees only the tools relevant to the current context.

### `useAssistantTools(defsFactory, label)` composable

```js
// src/composables/useAssistantTools.js
import { useAssistantTools } from '@/composables/useAssistantTools'
import { mapTools } from '@/services/assistant/tools/map'

// Inside a <script setup> in a view:
const featuresStore = useFeaturesStore()
useAssistantTools(() => mapTools({ featuresStore }), 'Map assistant')
```

- `defsFactory` — called on mount; return an array of `ToolDef` objects.
- `label` — sets `assistantStore.contextLabel`, shown in the panel header.

### Adding a new tool bundle

1. Create `src/services/assistant/tools/{surface}.js` exporting a factory function.
2. Define your `ToolDef` array. For write tools, include `previewRender`.
3. Call `useAssistantTools(() => myTools({ ...deps }), 'My assistant')` in the view.

### Built-in bundles

| File | Surface | Tools |
|------|---------|-------|
| `tools/map.js` | MapView | `map_list_features`, `map_get_feature`, `map_draw_circle`, `map_draw_polygon`, `map_delete_feature` |
| `tools/scenes.js` | ScenesView, SceneEditorView | `scenes_list`, `scenes_create_scene` |

## Configuration

Three keys in `useSettingsStore` (persisted via `tauri-plugin-store`):

| Key | Default | Purpose |
|-----|---------|---------|
| `assistantProvider` | `'anthropic'` | LLM provider |
| `assistantModel` | `'claude-sonnet-4-6'` | Model identifier sent to the API |
| `assistantApiKey` | `''` | User's personal API key |

**Key storage note:** `tauri-plugin-store` persists to a JSON file in the app data directory. The file is not encrypted. The API key is disclosed as such in the Settings UI caption.

Settings UI: **Settings → Assistant tab** (`mdi-robot-outline`). Provider dropdown, model text field, API key field with eye toggle.

## Turn loop (technical)

In `src/stores/assistant.js`, `_runTurnLoop()`:

1. Builds `tools` array from `toolRegistry.list()` mapped to Anthropic's `{name, description, input_schema}` shape.
2. Serialises the conversation `messages` array (user/assistant roles; tool_result turns use role `user` with `tool_result` content blocks — Anthropic format).
3. Calls `assistant_chat` via `client.chat(...)`.
4. Appends the assistant turn to `messages`.
5. For each `tool_use` block in the response:
   - Looks up the `ToolDef` by name.
   - Readonly → `await toolDef.handler(args)` → stash result.
   - Write → push to `pendingCalls` → `await _awaitDecision(callId)` → execute or feed "user declined".
6. Appends a user turn with all collected `tool_result` blocks.
7. If `response.stop_reason === 'tool_use'`, loops from step 1.
8. Otherwise, the loop exits — the final text is already appended in step 4.

## Out of scope (v1)

- OpenAI / multi-provider (stub in settings, `Err` from Rust command)
- Scene card-authoring tools (LLM composing `typeId` + `controls`)
- Real MCP server (stdio / SSE for external clients — the registry is MCP-schema-compatible, so this is a future promotion)
- Streaming responses
- Conversation persistence across app restarts
- Markdown rendering in messages
- Undo stack (writes require confirm instead)
- Keyring-based key storage
