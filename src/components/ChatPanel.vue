<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useChatStore }     from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useDraggable }     from '@/composables/useDraggable'
import { useZIndex }        from '@/composables/useZIndex'

const emit = defineEmits(['close'])

const chatStore     = useChatStore()
const settingsStore = useSettingsStore()

const positioned = ref(false)
const { pos, onPointerDown }   = useDraggable()
const { zIndex, bringToFront } = useZIndex()

const draftText      = ref('')
const showContacts   = ref(false)
const messagesEl     = ref(null)
const minimized      = ref(false)

// One-time callsign setup. Hidden once `selfCallsign` is set; the chat
// store gates `sendMessage` and the announce broadcast on the same
// condition, so this dialog is the single point of entry into chat.
const setupCallsign = ref('')
function saveSetup() {
  const cs = setupCallsign.value.trim()
  if (!cs) return
  settingsStore.setSetting('selfCallsign', cs)
  setupCallsign.value = ''
}

// Inline callsign edit — click the callsign chip in the header to swap it
// for an input. Save on Enter or blur, cancel on Escape.
const editingCallsign = ref(false)
const callsignDraft   = ref('')
const callsignInputEl = ref(null)
function beginEditCallsign() {
  callsignDraft.value = settingsStore.selfCallsign ?? ''
  editingCallsign.value = true
  nextTick(() => callsignInputEl.value?.focus())
}
function commitCallsign() {
  if (!editingCallsign.value) return
  const cs = callsignDraft.value.trim()
  // Empty input clears (re-locks chat); intentional, mirrors Settings.
  settingsStore.setSetting('selfCallsign', cs || null)
  editingCallsign.value = false
}
function cancelCallsign() {
  editingCallsign.value = false
}

onMounted(() => {
  pos.value        = { x: 16, y: 80 }
  positioned.value = true
})

const activeRoom = computed(() =>
  chatStore.rooms.get(chatStore.activeRoomId) ?? null
)

const activeMessages = computed(() =>
  chatStore.messages.get(chatStore.activeRoomId) ?? []
)

function selectRoom(roomId) {
  chatStore.setActiveRoom(roomId)
  draftText.value = ''
  scrollToBottom()
}

async function send() {
  const text = draftText.value
  if (!text.trim()) return
  const result = await chatStore.sendMessage(chatStore.activeRoomId, text)
  if (result.ok) draftText.value = ''
  await nextTick()
  scrollToBottom()
}

function onSendKey(ev) {
  if (ev.shiftKey) return            // Shift+Enter → newline
  ev.preventDefault()
  send()
}

function scrollToBottom() {
  const el = messagesEl.value
  if (!el) return
  nextTick(() => { el.scrollTop = el.scrollHeight })
}

watch(
  () => activeMessages.value.length,
  () => scrollToBottom()
)

function startDirect(contact) {
  chatStore.openDirectRoom(contact.uid, contact.callsign)
  showContacts.value = false
  scrollToBottom()
}

function unreadFor(roomId) {
  return chatStore.unread.get(roomId) ?? 0
}

function formatTs(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}
</script>

