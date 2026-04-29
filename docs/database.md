# Database

> Source of truth for database schema and data access patterns.

## Stack
- **Engine:** SQLite (embedded, cross-platform)
- **Rust Plugin:** `tauri-plugin-sql` (with `sqlite` feature)
- **Frontend API:** `@tauri-apps/plugin-sql`

## Storage Location
The DB path is resolved in Rust (`src-tauri/src/lib.rs::resolve_database_url`) and
exposed to the frontend through the `get_database_url` command so both sides
always agree on the file.

- **Debug builds (`pnpm tauri dev`)** — `<project-root>/ares.db` (gitignored).
  Easy to inspect, diff, and wipe during development.
- **Release builds** — OS-appropriate app data directory, resolved by the plugin
  from the bare URL `sqlite:ares.db`:
  - macOS: `~/Library/Application Support/<bundle-identifier>/ares.db`
  - Windows: `%APPDATA%\<bundle-identifier>\ares.db`
  - Linux: `~/.local/share/<bundle-identifier>/ares.db`

## Access Pattern
The frontend never loads the DB directly with a hardcoded path. It calls
`getDb()` in `src/plugins/database.js`, which:
1. Invokes the `get_database_url` Tauri command to get the resolved path.
2. Opens a single `Database` handle (promise-cached to serialize concurrent callers).
3. Returns that handle to every caller for the remainder of the session.

```js
import { getDb } from '@/plugins/database'

const db = await getDb()
const rows = await db.select('SELECT * FROM missions WHERE id = $1', [id])
```

## Migrations

Schema changes are versioned and applied automatically by `tauri-plugin-sql`'s
migration runner at plugin initialization. The plugin tracks applied versions
in a `_sqlx_migrations` table inside the DB, so each migration runs at most
once per database file.

Migrations live in `src-tauri/src/migrations.rs`, returned as a `Vec<Migration>`:

```rust
Migration {
    version: 1,
    description: "create_initial_tables",
    sql: "...",
    kind: MigrationKind::Up,
}
```

### Rules for adding a migration

- **Never edit or reorder existing migrations.** Deployed databases have
  already applied them; changing the SQL retroactively would desync.
- **Always add a new migration** with the next incrementing version number.
- **Keep SQL idempotent** where practical (`CREATE TABLE IF NOT EXISTS`,
  `DROP TABLE IF EXISTS`, etc.) so dev databases in mixed states still converge.
- **One logical change per migration.** Easier to review, revert, and reason
  about in the migration log.
- **Document the table/column changes** in the *Tables* section below when
  adding a migration that affects schema shape.

### Adding a migration

1. Append a new `Migration { version: N+1, ... }` entry to the `vec!` in
   `migrations.rs`.
2. `pnpm tauri dev` — the plugin detects the new version on startup and runs
   only the unapplied migrations.

## Conventions
- Use parameterized queries (`$1`, `$2`) — never interpolate values into SQL strings.
- Keep queries in the frontend layer via the plugin; only move to Rust commands
  if performance or privilege boundaries require it.

## Tables

### `missions` (migration v1 as `projects`, renamed in v2)
Top-level container the user picks on the home screen. A mission owns a set
of features (both freehand drawings and anything the user imports while that
mission is active).

| Column       | Type    | Notes                                            |
|--------------|---------|--------------------------------------------------|
| `id`         | INTEGER | Primary key, autoincrement.                      |
| `name`       | TEXT    | Human-readable mission name.                     |
| `created_at` | TEXT    | `datetime('now')` default.                       |
| `updated_at` | TEXT    | Bumped by the store whenever features change.    |

### `features` (migration v1; `project_id` renamed to `mission_id` in v2)
Individual geometries belonging to a mission.

| Column       | Type    | Notes                                                                                     |
|--------------|---------|-------------------------------------------------------------------------------------------|
| `id`         | INTEGER | Primary key, autoincrement.                                                               |
| `mission_id` | INTEGER | FK → `missions.id`, `ON DELETE CASCADE`.                                                  |
| `type`       | TEXT    | Shape type string — see *Shape types* section in `frontend.md` for the full enumeration. |
| `geometry`   | TEXT    | JSON-serialized GeoJSON geometry object.                                                  |
| `properties` | TEXT    | JSON-serialized property bag (name, color, canonical parameters — see *Shape types*).     |
| `created_at` | TEXT    | `datetime('now')` default.                                                                |
| `updated_at` | TEXT    | Bumped on edit.                                                                           |

### `scenes` (migration v3)

User-authored dashboards composed of draggable/resizable cards. Global — not mission-scoped. See [scenes.md](./scenes.md) for the full data model.

