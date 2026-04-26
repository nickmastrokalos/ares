// MapLibre IControl: vertical slider for setting the camera pitch.
//
// Stacks below `NavigationControl` when both are added to the same corner
// (top-right). Two-way bound: dragging the slider sets pitch via
// `map.setPitch`, and any other source of pitch change (mouse drag, the
// NavigationControl compass) updates the slider via `map.on('pitch')`.
//
// Plain vanilla DOM — no Vue / Vuetify — so it lives in the MapLibre
// control row alongside the built-in zoom + compass buttons. Styling is
// kept inline to the file so the control is self-contained.

const MAX_PITCH = 85   // MapLibre's default cap

let stylesInjected = false

function injectStyles() {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .ares-pitch-ctrl {
      width: 29px;
      padding: 6px 0 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      box-sizing: border-box;
    }

    .ares-pitch-ctrl .ares-pitch-input {
      -webkit-appearance: slider-vertical;
      appearance: slider-vertical;
      writing-mode: vertical-lr;
      direction: rtl;
      width: 14px;
      height: 96px;
      margin: 0;
      cursor: ns-resize;
      background: transparent;
    }

    .ares-pitch-ctrl .ares-pitch-label {
      font-size: 9px;
      font-family: monospace;
      color: rgba(0, 0, 0, 0.6);
      letter-spacing: 0.04em;
      user-select: none;
      min-width: 22px;
      text-align: center;
    }

    /* Dark surfaces — hard to detect Vuetify theme from a plain control,
       so favour the same look as the built-in MapLibre buttons (white
       background, black glyph) and let the slider thumb pick up the
       browser default. */
  `
  document.head.appendChild(style)
}

export class MapPitchControl {
  constructor() {
    this._container = null
    this._input     = null
    this._label     = null
    this._map       = null
    this._onPitch   = null
  }

  onAdd(map) {
    injectStyles()
    this._map = map

    this._container = document.createElement('div')
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group ares-pitch-ctrl'

    this._input = document.createElement('input')
    this._input.type  = 'range'
    this._input.min   = '0'
    this._input.max   = String(MAX_PITCH)
    this._input.step  = '1'
    this._input.value = String(map.getPitch())
    this._input.className = 'ares-pitch-input'
    this._input.title = 'Camera pitch'
    // Older WebKit honours the `orient` attribute for vertical sliders;
    // modern browsers use the `writing-mode` / `appearance` styles set
    // above. Setting both gives us cross-browser coverage.
    this._input.setAttribute('orient', 'vertical')

    this._label = document.createElement('div')
    this._label.className = 'ares-pitch-label'
    this._label.textContent = `${Math.round(map.getPitch())}°`

    this._container.appendChild(this._input)
    this._container.appendChild(this._label)

    this._input.addEventListener('input', () => {
      const v = Number(this._input.value)
      this._map.setPitch(v)
      this._label.textContent = `${Math.round(v)}°`
    })
    this._input.addEventListener('dblclick', () => {
      this._map.setPitch(0)
    })

    // Keep the slider in sync if pitch changes via another source
    // (mouse drag, NavigationControl compass, programmatic setPitch).
    this._onPitch = () => {
      const v = this._map.getPitch()
      this._input.value = String(v)
      this._label.textContent = `${Math.round(v)}°`
    }
    this._map.on('pitch', this._onPitch)

    return this._container
  }

  onRemove() {
    if (this._onPitch && this._map) this._map.off('pitch', this._onPitch)
    this._container?.remove()
    this._container = null
    this._input     = null
    this._label     = null
    this._map       = null
    this._onPitch   = null
  }
}
