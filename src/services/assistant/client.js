import { invoke } from '@tauri-apps/api/core'

export async function chat({ provider, model, apiKey, system, messages, tools }) {
  return invoke('assistant_chat', { provider, model, apiKey, system, messages, tools })
}
