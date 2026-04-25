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
      'Track cards now show m/s alongside the unit-formatted speed (e.g. "24.3 kts (12.5 m/s)").',
      'Releases tab on the Settings page (sidebar) showing per-version notes.',
      'First-launch-after-update overlay listing every entry newer than what the user last dismissed.'
    ],
    changed: [
      'Track-card speed display (CoT and manual track panels) now honors the Distance Units setting; the manual-track inline edit input adapts placeholder + parsing to the current unit.'
    ],
    fixed: [
      'Bloodhound: turning the tool off via the toolbar button now drops the crosshair cursor and exits selection mode, matching the panel\'s close button.'
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
