# Database

> Source of truth for database schema and data access patterns.

## Stack
- **Engine:** SQLite (embedded, cross-platform)
- **Rust Plugin:** `tauri-plugin-sql` (with `sqlite` feature)
- **Frontend API:** `@tauri-apps/plugin-sql`
- **DB File:** `sqlite:ares.db` (stored in Tauri's app data directory)

## Access Pattern
- The database is accessed from the **frontend** via the Tauri SQL plugin.
- Use `src/plugins/database.js` to get the shared database instance.
- The `getDb()` function returns a singleton — call it wherever DB access is needed.

```js
import { getDb } from '@/plugins/database'

const db = await getDb()
await db.execute('CREATE TABLE IF NOT EXISTS ...')
const rows = await db.select('SELECT * FROM ...')
```

## Conventions
- All schema creation and migrations should be handled at app startup.
- Use parameterized queries (`$1`, `$2`) — never interpolate values into SQL strings.
- Keep queries in the frontend layer via the plugin; only move to Rust commands if performance requires it.
- Document all tables and their purpose in this file as they are created.

## Tables
<!-- Document tables here as they are created -->
