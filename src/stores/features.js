import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getDb } from '@/plugins/database'

export const DEFAULT_FEATURE_COLOR = '#ffffff'
// Fill opacity for polygons/circles/sectors when the user hasn't chosen
// one explicitly. Low by default so the underlying basemap stays legible.
export const DEFAULT_FEATURE_OPACITY = 0.2

export const useFeaturesStore = defineStore('features', () => {
  const missions = ref([])
  const activeMissionId = ref(null)
  const features = ref([])
  const selectedFeatureId = ref(null)

  const activeMission = computed(() =>
    missions.value.find(m => m.id === activeMissionId.value) || null
  )

  const selectedFeature = computed(() => {
    if (!selectedFeatureId.value) return null
    const row = features.value.find(f => f.id === selectedFeatureId.value)
    if (!row) return null
    return {
      id: row.id,
      type: row.type,
      geometry: JSON.parse(row.geometry),
      properties: JSON.parse(row.properties)
    }
  })

  const featureCollection = computed(() => ({
    type: 'FeatureCollection',
    features: features.value.map(f => ({
      type: 'Feature',
      id: f.id,
      geometry: JSON.parse(f.geometry),
      properties: { ...JSON.parse(f.properties), _dbId: f.id, _type: f.type }
    }))
  }))

  async function loadMissions() {
    const db = await getDb()
    missions.value = await db.select('SELECT * FROM missions ORDER BY updated_at DESC')
  }

  async function createMission(name) {
    const db = await getDb()
    const result = await db.execute('INSERT INTO missions (name) VALUES ($1)', [name])
    await loadMissions()
    return result.lastInsertId
  }

  async function renameMission(id, name) {
    const trimmed = name?.trim()
    if (!id || !trimmed) return
    const db = await getDb()
    await db.execute(
      "UPDATE missions SET name = $1, updated_at = datetime('now') WHERE id = $2",
      [trimmed, id]
    )
    await loadMissions()
  }

  async function deleteMission(id) {
    return deleteMissions([id])
  }

  async function deleteMissions(ids) {
    if (!ids?.length) return
    const db = await getDb()
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
    await db.execute(`DELETE FROM features WHERE mission_id IN (${placeholders})`, ids)
    await db.execute(`DELETE FROM missions WHERE id IN (${placeholders})`, ids)
    if (ids.includes(activeMissionId.value)) {
      activeMissionId.value = null
      features.value = []
      selectedFeatureId.value = null
    }
    await loadMissions()
  }

  // Snapshot of feature counts per mission, used by the mission picker.
  async function missionFeatureCounts() {
    const db = await getDb()
    const rows = await db.select(
      'SELECT mission_id AS missionId, COUNT(*) AS count FROM features GROUP BY mission_id'
    )
    return Object.fromEntries(rows.map(r => [r.missionId, r.count]))
  }

  // Entry point used by MapView after the router resolves `:missionId`. Loads
  // the mission row cache, sets the active id, and fetches the feature list.
  // Returns the mission row (or null if the id doesn't resolve).
  async function setActiveMission(id) {
    if (!missions.value.length) await loadMissions()
    const match = missions.value.find(m => m.id === id)
    if (!match) {
      activeMissionId.value = null
      features.value = []
      selectedFeatureId.value = null
      return null
    }
    activeMissionId.value = match.id
    selectedFeatureId.value = null
    await loadFeatures()
    return match
  }

  async function loadFeatures() {
    if (!activeMissionId.value) {
      features.value = []
      return
    }
    const db = await getDb()
    features.value = await db.select(
      'SELECT * FROM features WHERE mission_id = $1 ORDER BY created_at',
      [activeMissionId.value]
    )
  }

  async function addFeature(type, geometry, properties = {}) {
    if (!activeMissionId.value) return null
    const db = await getDb()
    const result = await db.execute(
      'INSERT INTO features (mission_id, type, geometry, properties) VALUES ($1, $2, $3, $4)',
      [activeMissionId.value, type, JSON.stringify(geometry), JSON.stringify(properties)]
    )
    await db.execute(
      "UPDATE missions SET updated_at = datetime('now') WHERE id = $1",
      [activeMissionId.value]
    )
    await loadFeatures()
    return result.lastInsertId
  }

  async function updateFeature(id, geometry, properties) {
    const db = await getDb()
    await db.execute(
      "UPDATE features SET geometry = $1, properties = $2, updated_at = datetime('now') WHERE id = $3",
      [JSON.stringify(geometry), JSON.stringify(properties), id]
    )
    await loadFeatures()
  }

  async function updateFeatureProperties(id, patch) {
    const row = features.value.find(f => f.id === id)
    if (!row) return
    const merged = { ...JSON.parse(row.properties), ...patch }
    const db = await getDb()
    await db.execute(
      "UPDATE features SET properties = $1, updated_at = datetime('now') WHERE id = $2",
      [JSON.stringify(merged), id]
    )
    await loadFeatures()
  }

  async function removeFeature(id) {
    return removeFeatures([id])
  }

  async function removeFeatures(ids) {
    if (!ids?.length) return
    const db = await getDb()
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
    await db.execute(`DELETE FROM features WHERE id IN (${placeholders})`, ids)
    if (ids.includes(selectedFeatureId.value)) selectedFeatureId.value = null
    await loadFeatures()
  }

  function selectFeature(id) {
    selectedFeatureId.value = id
  }

  async function clearFeatures() {
    if (!activeMissionId.value) return
    const db = await getDb()
    await db.execute('DELETE FROM features WHERE mission_id = $1', [activeMissionId.value])
    features.value = []
  }

  return {
    missions,
    activeMissionId,
    activeMission,
    features,
    featureCollection,
    selectedFeatureId,
    selectedFeature,
    loadMissions,
    createMission,
    renameMission,
    deleteMission,
    deleteMissions,
    missionFeatureCounts,
    setActiveMission,
    loadFeatures,
    addFeature,
    updateFeature,
    updateFeatureProperties,
    removeFeature,
    removeFeatures,
    clearFeatures,
    selectFeature
  }
})
