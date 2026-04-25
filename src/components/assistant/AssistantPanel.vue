<script setup>
import { ref, watch, nextTick, onMounted } from 'vue'
import { useAssistantStore } from '@/stores/assistant'
import { useAssistantConfirmStore } from '@/stores/assistantConfirm'
import { useZIndex } from '@/composables/useZIndex'
import { useDraggable } from '@/composables/useDraggable'
import AssistantMessage from './AssistantMessage.vue'
import AssistantConfirmCard from './AssistantConfirmCard.vue'

const store        = useAssistantStore()
const confirmStore = useAssistantConfirmStore()
const { zIndex, bringToFront } = useZIndex()
const { pos, onPointerDown } = useDraggable()
const positioned = ref(false)

const inputText = ref('')
const logRef    = ref(null)
const inputRef  = ref(null)
const helpOpen  = ref(false)

// Suggestive prompt library shown by the header help button. Skewed
// toward the complex routing flows since the simple cases are
// self-discoverable. Placeholders in <angle brackets> are meant to be
// replaced before submitting.
const EXAMPLES = [
  {
    category: 'Routes',
    items: [
      { label: 'Stay over water',          prompt: 'create a route from <start> to <end> that stays over water' },
      { label: 'Avoid a shape',            prompt: 'create a route from <start> to <end> avoiding <shape name>' },
      { label: 'Avoid + land',             prompt: 'create a route from <start> to <end> avoiding <shape name> and not crossing land' },
      { label: 'Through a shape',          prompt: 'create a route from <start> to <end> through <shape name>' },
      { label: 'Through, with entry/exit', prompt: 'create a route from <start> to <end> through <shape name> entering from the south and exiting at the north' },
      { label: 'Avoid AIS',                prompt: 'create a route from <start> to <end> avoiding AIS tracks' },
      { label: 'AIS, custom horizon',      prompt: 'create a route from <start> to <end> avoiding AIS tracks within 2 nm for the next hour' },
      { label: 'Stacked constraints',      prompt: 'create a route from <start> to <end> through <shape A> avoiding <shape B>, land, and AIS tracks' }
    ]
  },
  {
    category: 'Drawing',
    items: [
      { label: 'Named polygon',          prompt: 'draw a polygon called Keepout with vertices at <coord 1>, <coord 2>, <coord 3>, <coord 4>' },
      { label: 'Circle by radius',       prompt: 'draw a 5 km circle at <coord>' },
      { label: 'Box around features',    prompt: 'draw a box around <feature 1> and <feature 2>' },
      { label: 'Place a manual track',   prompt: 'place a hostile tank at <coord> called <callsign>' }
    ]
  },
  {
    category: 'Queries',
    items: [
      { label: 'Tracks within range',    prompt: 'list all hostile tracks within 10 nm of FRND-1' },
      { label: 'AIS vessels nearby',     prompt: 'list AIS vessels within 5 nm of <coord>' },
      { label: 'Resolve a name',         prompt: 'find <entity name>' },
      { label: 'Distance + bearing',     prompt: 'what is the distance and bearing from <a> to <b>?' }
    ]
  },
  {
    category: 'Snapshot',
    items: [
      { label: 'Snapshot to Desktop',    prompt: 'create a snapshot of the current view' },
      { label: 'Snapshot, named',        prompt: 'create a snapshot called <name>' }
    ]
  }
]

function fillExample(prompt) {
  inputText.value = prompt
  helpOpen.value = false
  nextTick(() => {
    // Focus the textarea so the user can edit placeholders right away.
    const el = inputRef.value?.$el?.querySelector('textarea')
    if (el) {
      el.focus()
      el.setSelectionRange(prompt.length, prompt.length)
    }
  })
}

// Start docked bottom-right, matching the previous fixed position, then let
// the user drag from there. Recomputed each time the panel is (re)opened
// because v-if unmounts the component when closed.
onMounted(() => {
  const width  = 360
  const height = Math.min(window.innerHeight * 0.6, 520)
  pos.value = {
    x: Math.max(12, window.innerWidth  - width  - 12),
    y: Math.max(12, window.innerHeight - height - 40)
  }
  positioned.value = true
})

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

function submit() {
  const text = inputText.value.trim()
  if (!text || store.busy) return
  inputText.value = ''
  store.send(text)
}

// Scroll to bottom when messages or pending confirm cards change
watch(
  () => [store.messages.length, confirmStore.pending.length],
  async () => {
    await nextTick()
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
  }
)
</script>

