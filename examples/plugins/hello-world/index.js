/**
 * Hello World plugin for Ares.
 *
 * Demos every plugin host API surface the registry exposes:
 *   - registerToolbarButton — adds two buttons in the toolbar's plugin slot.
 *   - map.addLayer          — drops a single magenta circle at lat/lon (0, 0).
 *   - map.onMove             — logs viewport state on every map move.
 *   - registerPanel          — opens a draggable panel with a click counter.
 *   - settings.get/set       — persists the click counter across reopen +
 *                              plugin disable/enable cycles.
 *
 * Installation:
 *   Copy the hello-world/ directory into your Ares plugins directory, then
 *   enable it in Settings → Plugins.
 *
 *   macOS:   ~/Library/Application Support/com.ares.app/plugins/hello-world/
 *   Windows: %APPDATA%\com.ares.app\plugins\hello-world\
 *   Linux:   ~/.config/com.ares.app/plugins/hello-world/
 */
export default {
  id:             'com.example.hello-world',
  name:           'Hello World',
  version:        '1.1.0',
  // Uses api.registerPanel, api.settings, api.map.addLayer / onMove —
  // all 1.1.2 surfaces. Older hosts will refuse to activate this plugin
  // and surface the version mismatch in Settings → Plugins.
  minHostVersion: '1.1.2',

  async activate(api) {
    api.log('Plugin activated.')

    // ---- Existing toolbar button: log counts + fly to first feature ----
    api.registerToolbarButton({
      id:      'hello-world-info',
      icon:    'mdi-information-outline',
      tooltip: 'Hello World — log counts',
      onClick() {
        const featureCount = api.features.value.length
        const trackCount   = api.tracks.value.length
        api.log(`Features on map: ${featureCount}, CoT tracks: ${trackCount}`)
        const first = api.features.value[0]
        if (first) {
          const geom = JSON.parse(first.geometry)
          api.flyToGeometry(geom)
          api.log(`Flying to feature id=${first.id}`)
        }
      }
    })

    // ---- Map layer: a single magenta circle at (0, 0). The optional
    //      onClick handler fires when the user clicks the dot; the cursor
    //      turns to a pointer on hover so it reads as interactive.
    api.map.addLayer({
      id: 'hello-world-marker',
      source: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { label: 'Null Island' }
          }]
        }
      },
      layer: {
        type: 'circle',
        paint: {
          'circle-radius':       8,
          'circle-color':        '#ff4081',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }
      },
      onClick({ feature, lngLat }) {
        api.log(`Clicked "${feature?.properties?.label ?? 'marker'}" at`, lngLat)
        api.flyToGeometry(feature.geometry)
      }
    })

    // ---- Map move events ----
    api.map.onMove((state) => {
      api.log('move', state)
    })

    // ---- Panel: click counter persisted via plugin-scoped settings ----
    let count = (await api.settings.get('clickCount')) ?? 0

    const panel = api.registerPanel({
      id: 'hello-world-panel',
      title: 'Hello World',
      icon: 'mdi-hand-wave-outline',
      initialPosition: { x: 60, y: 80 },
      mount(el) {
        el.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:8px;min-width:200px;">
            <div style="font-size:11px;line-height:1.5;color:rgba(255,255,255,0.6)">
              Click the button below; the counter persists across panel close
              and across plugin disable/enable.
            </div>
            <button
              id="hw-btn"
              style="
                background:#ff4081;color:#fff;border:none;border-radius:2px;
                padding:6px 10px;font-size:11px;font-weight:600;cursor:pointer;
              "
            >Clicked <span id="hw-count">${count}</span> times</button>
          </div>
        `
        const countEl = el.querySelector('#hw-count')
        const btnEl   = el.querySelector('#hw-btn')
        async function bump() {
          count += 1
          countEl.textContent = String(count)
          await api.settings.set('clickCount', count)
        }
        btnEl.addEventListener('click', bump)
        return () => btnEl.removeEventListener('click', bump)
      }
    })

    // ---- Toolbar button to toggle the panel ----
    api.registerToolbarButton({
      id:      'hello-world-panel-toggle',
      icon:    'mdi-hand-wave-outline',
      tooltip: 'Hello World — open panel',
      onClick() { panel.toggle() }
    })

    api.onDeactivate(() => {
      api.log('Plugin deactivated.')
    })
  }
}
