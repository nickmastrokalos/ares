import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useNavigationStore = defineStore('navigation', () => {
  // Persists the last active mission across sidebar navigation so clicking
  // "Map" from Hub/Config/Scenes returns to the same mission.
  const activeMissionId = ref(null)

  function setActiveMission(id) {
    activeMissionId.value = id
  }

  function clearActiveMission() {
    activeMissionId.value = null
  }

  return { activeMissionId, setActiveMission, clearActiveMission }
})
