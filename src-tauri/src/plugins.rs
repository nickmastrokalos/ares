use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
pub fn list_plugin_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let plugins_dir = resolve_plugins_dir(&app)?;

    if !plugins_dir.exists() {
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create plugins directory: {e}"))?;
        std::fs::write(
            plugins_dir.join("README.txt"),
            "Drop .js plugin files in this directory to load them on next app launch.\n\
             See docs/plugins.md for the plugin authoring guide.\n",
        )
        .map_err(|e| format!("Failed to seed README: {e}"))?;
        return Ok(vec![]);
    }

    let mut files: Vec<String> = std::fs::read_dir(&plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {e}"))?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("js") {
                Some(path.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .collect();
    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn read_plugin_file(path: String, app: tauri::AppHandle) -> Result<String, String> {
    let plugins_dir = resolve_plugins_dir(&app)?;

    let requested = PathBuf::from(&path);

    let canonical_plugins = plugins_dir
        .canonicalize()
        .map_err(|e| format!("Cannot resolve plugins directory: {e}"))?;
    let canonical_path = requested
        .canonicalize()
        .map_err(|_| "Plugin file not found".to_string())?;

    if !canonical_path.starts_with(&canonical_plugins) {
        return Err("Access denied: path is outside the plugins directory".to_string());
    }
    if canonical_path.extension().and_then(|e| e.to_str()) != Some("js") {
        return Err("Only .js files may be loaded as plugins".to_string());
    }

    std::fs::read_to_string(&canonical_path).map_err(|e| format!("Failed to read plugin: {e}"))
}

fn resolve_plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("plugins"))
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))
}
