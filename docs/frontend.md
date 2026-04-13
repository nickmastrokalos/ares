# Frontend

> Source of truth for frontend architecture and design decisions.

## Stack
- **Framework:** Vue 3 (Composition API, `<script setup>`)
- **UI Library:** Vuetify 3 (auto-imported via vite-plugin-vuetify)
- **Build Tool:** Vite
- **Language:** JavaScript (no TypeScript)
- **Icons:** Material Design Icons (@mdi/font)
- **Routing:** Vue Router 4 (history mode)
- **State Management:** Pinia 3 (Composition API style)
- **Persistent Store:** @tauri-apps/plugin-store (key-value, persists to JSON)
- **Tauri API:** @tauri-apps/api for invoking Rust commands
- **Path Alias:** `@/` resolves to `src/`

## Project Structure
```
src/
  main.js          # App entry — mounts Vue with Pinia, Router, and Vuetify
  App.vue          # Root shell — contains <router-view />
  router/
    index.js       # Route definitions
  plugins/
    vuetify.js     # Vuetify configuration (theme, defaults)
    database.js    # SQLite database singleton (getDb)
    store.js       # Key-value store singleton (getStore)
  views/           # Page-level components (one per route)
    HomeView.vue   # Home page
  stores/          # Pinia stores (one file per domain)
    app.js         # Global app state
  components/      # Reusable Vue components
  assets/          # Static assets (images, fonts, etc.)
```

## State Management
- Use Pinia for all shared state.
- Use the Composition API style (`defineStore` with a setup function) for all stores.
- One store per domain — name files after their concern (e.g., `app.js`, `auth.js`).
- Store files live in `src/stores/`.

## Persistent Store (tauri-plugin-store)
- Use for app settings, preferences, and small persisted values — not for domain data (use SQLite for that).
- Access via `src/plugins/store.js` singleton (`getStore()`).
- Persists to `settings.json` in the app data directory with auto-save enabled.

```js
import { getStore } from '@/plugins/store'

const store = await getStore()
await store.set('theme', 'dark')
const theme = await store.get('theme')
```

## Routing
- Define all routes in `src/router/index.js`.
- Page-level components live in `src/views/` and are named `*View.vue`.
- Reusable components live in `src/components/` — do not put them in `views/`.
- `App.vue` is the shell (`<v-app>` + `<v-main>` + `<router-view />`). Page layout belongs in views, not in App.vue.

## Conventions
- Use `@/` alias for all imports (e.g., `import { getDb } from '@/plugins/database'`).
- Use Vuetify components for all UI elements — do not use raw HTML for things Vuetify provides.
- Use `<script setup>` syntax for all components.
- Vuetify is auto-imported via the Vite plugin; no need to import individual components.
- Invoke Tauri commands via `import { invoke } from '@tauri-apps/api/core'`.
