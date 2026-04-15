<script setup>
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '@/stores/settings'
import { isValidIP } from '@/services/network'

const open = defineModel({ type: Boolean })

const settingsStore = useSettingsStore()

// Add form
const newName = ref('')
const newAddress = ref('')
const newPort = ref('')
const newProtocol = ref('udp')
const formError = ref('')

// Edit state
const editingIndex = ref(null)
const editName = ref('')
const editAddress = ref('')
const editPort = ref('')
const editProtocol = ref('udp')
const editError = ref('')

const canAdd = computed(() => {
  return newName.value.trim() && newAddress.value.trim() && newPort.value.trim() && newProtocol.value
})

function isDuplicateSocket(address, port, excludeIndex) {
  return settingsStore.cotListeners.some((l, i) =>
    i !== excludeIndex && l.address === address && l.port === port
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

async function addListener() {
  const address = newAddress.value.trim()
  const error = validateFields(address, newPort.value, newProtocol.value, -1)
  if (error) { formError.value = error; return }

  const port = Number(newPort.value)
  const protocol = newProtocol.value

  await settingsStore.addCotListener({
    name: newName.value.trim(),
    address,
    port,
    protocol
  })

  // New listeners are enabled by default — start immediately.
  try {
    await invoke('start_listener', { address, port, protocol })
  } catch (err) {
    console.error('Failed to start listener:', err)
  }

  newName.value = ''
  newAddress.value = ''
  newPort.value = ''
  newProtocol.value = 'udp'
  formError.value = ''
}

function startEdit(index) {
  const listener = settingsStore.cotListeners[index]
  editingIndex.value = index
  editName.value = listener.name || ''
  editAddress.value = listener.address
  editPort.value = String(listener.port || '')
  editProtocol.value = listener.protocol || 'udp'
  editError.value = ''
}

async function saveEdit() {
  const address = editAddress.value.trim()
  const error = validateFields(address, editPort.value, editProtocol.value, editingIndex.value)
  if (error) { editError.value = error; return }

  await settingsStore.updateCotListener(editingIndex.value, {
    name: editName.value.trim(),
    address,
    port: Number(editPort.value),
    protocol: editProtocol.value
  })
  editingIndex.value = null
  editError.value = ''
}

function cancelEdit() {
  editingIndex.value = null
  editError.value = ''
}

async function toggleListener(index) {
  const listener = settingsStore.cotListeners[index]
  const willEnable = !listener.enabled
  await settingsStore.toggleCotListener(index)
  try {
    if (willEnable) {
      await invoke('start_listener', {
        address: listener.address,
        port: listener.port,
        protocol: listener.protocol ?? 'udp'
      })
    } else {
      await invoke('stop_listener', { address: listener.address, port: listener.port })
    }
  } catch (err) {
    console.error('Failed to toggle listener:', err)
  }
}

async function removeListener(index) {
  const listener = settingsStore.cotListeners[index]
  if (editingIndex.value === index) editingIndex.value = null
  // Stop the socket task before removing from settings.
  if (listener.enabled) {
    try {
      await invoke('stop_listener', { address: listener.address, port: listener.port })
    } catch (err) {
      console.error('Failed to stop listener on remove:', err)
    }
  }
  await settingsStore.removeCotListener(index)
}

function formatListener(listener) {
  const proto = (listener.protocol || 'udp').toUpperCase()
  const port = listener.port || '—'
  return `${proto} ${listener.address}:${port}`
}
</script>

<template>
  <v-dialog v-model="open" max-width="520">
    <v-card color="surface" rounded="sm" flat>
      <v-card-title class="d-flex align-center pa-3">
        <v-icon icon="mdi-access-point" size="20" class="me-2 text-medium-emphasis" />
        <span class="text-body-1">CoT Listeners</span>
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

      <!-- Add new listener -->
      <div class="pa-3">
        <div class="section-label mb-3">New Listener</div>
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
            @keydown.enter="addListener"
          />
          <v-btn
            icon="mdi-plus"
            size="small"
            variant="text"
            :disabled="!canAdd"
            @click="addListener"
          />
        </div>
        <div v-if="formError" class="text-caption text-error mt-1">
          {{ formError }}
        </div>
      </div>

      <v-divider />

      <!-- Configured listeners -->
      <div class="pb-1">
        <div class="d-flex align-center px-3 pt-3 pb-1">
          <span class="section-label">Configured</span>
          <span v-if="settingsStore.cotListeners.length" class="text-caption text-medium-emphasis ms-2">
            {{ settingsStore.cotListeners.length }}
          </span>
        </div>

        <div v-if="!settingsStore.cotListeners.length" class="px-3 pb-2 text-body-2 text-medium-emphasis">
          No listeners configured.
        </div>

        <div v-else class="listener-list">
          <div
            v-for="(listener, index) in settingsStore.cotListeners"
            :key="index"
            class="listener-row px-3"
          >
            <!-- Display mode -->
            <v-list-item
              v-if="editingIndex !== index"
              :title="listener.name || formatListener(listener)"
              :subtitle="listener.name ? formatListener(listener) : undefined"
              :class="{ 'text-medium-emphasis': !listener.enabled }"
              class="px-0"
            >
              <template #prepend>
                <v-list-item-action start>
                  <v-checkbox-btn
                    :model-value="listener.enabled"
                    density="compact"
                    hide-details
                    @update:model-value="toggleListener(index)"
                  />
                </v-list-item-action>
              </template>
              <template #append>
                <v-btn
                  icon="mdi-pencil-outline"
                  size="x-small"
                  variant="text"
                  class="text-medium-emphasis me-1"
                  @click="startEdit(index)"
                />
                <v-btn
                  icon="mdi-close"
                  size="x-small"
                  variant="text"
                  class="text-medium-emphasis"
                  @click="removeListener(index)"
                />
              </template>
            </v-list-item>

            <!-- Edit mode -->
            <div v-else class="py-2">
              <v-text-field
                v-model="editName"
                placeholder="Name"
                density="compact"
                hide-details
                variant="outlined"
                rounded="sm"
              />
              <div class="d-flex align-center ga-2 mt-2">
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

.listener-list {
  max-height: 260px;
  overflow-y: auto;
}

.listener-row + .listener-row {
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
}

.port-field {
  max-width: 90px;
}

.protocol-toggle {
  flex-shrink: 0;
}
</style>
