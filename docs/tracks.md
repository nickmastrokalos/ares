# Tracks

> Source of truth for track data, rendering, and UI components.

## Overview

The app has two track systems that coexist on the map and in the track list:

| System | Source | Persistence | Owner |
|--------|--------|-------------|-------|
| **CoT-feed tracks** | Incoming CoT XML events | Ephemeral — cleared on unmount or after staleness | `useTracksStore` + `useMapTracks` |
| **Manual tracks** | User clicks on the map | Persistent — stored in the `features` SQLite table | `useMapManualTracks` + `useFeaturesStore` |

Both render to MapLibre via separate sources and layers. They share an affiliation palette and CoT type string conventions.

---

## Shared Foundations

### Affiliation

Four affiliations are recognized throughout the track system:

| Key | Label | Color |
|-----|-------|-------|
| `f` | Friendly | `#4a9ade` |
| `h` | Hostile | `#f44336` |
| `n` | Civilian | `#4caf50` |
| `u` | Unknown | `#ffeb3b` |

For CoT-feed tracks, affiliation is derived from `cotType[2]` at render time. For manual tracks, it is stored explicitly as `properties.affiliation`.

`AFFIL_CONFIG` in `src/composables/useMapManualTracks.js` is the canonical object — `{ label, color, prefix }` per key. The `prefix` drives auto-callsign generation (`FRND-1`, `HSTL-2`, etc.) when a manual track is placed.

### CoT type strings

Format: `a-{affiliation}-{dimension}-{function}` — for example `a-f-G-U-C-I` (friendly ground infantry).

Only atom-type (`a-…`) CoT events produce meaningful MIL-STD-2525 SIDCs. Non-atom types fall back to a generic unknown.

### `src/services/sidc.js`

Converts CoT types to MIL-STD-2525C SIDCs and renders them via the `milsymbol` library.

- `cotTypeToSidc(cotType)` — `a-f-G-U-C-I` → 15-char SIDC string (e.g. `SFGPUCI--------`).  
  SIDC layout: `S {AFFIL} {DIM} P {FUNCID:6} {MODS:5}`. Function segments after the dimension are joined and left-padded to 6 chars.
- `getOrCreateIcon(sidc)` — renders a symbol at size 20 / 2× pixel ratio and returns `{ image: { width, height, data } }` — the format MapLibre's `map.addImage()` expects. Results are cached in `iconCache`.
- `sidcToDataUrl(sidc)` — renders at 1× and returns a PNG base64 data URL (via `symbol.asCanvas(1).toDataURL()`), cached in `svgUrlCache`. Used by `TrackTypePicker` for picker preview icons — not for map rendering.
- `clearIconCache()` — clears both caches. Call on map teardown.

### MIL-STD-2525 symbology toggle

`settingsStore.milStdSymbology` (default `false`) is the single on/off switch. When enabled, typed manual tracks render as 2525 icons rather than colored circles. The toggle lives in the Display tab of the Settings dialog.

---

## CoT-Feed Tracks

### `useTracksStore` (`src/stores/tracks.js`)

Pinia store keyed by CoT `uid`. Each entry: `{ uid, cotType, lat, lon, hae, speed, course, callsign, time, stale, updatedAt }`.

- `trackCollection` computed — GeoJSON `FeatureCollection` of Point features with all track fields as properties plus `affiliation` derived from `cotType[2]` (`f`/`h`/`n`/`u`).
- `startListening()` — calls `listen('cot-event', ...)`, upserts tracks, starts stale pruning (30-second interval).
- `stopListening()` — unregisters the listener, stops pruning.
- `clearTracks()` — empties the Map.

Reactivity note: Vue's reactive system does not track internal `Map` mutations. The store reassigns `tracks.value = new Map(tracks.value)` after each update to trigger computed re-evaluation.

### `useMapTracks` (`src/composables/useMapTracks.js`)

