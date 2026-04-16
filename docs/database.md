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

### Migration v2 — rename to missions
Dropped the "projects" vocabulary in favor of "missions" to match the
mission-picker entry flow on the home page. SQLite can rename a parent table
in place with `ALTER TABLE ... RENAME TO`, but a FK column needs a full
table rebuild — v2 copies `features` into a new table whose `mission_id`
column references the renamed parent, then swaps the new table into place.
No data is lost; ids and timestamps round-trip verbatim.
