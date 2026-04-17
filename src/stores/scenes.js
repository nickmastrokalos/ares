import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getDb } from '@/plugins/database'
import { useAppStore } from '@/stores/app'
import { stableSerialize } from '@/utils/sceneSerialization'

export const useScenesStore = defineStore('scenes', () => {
  const appStore = useAppStore()

  const scenes = ref([])

  const saveTimers = {}
  const lastSaved = {}

  function getById(id) {
    return scenes.value.find(s => s.id === id) ?? null
  }

  async function loadScenes() {
    appStore.beginLoad()
    try {
      const db = await getDb()
      const rows = await db.select('SELECT * FROM scenes ORDER BY order_idx, created_at')
      scenes.value = rows.map(r => ({ ...r, cards: JSON.parse(r.cards || '[]') }))
    } finally {
      appStore.endLoad()
    }
  }

  async function createScene({ label, icon = 'mdi-view-dashboard-outline' }) {
    const id = crypto.randomUUID()
    const orderIdx = scenes.value.length
    appStore.beginLoad()
    try {
      const db = await getDb()
      await db.execute(
        'INSERT INTO scenes (id, label, icon, order_idx, cards) VALUES ($1, $2, $3, $4, $5)',
        [id, label.trim(), icon, orderIdx, '[]']
      )
      await loadScenes()
      return id
    } finally {
      appStore.endLoad()
    }
  }

  async function updateScene(id, patch) {
    const allowed = ['label', 'description', 'icon']
    const entries = Object.entries(patch).filter(([k]) => allowed.includes(k))
    if (!entries.length) return
    appStore.beginLoad()
    try {
      const db = await getDb()
      const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ')
      const values = [...entries.map(([, v]) => v), id]
      await db.execute(
        `UPDATE scenes SET ${sets}, updated_at = datetime('now') WHERE id = $${values.length}`,
        values
      )
      await loadScenes()
    } finally {
      appStore.endLoad()
    }
  }

  async function deleteScene(id) {
    appStore.beginLoad()
    try {
      const db = await getDb()
      await db.execute('DELETE FROM scenes WHERE id = $1', [id])
      await loadScenes()
    } finally {
      appStore.endLoad()
    }
  }

  function saveSceneCards(id, cards) {
    const serialized = stableSerialize(cards)
    if (lastSaved[id] === serialized) return

    clearTimeout(saveTimers[id])
    saveTimers[id] = setTimeout(async () => {
      if (lastSaved[id] === serialized) return
      lastSaved[id] = serialized
      const db = await getDb()
      await db.execute(
        "UPDATE scenes SET cards = $1, updated_at = datetime('now') WHERE id = $2",
        [JSON.stringify(cards), id]
      )
      const idx = scenes.value.findIndex(s => s.id === id)
      if (idx !== -1) scenes.value[idx] = { ...scenes.value[idx], cards }
    }, 300)
  }

  return {
    scenes,
    getById,
    loadScenes,
    createScene,
    updateScene,
    deleteScene,
    saveSceneCards,
  }
})