- `initLayers()` — adds GeoJSON source `cot-tracks`, circle layer `cot-tracks-points`, and symbol layer `cot-tracks-labels`. Called from `MapView`'s `map.on('load', ...)` handler.
- Circle color is data-driven via a `match` expression on the `affiliation` property — same palette as manual tracks, but the two systems do not share a source or layer.
- Watches `tracksStore.trackCollection` and calls `setData` on the map source whenever it changes.
- Removes layers and source on `onUnmounted`.

---

## Manual Tracks

### Data model

A manual track is a `features` table row with `type = 'manual-track'` and `Point` geometry. The `properties` JSON object carries:

| Field | Required | Description |
|-------|----------|-------------|
| `callsign` | yes | Display name; auto-generated as `{PREFIX}-{N}` on placement |
| `affiliation` | yes | `f`/`h`/`n`/`u` |
| `cotType` | no | Full CoT type string (e.g. `a-f-G-U-C-I`). `null` = untyped track |
| `hae` | no | Altitude in meters |
| `course` | no | Heading 0–359° |
| `speed` | no | Speed in knots |

Manual tracks are not exported via CoT or KML (see `frontend.md` — Import / Export).

### Type catalog — `src/services/trackTypes.js`

`TRACK_TYPE_CATALOG` is the curated list of MIL-STD-2525 types surfaced in the picker UI. It is grouped by dimension:

| Dimension key | Label | Example entries |
|---------------|-------|-----------------|
| `ground` | Ground | Generic, Infantry, Armor, Artillery, Engineer, Recon, HQ, Support, Unmanned |
| `air` | Air | Generic, Fixed Wing, UAV, Helicopter, Atk Helo |
| `sea` | Sea | Surface, Combatant, Unmanned, Sub |
| `sof` | SOF | Generic |

Each entry is `{ label, suffix }`. The `suffix` is the tail of the CoT type — the picker prepends `a-{affiliation}-` to form the full `cotType` string (e.g. suffix `G-U-C-I` → `a-f-G-U-C-I` for a Friendly track).

`labelFromCotType(cotType)` is the reverse lookup — strips the `a-{affil}-` prefix, matches the remainder against catalog suffixes, and returns the human label (or `null`). Used by `ManualTrackPanel` for the TYPE row display.

**Why curated?** The full MIL-STD-2525 tree has thousands of codes. The catalog surfaces the ~20 entries that map cleanly to user intent. All additions go here — nowhere else.

**SIDC validation pitfall.** A suffix must produce a SIDC that `milsymbol` actually ships. An unrecognized SIDC renders as a pink circle with a question mark. Smoke-test any new catalog entry by placing a typed track and checking the icon. Example of a past breakage: suffix `S-X-C` produced `SFSPXC---------` which is not defined in milsymbol's sea symbol set — corrected to `S-C`.

### Components

#### `TrackTypePicker.vue` — reusable

Used in both the placement flow and the edit panel.

- **Props:** `affiliation` (colors the preview icons), `modelValue` (current `cotType` string or null), `disabled`.
- **Emits:** `update:modelValue` with the full `cotType` string.
- UI: category tabs (Ground / Air / Sea / SOF) over a 3-column icon grid. Icons are rendered via `sidcToDataUrl(cotTypeToSidc(cotType(suffix)))`.

#### `TrackDropPanel.vue` — placement flow

Opened from the manual-track toolbar button. Two-step flow:

1. User clicks an affiliation row — local state only, no placement begins.
2. User clicks a type in the picker → emits `set-placing({ affiliation, cotType })` → cursor becomes crosshair.

A map click drops the track at that point. The panel stays in placing mode after each drop so users can place tracks in rapid succession. Escape cancels. Switching affiliation cancels any in-flight placement and clears the selected type.

The type picker is always visible (disabled until affiliation is chosen) so a type is already set if the user later enables MIL-STD-2525 symbology.

#### `ManualTrackPanel.vue` — edit panel

Floating draggable panel opened on track click. Multiple panels can be open simultaneously — `openPanelIds` (a `Set`) in `useMapManualTracks` tracks which ids are open.

