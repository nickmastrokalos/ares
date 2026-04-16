# Styles

> Source of truth for styling decisions and design system.

## Design Philosophy
- **Dark, modern, sleek.** The UI should feel like a professional tool, not a colorful consumer app.
- **Icons over text.** Prefer icon buttons over text buttons. Use tooltips for clarity when needed.
- **Monochrome by default.** The UI is predominantly grayscale. Color is reserved for meaning.
- **Minimal rounding.** Use `rounded="sm"` (slight rounding). No pill shapes or large radii.

## Color Usage
- **White/gray** — all standard UI elements, icons, text, borders.
- **Color is reserved for semantic meaning only:**
  - `success` (green) — confirmed, connected, healthy, complete
  - `error` (red) — failed, disconnected, critical
  - `warning` (amber) — attention needed, degraded
  - `info` (blue) — informational, neutral status
- Think of color as "LEDs" — small indicators of state, not decoration.

## Theme
- Configured in `src/plugins/vuetify.js` as the `aresDark` theme.
- Key surfaces:
  - `background: #0d0d0d` — app background
  - `surface: #161616` — cards, drawers, toolbars
  - `surface-light: #1e1e1e` — elevated or highlighted areas
  - `surface-variant: #252525` — dividers, subtle borders
- Text: `#e0e0e0` (on-surface), `#888888` (secondary/muted)
- Interactive accent: `primary: #4a9ade` — the single token for all active/interactive states (switch tracks, slider fills, tab indicators, focus rings, toolbar active buttons). Matches the map selection highlight color, reinforcing "blue = active" throughout the app.

## Icons
- Use Material Design Icons (`mdi-*`) via `@mdi/font`.
- Prefer **outline** variants (e.g., `mdi-cog-outline` not `mdi-cog`).
- Icons are white/light gray by default. Only apply color for status indicators.

## Components
- **Buttons:** Icon-only (`v-btn icon`), `variant="text"`, `size="small"`. Add `v-tooltip` for discoverability.
- **Cards:** Flat, `color="surface"`, `rounded="sm"`.
- **Inputs:** Outlined, compact density, `rounded="sm"`.
- **Lists:** Transparent background, slight rounding on items.
- **Toolbars:** Flat, compact, `color="surface"`.
- Vuetify component defaults are set in `src/plugins/vuetify.js` — do not override per-instance unless justified.

## Global Styles
- `src/assets/global.css` — scrollbar styling, overflow control, focus outline removal.
- Keep this file minimal. Vuetify's utility classes and theme handle nearly everything.
- Do not add component-specific CSS here.

## Rules
- No inline color values. Use theme tokens (`color="surface"`, `class="text-medium-emphasis"`).
- No custom CSS unless Vuetify cannot achieve the result.
- No bright or saturated colors in the default UI state.
- Scoped `<style>` blocks in components are acceptable for layout that utility classes can't cover.

## Map Features (exception to the monochrome rule)
Drawn features on the map are **data**, not chrome. The user picks the color and we render it as-is — this is the one place where saturated color is expected.

- Default feature color: `#ffffff` (white) — defined as `DEFAULT_FEATURE_COLOR` in `src/stores/features.js`. Features without an explicit color fall back to this.
- Features are rendered with a **solid 2px stroke** and, for fillable shapes (polygon / box / circle / ellipse / sector), a fill whose opacity is per-feature (defaults to 20% via `DEFAULT_FEATURE_OPACITY`). No glow, halo, or outline-on-outline treatment.
- Per-feature color and fill-opacity are stored on `properties.color` / `properties.opacity` and resolved in MapLibre paint expressions via `['coalesce', ['get', '<prop>'], <default>]`. The stroke stays fully opaque so the shape boundary remains visible at any fill opacity.
- Opacity is editable in `AttributesPanel` via a slider popover, only surfaced when the selected feature is fillable — lines and points never show the control.
- The selection highlight is a separate layer (`draw-features-selected`) rendered in the info blue (`#4a9ade`) on top of the feature. It never replaces the feature's own color.
- `AttributesPanel` color picker: a curated 12-swatch quick-select grid for common colors, plus a `v-color-picker` canvas (hex mode only, no alpha) for fine-tuning. Swatches commit immediately and close the popover; canvas/hex changes commit when the popover closes. Color is always stored as lowercase `#rrggbb`.

## Floating Panels
- Shared surface style: `rgba(var(--v-theme-surface), 0.92)` background, `1px solid rgb(var(--v-theme-surface-variant))` border, `4px` radius.
- Include a drag handle with `mdi-drag-horizontal` (for vertical panels) or `mdi-drag-vertical` (for horizontal panels) at `text-medium-emphasis`.
- Draggable via `useDraggable`. Do not reimplement pointer tracking per panel.
