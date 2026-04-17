import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { buildSceneDataKey } from '@/utils/sceneSerialization'

const CHUNK_SIZE = 24
const POLL_INTERVAL_MS = 30_000
const LRU_MAX = 200

export const useSceneDataStore = defineStore('sceneData', () => {
  const entries = ref({})
  const subs = ref({})

  let pollTimer = null
  let unlistenInvalidated = null

  function subscribeQuery({ cardTypeId, source, controls }) {
    const key = buildSceneDataKey(cardTypeId, source, controls)

    if (subs.value[key]) {
      subs.value[key].refCount++
    } else {
      subs.value[key] = { refCount: 1, cardTypeId, source: source ?? null, controls: controls ?? {} }
      if (!entries.value[key]) {
        entries.value[key] = { status: 'loading', loading: true, data: null, meta: null, error: null }
      }
      fetchBatch([key])
    }

    return {
      key,
      unsubscribe() {
        if (!subs.value[key]) return
        subs.value[key].refCount--
        if (subs.value[key].refCount <= 0) {
          delete subs.value[key]
          evictLRU()
        }
      },
    }
  }

  async function fetchBatch(keys) {
    if (document.visibilityState === 'hidden') return

    const toFetch = keys.filter(k => subs.value[k])
    if (!toFetch.length) return

    for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
      const chunk = toFetch.slice(i, i + CHUNK_SIZE)
      const reqs = chunk.map(key => {
        const sub = subs.value[key]
        return { key, card_type_id: sub.cardTypeId, source: sub.source ?? '', controls: sub.controls }
      })

      try {
        const results = await invoke('scene_data_fetch_batch', { reqs })
        for (const r of results) {
          entries.value[r.key] = {
            status: r.status,
            loading: false,
            data: r.data ?? null,
            meta: r.status === 'ok'
              ? { asOfTs: Date.now(), rowCount: r.row_count, queryMs: r.query_ms }
              : null,
            error: r.error ?? null,
          }
        }
      } catch (e) {
        for (const key of chunk) {
          if (entries.value[key]) {
            entries.value[key] = { ...entries.value[key], loading: false, status: 'error', error: String(e) }
          }
        }
      }
    }
  }

  function evictLRU() {
    const all = Object.keys(entries.value)
    if (all.length <= LRU_MAX) return
    const orphaned = all
      .filter(k => !subs.value[k])
      .sort((a, b) => (entries.value[a]?.meta?.asOfTs ?? 0) - (entries.value[b]?.meta?.asOfTs ?? 0))
    for (const k of orphaned.slice(0, all.length - LRU_MAX)) delete entries.value[k]
  }

  async function init() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      const keys = Object.keys(subs.value)
      if (keys.length) fetchBatch(keys)
    }, POLL_INTERVAL_MS)

    unlistenInvalidated = await listen('scene-data-invalidated', event => {
      const keys = Array.isArray(event.payload) ? event.payload : []
      const active = keys.filter(k => subs.value[k])
      if (active.length) fetchBatch(active)
    })
  }

  function teardown() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (unlistenInvalidated) { unlistenInvalidated(); unlistenInvalidated = null }
  }

  return { entries, subscribeQuery, init, teardown }
})