<template>
  <div
    class="chat-panel"
    :class="{ 'chat-panel--minimized': minimized }"
    :style="{
      left: pos.x + 'px',
      top:  pos.y + 'px',
      zIndex,
      visibility: positioned ? 'visible' : 'hidden'
    }"
    @pointerdown="bringToFront"
  >
    <!-- Header -->
    <div class="panel-header" @pointerdown="onPointerDown">
      <v-icon size="14" class="text-medium-emphasis" style="flex-shrink:0">mdi-chat-outline</v-icon>
      <span class="panel-title">Chat</span>
      <input
        v-if="editingCallsign"
        ref="callsignInputEl"
        v-model="callsignDraft"
        class="panel-self panel-self--edit"
        :placeholder="settingsStore.selfCallsign ?? 'Callsign'"
        spellcheck="false"
        autocomplete="off"
        maxlength="20"
        @pointerdown.stop
        @keydown.enter.prevent="commitCallsign"
        @keydown.escape.prevent="cancelCallsign"
        @blur="commitCallsign"
      />
      <span
        v-else-if="settingsStore.selfCallsign"
        class="panel-self panel-self--button"
        title="Click to change callsign"
        @pointerdown.stop
        @click.stop="beginEditCallsign"
      >{{ settingsStore.selfCallsign }}</span>
      <v-spacer />
      <v-btn
        icon="mdi-account-plus-outline"
        size="x-small"
        variant="text"
        title="Direct chat with a known track"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="showContacts = !showContacts"
      />
      <v-btn
        :icon="minimized ? 'mdi-chevron-down' : 'mdi-chevron-up'"
        size="x-small"
        variant="text"
        :title="minimized ? 'Expand' : 'Minimize'"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="minimized = !minimized"
      />
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        class="text-medium-emphasis header-btn"
        @pointerdown.stop
        @click.stop="emit('close')"
      />
    </div>

    <!-- Setup gate: callsign required before chat features unlock -->
    <div v-if="!minimized && !chatStore.setupReady" class="setup-card" @pointerdown.stop>
      <div class="setup-title">Pick a callsign</div>
      <div class="setup-help">
        Peers see this name in their chat contacts list. You can change it later from Settings → Network.
      </div>
      <input
        v-model="setupCallsign"
        class="setup-input"
        placeholder="e.g. ARES-1"
        spellcheck="false"
        autocomplete="off"
        maxlength="20"
        @keydown.enter.prevent="saveSetup"
      />
      <button
        class="setup-btn"
        :disabled="!setupCallsign.trim()"
        @click="saveSetup"
      >
        Save and start
      </button>
    </div>

    <!-- Contacts popover -->
    <div v-else-if="!minimized && showContacts" class="contacts-pop" @pointerdown.stop>
      <div class="contacts-title">Start direct chat</div>
      <div v-if="!chatStore.knownContacts.length" class="contacts-empty">
        No CoT tracks with callsigns yet.
      </div>
      <div
        v-for="c in chatStore.knownContacts"
        :key="c.uid"
        class="contact-row"
        @click="startDirect(c)"
      >
        <v-icon size="13" class="text-medium-emphasis">mdi-account-outline</v-icon>
        <span class="contact-name">{{ c.callsign }}</span>
      </div>
    </div>

    <!-- Body: rooms left, conversation right -->
    <div v-if="!minimized && chatStore.setupReady" class="panel-body">

      <!-- Room list -->
      <div class="rooms" @pointerdown.stop>
        <div
          v-for="room in chatStore.roomList"
          :key="room.id"
          class="room-row"
          :class="{ 'room-row--active': room.id === chatStore.activeRoomId }"
          @click="selectRoom(room.id)"
        >
          <v-icon size="13" class="room-icon">{{
            room.kind === 'group' ? 'mdi-account-group-outline' : 'mdi-account-outline'
          }}</v-icon>
          <span class="room-name">{{ room.name }}</span>
          <span v-if="unreadFor(room.id)" class="room-unread">
            {{ unreadFor(room.id) }}
          </span>
        </div>
      </div>

      <!-- Conversation -->
      <div class="convo">
        <div ref="messagesEl" class="messages">
          <div v-if="!activeMessages.length" class="messages-empty">
            <template v-if="activeRoom?.kind === 'group'">
              No messages yet — start the conversation.
            </template>
            <template v-else>
              No messages with {{ activeRoom?.name }} yet.
            </template>
          </div>
          <div
            v-for="m in activeMessages"
            :key="m.uid"
            class="msg"
            :class="{ 'msg--out': m.outbound, 'msg--err': chatStore.sendErrors.get(m.uid) }"
          >
            <div class="msg-meta">
              <span class="msg-from">{{ m.outbound ? 'me' : m.fromCallsign }}</span>
              <span class="msg-ts">{{ formatTs(m.ts) }}</span>
            </div>
            <div class="msg-text">{{ m.text }}</div>
            <div v-if="chatStore.sendErrors.get(m.uid)" class="msg-err">
              {{ chatStore.sendErrors.get(m.uid) }}
            </div>
          </div>
        </div>

        <div class="composer" @pointerdown.stop>
          <textarea
            v-model="draftText"
            class="composer-input"
            placeholder="Message…"
            rows="2"
            spellcheck="false"
            @keydown.enter="onSendKey"
          />
          <button class="send-btn" :disabled="!draftText.trim()" @click="send">
            <v-icon size="14">mdi-send</v-icon>
          </button>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  position: absolute;
  width: 480px;
  height: 360px;
  background: rgba(var(--v-theme-surface), 0.95);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
  display: flex;
  flex-direction: column;
}