Sections:

- **Identity** — callsign (inline rename), affiliation dot + label, TYPE row with inline `TrackTypePicker` that expands on click.
- **Position** — coordinate formatted via `coordinateFormat` setting.
- **Attributes** — altitude (m), heading (°, with compass rose label), speed (kts). All three are inline-editable.

Writes go through `featuresStore.updateFeature()`. Delete removes the feature and closes the panel.

#### `TrackListPanel.vue` — unified list

Floating draggable panel showing tracks from **both** systems in one list.

- **Sort:** toggle in the header (A→Z / Z→A, default ascending). Applies to `callsign` via `localeCompare`.
- **Filters:**
  - Type pills — All / COT / MAN. Switches between feed tracks, manual tracks, or both.
  - Callsign search — case-insensitive substring match on `callsign`. Updates live as you type.
  - Affiliation toggles — click a colored dot to include/exclude that affiliation. All active by default.
- **Per-row actions:** center map on track (`flyToGeometry`), open detail panel (`openManualTrackPanel` or `tracksStore.openPanel`), remove/dismiss.
- Header count shows `{visible} / {total}` when any filter is active, plain total otherwise.

### Rendering pipeline — `useMapManualTracks.js`

`manualTrackCollection` computed — GeoJSON `FeatureCollection` from `featuresStore.features`. Each feature's properties include `callsign`, `affiliation`, `cotType` (nullable), and a computed `sidc` (empty string when `cotType` is null).

Three MapLibre layers on a single `manual-tracks` GeoJSON source:

| Layer id | Type | Purpose |
|----------|------|---------|
| `manual-tracks-points` | circle | Affiliation-colored dots |
| `manual-tracks-symbols` | symbol | MIL-STD-2525 icons (`icon-image: ['get', 'sidc']`) |
| `manual-tracks-labels` | symbol | Callsign text |

**Rendering mode is driven by `settingsStore.milStdSymbology`:**

- **Off (default):** circle layer has no filter — every track is a dot. Symbol layer is `visibility: 'none'`.
- **On:** circle layer filtered to `['==', ['get', 'sidc'], '']` — only untyped tracks render as dots. Symbol layer filtered to `['!=', ['get', 'sidc'], '']` and visible — typed tracks render as 2525 icons.

The label `text-offset` shifts from `[0, 1.5]` (circle) to `[0, 2.5]` (2525 on) so text clears the taller symbol.

**Lazy icon registration.** `ensureMilStdIcons(map, features)` walks the feature collection and calls `map.addImage(sidc, image, { pixelRatio: 2 })` for any SIDC not already loaded. Runs from the data watcher (on collection change) and from the milStd-on toggle handler.

**Click dispatch.** If a `dispatcher` instance is provided (from `useClickDispatcher`), the composable registers with it for multi-layer click arbitration. Otherwise it falls back to direct `map.on('click', layer, …)` bindings on both the circle and symbol layers.

---

## Map provide/inject

`MapView` provides the following track-related helpers via Vue's `inject` API:

| Key | Shape | Source |
|-----|-------|--------|
| `openManualTrackPanel` | `(id: number) => void` | `useMapManualTracks().openPanel` |

---

## CoT Test Harness (`scripts/cot-sender.mjs`)

Node.js script (no external dependencies) that generates synthetic CoT traffic for development.

```sh
pnpm cot:send                        # 5 tracks, UDP, 127.0.0.1:4242, 3s interval
pnpm cot:send -- --tracks 10         # 10 tracks
pnpm cot:send -- --port 8087         # different port
pnpm cot:send -- --protocol tcp      # TCP instead of UDP
pnpm cot:send -- --interval 1000     # 1s interval
```

Each track has a stable `uid` (`ARES-TEST-N`), a NATO phonetic callsign, a CoT affiliation cycling through `f/h/n/u`, and a random-walk position starting near Washington DC. The script reconnects automatically on TCP disconnection.
