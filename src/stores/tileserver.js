import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getStore } from '@/plugins/store'

export const TILE_SERVER_PORT = 3650

export const useTileserverStore = defineStore('tileserver', () => {
  const paths    = ref([])   // registered folder paths (strings)
  const tilesets = ref([])   // TilesetInfo[]

  // ---- Persistence ----

  async function load() {
    try {
      const store  = await getStore()
      const saved  = await store.get('tileserverPaths')
      if (Array.isArray(saved) && saved.length) {
        for (const p of saved) {
          // Re-register each saved path with the Rust tile server.
          // Errors are swallowed — if the folder is gone, it's just skipped.
          try {
            const found = await invoke('add_tile_path', { path: p })
            if (!paths.value.includes(p)) paths.value.push(p)
            _mergeTilesets(found)
          } catch { /* path no longer accessible */ }
        }
      }
    } catch { /* first run */ }
  }

  async function _persist() {
    const store = await getStore()
    await store.set('tileserverPaths', paths.value)
  }

  function _mergeTilesets(incoming) {
    for (const ts of incoming) {
      if (!tilesets.value.find(t => t.name === ts.name)) {
        tilesets.value.push(ts)
      }
    }
    tilesets.value.sort((a, b) => a.display_name.localeCompare(b.display_name))
  }

  // ---- Public actions ----

  async function addPath(path) {
    const found = await invoke('add_tile_path', { path })
    if (!paths.value.includes(path)) paths.value.push(path)
    _mergeTilesets(found)
    await _persist()
    return found
  }

  async function removePath(path) {
    await invoke('remove_tile_path', { path })
    paths.value = paths.value.filter(p => p !== path)
    // Refresh full list from Rust (authoritative)
    tilesets.value = await invoke('list_tilesets')
    await _persist()
  }

  async function refresh() {
    tilesets.value = await invoke('list_tilesets')
  }

  return { paths, tilesets, load, addPath, removePath, refresh }
})