<template>
  <div
    v-if="store.open"
    class="assistant-panel"
    :style="{
      left: pos.x + 'px',
      top:  pos.y + 'px',
      zIndex,
      visibility: positioned ? 'visible' : 'hidden'
    }"
    @pointerdown="bringToFront"
  >
    <!-- Header (drag handle) -->
    <div class="panel-header" @pointerdown="onPointerDown">
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-robot-outline</v-icon>
      <span class="panel-title">{{ store.contextLabel }}</span>
      <v-spacer />
      <v-menu
        v-model="helpOpen"
        :close-on-content-click="false"
        location="bottom end"
        offset="2"
      >
        <template #activator="{ props: menuProps }">
          <v-btn
            v-bind="menuProps"
            icon="mdi-help-circle-outline"
            size="x-small"
            variant="text"
            class="text-medium-emphasis header-btn"
            title="Example prompts"
            @click.stop
            @pointerdown.stop
          />
        </template>
        <div class="examples-popover" @pointerdown.stop>
          <div class="examples-header">
            <v-icon size="12" class="text-medium-emphasis">mdi-lightbulb-outline</v-icon>
            <span class="text-caption">Example prompts · click to insert</span>
          </div>
          <div
            v-for="group in EXAMPLES"
            :key="group.category"
            class="examples-group"
          >
            <div class="examples-group-label">{{ group.category }}</div>
            <button
              v-for="item in group.items"
              :key="item.label"
              type="button"
              class="example-row"
              @click="fillExample(item.prompt)"
            >
              <span class="example-label">{{ item.label }}</span>
              <span class="example-prompt">{{ item.prompt }}</span>
            </button>
          </div>
        </div>
      </v-menu>
      <v-btn
        :icon="store.minimized ? 'mdi-chevron-up' : 'mdi-chevron-down'"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @click.stop="store.minimize()"
      />
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @click.stop="store.close()"
      />
    </div>

    <!-- Body -->
    <div v-show="!store.minimized" class="panel-body">
      <!-- Message log -->
      <div ref="logRef" class="message-log">
        <div v-if="!store.messages.length && !store.error" class="log-empty">
          <span class="text-caption text-disabled">Ask anything about the current view.</span>
        </div>
        <AssistantMessage
          v-for="msg in store.messages"
          :key="msg.id"
          :message="msg"
        />
        <!-- Inline confirm cards for pending writes (after the latest assistant turn) -->
        <AssistantConfirmCard
          v-for="call in confirmStore.pending"
          :key="call.id"
          :call="call"
        />
        <div v-if="store.busy" class="typing-indicator">
          <span /><span /><span />
        </div>
        <div v-if="store.error" class="error-bubble">
          {{ store.error }}
        </div>
      </div>

      <!-- Input -->
      <div class="input-row">
        <v-textarea
          ref="inputRef"
          v-model="inputText"
          placeholder="Ask the assistant…"
          rows="2"
          auto-grow
          :max-rows="6"
          density="compact"
          variant="plain"
          hide-details
          class="input-field"
          :disabled="store.busy"
          @keydown="onKeydown"
        />
        <v-btn
          icon="mdi-send"
          size="x-small"
          variant="text"
          :color="inputText.trim() && !store.busy ? 'primary' : undefined"
          :class="{ 'text-disabled': !inputText.trim() || store.busy }"
          :disabled="!inputText.trim() || store.busy"
          @click="submit"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.assistant-panel {
  position: fixed;
  width: 360px;
  max-height: min(60vh, 520px);
  background: rgba(var(--v-theme-surface), 0.97);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px 4px 8px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  flex-shrink: 0;
  cursor: grab;
}

.panel-header:active {
  cursor: grabbing;
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-btn {
  flex-shrink: 0;
}

.panel-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.message-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 10px 4px;
  scrollbar-width: none;
}

.message-log::-webkit-scrollbar {
  display: none;
}

.log-empty {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}

.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 4px 0 8px;
}

.typing-indicator span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.35);
  animation: blink 1.2s ease-in-out infinite;
}

.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.3; }
  40%            { opacity: 1; }
}

.error-bubble {
  font-size: 11px;
  color: rgb(var(--v-theme-error));
  background: rgba(var(--v-theme-error), 0.08);
  border: 1px solid rgba(var(--v-theme-error), 0.2);
  border-radius: 4px;
  padding: 6px 8px;
  margin-top: 4px;
  line-height: 1.4;
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 4px 4px 4px 10px;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  flex-shrink: 0;
  user-select: text;
}

.input-field {
  flex: 1;
  min-width: 0;
}

.input-field :deep(.v-field__input) {
  font-size: 12px;
  padding: 6px 4px;
  min-height: unset;
}

/* ---- Help / examples popover ---- */

.examples-popover {
  width: 360px;
  max-height: 60vh;
  overflow-y: auto;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  padding: 6px 0;
  user-select: text;
}

.examples-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px 6px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.examples-group {
  padding: 4px 0;
}

.examples-group + .examples-group {
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.04);
}

.examples-group-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.4);
  padding: 4px 10px;
}

.example-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font-family: inherit;
}

.example-row:hover {
  background: rgba(var(--v-theme-on-surface), 0.05);
}

.example-row:active {
  background: rgba(var(--v-theme-on-surface), 0.08);
}

.example-label {
  font-size: 11px;
  font-weight: 500;
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.example-prompt {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-style: italic;
  line-height: 1.35;
  white-space: normal;
}
</style>
