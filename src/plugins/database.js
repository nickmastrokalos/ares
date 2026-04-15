import Database from '@tauri-apps/plugin-sql'
import { invoke } from '@tauri-apps/api/core'

let dbPromise = null

/**
 * Returns a singleton SQLite handle. Schema is managed by the
 * `tauri-plugin-sql` migration runner wired up in `src-tauri/src/lib.rs`,
 * so this function just opens the connection once per app session.
 *
 * Promise-caching ensures concurrent callers receive the same handle
 * without racing on initialization.
 */
export function getDb() {
  if (!dbPromise) {
    dbPromise = loadDb().catch(err => {
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

async function loadDb() {
  const url = await invoke('get_database_url')
  return await Database.load(url)
}
