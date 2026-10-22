use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

const STATE_FILE: &str = "app-state.json";

/// Where the UI's saved jobs and settings live, created on first write.
fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    Ok(dir.join(STATE_FILE))
}

/// Returns the saved UI state, or `None` on a first run.
///
/// The blob is passed through untyped on purpose: its shape belongs to the
/// frontend, and mirroring it here would only add a second place to update
/// whenever the UI grows a field.
#[tauri::command]
pub fn load_app_state(app: AppHandle) -> Result<Option<Value>, String> {
    let path = state_path(&app)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    };

    match serde_json::from_str(&raw) {
        Ok(value) => Ok(Some(value)),
        // A corrupt file shouldn't brick the app; start fresh instead.
        Err(e) => {
            eprintln!("ignoring unreadable {}: {e}", path.display());
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn save_app_state(app: AppHandle, state: Value) -> Result<(), String> {
    let path = state_path(&app)?;
    let raw = serde_json::to_string_pretty(&state).map_err(|e| format!("failed to encode state: {e}"))?;

    // Write beside the target first so a crash mid-write can't leave a
    // half-written file where the real one used to be.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("failed to replace {}: {e}", path.display()))?;
    Ok(())
}
