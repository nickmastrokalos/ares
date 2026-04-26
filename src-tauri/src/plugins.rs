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

    let mut files: Vec<String> = vec![];

    for entry in std::fs::read_dir(&plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {e}"))?
        .flatten()
    {
        let path = entry.path();
        if path.is_dir() {
            // Directory-based plugin: must contain an index.js entry point.
            let index = path.join("index.js");
            if index.exists() {
                files.push(index.to_string_lossy().into_owned());
            }
        } else if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("js") {
            // Single-file plugin at the top level.
            files.push(path.to_string_lossy().into_owned());
        }
    }

    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn read_plugin_file(path: String, app: tauri::AppHandle) -> Result<String, String> {
    let plugins_dir = resolve_plugins_dir(&app)?;

    let requested = PathBuf::from(&path);
    let parent = requested
        .parent()
        .ok_or_else(|| "Plugin path has no parent".to_string())?;
    let basename = requested
        .file_name()
        .ok_or_else(|| "Plugin path has no filename".to_string())?;

    let canonical_plugins = plugins_dir
        .canonicalize()
        .map_err(|e| format!("Cannot resolve plugins directory: {e}"))?;
    // Canonicalize only the parent — that handles `..` traversal — and
    // require the parent to be inside the plugins directory. The leaf
    // itself is allowed to be a symlink (common dev pattern: symlink
    // `<plugins>/my-plugin/index.js` to a built bundle elsewhere on
    // disk so rebuilds land instantly without re-copying). The trust
    // model is unchanged because the JS we ultimately execute already
    // runs with full webview privileges regardless of how we got it.
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| "Plugin file not found".to_string())?;

    if !canonical_parent.starts_with(&canonical_plugins) {
        return Err("Access denied: path is outside the plugins directory".to_string());
    }

    let target = canonical_parent.join(basename);
    if target.extension().and_then(|e| e.to_str()) != Some("js") {
        return Err("Only .js files may be loaded as plugins".to_string());
    }

    std::fs::read_to_string(&target).map_err(|e| format!("Failed to read plugin: {e}"))
}

fn resolve_plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("plugins"))
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))
}
