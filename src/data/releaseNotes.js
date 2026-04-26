// Single source of truth for in-app release notes.
//
// Authoring: when bumping the app version, prepend a new entry to RELEASES
// covering anything user-visible since the previous version. Keep entries
// concise — one line per change, plain language, user-facing impact only.
//
// Schema:
//   version  — the semver string matching package.json
//   date     — ISO date (YYYY-MM-DD) of the release
//   added    — new features
//   changed  — behavior/UX changes to existing features
//   fixed    — bug fixes
//
// Empty arrays may be omitted. The Settings tab and the post-update overlay
// both render directly from this list.

export const RELEASES = [
  {
    // WIP entry — accumulates user-visible changes between version bumps and
    // is hidden from the UI by ReleaseNotesList.vue. At bump time, rename
    // `version` to the new semver and add a `date`. See docs/release-notes.md.
    version: 'unreleased',
    added: [
      'ADS-B aircraft feed via airplanes.live — new toolbar button (`mdi-airplane`) next to AIS opens an `AdsbPanel` with three toggles (Active / Visible on map / Heading arrows). The endpoint is free and key-less so there is no feed URL or API key to configure. Aircraft render in magenta (outside the MIL-STD-2525 affiliation palette) to stay visually distinct from CoT/manual symbology and AIS yellow; clicking one opens a draggable detail panel showing hex, flight, registration, type, altitude in feet, ground speed, track, heading, vertical rate, and squawk. Six assistant tools mirror the AIS set: `adsb_get_status`, `adsb_list_aircraft`, `adsb_aircraft_near`, `adsb_set_enabled`, `adsb_set_visible`, `adsb_set_heading_arrows`. Polled every 10 s with a viewport-derived radius capped at 250 nm; breadcrumbs share the global `Track breadcrumbs` setting.'
    ],
    changed: [
      'Breadcrumb-length setting is now a fixed map distance (meters) instead of a time window (seconds). Same value applies to every track type — CoT, AIS, ADS-B — so a slow vessel and a fast jet draw tails of identical visual length. Slider range 100 m – 5 km, default 1 km. CoT trails truncate accumulated history to the target distance (with proportional truncation of the last segment); AIS / ADS-B project that fixed length backward along COG / track. Old persisted values (≤60, the prior seconds maximum) are migrated to the new default on load.',
      'AIS and ADS-B breadcrumbs now have their own toggles — separate from the global CoT `Track breadcrumbs` setting. The AIS panel and ADS-B panel each gain a `Heading breadcrumbs` switch; the trail length is fixed (~500 m for AIS, ~1.5 km for ADS-B) and not user-adjustable. The Settings → Tracks toggle now reads `CoT track breadcrumbs` and only governs CoT history trails. New assistant tools `ais_set_breadcrumbs` and `adsb_set_breadcrumbs` mirror the new switches.',
      'ADS-B aircraft on the airplanes.live military database now render with a distinct white halo (arrow icon) or a thicker white stroke + larger radius (circle icon) so they stand out from civilian traffic without changing the magenta feed color. The `military` flag is decoded from bit 0 of the airplanes.live `dbFlags` field and surfaced everywhere: the `AdsbTrackPanel` adds a `CLASS` row (Military / Civilian), and `adsb_list_aircraft` gains a `military_only: true` filter. Returned tool shapes include a `military` boolean.',
      'CoT and manual-track icons now tilt with the map plane when the camera is pitched, matching the AIS / ADS-B perspective. Affiliation circles flatten into ovals and 2525 symbols flatten into trapezoids when the map is tilted; labels stay upright and readable. Yaw alignment is unchanged so 2525 symbol orientation is preserved when the operator rotates the map.'
    ],
    fixed: [
      'Offline tile-server responses now include CORS headers on every path (empty-tile 204s, unknown-name 404s, `/tilesets` JSON), not just the success branch — eliminates the dev-console error spam when an MBTiles basemap is selected and the viewport requests tiles outside the file\'s covered area.'
    ]
  },
  {
    version: '1.1.0',
    date: '2026-04-25',
    added: [
      'Drag-to-move existing waypoints on a selected route, with live map and panel updates.',
      'Assistant tools to list, add, remove, and enable/disable CoT listeners.',
      'Assistant tool to snapshot the map (PNG) directly to the Desktop.',
      'Assistant tool to record a 1–60 s video clip of the map to the Desktop.',
      'Toolbar video-clip button with a 5 / 10 / 30 / 60 s duration menu and red recording state.',
      'Help button in the assistant panel with grouped example prompts.',
      'Track cards show speed in m/s alongside the unit-formatted value.',
      'Releases tab in Settings showing per-version notes.',
      'First-launch-after-update overlay listing new entries.',
      'Assistant can plan water-only routes that detour around land.',
      'Assistant can plan routes with stacked constraints — avoid keepout shapes, route via shapes, avoid land, avoid AIS vessel projections.'
    ],
    changed: [
      'Track-card speed display honors the Distance Units setting (incl. manual-track edit input).',
      'Assistant input field is taller and a bit more padded.',
      'Assistant confirm card buttons relabeled and recolored: red Cancel, green Execute.',
      'AIS breadcrumbs share the global Track breadcrumbs toggle; the AIS "Heading tails" switch is now "Heading arrows" and only controls icon shape.',
      'Map snapshot default filename is now `ares_screen_capture_<stamp>.png`; agent accepts an optional filename.',
      'New features get a default name like `polygon-a3f9` / `route-7c2e` instead of `Polygon 1` / `Route 1`.'
    ],
    fixed: [
      'AIS route avoidance now keeps clear of every vessel from any approach angle, not just along its heading.',
      'Assistant draw / route / capture tools reject coordinate-shaped names and filenames so the auto-default is used.',
      'Map toolbar tools are mutually exclusive — picking one disarms the previously active tool.',
      'Long routes no longer produce hundreds of stair-step waypoints.',
      'Water-only routing now stays a small buffer offshore to absorb coastline-data error.',
      'Water-only routing no longer freezes the UI on continent-sized bboxes.',
      'Toggling bloodhound / perimeter / bullseye / annotations off now drops the crosshair and exits selection.',
      'Bloodhounds and perimeters auto-remove when their underlying track is removed or pruned.',
      'Route waypoint append keeps the crosshair cursor while hovering other map features.',
      'Per-perimeter radius input no longer clobbers the typed value when the track moves.'
    ]
  },
  {
    version: '1.0.5',
    date: '2026-04-25',
    added: [
      'Drag-to-rotate handle on box shapes.',
      'Paste-from-clipboard button on the coordinate input.',
      'Auto-numbered default names for new draw features.'
    ],
    changed: [
      'Bullseye, annotations, and manual tracks now use a two-step select-then-drag flow on the map.',
      'Perimeter breach halo enlarged to wrap MIL-STD-2525 icons cleanly.'
    ],
    fixed: [
      'Box rotation direction now matches compass convention.',
      'Bullseye cross offset corrected by replacing the native draggable marker.',
      'Drag-to-move on bullseye and annotations.'
    ]
  },
  {
    version: '1.0.4',
    date: '2026-03-29',
    added: [
      'In-app AI assistant: docked chat panel with per-route tool registry and OpenAI/Anthropic providers.',
      'Bullseye: tactical reference point with range rings and bearing calls.',
      'Annotations: per-mission sticky notes with assistant tools.',
      'Perimeter: standoff rings with breach alerts around tracks.',
      'Intercept: AIS support, CPA fallback, and persistent map geometry.',
      'Bloodhound live-tracking range lines.',
      'Map snapshot: PNG export of the current view with a legend strip.',
      'Sidebar Settings page (assistant config moved here).'
    ],
    changed: [
      'Default track affiliation is now Friendly; the "Generic" affiliation has been removed.',
      'Perimeter ring softened: thinner width, subtle opacity, and blur.'
    ]
  },
  {
    version: '1.0.3',
    date: '2026-03-08',
    added: [
      'Manual track types with a curated MIL-STD-2525 picker.',
      'Track list filters.',
      'MIL-STD-2525 symbology toggle for tracks.'
    ]
  },
  {
    version: '1.0.2',
    date: '2026-02-15',
    added: [
      'Per-route color support with rendering and live preview.',
      'Fine-tune color picker with hex input on the attributes panel.'
    ],
    changed: [
      'Color picker stays open after a swatch click for faster iteration.',
      'Expanded color swatches: 14 swatches in 7 columns.'
    ]
  },
  {
    version: '1.0.1',
    date: '2026-02-02',
    added: [
      'Ellipse shape.',
      'CoT import/export overhaul.',
      'Route support.',
      'Box rotation.'
    ],
    fixed: [
      'UDP listener now receives multicast CoT packets.',
      'Polygon preview line no longer missing after the first click.'
    ]
  },
  {
    version: '1.0.0',
    date: '2026-01-22',
    added: [
      'Initial release.',
      'Program/unit footer on the home page.'
    ]
  }
]
