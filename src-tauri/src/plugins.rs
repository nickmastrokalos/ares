use std::io;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[tauri::command]
pub fn list_plugin_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let plugins_dir = resolve_plugins_dir(&app)?;

    if !plugins_dir.exists() {
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create plugins directory: {e}"))?;
        std::fs::write(
            plugins_dir.join("README.txt"),
            "Drop a plugin .zip into this directory and restart Ares; the host extracts\n\
             it automatically into a folder of the same name and renames the source to\n\
             `*.zip.installed` so it isn't re-extracted on every launch. You can also\n\
             extract manually or drop a single .js plugin file here.\n\
             See docs/plugins.md for the plugin authoring guide.\n",
        )
        .map_err(|e| format!("Failed to seed README: {e}"))?;
        return Ok(vec![]);
    }

    // First pass: extract any *.zip files that haven't been processed yet.
    // Failures are logged (printed to stderr) but don't abort plugin
    // discovery — a malformed or unreadable zip shouldn't take the rest of
    // the plugin folder down with it.
    if let Err(e) = extract_pending_zips(&plugins_dir) {
        eprintln!("[plugin-loader] zip extraction warning: {e}");
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

/// Walk the plugins directory and extract every `*.zip` (skipping
/// already-handled `*.zip.installed` files). After a successful
/// extraction the source archive is renamed to `<name>.zip.installed`
/// so we don't re-extract on every launch.
///
/// Files inside the zip overwrite same-named files in the target dir,
/// which is what makes drop-in updates work — drop a newer
/// `weather-0.3.0.zip` next to a previously-extracted
/// `weather-0.2.0.zip.installed` and the contents update in place.
fn extract_pending_zips(plugins_dir: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("zip") {
            continue;
        }
        if let Err(e) = extract_zip(&path, plugins_dir) {
            eprintln!(
                "[plugin-loader] failed to extract {}: {e}",
                path.display()
            );
            continue;
        }
        // Rename the source so subsequent launches skip it. If the
        // rename itself fails (e.g. read-only volume) we log and move
        // on — the next launch will simply re-extract, which is
        // wasteful but not incorrect.
        let installed = with_extension(&path, "installed");
        if let Err(e) = std::fs::rename(&path, &installed) {
            eprintln!(
                "[plugin-loader] extracted {} but couldn't rename to .installed: {e}",
                path.display()
            );
        }
    }
    Ok(())
}

fn extract_zip(zip_path: &Path, plugins_dir: &Path) -> Result<(), String> {
    let canonical_plugins = plugins_dir
        .canonicalize()
        .map_err(|e| format!("canonicalize plugins dir: {e}"))?;

    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("read zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;

        // ZIP slip protection: only accept entries whose path is
        // contained in plugins_dir AFTER we resolve any `..` segments
        // by joining and canonicalizing the parent directory.
        let entry_path = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue, // skip absolute / `..`-laden paths
        };
        let outpath = plugins_dir.join(&entry_path);

        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("mkdir {}: {e}", outpath.display()))?;
            continue;
        }

        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir parent {}: {e}", parent.display()))?;
            // Verify the parent canonicalizes inside plugins_dir.
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| format!("canonicalize parent {}: {e}", parent.display()))?;
            if !canonical_parent.starts_with(&canonical_plugins) {
                return Err(format!(
                    "zip-slip: entry {} resolves outside plugins dir",
                    entry_path.display()
                ));
            }
        }

        let mut outfile = std::fs::File::create(&outpath)
            .map_err(|e| format!("create {}: {e}", outpath.display()))?;
        io::copy(&mut entry, &mut outfile)
            .map_err(|e| format!("write {}: {e}", outpath.display()))?;
    }
    Ok(())
}

/// Append a suffix to the path's filename. Used to turn
/// `weather-0.2.0.zip` into `weather-0.2.0.zip.installed`. We append
/// rather than `set_extension` so the original extension stays
/// visible — useful when the user wants to re-trigger extraction by
/// renaming back.
fn with_extension(path: &Path, ext: &str) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let mut name = path
        .file_name()
        .map(|n| n.to_owned())
        .unwrap_or_default();
    name.push(".");
    name.push(ext);
    parent.join(name)
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
