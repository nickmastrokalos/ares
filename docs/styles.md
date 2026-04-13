# Styles

> Source of truth for styling decisions and design system.

## Design System
- **UI Framework:** Vuetify 3 — all styling should go through Vuetify's theming and component props.
- **Theme:** Dark theme by default (configured in `src/plugins/vuetify.js`).
- **Icons:** Material Design Icons via `@mdi/font`.

## Conventions
- Use Vuetify's built-in utility classes (e.g., `d-flex`, `ma-4`, `text-h3`) for layout and spacing.
- Use Vuetify's theme system for colors — do not hardcode color values.
- Avoid custom CSS unless Vuetify does not provide a solution.
- No inline styles unless there is a clear justification.
- All theme customization goes in `src/plugins/vuetify.js`.
