use std::path::PathBuf;
use std::sync::Mutex;

mod assistant;
mod cot;
mod cot_sender;
mod listeners;
mod migrations;
mod plugins;
mod scenes;
mod tak_v1;
mod tileserver;

use listeners::ListenerManager;

struct DatabaseUrl(String);

/// Managed state holding all active CoT listener tasks.
struct ListenerState(Mutex<ListenerManager>);

/// Managed state for the local MBTiles tile server.
struct TileServerState(tileserver::Registry);

// ---- Tile server commands ----

/// Scan `path` (a directory) for .mbtiles files and register them.
/// Returns the list of newly discovered tilesets.
#[tauri::command]
fn add_tile_path(
    path: String,
    state: tauri::State<TileServerState>,
) -> Vec<tileserver::TilesetInfo> {
    tileserver::register_path(&state.0, &path)
}

/// Remove all tilesets whose files live in `path`.
#[tauri::command]
fn remove_tile_path(path: String, state: tauri::State<TileServerState>) {
    tileserver::unregister_path(&state.0, &path);
}

/// Return all currently registered tilesets.
#[tauri::command]
fn list_tilesets(state: tauri::State<TileServerState>) -> Vec<tileserver::TilesetInfo> {
    tileserver::list(&state.0)
}

#[tauri::command]
fn get_database_url(state: tauri::State<DatabaseUrl>) -> String {
    state.0.clone()
}

/// Start a listener on the given address, port, and protocol ("udp" or "tcp").
/// `parser` selects how received bytes are routed:
///   - `"cot"` (or omitted) → parsed as CoT and emitted on the
///     `cot-event` channel — the legacy behavior used by the protected
///     core listeners and any user-added ad-hoc CoT listener.
///   - `"raw"` → emitted as-is on the `connection-packet` channel,
///     tagged with `kind` so the frontend dispatcher can route the
///     bytes to the right plugin's `onPacket` callback.
///
/// `kind` is required when `parser == "raw"` and ignored otherwise. If a
/// listener already exists for this address:port it is replaced.
#[tauri::command]
fn start_listener(
    address: String,
    port: u16,
    protocol: String,
    kind: Option<String>,
    parser: Option<String>,
    state: tauri::State<ListenerState>,
    app: tauri::AppHandle,
) {
    let parser_kind = match parser.as_deref().unwrap_or("cot") {
        "raw" => match kind {
            Some(k) => listeners::Parser::Raw { kind: k },
            None => {
                eprintln!("[connection] start_listener: parser=raw requires kind; falling back to cot");
                listeners::Parser::Cot
            }
        },
        _ => listeners::Parser::Cot,
    };

    let mut mgr = state.0.lock().unwrap();
    match protocol.to_lowercase().as_str() {
        "tcp" => mgr.start_tcp(address, port, parser_kind, app),
        _ => mgr.start_udp(address, port, parser_kind, app),
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

/// Parse a CoT message (XML or TAK Protocol v1) and return the host's
/// `CotEvent` shape. Used by plugins that own a raw socket
/// (`parser: 'plugin'`) and want to feed received bytes back into the
/// host's CoT pipeline via `api.cot.emit`. Errors come back as a
/// human-readable string so the plugin can log and skip bad packets.
#[tauri::command]
fn parse_cot_bytes(bytes: Vec<u8>) -> Result<cot::CotEvent, String> {
    cot::parse_cot(&bytes)
}

/// Send a single CoT XML payload to a destination.
///
/// `protocol` is "udp" (functional in v1) or "tcp" (returns an error from
/// `cot_sender::send_tcp` until streaming/TAK Server support lands).
/// Multicast detection happens inside the sender module.
#[tauri::command]
async fn send_cot(
    address: String,
    port: u16,
    protocol: String,
    xml: String,
) -> Result<(), String> {
    match protocol.to_lowercase().as_str() {
        "tcp" => cot_sender::send_tcp(&address, port, &xml).await,
        _     => cot_sender::send_udp(&address, port, &xml).await,
    }
}

/// Proxy an AIS vessel fetch through Rust to avoid CORS restrictions.
/// Returns the parsed JSON response body on success, or an error string.
#[tauri::command]
async fn fetch_ais_vessels(
    url: String,
    api_key: String,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
) -> Result<serde_json::Value, String> {
    let base = url.trim_end_matches('/');
    let endpoint = format!("{base}/v1/vessels");

    let geometry = serde_json::json!({
        "type": "bbox",
        "bbox": [min_lon, min_lat, max_lon, max_lat]
    });

    let client = reqwest::Client::new();
    let res = client
        .get(&endpoint)
        .header("x-api-key", &api_key)
        .query(&[("geometry", geometry.to_string())])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }

    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy an ADS-B aircraft fetch through Rust. The endpoint
/// `https://api.airplanes.live/v2/point/{lat}/{lon}/{radius_nm}` is free and
/// unauthenticated; routing through Rust avoids any CORS questions and gives
/// a single place to set a User-Agent / customise the call later. The
/// `radius_nm` is clamped to the airplanes.live cap of 250 nm before the
/// request is sent.
#[tauri::command]
async fn fetch_adsb_aircraft(
    lat: f64,
    lon: f64,
    radius_nm: f64,
) -> Result<serde_json::Value, String> {
    let radius = radius_nm.clamp(1.0, 250.0);
    let endpoint = format!(
        "https://api.airplanes.live/v2/point/{lat}/{lon}/{radius}"
    );

    let client = reqwest::Client::new();
    let res = client
        .get(&endpoint)
        .header("User-Agent", "Ares/1.x (https://github.com/)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }

    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
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
    let db_url        = resolve_database_url();
    let tile_registry = tileserver::new_registry();

    tauri::Builder::default()
        .setup({
            let tile_registry = tile_registry.clone();
            move |_app| {
                tileserver::start(tile_registry);
                Ok(())
            }
        })
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
        .manage(TileServerState(tile_registry))
        .invoke_handler(tauri::generate_handler![
            get_database_url,
            start_listener,
            stop_listener,
            stop_all_listeners,
            parse_cot_bytes,
            send_cot,
            cot_sender::get_lan_ipv4,
            fetch_ais_vessels,
            fetch_adsb_aircraft,
            add_tile_path,
            remove_tile_path,
            list_tilesets,
            plugins::list_plugin_files,
            plugins::read_plugin_file,
            plugins::install_plugin_zip,
            scenes::commands::scene_data_fetch_batch,
            assistant::commands::assistant_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
