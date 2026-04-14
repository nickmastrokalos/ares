use std::path::PathBuf;
use std::sync::Mutex;

mod cot;
mod listeners;
mod migrations;

use listeners::ListenerManager;

struct DatabaseUrl(String);

/// Managed state holding all active CoT listener tasks.
struct ListenerState(Mutex<ListenerManager>);

#[tauri::command]
fn get_database_url(state: tauri::State<DatabaseUrl>) -> String {
    state.0.clone()
}

/// Start a CoT listener on the given address, port, and protocol ("udp" or "tcp").
/// If a listener already exists for this address:port it is replaced.
#[tauri::command]
fn start_listener(
    address: String,
    port: u16,
    protocol: String,
    state: tauri::State<ListenerState>,
    app: tauri::AppHandle,
) {
    let mut mgr = state.0.lock().unwrap();
    match protocol.to_lowercase().as_str() {
        "tcp" => mgr.start_tcp(address, port, app),
        _ => mgr.start_udp(address, port, app),
    }
}

/// Stop the listener bound to `address:port`.
#[tauri::command]
fn stop_listener(address: String, port: u16, state: tauri::State<ListenerState>) {
    let key = format!("{address}:{port}");
    state.0.lock().unwrap().stop(&key);
}

/// Stop all active CoT listeners.
#[tauri::command]
fn stop_all_listeners(state: tauri::State<ListenerState>) {
    state.0.lock().unwrap().stop_all();
}

/// Resolve the SQLite connection URL used by the `tauri-plugin-sql`.
///
/// - In debug builds the file lives in the project root (one level above
///   `src-tauri`) so it can be inspected and wiped easily during development.
/// - In release builds we hand the plugin a bare `sqlite:ares.db`, which it
///   resolves relative to the OS-appropriate app data directory (e.g.
///   `~/Library/Application Support/<identifier>` on macOS,
///   `%APPDATA%\<identifier>` on Windows, `~/.local/share/<identifier>` on Linux).
fn resolve_database_url() -> String {
    if cfg!(debug_assertions) {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR has a parent directory")
            .to_path_buf();
        let path = project_root.join("ares.db");
        format!("sqlite:{}", path.to_string_lossy())
    } else {
        "sqlite:ares.db".to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_url = resolve_database_url();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&db_url, migrations::migrations())
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(DatabaseUrl(db_url))
        .manage(ListenerState(Mutex::new(ListenerManager::new())))
        .invoke_handler(tauri::generate_handler![
            get_database_url,
            start_listener,
            stop_listener,
            stop_all_listeners,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
