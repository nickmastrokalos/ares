# Backend

> Source of truth for backend architecture and design decisions.

## Stack
- **Framework:** Tauri v2
- **Language:** Rust (2021 edition)
- **Serialization:** serde / serde_json
- **Async runtime:** tokio (via `tauri::async_runtime`)
- **XML parsing:** quick-xml

## Project Structure
```
src-tauri/
  Cargo.toml           # Rust dependencies
  build.rs             # Tauri build script
  tauri.conf.json      # Tauri app configuration
  capabilities/
    default.json       # Window permissions
  src/
    main.rs            # Desktop entry point
    lib.rs             # Core application logic and Tauri commands
    migrations.rs      # SQLite schema migrations
    cot.rs             # CoT XML parser
    listeners.rs       # UDP/TCP CoT listener task manager
  icons/               # Generated app icons
```

## Conventions
- Define Tauri commands in `src/lib.rs` using the `#[tauri::command]` attribute.
- Register commands in the `invoke_handler` within the `run()` function.
- Use `serde` for all data serialization between frontend and backend.
- Use `tauri::async_runtime::spawn` (not `tokio::spawn` directly) for async tasks — it wraps Tokio but integrates with Tauri's handle lifecycle.

## Cross-Platform (Windows, Linux, macOS)
- Use `std::path::PathBuf` and `Path` for all file paths — never hardcode `/` or `\`.
- Use Tauri's `app.path()` resolver for standard directories (app data, config, home, etc.).
- Gate any platform-specific code with `#[cfg(target_os = "...")]` attributes.
- Avoid shell commands (`std::process::Command`) unless absolutely necessary; if used, handle differences between `cmd`/`sh`/`bash`.
- Test assumptions about file system behavior (case sensitivity, symlinks, permissions) against all three OSes.

## CoT Networking

### `cot.rs` — Parser
- `CotEvent` struct: `uid`, `cot_type`, `lat`, `lon`, `hae`, `speed`, `course`, `callsign`, `time`, `stale`
- `parse_cot(data: &[u8]) -> Result<CotEvent, String>` — parses CoT XML using `quick-xml`. Required fields: `uid`, `lat`, `lon`. Optional: `hae`, `speed`, `course`, `callsign` (falls back to `uid`), `time`, `stale`.

### `listeners.rs` — Listener Manager
- `ListenerManager` — holds a `HashMap<String, JoinHandle<()>>` keyed by `"{address}:{port}"`.
- `start_udp(address, port, app_handle)` — binds a UDP socket, spawns a recv loop. Parses each datagram as a complete CoT message.
- `start_tcp(address, port, app_handle)` — binds a TCP listener, spawns a task per accepted connection. Frames messages by splitting on `</event>`.
- `stop(key)` — aborts the task and removes it from the map.
- `stop_all()` — aborts all tasks and clears the map.
- On parse error: logs and continues (does not crash the listener).

### Tauri Commands
| Command | Parameters | Description |
|---------|-----------|-------------|
| `start_listener` | `address: String, port: u16, protocol: String` | Start a UDP or TCP listener. Replaces existing listener at the same address:port. |
| `stop_listener` | `address: String, port: u16` | Stop and remove a specific listener. |
| `stop_all_listeners` | — | Stop all active listeners. Called on map unmount. |

### `cot-event` — Frontend Event
Emitted via `app_handle.emit("cot-event", &cot_event)` for each successfully parsed CoT message.

Payload shape (snake_case, serialized from `CotEvent`):
```json
{
  "uid": "ARES-TEST-1",
  "cot_type": "a-f-G-U-C",
  "lat": 38.89,
  "lon": -77.03,
  "hae": 0.0,
  "speed": 15.2,
  "course": 270.0,
  "callsign": "Alpha",
  "time": "2026-04-13T00:00:00Z",
  "stale": "2026-04-13T00:05:00Z"
}
```

### Managed State
`ListenerState(Mutex<ListenerManager>)` is registered via `.manage()` in `run()` and injected into each command handler via Tauri's state extractor.
