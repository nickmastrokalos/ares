# Backend

> Source of truth for backend architecture and design decisions.

## Stack
- **Framework:** Tauri v2
- **Language:** Rust (2021 edition)
- **Serialization:** serde / serde_json

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
  icons/               # Generated app icons
```

## Conventions
- Define Tauri commands in `src/lib.rs` using the `#[tauri::command]` attribute.
- Register commands in the `invoke_handler` within the `run()` function.
- Use `serde` for all data serialization between frontend and backend.

## Cross-Platform (Windows, Linux, macOS)
- Use `std::path::PathBuf` and `Path` for all file paths — never hardcode `/` or `\`.
- Use Tauri's `app.path()` resolver for standard directories (app data, config, home, etc.).
- Gate any platform-specific code with `#[cfg(target_os = "...")]` attributes.
- Avoid shell commands (`std::process::Command`) unless absolutely necessary; if used, handle differences between `cmd`/`sh`/`bash`.
- Test assumptions about file system behavior (case sensitivity, symlinks, permissions) against all three OSes.
