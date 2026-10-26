use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use download_engine::{
    build_client, discard_partial, download_with_handle, guess_filename, probe, DownloadHandle, DownloadOptions,
    DownloadOutcome, HeaderMap, HeaderName, HeaderValue, ResumeState, SharedRateLimiter,
};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

mod bridge;
mod island;
mod persistence;

#[derive(Clone, Serialize)]
struct JobProgress {
    job_id: String,
    downloaded: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct ProbeResult {
    total_size: u64,
    supports_range: bool,
    /// Name the server suggested, already sanitised by the engine into a single
    /// path component. The UI may use it as a file name as-is.
    suggested_filename: Option<String>,
}

#[derive(Clone, Serialize)]
struct ResumeInfo {
    downloaded: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct SegmentProgress {
    index: usize,
    downloaded: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum JobResult {
    Completed { path: String },
    Cancelled,
}

/// Everything the commands share: the handle of each running download, the
/// app-wide speed cap, and the User-Agent to send.
#[derive(Default)]
struct EngineState {
    jobs: Mutex<HashMap<String, DownloadHandle>>,
    limiter: SharedRateLimiter,
    user_agent: Mutex<Option<String>>,
    /// Set once the user picks "Keluar", so closing the window really exits
    /// instead of hiding to the tray again.
    quitting: AtomicBool,
}

impl EngineState {
    fn client(&self) -> Result<reqwest::Client, String> {
        let user_agent = self.user_agent.lock().map_err(|_| "state poisoned")?.clone();
        build_client(user_agent.as_deref()).map_err(|e| e.to_string())
    }

    fn handle(&self, job_id: &str) -> Option<DownloadHandle> {
        self.jobs.lock().ok()?.get(job_id).cloned()
    }
}

/// Parses a human rate like "500KB", "2MB", "1GB" into bytes/sec.
fn parse_rate(input: &str) -> Result<u64, String> {
    let input = input.trim();
    let split_at = input.find(|c: char| !c.is_ascii_digit()).unwrap_or(input.len());
    let (number, unit) = input.split_at(split_at);
    let number: u64 = number.parse().map_err(|_| format!("invalid rate '{input}'"))?;
    let multiplier = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1,
        "k" | "kb" => 1024,
        "m" | "mb" => 1024 * 1024,
        "g" | "gb" => 1024 * 1024 * 1024,
        other => return Err(format!("unknown rate unit '{other}' (use B, KB, MB or GB)")),
    };
    Ok(number * multiplier)
}

/// Headers a caller is allowed to put on a download.
///
/// An allowlist rather than a blocklist: these pairs come from outside the app
/// — a browser extension hands over the context a link needs to resolve — and
/// this is the narrowest set that makes a logged-in download work. Anything
/// else is dropped, so a compromised or buggy caller can't turn the engine
/// into a general-purpose request forger.
const ALLOWED_HEADERS: &[&str] = &[
    "cookie",
    "referer",
    "user-agent",
    "authorization",
    "accept",
    "accept-language",
    "origin",
];

/// Validates header pairs coming from a caller into a `HeaderMap`.
///
/// Malformed or disallowed entries are skipped instead of failing the whole
/// call: one bad pair shouldn't block a download the user asked for. Note that
/// `HeaderValue::from_str` rejects control characters, which is what stops a
/// crafted value from injecting extra headers.
fn to_header_map(pairs: Option<HashMap<String, String>>) -> HeaderMap {
    let mut map = HeaderMap::new();
    let Some(pairs) = pairs else { return map };
    for (name, value) in pairs {
        if !ALLOWED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(&value)) else {
            continue;
        };
        map.insert(name, value);
    }
    map
}

/// Checks a URL's size, Range-request support and preferred file name before a
/// download starts, so the UI can show them without guessing.
#[tauri::command]
async fn probe_url(state: State<'_, EngineState>, url: String, headers: Option<HashMap<String, String>>) -> Result<ProbeResult, String> {
    let client = state.client()?;
    let info = probe(&client, &url, &to_header_map(headers)).await.map_err(|e| e.to_string())?;
    Ok(ProbeResult {
        total_size: info.total_size,
        supports_range: info.supports_range,
        suggested_filename: info.suggested_filename,
    })
}

/// Reports how much of a partial file is already on disk, so the UI can offer
/// "Resume" with a real number instead of a blind restart.
#[tauri::command]
async fn resume_info(output: Option<String>) -> Option<ResumeInfo> {
    let output = PathBuf::from(output?);
    let state = ResumeState::load(&output).await?;
    Some(ResumeInfo {
        downloaded: state.downloaded(),
        total: state.total_size,
    })
}

/// Throws away a partial download and its sidecar, so removing a job doesn't
/// leave gigabytes of half-finished file behind.
#[tauri::command]
async fn discard_download(output: Option<String>) {
    if let Some(output) = output {
        discard_partial(&PathBuf::from(output)).await;
    }
}

/// Runs one download job, identified by `job_id` so the UI can track and
/// control it independently from any other job running at the same time.
#[tauri::command]
async fn start_download(
    app: AppHandle,
    state: State<'_, EngineState>,
    job_id: String,
    url: String,
    output: Option<String>,
    segments: Option<u32>,
    limit: Option<String>,
    retries: Option<u32>,
    allow_resume: Option<bool>,
    headers: Option<HashMap<String, String>>,
) -> Result<JobResult, String> {
    let output: PathBuf = output.map(PathBuf::from).unwrap_or_else(|| guess_filename(&url));
    let max_bytes_per_sec = limit.as_deref().filter(|l| !l.is_empty()).map(parse_rate).transpose()?;
    let client = state.client()?;

    let opts = DownloadOptions {
        url,
        output: output.clone(),
        max_segments: segments.unwrap_or(8),
        max_bytes_per_sec,
        global_limiter: Some(state.limiter.clone()),
        max_retries: retries.unwrap_or(5),
        allow_resume: allow_resume.unwrap_or(true),
        headers: to_header_map(headers),
        ..Default::default()
    };

    let handle = DownloadHandle::new();
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.insert(job_id.clone(), handle.clone());
    }

