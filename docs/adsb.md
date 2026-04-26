# ADS-B feed

Live aircraft positions from the free, key-less [airplanes.live](https://airplanes.live) REST API, rendered as cyan icons on the map alongside (and visually distinct from) the yellow AIS vessels.

## Data source

- Endpoint: `https://api.airplanes.live/v2/point/{lat}/{lon}/{radius_nm}` — aircraft within `radius_nm` of `(lat, lon)`. Hard cap of **250 nm** server-side; the composable clamps before sending.
- Rate limit: **1 request per second**. The poll interval is 10 s, so we never approach it; the move/zoom debounce is 600 ms to coalesce viewport changes.
- No auth, no API key. The fetch is proxied through Rust (`fetch_adsb_aircraft` in `src-tauri/src/lib.rs`) — not for CORS reasons but to keep one place to set the User-Agent and to match the AIS pattern.

## Architecture

| Layer | File | Responsibility |
|-------|------|----------------|
| Rust command | `src-tauri/src/lib.rs::fetch_adsb_aircraft` | GET against airplanes.live, return parsed JSON, clamp radius. |
| Pinia store | `src/stores/adsb.js` | Persisted config (`enabled` / `visible` / `headingArrows` under store key `adsbConfig`), runtime state (`aircraft` Map, `lastFetch`, `fetchError`, `loading`), GeoJSON `aircraftCollection`, synthetic `breadcrumbCollection`, panel list management. |
| Composable | `src/composables/useMapAdsb.js` | Layers + sources + click/hover handlers, viewport-driven `(lat, lon, radius_nm)` derivation, 10 s poll, source-data watchers. |
| Config panel | `src/components/AdsbPanel.vue` | Three toggles (Active / Visible / Heading arrows) + status. No feed URL or API key fields — the endpoint is fixed. |
| Detail panel | `src/components/AdsbTrackPanel.vue` | Per-aircraft draggable panel: hex / flight / registration / type / squawk / coord / altitude / GS / track / heading / vertical rate / seen-ago. |
| Toolbar entry | `src/components/MapToolbar.vue` | `mdi-airplane` button next to the AIS `mdi-ferry` in the Feeds group; narrow layout adds the entry to the Feeds dropdown. |
| MapView wiring | `src/views/MapView.vue` | `useAdsbStore`, `useMapAdsb`, `adsbPanelOpen`, `toggleAdsbPanel`, `await adsbStore.load()`, `initAdsbLayers()`, panel rendering. |
| Assistant tools | `src/services/assistant/tools/adsb.js` | Six tools — see below. |

## Aircraft record shape

The store stores raw airplanes.live records, keyed by `hex`. Used fields: `hex`, `flight` (callsign), `lat`, `lon`, `alt_baro` (number ft or string `"ground"`), `gs` (kts), `track` (°), `r` (registration), `t` (type), `squawk`, `true_heading` / `mag_heading`, `baro_rate` / `geom_rate` (ft/min), `seen` (s).

`AdsbTrackPanel` renders altitudes ≥ 18,000 ft as flight levels (`FL250`), below as plain feet, and `"ground"` as `Ground`.

## Layers

Cyan (`#4dd0e1`) throughout — distinct from AIS yellow.

- `adsb-breadcrumbs` source + `adsb-breadcrumbs-line` line layer — synthetic backward projection along reverse `track`, length = `gs * trackBreadcrumbLength` (shared with CoT and AIS via `settingsStore.trackBreadcrumbs` / `trackBreadcrumbLength`). Suppressed below 5 kts ground speed.
- `adsb-aircraft` source feeding two mutually exclusive icon layers:
  - `adsb-aircraft-points` — circle, shown when `headingArrows = false`.
  - `adsb-aircraft-arrows` — symbol with `icon-rotate: ['get', 'track']`, shown when `headingArrows = true`.
- `adsb-aircraft-labels` — flight callsign, gated by `settingsStore.showFeatureLabels`.

## Assistant tools

| Tool | R/W | Purpose |
|------|-----|---------|
| `adsb_get_status` | r | Report enabled / visible / headingArrows / aircraftCount. |
| `adsb_list_aircraft` | r | List all aircraft with optional callsign-or-hex substring filter and limit. |
| `adsb_aircraft_near` | r | Aircraft within radius of a feature or coordinate, sorted nearest-first. |
| `adsb_set_enabled` | w | Turn the feed on/off. |
| `adsb_set_visible` | w | Show/hide on map (data still fetches when hidden). |
| `adsb_set_heading_arrows` | w | Toggle between circles and arrows. |

The `summariseAircraft` shape returned by the read tools: `{ hex, callsign, registration, type, coordinate, altitudeFt, onGround, speedKnots, trackDeg, headingDeg, squawk }`.

## Why mirror AIS instead of unifying

The two feeds have different ontologies (vessels with MMSI/COG/SOG vs aircraft with hex/track/gs/altitude), different icon styles (color, shape, label format), different rate-limit profiles, and their detail panels surface different fields. A shared abstraction would either flatten useful domain detail or grow a leaky union type. Each feed owns its own store / composable / panel trio and shares the breadcrumb-trail setting and the dispatcher entry-resolution layer.
