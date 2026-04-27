<script setup>
import { ref, computed, inject } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '@/stores/settings'
import { isValidIP } from '@/services/network'

const open = defineModel({ type: Boolean })

const settingsStore  = useSettingsStore()
// Plugin registry is provided by MapView. We use it for two things:
// (1) resolving the human-readable plugin name for the Owner badge on
// plugin-owned rows, and (2) gating socket start/stop on whether the
// owning plugin is currently enabled.
const pluginRegistry = inject('pluginRegistry', null)

// ---- Add CoT Listener form (ad-hoc, user-owned) -------------------------
const newName     = ref('')
const newAddress  = ref('')
const newPort     = ref('')
const newProtocol = ref('udp')
const formError   = ref('')

// ---- Edit row state -----------------------------------------------------
const editingIndex = ref(null)
const editName     = ref('')
const editAddress  = ref('')
const editPort     = ref('')
const editProtocol = ref('udp')
const editError    = ref('')

const canAdd = computed(() => {
  return newName.value.trim() && newAddress.value.trim() && newPort.value.trim() && newProtocol.value
})

function isDuplicateSocket(address, port, excludeIndex) {
  return settingsStore.connections.some((c, i) =>
    i !== excludeIndex && c.address === address && c.port === port
  )
}

function validateFields(address, port, protocol, excludeIndex) {
  if (!address) return 'Address is required'
  if (!isValidIP(address)) return 'Invalid IP address'

  const p = Number(port)
  if (!String(port).trim() || isNaN(p) || p < 1 || p > 65535 || !Number.isInteger(p)) {
    return 'Port must be 1–65535'
  }

  if (!protocol) return 'Protocol is required'

  if (isDuplicateSocket(address, p, excludeIndex)) {
    return 'This address:port is already configured'
  }

  return null
}

// ---- Owner / capability helpers -----------------------------------------
function isPluginEnabled(pluginId) {
  if (!pluginId) return false
  const list = pluginRegistry?.discoveredPlugins?.value ?? []
  return list.some(p => p.id === pluginId && p.active)
}

function pluginName(pluginId) {
  const list = pluginRegistry?.discoveredPlugins?.value ?? []
  return list.find(p => p.id === pluginId)?.name ?? null
}

/** Owner label shown in the row: "Ares", "Plugin: <name>", or "User". */
function ownerLabel(c) {
  if (c.ownerKind === 'host')   return 'Ares'
  if (c.ownerKind === 'plugin') return `Plugin: ${pluginName(c.ownerPluginId) ?? c.ownerPluginId ?? 'unknown'}`
  return 'User'
}

/** Whether the user can rename the row. Only ad-hoc rows are renamable;
 *  protected (host) and plugin rows have fixed labels. */
function isRenamable(c) {
  return c.ownerKind === 'adhoc'
}

/** Whether the user can delete the row. Only ad-hoc. */
function isRemovable(c) {
  return c.ownerKind === 'adhoc'
}

/** Whether the row's plugin owner is loaded + active. Used to gray out
 *  the row and prevent socket start when the owning plugin is disabled. */
function isOwnerActive(c) {
  if (c.ownerKind !== 'plugin') return true
  return isPluginEnabled(c.ownerPluginId)
}

// ---- Add ----------------------------------------------------------------
async function addAdhocListener() {
  const address = newAddress.value.trim()
  const error = validateFields(address, newPort.value, newProtocol.value, -1)
  if (error) { formError.value = error; return }

  const port = Number(newPort.value)
  const protocol = newProtocol.value

  await settingsStore.addAdhocCotConnection({
    name: newName.value.trim(),
    address,
    port,
    protocol
  })

  // Find the newly-added row's kind so we can pass it through to Rust.
  const fresh = settingsStore.connections[settingsStore.connections.length - 1]
  try {
    await invoke('start_listener', {
      address, port, protocol,
      kind:   fresh.kind,
      parser: 'cot'
    })
  } catch (err) {
    console.error('Failed to start listener:', err)
  }

  newName.value = ''
  newAddress.value = ''
  newPort.value = ''
  newProtocol.value = 'udp'
  formError.value = ''
}

// ---- Edit ---------------------------------------------------------------
function startEdit(index) {
  const c = settingsStore.connections[index]
  editingIndex.value = index
  editName.value = c.name || ''
  editAddress.value = c.address
  editPort.value = String(c.port || '')
  editProtocol.value = c.protocol || 'udp'
  editError.value = ''
}

