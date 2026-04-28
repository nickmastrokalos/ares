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
      'Plugin panels: `registerPanel({ width })` pins panel width across collapse/expand; `registerPanel({ iconSvg })` and `registerToolbarButton({ iconSvg })` accept inline SVG so plugins aren\'t locked to MDI icons. Panel headers now carry a chevron toggle that hides the body without unmounting plugin DOM.',
      'Plugin host: `api.units` + `api.format` mirror the host\'s display preferences (distance units, coordinate format). `api.format.distance / speed / coordinate` reuse the same services the host uses internally; `api.units.onChange(handler)` fires immediately on a settings flip.',
      'Plugin loader: enabling a plugin now re-reads its bundle from disk. Devs can `pnpm build` then toggle the plugin off → on to pick up changes without a full Ares restart.',
      'Plugin host: `api.routing.registerAvoidance` and `api.routing.registerEvaluator` let plugins contribute environmental obstacle polygons and point-samplers to the route planner. The illumination plugin registers a `cloud-cover` contributor and the sea-state plugin registers `waves` + `currents`; the host registers a built-in `tracks` avoidance for friendly surface CoT tracks. The assistant discovers them via `routing_list_avoidances` / `routing_list_evaluators`.',
      'Route tool: `map_draw_route_avoiding_features` now accepts `avoid_extras` (plugin-contributed environmental constraints), `depart_at_iso`, and `speed_kts`. When `speed_kts` is provided the planner attaches per-vertex ETAs; the new `route_evaluate_along` tool walks an existing route\'s waypoints and calls a registered evaluator at each one, anchored to that waypoint\'s ETA.',
      'Plugin host: optional `provides` field on the plugin manifest declares the tools / avoidances / evaluators a plugin would register when active. New `plugin_capabilities_list` assistant tool surfaces both enabled and disabled capabilities so the model can suggest "enable plugin X to unlock that" instead of refusing silently. `routing_list_avoidances` / `routing_list_evaluators` likewise grow `{ enabled, disabled }` shapes; the route tool\'s unknown-id error names the plugin to enable.'
    ],
    fixed: [
      'CoT tracks from peers with skewed clocks (radios without GPS lock, PCAP replays) used to disappear within 30 s of arriving because their `stale` field was already in the past. Stale handling now anchors the peer\'s intended freshness window (`stale − time`) to local receive time when skew exceeds 5 minutes.',
      'Plugin panels are now capped to the viewport height with a scrollable body — a panel that lists many items no longer runs off the bottom of the screen.',
      'Plugin connections honour their lifecycle correctly — registering a kind sets the row enabled and starts the socket; disabling the plugin flips the row off and stops the socket. Address / port / protocol edits still persist across reloads.'
    ]
  },
  {
    version: '1.1.6',
    date: '2026-04-27',
    added: [
      'Plugin host: `api.connections.registerKind` lets plugins declare their own UDP connections. Rows show up in Settings → Connections owned by the plugin; the host runs the socket and forwards bytes to the plugin\'s `onPacket`.',
      'Plugin host: `api.cot.emit(event)` injects a parsed CoT event into the host\'s `cot-event` pipeline, so plugins ingesting CoT from non-host sources (TAK Server, gateways, replays) reach all the existing track / chat stores.',
      'Plugin host: `api.cot.parse(bytes)` runs the host\'s CoT parser (XML + TAK Protocol v1) on raw bytes, returning a `null` result when the bytes aren\'t CoT. Plugins owning a raw CoT socket pair this with `cot.emit` to forward only their own socket\'s traffic into the host pipeline.'
    ],
    changed: [
      'Connections panel reworked: rows now show an Owner badge (Ares / Plugin name / User), edit affordances respect ownership (only ad-hoc rows are renamable / deletable), and the "Add" button is now "Add CoT Listener" with a clarifying note. Underlying store renamed from `cotListeners` to `connections` with one-shot migration on first launch.'
    ]
  },
  {
    version: '1.1.5',
    date: '2026-04-27',
    added: [
      'TAK Protocol v1 (binary protobuf) on UDP mesh — bidirectional. Inbound + outbound interop with WinTAK and current ATAK peers; presence + GeoChat (group and direct) flow both ways.',
      'Settings → Network gains team color + role pickers — 14 standard TAK colors with swatch chips, 8 standard roles. Updates broadcast immediately.'
    ],
    changed: [
      '`Active` toggle for TAK comms is per-session — off on every app start; operator opts in explicitly.',
      'Outbound multicast: TTL bumped 1 → 64 and sent on every non-loopback IPv4 interface, so peers across routed subnets actually receive Ares.',
      'Presence announces dual-publish to SA + chat-announce groups, advertise a real `<contact endpoint>` (LAN IP + chat port), and use `how="h-e"` for manually-set locations — peers list Ares as a fully addressable contact instead of stale / unreachable.'
    ],
    fixed: [
      'Track list no longer ingests chat events as Null-Island ghosts (now filters non-`a-*` CoT types).',
      'Settings → Network: TAK toggle row no longer crowds against its description; dialog reopens automatically after picking self-location on the map; dialog widened to 640.',
      'Chat panel unread-count badge renders as a proper circle / pill instead of a narrow sliver.',
      'MapView drag-drop teardown registers synchronously — the `onUnmounted is called when there is no active component instance` warning is gone.'
    ]
  },
  {
    version: '1.1.4',
    date: '2026-04-26',
    added: [
      'Plugins can place layers in the map stack via `api.map.addLayer({ ..., beforeId })`; `\'@bottom\'` is a sentinel for "just above the basemap, below all host content".',
      'Plugin install: drop a packaged `.zip` directly into the plugins folder. The host extracts it on next launch and renames the source to `*.zip.installed`. Updating is one drop-in too.',
      'Plugin install (drag-drop): drag a packaged `.zip` from Finder / Explorer onto the Ares map window. A "Drop to install plugin" overlay appears; release to install — the zip is copied, extracted, and the new plugin shows up in Settings → Plugins without a restart.'
    ],
    fixed: [
      'Assistant: `map_find_entity` now matches manual-track names whether the user-typed identifier lives in `props.name` or `props.callsign` (previously only the first field was searched, so renamed manual tracks could appear "missing" to the assistant).'
    ]
  },
  {
    version: '1.1.3',
    date: '2026-04-26',
    added: [
      'Plugins can register custom sprite icons (`api.map.addImage`) for fully offline-friendly map symbology.',
      'Plugins can expose tools to the AI assistant (`api.tools.register`); auto-prefixed names, same confirm-card flow as built-in tools.'
    ]
  },
  {
    version: '1.1.2',
    date: '2026-04-26',
    added: [
      'Plugin host API extension. Plugins can now: register their own MapLibre layers (`api.map.addLayer({ id, source, layer })`) without going through the features store; read the current viewport state (`api.map.getState()`) and subscribe to viewport-change events (`api.map.onMove`, `api.map.onZoom`); host their own draggable floating panels with a vanilla DOM body (`api.registerPanel({ id, title, mount(containerEl) })`); and persist plugin-scoped settings (`api.settings.get / set / delete / keys`) namespaced under `plugin:<id>:` so plugins can\'t collide with each other or with host settings. All registrations auto-clean on disable: layers + sources are removed, event listeners are detached, panels close. Settings persist across disable/enable. Plugin panels mount once and stay alive across close/reopen via `v-show` so internal state is preserved without authors having to externalize it. The `examples/plugins/hello-world` reference plugin is updated to exercise every new surface.',
      'Plugin host-version compatibility check. Plugin manifests can now declare `minHostVersion: \'X.Y.Z\'`; Ares refuses to activate any plugin whose minimum is newer than the running host, surfaces the reason in Settings → Plugins, and disables the enable toggle for that row. Replaces the prior failure mode where an outdated host would load a newer plugin and only crash the moment the plugin touched a missing API.',
      'Self-identity in TAK comms now carries a 2525 type and a manual location, not just a callsign. Settings → Network gains a `Type` picker (same flow as manual tracks — affiliation + 2525 type) and `Location` inputs (lat / lon, plus a "Use map center" shortcut). The presence announce broadcast picks up both, so peer TAK clients now see the operator on their map at the configured position with the configured 2525 symbol instead of a generic placeholder at lat/lon (0, 0). Clearing the type reverts to the v1 placeholder; clearing the location reverts to (0, 0) presence-only mode.'
    ],
    changed: [
      'Settings → Network → Callsign input now commits on blur or Enter instead of per-keystroke. Previously each character was being persisted to `tauri-plugin-store` and the next 60-second announce cycle would broadcast the partial string — peers briefly saw "d", "dr", "dra" on the way to "dragon".',
      'TAK comms outbound (presence announce + GeoChat send) is now gated by an explicit `Active` toggle. Default is off — Ares does not emit anything until the operator flips Active on, either via the new pill in the chat panel header or the switch at the top of Settings → Network. Inbound listeners stay running regardless so peers\' broadcasts still populate the track list. Activating fires an immediate one-shot announce so the operator appears in peer contact lists within ~1 s.'
    ],
    fixed: [
      'Operator\'s own GeoChat presence announce no longer renders as a phantom track at the broadcast position carrying the local callsign — the track store now drops events whose `uid` matches `selfUid`, mirroring the chat store\'s existing self-echo filter.'
    ]
  },
  {
    version: '1.1.1',
    date: '2026-04-26',
    added: [
      'TAK GeoChat interop — new `mdi-chat-outline` toolbar button opens a `ChatPanel` with a "Pick a callsign" setup splash on first use, then an "All Chat Rooms" group thread and direct-message threads keyed per peer UID. While chat is active, Ares broadcasts a presence announce (`a-f-G-U-C`) on the `tak-chat-announce` connection every 60 seconds so peers populate their contacts list with our callsign + UID without waiting for a first message. Wire-compatible with WinTAK / iTAK / ATAK: outbound goes through a new `send_cot` Tauri command (UDP unicast or multicast, multicast TTL 1) writing the standard `b-t-f` chat-on-CoT XML; inbound rides the existing `cot-event` channel — the Rust parser was extended to surface `<__chat>`, `<chatgrp>`, `<link>`, and `<remarks>` fields. Self identity (callsign + auto-generated UID) lives in Settings → Network. Three protected CoT listeners — GeoChat Messages (`224.10.10.1:17012`), GeoChat Announce (`224.10.10.1:18740`), and SA Multicast (`239.2.3.1:6969`) — are seeded automatically on first run; they can be retargeted or disabled but not deleted (the chat outbound destination is derived from the GeoChat Messages listener, so there\'s a single source of truth for each TAK group). v1 is intentionally LAN-scoped — TAK Server / SSL streaming, attachments, and read receipts are deferred. Chat history is in-memory.',
      'Map gets a vertical pitch slider in the top-right control stack, just below the compass / zoom buttons. Drag to set the camera pitch (0 – 85°), double-click the thumb to snap back to 0; the slider stays in sync if pitch changes via mouse drag or the compass. The built-in compass disc also now visualises pitch (`visualizePitch: true`) so it tilts as you tilt the map.',
      'ADS-B aircraft feed via airplanes.live — new toolbar button (`mdi-airplane`) next to AIS opens an `AdsbPanel` with three toggles (Active / Visible on map / Heading arrows). The endpoint is free and key-less so there is no feed URL or API key to configure. Aircraft render in magenta (outside the MIL-STD-2525 affiliation palette) to stay visually distinct from CoT/manual symbology and AIS yellow; clicking one opens a draggable detail panel showing hex, flight, registration, type, altitude in feet, ground speed, track, heading, vertical rate, and squawk. Six assistant tools mirror the AIS set: `adsb_get_status`, `adsb_list_aircraft`, `adsb_aircraft_near`, `adsb_set_enabled`, `adsb_set_visible`, `adsb_set_heading_arrows`. Polled every 10 s with a viewport-derived radius capped at 250 nm; breadcrumbs share the global `Track breadcrumbs` setting.'
    ],
    changed: [
      'Breadcrumb-length setting is now a fixed map distance (meters) instead of a time window (seconds). Same value applies to every track type — CoT, AIS, ADS-B — so a slow vessel and a fast jet draw tails of identical visual length. Slider range 100 m – 5 km, default 1 km. CoT trails truncate accumulated history to the target distance (with proportional truncation of the last segment); AIS / ADS-B project that fixed length backward along COG / track. Old persisted values (≤60, the prior seconds maximum) are migrated to the new default on load.',
      'AIS and ADS-B breadcrumbs now have their own toggles — separate from the global CoT `Track breadcrumbs` setting. The AIS panel and ADS-B panel each gain a `Heading breadcrumbs` switch; the trail length is fixed (~500 m for AIS, ~1.5 km for ADS-B) and not user-adjustable. The Settings → Tracks toggle now reads `CoT track breadcrumbs` and only governs CoT history trails. New assistant tools `ais_set_breadcrumbs` and `adsb_set_breadcrumbs` mirror the new switches.',
      'ADS-B aircraft on the airplanes.live military database now render with a distinct white halo (arrow icon) or a thicker white stroke + larger radius (circle icon) so they stand out from civilian traffic without changing the magenta feed color. The `military` flag is decoded from bit 0 of the airplanes.live `dbFlags` field and surfaced everywhere: the `AdsbTrackPanel` adds a `CLASS` row (Military / Civilian), and `adsb_list_aircraft` gains a `military_only: true` filter. Returned tool shapes include a `military` boolean.',
      'CoT and manual-track icons now tilt with the map plane when the camera is pitched, matching the AIS / ADS-B perspective. Affiliation circles flatten into ovals and 2525 symbols flatten into trapezoids when the map is tilted; labels stay upright and readable. Yaw alignment is unchanged so 2525 symbol orientation is preserved when the operator rotates the map.',
      'The CoT-listener panel is now called **Connections** (toolbar tooltip + dialog title), reflecting that one of the seeded entries also handles outbound chat. The `tak-chat-messages` row carries a small `mdi-swap-vertical-variant` glyph to mark it as bidirectional. Internal store keys, Rust commands, and `cot_*` agent tool names are unchanged.'
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
