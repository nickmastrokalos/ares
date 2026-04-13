import { load } from '@tauri-apps/plugin-store'

let store = null

export async function getStore() {
  if (!store) {
    store = await load('settings.json', { autoSave: true })
  }
  return store
}