async function saveEdit() {
  const c = settingsStore.connections[editingIndex.value]
  const address = editAddress.value.trim()
  const error = validateFields(address, editPort.value, editProtocol.value, editingIndex.value)
  if (error) { editError.value = error; return }

  // Stop the existing socket on the old address/port before saving,
  // then re-start on the new one if the row is enabled. Plugin rows
  // additionally require the plugin to be active.
  const wasEnabled = c.enabled
  if (wasEnabled) {
    try { await invoke('stop_listener', { address: c.address, port: c.port }) }
    catch (err) { console.error('Failed to stop listener on edit:', err) }
  }

  const patch = {
    address,
    port:     Number(editPort.value),
    protocol: editProtocol.value
  }
  // Renaming is only meaningful for ad-hoc rows.
  if (isRenamable(c)) patch.name = editName.value.trim()
  await settingsStore.updateConnection(editingIndex.value, patch)

  if (wasEnabled && isOwnerActive(c)) {
    try {
      await invoke('start_listener', {
        address:  patch.address,
        port:     patch.port,
        protocol: patch.protocol,
        kind:     c.kind,
        parser:   c.parser === 'plugin' ? 'raw' : 'cot'
      })
    } catch (err) {
      console.error('Failed to restart listener after edit:', err)
    }
  }

  editingIndex.value = null
  editError.value = ''
}

function cancelEdit() {
  editingIndex.value = null
  editError.value = ''
}

// ---- Toggle / remove ----------------------------------------------------
async function toggleConnection(index) {
  const c = settingsStore.connections[index]
  const willEnable = !c.enabled
  await settingsStore.toggleConnection(index)
  try {
    if (willEnable && isOwnerActive(c)) {
      await invoke('start_listener', {
        address:  c.address,
        port:     c.port,
        protocol: c.protocol ?? 'udp',
        kind:     c.kind,
        parser:   c.parser === 'plugin' ? 'raw' : 'cot'
      })
    } else {
      await invoke('stop_listener', { address: c.address, port: c.port })
    }
  } catch (err) {
    console.error('Failed to toggle listener:', err)
  }
}

async function removeConnection(index) {
  const c = settingsStore.connections[index]
  if (!isRemovable(c)) return
  if (editingIndex.value === index) editingIndex.value = null
  if (c.enabled) {
    try { await invoke('stop_listener', { address: c.address, port: c.port }) }
    catch (err) { console.error('Failed to stop listener on remove:', err) }
  }
  await settingsStore.removeConnection(index)
}

function formatConnection(c) {
  const proto = (c.protocol || 'udp').toUpperCase()
  const port  = c.port || '—'
  return `${proto} ${c.address}:${port}`
}
</script>

