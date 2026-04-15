import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useMapStore = defineStore('map', () => {
  const center = ref([-74.006, 40.7128])
  const zoom = ref(2)
  const bearing = ref(0)
  const pitch = ref(0)

  function saveView(map) {
    const c = map.getCenter()
    center.value = [c.lng, c.lat]
    zoom.value = map.getZoom()
    bearing.value = map.getBearing()
    pitch.value = map.getPitch()
  }

  return { center, zoom, bearing, pitch, saveView }
})