/* Collapse to just the header — same dropshadow / rounding, body hidden. */
.chat-panel--minimized {
  height: auto;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px 4px 8px;
  cursor: grab;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  flex-shrink: 0;
}

.panel-header:active { cursor: grabbing; }

.panel-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.panel-self {
  font-size: 10px;
  font-family: monospace;
  color: rgba(var(--v-theme-on-surface), 0.5);
  margin-left: 2px;
  padding: 1px 5px;
  border-radius: 2px;
}

.panel-self--button {
  cursor: pointer;
  border: 1px solid transparent;
}

.panel-self--button:hover {
  color: rgba(var(--v-theme-on-surface), 0.85);
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.panel-self--edit {
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  color: rgb(var(--v-theme-on-surface));
  outline: none;
  width: 100px;
}

.panel-self--edit::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.3);
}

.header-btn { flex-shrink: 0; }

.panel-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* Rooms rail */
.rooms {
  width: 140px;
  border-right: 1px solid rgb(var(--v-theme-surface-variant));
  overflow-y: auto;
  flex-shrink: 0;
}

.room-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.75);
  border-left: 2px solid transparent;
}

.room-row:hover { background: rgba(var(--v-theme-on-surface), 0.04); }

.room-row--active {
  background: rgba(var(--v-theme-primary), 0.1);
  border-left-color: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-surface));
}

.room-icon { color: rgba(var(--v-theme-on-surface), 0.45); flex-shrink: 0; }

.room-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.room-unread {
  flex-shrink: 0;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 8px;
  min-width: 16px;
  text-align: center;
}

/* Conversation pane */
.convo {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.messages-empty {
  margin: auto;
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.4);
  font-style: italic;
}

.msg {
  font-size: 11px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  border-radius: 4px;
  padding: 4px 6px;
  max-width: 85%;
  align-self: flex-start;
  word-break: break-word;
}

.msg--out {
  align-self: flex-end;
  background: rgba(var(--v-theme-primary), 0.18);
}

.msg--err {
  outline: 1px solid rgba(var(--v-theme-error), 0.5);
}

.msg-meta {
  display: flex;
  gap: 6px;
  font-size: 9px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  margin-bottom: 2px;
}

.msg-from { font-weight: 600; }
.msg-text { white-space: pre-wrap; }
.msg-err {
  margin-top: 3px;
  font-size: 9px;
  color: rgb(var(--v-theme-error));
}

/* Composer */
.composer {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
  flex-shrink: 0;
}

.composer-input {
  flex: 1;
  font-size: 11px;
  font-family: inherit;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  color: rgb(var(--v-theme-on-surface));
  padding: 4px 6px;
  outline: none;
  resize: none;
  box-sizing: border-box;
}

.composer-input::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.3);
}

.send-btn {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  border: none;
  border-radius: 2px;
  width: 32px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Setup gate */
.setup-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: stretch;
  padding: 16px 20px;
  gap: 8px;
}

.setup-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: rgb(var(--v-theme-on-surface));
}

.setup-help {
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.55);
  line-height: 1.4;
  margin-bottom: 4px;
}

.setup-input {
  font-size: 12px;
  font-family: monospace;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  color: rgb(var(--v-theme-on-surface));
  padding: 6px 8px;
  outline: none;
}

.setup-input::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.3);
}

.setup-btn {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  border: none;
  border-radius: 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 6px 10px;
  cursor: pointer;
  align-self: flex-end;
}

.setup-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Contacts popover */
.contacts-pop {
  position: absolute;
  top: 32px;
  right: 8px;
  width: 200px;
  max-height: 240px;
  overflow-y: auto;
  background: rgba(var(--v-theme-surface), 0.98);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  z-index: 1;
  padding: 4px 0;
}

.contacts-title {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.45);
  padding: 4px 8px;
}

.contacts-empty {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  font-style: italic;
  padding: 4px 8px;
}

.contact-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.contact-row:hover { background: rgba(var(--v-theme-on-surface), 0.06); }

.contact-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