<template>
  <v-dialog v-model="open" max-width="560">
    <v-card color="surface" rounded="sm" flat>
      <v-card-title class="d-flex align-center pa-3">
        <v-icon icon="mdi-access-point" size="20" class="me-2 text-medium-emphasis" />
        <span class="text-body-1">Connections</span>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          class="text-medium-emphasis"
          @click="open = false"
        />
      </v-card-title>

      <v-divider />

      <!-- Add CoT Listener (ad-hoc, user-owned) -->
      <div class="pa-3">
        <div class="section-label mb-1">Add CoT Listener</div>
        <div class="text-caption text-medium-emphasis mb-3">
          Adds a CoT-parsed listener for additional TAK multicast groups
          beyond the protected core. Plugin-owned connections are added
          automatically when their plugin loads — don't add them here.
        </div>
        <v-text-field
          v-model="newName"
          placeholder="Name"
          density="compact"
          hide-details
          variant="outlined"
          rounded="sm"
          class="mb-2"
        />
        <div class="d-flex align-center ga-2">
          <v-btn-toggle
            v-model="newProtocol"
            mandatory
            density="compact"
            rounded="sm"
            color="primary"
            class="protocol-toggle"
          >
            <v-btn value="udp" size="small">UDP</v-btn>
            <v-btn value="tcp" size="small">TCP</v-btn>
          </v-btn-toggle>
          <v-text-field
            v-model="newAddress"
            placeholder="Address"
            density="compact"
            hide-details
            variant="outlined"
            rounded="sm"
            class="flex-grow-1"
          />
          <v-text-field
            v-model="newPort"
            placeholder="Port"
            density="compact"
            hide-details
            variant="outlined"
            rounded="sm"
            type="number"
            class="port-field"
            @keydown.enter="addAdhocListener"
          />
          <v-btn
            icon="mdi-plus"
            size="small"
            variant="text"
            :disabled="!canAdd"
            @click="addAdhocListener"
          />
        </div>
        <div v-if="formError" class="text-caption text-error mt-1">
          {{ formError }}
        </div>
      </div>

      <v-divider />

      <!-- Configured connections -->
      <div class="pb-1">
        <div class="d-flex align-center px-3 pt-3 pb-1">
          <span class="section-label">Configured</span>
          <span v-if="settingsStore.connections.length" class="text-caption text-medium-emphasis ms-2">
            {{ settingsStore.connections.length }}
          </span>
        </div>

        <div v-if="!settingsStore.connections.length" class="px-3 pb-2 text-body-2 text-medium-emphasis">
          No connections configured.
        </div>

        <div v-else class="connection-list">
          <div
            v-for="(c, index) in settingsStore.connections"
            :key="c.kind"
            class="connection-row px-3"
          >
            <!-- Display mode -->
            <v-list-item
              v-if="editingIndex !== index"
              :title="c.name || formatConnection(c)"
              :class="{ 'text-medium-emphasis': !c.enabled || !isOwnerActive(c) }"
              class="px-0"
            >
              <template #prepend>
                <v-list-item-action start>
                  <v-checkbox-btn
                    :model-value="c.enabled"
                    density="compact"
                    hide-details
                    @update:model-value="toggleConnection(index)"
                  />
                </v-list-item-action>
              </template>
              <template #subtitle>
                <span class="d-flex align-center ga-2 flex-wrap">
                  <span>{{ formatConnection(c) }}</span>
                  <span class="owner-badge" :data-owner="c.ownerKind">{{ ownerLabel(c) }}</span>
                  <span
                    v-if="c.ownerKind === 'plugin' && !isOwnerActive(c)"
                    class="text-caption text-warning"
                    title="Plugin not active — toggle the plugin on in Settings → Plugins to start this connection."
                  >
                    plugin off
                  </span>
                </span>
              </template>
              <template #append>
                <v-icon
                  v-if="c.kind === 'tak-chat-messages' || c.kind === 'tak-chat-announce'"
                  icon="mdi-swap-vertical-variant"
                  size="14"
                  class="text-medium-emphasis me-1"
                  :title="c.kind === 'tak-chat-messages'
                    ? 'Bidirectional — outbound chat goes through this connection'
                    : 'Bidirectional — presence announces go out through this connection'"
                />
                <v-icon
                  v-if="c.protected"
                  icon="mdi-shield-lock-outline"
                  size="14"
                  class="text-medium-emphasis me-1"
                  title="Owner-managed connection — editable but cannot be removed"
                />
                <v-btn
                  icon="mdi-pencil-outline"
                  size="x-small"
                  variant="text"
                  class="text-medium-emphasis me-1"
                  @click="startEdit(index)"
                />
                <v-btn
                  v-if="isRemovable(c)"
                  icon="mdi-close"
                  size="x-small"
                  variant="text"
                  class="text-medium-emphasis"
                  @click="removeConnection(index)"
                />
              </template>
            </v-list-item>

            <!-- Edit mode -->
            <div v-else class="py-2">
              <v-text-field
                v-if="isRenamable(settingsStore.connections[editingIndex])"
                v-model="editName"
                placeholder="Name"
                density="compact"
                hide-details
                variant="outlined"
                rounded="sm"
                class="mb-2"
              />
              <div class="d-flex align-center ga-2">
                <v-btn-toggle
                  v-model="editProtocol"
                  mandatory
                  density="compact"
                  rounded="sm"
                  color="primary"
                  class="protocol-toggle"
                >
                  <v-btn value="udp" size="small">UDP</v-btn>
                  <v-btn value="tcp" size="small">TCP</v-btn>
                </v-btn-toggle>
                <v-text-field
                  v-model="editAddress"
                  placeholder="Address"
                  density="compact"
                  hide-details
                  variant="outlined"
                  rounded="sm"
                  class="flex-grow-1"
                />
                <v-text-field
                  v-model="editPort"
                  placeholder="Port"
                  density="compact"
                  hide-details
                  variant="outlined"
                  rounded="sm"
                  type="number"
                  class="port-field"
                  @keydown.enter="saveEdit"
                />
              </div>
              <div v-if="editError" class="text-caption text-error mt-1">
                {{ editError }}
              </div>
              <div class="d-flex justify-end ga-1 mt-2">
                <v-btn size="small" variant="text" class="text-medium-emphasis" @click="cancelEdit">
                  Cancel
                </v-btn>
                <v-btn size="small" variant="text" color="primary" @click="saveEdit">
                  Save
                </v-btn>
              </div>
            </div>
          </div>
        </div>
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.section-label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.45);
}

.connection-list {
  max-height: 320px;
  overflow-y: auto;
}

.connection-row + .connection-row {
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
}

.port-field {
  max-width: 90px;
}

.protocol-toggle {
  flex-shrink: 0;
}

/* Owner badge — small inline tag colored by category. Subtle: the
   primary visual on the row is the connection title and address. */
.owner-badge {
  display: inline-flex;
  align-items: center;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.15);
  color: rgba(var(--v-theme-on-surface), 0.7);
}
.owner-badge[data-owner="host"]   { color: rgb(var(--v-theme-primary)); border-color: rgb(var(--v-theme-primary)); }
.owner-badge[data-owner="plugin"] { color: #b8a2ff; border-color: #b8a2ff; }
.owner-badge[data-owner="adhoc"]  { color: rgba(var(--v-theme-on-surface), 0.7); }
</style>