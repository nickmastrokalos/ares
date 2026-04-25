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
      'Assistant panel: new help button (?) in the header opens a popover of example prompts grouped by category — Routes, Drawing, Queries — focused on the more complex flows (water-only, via, multi-side via, AIS avoidance, stacked constraints). Click an example to insert its template into the input with placeholders to fill in.',
      'Track cards now show m/s alongside the unit-formatted speed (e.g. "24.3 kts (12.5 m/s)").',
      'Releases tab on the Settings page (sidebar) showing per-version notes.',
      'First-launch-after-update overlay listing every entry newer than what the user last dismissed.',
      'Assistant can now plan water-only routes that avoid land. New tools: `route_check_land_crossing` (read) tests an existing route against bundled coastlines, and `map_draw_route_water_only` (write) plans and draws a route from start to end with detours around land. Backed by Natural Earth 10m coastlines — reliable at ocean / large-bay scale; the tool description warns the user when the route is short enough for the dataset to be too coarse.',
      'Assistant can now plan routes that avoid user-drawn keepout shapes. New tool `map_draw_route_avoiding_features` takes a list of feature ids (polygon, box, circle, ellipse, or sector) plus an optional `buffer_meters` standoff and draws a route that detours around them. Same A* + bitmap planner as water-routing. An `avoid_land: true` flag stacks the bundled coastline data as an additional obstacle, so requests like "create a route that avoids Polygon 1 AND stays over water" can be satisfied in a single call instead of needing to combine two tools. Same tool now also accepts `via_feature_ids` for "route from X to Y through Polygon 1" requests — each via shape contributes an intermediate waypoint at its center and legs are planned independently with the same avoidance constraints. New `avoid_ais: true` flag projects every AIS vessel forward along its current course/speed (default 30 min, ±1 nm — overridable via `ais_horizon_minutes` / `ais_standoff_meters`) and uses each swept corridor as an additional obstacle, so "route avoiding AIS tracks" actually routes around vessel projections instead of cutting through them.'
    ],
    changed: [
      'Track-card speed display (CoT and manual track panels) now honors the Distance Units setting; the manual-track inline edit input adapts placeholder + parsing to the current unit.',
      'Assistant input field is taller by default (two rows) and has a bit more padding so prompts feel less cramped.',
      'Assistant confirm card: action buttons relabeled (Confirm → Execute) and colored — red for Cancel, green for Execute — to make commit/abort decisions read at a glance.',
      'New mission features (polygon, box, circle, ellipse, sector, line, route, point, image) now get a default name in the form `<type>-<4hex>` (e.g. `polygon-a3f9`, `route-7c2e`) instead of the old `Polygon 1` / `Route 1` numbering. Applies to both manual-draw and assistant-created features. The agent draw-tool descriptions now instruct the LLM to OMIT the `name` field unless the user explicitly named the feature, so context-derived names like `Circle at 40R EP 13166 05853` should not recur. Same guidance applies to per-waypoint `label` on `map_draw_route` — descriptive labels like "South entry" / "Turning point" should no longer appear; waypoints get the default `SP / WP 1 / WP 2 / … / EP` unless the user explicitly named one. Manual tracks keep their affiliation-prefixed callsigns (`FRND-1`, `HSTL-2`, …) since those carry tactical meaning.'
    ],
    fixed: [
      'Map toolbar tools are now mutually exclusive. Picking any toolbar tool (route builder, measure, draw, manual-track placement, bloodhound, perimeter, bullseye, annotations) automatically disarms whatever was previously active and closes its panel. Previously you could leave route-building armed, click another tool, and end up dropping route waypoints while a different panel was open — that won\'t happen any more. Passive panels (track list, AIS, ghost, settings, IO, layers, listeners) still coexist freely.',
      'Route planner (water + feature-avoidance) no longer outputs hundreds of stair-step waypoints on long routes. The 1 km per-leg smoothing cap interacted badly with the cell size: when the bbox is large (~100 km), each cell is ~500 m, so the cap stopped the smoother from merging more than ~2 cells per leg. The cap is removed; the buffered bitmap line-of-sight test is the actual safety mechanism and is sufficient on its own.',
      'Water-only routing: planner now stays a buffer offshore from the simplified coastline (Natural Earth 10m generalizes by ~250-500 m, so a buffer of ~555 m absorbs that error). Long across-the-peninsula clipping shouldn\'t recur; very narrow channels may now be refused — that\'s the trade-off.',
      'Water-only routing no longer freezes the UI when the route bbox covers a continent-sized polygon. The planner now rasterizes the land polygons into a bitmap once (scanline rasterization with edge-bucket pre-filter) and runs A* + smoothing on the bitmap, replacing what used to be hundreds of thousands of `pointInPolygon` calls per request.',
      'Bloodhound, perimeter, bullseye, and annotations: turning the tool off via the toolbar button now drops the crosshair cursor and exits selection mode, matching the panel\'s close button.',
      'Bloodhounds and perimeters now auto-remove when their CoT track or AIS vessel anchor is removed or pruned, instead of freezing at the last-known position. Hiding a track via the track-list eye icon still keeps the bloodhound/perimeter alive — visibility is separate from deletion.',
      'Route waypoint append now keeps the crosshair cursor while the mouse moves over other map features (AIS vessels, draw shapes, etc.) instead of reverting to a pointer.',
      'Per-perimeter radius input no longer clobbers the typed value when the underlying track moves. Type any integer and commit on blur or Enter.'
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
