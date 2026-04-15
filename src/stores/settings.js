import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getStore } from '@/plugins/store'
import { useAppStore } from '@/stores/app'

// Single source of truth for which settings exist and their default values.
// Adding a new setting is: add a default here, add a matching `ref` below
// (and expose it from the store), and register it in the `refs` map.
const DEFAULTS = {
  showFeatureLabels: true,
  selectedBasemap: 'osm',
  cotListeners: [],
  distanceUnits: 'metric',
  coordinateFormat: 'dd',
  trackBreadcrumbs: false,
  trackBreadcrumbLength: 30,  // seconds
  basemapOpacity: 1.0
}

export const useSettingsStore = defineStore('settings', () => {
  const appStore = useAppStore()

  const showFeatureLabels = ref(DEFAULTS.showFeatureLabels)
  const selectedBasemap = ref(DEFAULTS.selectedBasemap)
  const cotListeners = ref([...DEFAULTS.cotListeners])
  const distanceUnits = ref(DEFAULTS.distanceUnits)
  const coordinateFormat = ref(DEFAULTS.coordinateFormat)
  const trackBreadcrumbs = ref(DEFAULTS.trackBreadcrumbs)
  const trackBreadcrumbLength = ref(DEFAULTS.trackBreadcrumbLength)
  const basemapOpacity = ref(DEFAULTS.basemapOpacity)

  // Keyed lookup so `setSetting(key, value)` can update the right ref
  // without a growing switch statement as we add more settings.
  const refs = {
    showFeatureLabels,
    selectedBasemap,
    cotListeners,
    distanceUnits,
    coordinateFormat,
    trackBreadcrumbs,
    trackBreadcrumbLength,
    basemapOpacity
  }

  // Promise cache: `load()` may be called from multiple places during boot
  // (App.vue on mount, MapView.vue before initializing map layers). Both
  // callers share the same in-flight read.
  let loadPromise = null

  async function load() {
    if (loadPromise) return loadPromise
    appStore.beginLoad()
    loadPromise = (async () => {
      try {
        const store = await getStore()
        for (const key of Object.keys(refs)) {
          const stored = await store.get(key)
          // Only override the default when the user has actually set a value —
          // `null`/`undefined` mean "never written" and should stay as default.
          if (stored !== undefined && stored !== null) {
            refs[key].value = stored
          }
        }
      } finally {
        appStore.endLoad()
      }
    })()
    return loadPromise
  }

  async function setSetting(key, value) {
    if (!(key in refs)) return
    const store = await getStore()
    await store.set(key, value)
    refs[key].value = value
  }

  async function saveCotListeners() {
    const store = await getStore()
    await store.set('cotListeners', cotListeners.value)
  }

  async function addCotListener({ name, address, port, protocol }) {
    cotListeners.value.push({ name, address, port, protocol, enabled: true })
    await saveCotListeners()
  }

  async function updateCotListener(index, patch) {
    Object.assign(cotListeners.value[index], patch)
    await saveCotListeners()
  }

  async function removeCotListener(index) {
    cotListeners.value.splice(index, 1)
    await saveCotListeners()
  }

  async function toggleCotListener(index) {
    cotListeners.value[index].enabled = !cotListeners.value[index].enabled
    await saveCotListeners()
  }

  return {
    showFeatureLabels,
    selectedBasemap,
    cotListeners,
    distanceUnits,
    coordinateFormat,
    trackBreadcrumbs,
    trackBreadcrumbLength,
    basemapOpacity,
    load,
    setSetting,
    addCotListener,
    updateCotListener,
    removeCotListener,
    toggleCotListener
  }
})
