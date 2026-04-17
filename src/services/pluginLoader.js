import { invoke } from '@tauri-apps/api/core'

/**
 * Discover and load all .js plugin files from the app-data plugins directory.
 * Each plugin is imported as an ES module via a temporary Blob URL. The plugin's
 * default export must be { id, name, version, activate(api) }.
 *
 * Errors in any individual plugin are caught and logged — a bad plugin does not
 * prevent others from loading. Registry.registerPlugin handles whether to call
 * activate() based on the current enabledPlugins setting.
 */
export async function loadPlugins(registry) {
  let paths
  try {
    paths = await invoke('list_plugin_files')
  } catch (err) {
    console.warn('[plugin-loader] Failed to list plugin files:', err)
    return
  }

  for (const filePath of paths) {
    try {
      const source = await invoke('read_plugin_file', { path: filePath })
      const blob = new Blob([source], { type: 'text/javascript' })
      const url  = URL.createObjectURL(blob)
      let manifest
      try {
        const module = await import(/* @vite-ignore */ url)
        manifest = module.default
      } finally {
        URL.revokeObjectURL(url)
      }
      registry.registerPlugin(manifest, filePath)
    } catch (err) {
      console.error(`[plugin-loader] Failed to load plugin at "${filePath}":`, err)
    }
  }
}
