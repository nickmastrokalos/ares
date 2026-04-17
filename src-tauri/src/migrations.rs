use tauri_plugin_sql::{Migration, MigrationKind};

/// Database migrations, applied in order by version.
///
/// Rules for adding a new migration:
/// - Never edit or reorder an existing migration — deployed databases will
///   already have it applied. Add a new one with the next version number.
/// - Keep each migration idempotent where reasonable (e.g. `IF NOT EXISTS`).
/// - `description` is for humans; `version` is what the plugin tracks.
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: "
                CREATE TABLE IF NOT EXISTS projects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE IF NOT EXISTS features (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    geometry TEXT NOT NULL,
                    properties TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "rename_projects_to_missions",
            // SQLite can't rename a column with a FK dependency cleanly, so we
            // rebuild both tables. ALTER TABLE ... RENAME TO handles `projects`
            // since nothing references its name directly; `features` needs a
            // full copy so `project_id` can become `mission_id` and the FK can
            // re-target the renamed parent.
            sql: "
                ALTER TABLE projects RENAME TO missions;

                CREATE TABLE features_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mission_id INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    geometry TEXT NOT NULL,
                    properties TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
                );
                INSERT INTO features_new (id, mission_id, type, geometry, properties, created_at, updated_at)
                    SELECT id, project_id, type, geometry, properties, created_at, updated_at FROM features;
                DROP TABLE features;
                ALTER TABLE features_new RENAME TO features;
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_scenes_table",
            // User-authored dashboards composed of draggable/resizable cards.
            // Cards are stored as a JSON array in the `cards` column — card
            // controls are card-type-specific so normalizing would require a
            // per-type table or an EAV blob anyway.
            sql: "
                CREATE TABLE IF NOT EXISTS scenes (
                    id          TEXT PRIMARY KEY,
                    label       TEXT NOT NULL,
                    description TEXT,
                    icon        TEXT,
                    order_idx   INTEGER NOT NULL DEFAULT 0,
                    cards       TEXT NOT NULL DEFAULT '[]',
                    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_scenes_order ON scenes(order_idx);
            ",
            kind: MigrationKind::Up,
        },
    ]
}