| Column       | Type    | Notes |
|--------------|---------|-------|
| `id`         | TEXT PK | UUID (generated in the webview). |
| `label`      | TEXT    | Scene name. |
| `description`| TEXT    | Optional description. |
| `icon`       | TEXT    | MDI icon name. |
| `order_idx`  | INTEGER | Display order. |
| `cards`      | TEXT    | JSON array of card objects `{id, typeId, source, controls, layout:{x,y,w,h}}`. |
| `created_at` | TEXT    | `datetime('now')` default. |
| `updated_at` | TEXT    | Bumped on save. |

### `bullseyes` (migration v4)

One bullseye per mission — `mission_id` doubles as the primary key so the one-per-mission invariant is enforced at the schema level, and the FK cascades on mission delete. See [bullseye.md](./bullseye.md) for the feature.

| Column           | Type    | Notes |
|------------------|---------|-------|
| `mission_id`     | INTEGER PK, FK → missions(id) ON DELETE CASCADE | Mission that owns this bullseye. |
| `lat`, `lon`     | REAL    | Center in degrees; always WGS84. |
| `name`           | TEXT    | Free-text label rendered above the center. |
| `ring_interval`  | REAL    | Meters between consecutive rings. Storage is always meters; display unit follows `settings.distanceUnits`. |
| `ring_count`     | INTEGER | Number of rings (1–20). |
| `show_cardinals` | INTEGER | 0 / 1 — SQLite's boolean convention. |
| `updated_at`     | TEXT    | `datetime('now')` default; bumped on every write. |

Writes use `INSERT … ON CONFLICT(mission_id) DO UPDATE` so "place" and "edit" are the same statement. Clear is a straight `DELETE WHERE mission_id = ?`.

### `annotations` (migration v5)

Operator-placed sticky notes pinned to map locations — many per mission. See [annotations.md](./annotations.md).

| Column        | Type    | Notes |
|---------------|---------|-------|
| `id`          | INTEGER PK AUTOINCREMENT | Surrogate key. |
| `mission_id`  | INTEGER NOT NULL, FK → missions(id) ON DELETE CASCADE | Plain FK (not PK) — duplicates allowed. |
| `lat`, `lon`  | REAL    | Pin coordinates, WGS84. |
| `text`        | TEXT    | Free-text note body. Plain text only in v1. |
| `color`       | TEXT    | Hex string, e.g. `#ffeb3b`. Defaulted to yellow at the schema level. |
| `created_at`  | TEXT    | `datetime('now')` default. |
| `updated_at`  | TEXT    | `datetime('now')` default; bumped on every write. |

Index `idx_annotations_mission` covers the `mission_id` lookup used on every `init()`.

### `ghosts` (migration v6)

Persistent ghost tracks (simulated movement along a route). Configured state survives app restarts; live position does NOT — every ghost re-anchors to `start_waypoint_index` in the idle state on load.

| Column                  | Type    | Notes |
|-------------------------|---------|-------|
| `id`                    | INTEGER PK AUTOINCREMENT | Surrogate key. The store's monotonic counter resets to `max(id) + 1` on each `init()` so reused ids don't collide with persisted rows. |
| `mission_id`            | INTEGER NOT NULL, FK → missions(id) ON DELETE CASCADE | Mission scope. |
| `route_id`              | INTEGER NOT NULL, FK → features(id) ON DELETE CASCADE | The route the ghost walks. CASCADE drops the row when the route is deleted at the DB level; the store's `init()` also defensively `DELETE`s any row whose `route_id` is missing in `featuresStore.features` to handle prior-session deletes. |
| `name`                  | TEXT NOT NULL | Display label (default `ghost-xxxx`, renamable). |
| `start_waypoint_index`  | INTEGER NOT NULL | Zero-based index along the route's coordinates. `ghost_reset` returns the ghost here. |
| `direction`             | TEXT NOT NULL | `"forward"` or `"backward"`. Auto-clamped at endpoints. |
| `speed_ms`              | REAL NOT NULL | Configured speed in m/s. |
| `created_at`, `updated_at` | TEXT | `datetime('now')` defaults; `updated_at` bumped on every `_dbUpdate`. |

Index `idx_ghosts_mission` covers the `mission_id` lookup used on every `init()`. Live fields (`status`, `currentIndex`, `currentLon`, `currentLat`, `segmentProgress`) are deliberately not persisted — operators restart motion explicitly after a relaunch.

### Migration v2 — rename to missions
Dropped the "projects" vocabulary in favor of "missions" to match the
mission-picker entry flow on the home page. SQLite can rename a parent table
in place with `ALTER TABLE ... RENAME TO`, but a FK column needs a full
table rebuild — v2 copies `features` into a new table whose `mission_id`
column references the renamed parent, then swaps the new table into place.
No data is lost; ids and timestamps round-trip verbatim.