    let app_for_progress = app.clone();
    let progress_id = job_id.clone();
    let on_progress: download_engine::ProgressCallback = Arc::new(move |downloaded, total| {
        let _ = app_for_progress.emit(
            "job-progress",
            JobProgress {
                job_id: progress_id.clone(),
                downloaded,
                total,
            },
        );
    });

    let result = download_with_handle(&client, opts, handle, on_progress).await;

    // The job is over either way, so stop advertising a handle for it.
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.remove(&job_id);
    }

    match result.map_err(|e| e.to_string())? {
        DownloadOutcome::Completed => Ok(JobResult::Completed {
            path: output.display().to_string(),
        }),
        DownloadOutcome::Cancelled => Ok(JobResult::Cancelled),
    }
}

#[tauri::command]
fn pause_download(state: State<'_, EngineState>, job_id: String) -> Result<(), String> {
    state
        .handle(&job_id)
        .ok_or_else(|| format!("job {job_id} is not running"))?
        .pause();
    Ok(())
}

#[tauri::command]
fn resume_download(state: State<'_, EngineState>, job_id: String) -> Result<(), String> {
    state
        .handle(&job_id)
        .ok_or_else(|| format!("job {job_id} is not running"))?
        .resume();
    Ok(())
}

#[tauri::command]
fn cancel_download(state: State<'_, EngineState>, job_id: String) -> Result<(), String> {
    state
        .handle(&job_id)
        .ok_or_else(|| format!("job {job_id} is not running"))?
        .cancel();
    Ok(())
}

/// Per-segment progress, polled by the inspector panel. Empty once the job has
/// finished and its handle is gone.
#[tauri::command]
fn segment_progress(state: State<'_, EngineState>, job_id: String) -> Vec<SegmentProgress> {
    let Some(handle) = state.handle(&job_id) else {
        return Vec::new();
    };
    handle
        .segments()
        .into_iter()
        .map(|s| SegmentProgress {
            index: s.index,
            downloaded: s.downloaded,
            total: s.total,
        })
        .collect()
}

/// Caps the combined throughput of every running download. An empty limit
/// lifts the cap.
#[tauri::command]
fn set_global_speed_limit(state: State<'_, EngineState>, limit: Option<String>) -> Result<(), String> {
    let rate = match limit.as_deref().filter(|l| !l.is_empty()) {
        Some(value) => parse_rate(value)?,
        None => 0,
    };
    state.limiter.set_rate(rate);
    Ok(())
}

#[tauri::command]
fn set_user_agent(state: State<'_, EngineState>, user_agent: Option<String>) -> Result<(), String> {
    let mut slot = state.user_agent.lock().map_err(|_| "state poisoned")?;
    *slot = user_agent.filter(|ua| !ua.trim().is_empty());
    Ok(())
}

/// Shuts the app down for real. The UI calls this from the tray's "Keluar"
/// after it has flushed its state, since closing the window only hides it.
#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, EngineState>) {
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Brings the main window back from the tray. Also un-minimises it, since a
/// hidden-while-minimised window would otherwise reappear on the taskbar only.
fn reveal_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Builds the tray icon. Menu entries that depend on job state are forwarded to
/// the UI as events, because the job list lives there and not in `EngineState`.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Tampilkan Jendela", true, None::<&str>)?;
    let start_all = MenuItem::with_id(app, "start-all", "Mulai Semua", true, None::<&str>)?;
    let pause_all = MenuItem::with_id(app, "pause-all", "Jeda Semua", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &start_all,
            &pause_all,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Download Engine")
        .menu(&menu)
        // Left click belongs to show/hide; the menu stays on right click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal_main_window(app),
            "start-all" => {
                let _ = app.emit("tray-start-all", ());
            }
            "pause-all" => {
                let _ = app.emit("tray-pause-all", ());
            }
            "quit" => {
                let _ = app.emit("tray-quit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Closing to the tray makes it easy to think the app has exited and
        // launch it again; a second instance would fight the first one over
        // the saved job list, so re-launching just surfaces the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            reveal_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        // The overlay is parked by `island::place`, so the plugin must not
        // restore a position for it — the two would fight on every start.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state(island::LABEL)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(EngineState::default());
            // The listener itself stays down until the UI restores its setting
            // and asks for it; this only makes the state available.
            app.manage(bridge::BridgeState::default());
            setup_tray(app.handle())?;
            island::setup(app.handle())?;
            Ok(())
        })
        // Closing the window parks the app in the tray so downloads keep
        // running; only the tray's "Keluar" actually exits.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !app.state::<EngineState>().quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            probe_url,
            resume_info,
            discard_download,
            start_download,
            pause_download,
            resume_download,
            cancel_download,
            segment_progress,
            set_global_speed_limit,
            set_user_agent,
            quit_app,
            island::island_update,
            island::island_drag,
            island::island_drag_end,
            island::island_action,
            island::island_reveal_main,
            bridge::bridge_info,
            bridge::set_bridge_enabled,
            persistence::load_app_state,
            persistence::save_app_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
