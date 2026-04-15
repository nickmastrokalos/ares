use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{
    Router,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};

pub const PORT: u16 = 3650;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TilesetInfo {
    pub name:         String,
    pub display_name: String,
    pub path:         String,
    pub format:       String,
    pub minzoom:      u8,
    pub maxzoom:      u8,
    pub bounds:       Option<[f64; 4]>,
    pub tile_url:     String,
}

/// Shared, mutable registry of registered tilesets.
pub type Registry = Arc<RwLock<HashMap<String, TilesetInfo>>>;

pub fn new_registry() -> Registry {
    Arc::new(RwLock::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Registry helpers (called from Tauri commands)
// ---------------------------------------------------------------------------

/// Scan `dir` for top-level `.mbtiles` files, open each, read its metadata,
/// and register it in the registry.  Returns the newly registered tilesets.
pub fn register_path(registry: &Registry, dir: &str) -> Vec<TilesetInfo> {
    let dir_path = PathBuf::from(dir);
    if !dir_path.is_dir() {
        return vec![];
    }

    let entries = match std::fs::read_dir(&dir_path) {
        Ok(e)  => e,
        Err(_) => return vec![],
    };

    let mut added = vec![];
    let mut reg   = registry.write().unwrap();

    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("mbtiles") {
            continue;
        }
        let stem = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None    => continue,
        };
        // URL-safe name: lowercase, spaces/underscores → dashes
        let name: String = stem
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' })
            .collect();

        if let Some(info) = open_tileset_info(&p, &name, &stem) {
            reg.insert(name.clone(), info.clone());
            added.push(info);
        }
    }

    added
}

/// Remove all tilesets whose file path lives inside `dir`.
pub fn unregister_path(registry: &Registry, dir: &str) {
    let dir_path = PathBuf::from(dir);
    registry.write().unwrap().retain(|_, info| {
        !PathBuf::from(&info.path).starts_with(&dir_path)
    });
}

/// Return all registered tilesets.
pub fn list(registry: &Registry) -> Vec<TilesetInfo> {
    let mut ts: Vec<TilesetInfo> = registry.read().unwrap().values().cloned().collect();
    ts.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    ts
}

// ---------------------------------------------------------------------------
// MBTiles metadata reader
// ---------------------------------------------------------------------------

fn open_tileset_info(path: &PathBuf, name: &str, display_fallback: &str) -> Option<TilesetInfo> {
    let conn = rusqlite::Connection::open(path).ok()?;

    let mut meta: HashMap<String, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT name, value FROM metadata") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                meta.insert(row.0, row.1);
            }
        }
    }

    let format   = meta.get("format").cloned().unwrap_or_else(|| "png".into());
    let minzoom: u8 = meta.get("minzoom").and_then(|v| v.parse().ok()).unwrap_or(0);
    let maxzoom: u8 = meta.get("maxzoom").and_then(|v| v.parse().ok()).unwrap_or(22);
    let display  = meta.get("name").cloned().unwrap_or_else(|| display_fallback.to_string());

    let bounds = meta.get("bounds").and_then(|b| {
        let v: Vec<f64> = b.split(',').filter_map(|s| s.trim().parse().ok()).collect();
        if v.len() == 4 { Some([v[0], v[1], v[2], v[3]]) } else { None }
    });

    Some(TilesetInfo {
        name:         name.to_string(),
        display_name: display,
        path:         path.to_string_lossy().into_owned(),
        format,
        minzoom,
        maxzoom,
        bounds,
        tile_url:     format!("http://127.0.0.1:{PORT}/{name}/{{z}}/{{x}}/{{y}}"),
    })
}

// ---------------------------------------------------------------------------
// Axum server
// ---------------------------------------------------------------------------

pub fn start(registry: Registry) {
    tauri::async_runtime::spawn(async move {
        let app = Router::new()
            .route("/{name}/{z}/{x}/{y}", get(serve_tile))
            .route("/tilesets",           get(serve_tilesets))
            .with_state(registry);

        let Ok(listener) = tokio::net::TcpListener::bind(
            format!("127.0.0.1:{PORT}")
        ).await else {
            eprintln!("[tileserver] failed to bind 127.0.0.1:{PORT}");
            return;
        };
        let _ = axum::serve(listener, app).await;
    });
}

/// `GET /{name}/{z}/{x}/{y}` — return raw tile bytes.
async fn serve_tile(
    Path((name, z, x, y)): Path<(String, u32, u32, u32)>,
    State(registry): State<Registry>,
) -> Response {
    let info = {
        let reg = registry.read().unwrap();
        reg.get(&name).cloned()
    };
    let Some(info) = info else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let path   = PathBuf::from(&info.path);
    let format = info.format.clone();

    let result = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
        let conn   = rusqlite::Connection::open(&path).ok()?;
        // MBTiles uses TMS y (origin at south); flip from XYZ (origin at north).
        let tms_y  = (1u32 << z).saturating_sub(1).saturating_sub(y);
        conn.query_row(
            "SELECT tile_data FROM tiles \
             WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
            rusqlite::params![z, x, tms_y],
            |row| row.get::<_, Vec<u8>>(0),
        ).ok()
    }).await;

    match result {
        Ok(Some(data)) => {
            let content_type = match format.as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "webp"         => "image/webp",
                "pbf"          => "application/x-protobuf",
                _              => "image/png",
            };
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE,
                HeaderValue::from_static(content_type));
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("*"));
            (headers, data).into_response()
        }
        // Empty tile — MapLibre handles 204 gracefully (renders nothing).
        _ => StatusCode::NO_CONTENT.into_response(),
    }
}

/// `GET /tilesets` — return JSON list of registered tilesets.
async fn serve_tilesets(State(registry): State<Registry>) -> Json<Vec<TilesetInfo>> {
    Json(list(&registry))
}
