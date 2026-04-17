/**
 * Hello World plugin for Ares.
 *
 * Adds a toolbar button that logs the current feature and track counts to the
 * browser console. Use this as a starting point for your own plugin.
 *
 * Installation:
 *   Copy the hello-world/ directory into your Ares plugins directory, then
 *   enable it in Settings → Plugins. Ares loads index.js from each plugin
 *   directory it finds.
 *
 *   macOS:   ~/Library/Application Support/com.ares.app/plugins/hello-world/
 *   Windows: %APPDATA%\com.ares.app\plugins\hello-world\
 *   Linux:   ~/.config/com.ares.app/plugins/hello-world/
 */
export default {
  id:      'com.example.hello-world',
  name:    'Hello World',
  version: '1.0.0',

  activate(api) {
    api.log('Plugin activated.')

    api.registerToolbarButton({
      id:      'hello-world-info',
      icon:    'mdi-information-outline',
      tooltip: 'Hello World — log counts',
      onClick() {
        const featureCount = api.features.value.length
        const trackCount   = api.tracks.value.length
        api.log(`Features on map: ${featureCount}, CoT tracks: ${trackCount}`)
        // Example mutation — fly to the first feature if one exists.
        const first = api.features.value[0]
        if (first) {
          const geom = JSON.parse(first.geometry)
          api.flyToGeometry(geom)
          api.log(`Flying to feature id=${first.id}`)
        }
      }
    })

    api.onDeactivate(() => {
      api.log('Plugin deactivated.')
    })
  }
}
