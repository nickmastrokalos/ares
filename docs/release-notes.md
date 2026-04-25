# Release notes

The app ships its release history with the bundle and surfaces it in two places:

1. **Settings page → Releases tab** (sidebar Settings, `src/views/SettingsView.vue`) — the full history, always available.
2. **Post-update overlay** — shown automatically on the first launch after a version bump, listing every entry newer than the version the user last dismissed.

## Source of truth

`src/data/releaseNotes.js` exports `RELEASES`: an ordered array (newest first) of structured entries. Schema:

```js
{
  version: '1.0.6',     // matches package.json (or the literal 'unreleased' for the WIP entry)
  date:    '2026-04-25', // ISO YYYY-MM-DD; omitted on the unreleased entry
  added:   ['…'],        // optional
  changed: ['…'],        // optional
  fixed:   ['…']         // optional
}
```

Empty arrays may be omitted. One line per change, user-facing impact only — implementation details belong in commit messages.

## Workflow

The list grows incrementally — not in a single sitting at bump time.

### As user-visible changes land

The top of `RELEASES` carries an `unreleased` entry (no `date`) that accumulates one-liners as features merge:

```js
{
  version: 'unreleased',
  added:   ['…'],
  changed: ['…'],
  fixed:   ['…']
}
```

Append to it whenever a change a user would notice ships — new feature, behavior/UX change, bug fix. **Skip** refactors, internal cleanups, doc-only edits, and dep bumps. If the `unreleased` entry doesn't exist, create one.

`ReleaseNotesList.vue` filters out `version === 'unreleased'`, so the WIP list never appears in the Settings tab or the post-update overlay.

### At version bump

When bumping the app version (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`):

1. In `src/data/releaseNotes.js`, rename `version: 'unreleased'` → `'X.Y.Z'` and add `date: 'YYYY-MM-DD'`.
2. Commit alongside the version bump.

That's it. The Settings tab and the post-update overlay render directly from this file.

## Detection of "first launch after update"

Implemented in `src/App.vue` `onMounted`:

- The current version is imported from `package.json` at build time.
- `settingsStore.lastSeenVersion` is the persisted record of the last version the user dismissed the overlay for.
  - `null` → fresh install. The current version is recorded silently; no overlay shown.
  - Strictly less than the current version → the overlay opens with `sinceVersion = lastSeenVersion`. On dismiss, `lastSeenVersion` is updated to the current version.
  - Equal or greater → nothing happens.

Version comparison is `compareSemver()` from `src/services/version.js` — a tiny X.Y.Z helper, no new dependency.

## Components

- **`ReleaseNotesList.vue`** — pure renderer. Optional `sinceVersion` prop filters to entries strictly greater than the given version. Used by both the Settings page tab (no filter) and the overlay (filtered).
- **`ReleaseNotesDialog.vue`** — `v-dialog` wrapper around `ReleaseNotesList` with a "What's new" header and a "Got it" dismiss button. Mounted once at the app root in `App.vue`.

## Settings store

`lastSeenVersion` is added to `settingsStore` (`src/stores/settings.js`) following the standard pattern: default in `DEFAULTS`, ref, `refs` map entry, and exported. Default is `null` so the store can distinguish "never seen" from "seen v1.0.0".
