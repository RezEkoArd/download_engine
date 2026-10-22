use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use download_engine::{
    build_client, discard_partial, download_with_handle, guess_filename, probe, DownloadHandle, DownloadOptions,
    DownloadOutcome, ResumeState, SharedRateLimiter,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Checks a URL's size and Range-request support before a download starts,
/// so the UI can show it without guessing.
#[tauri::command]
async fn probe_url(state: State<'_, EngineState>, url: String) -> Result<ProbeResult, String> {
    let client = state.client()?;
    let info = probe(&client, &url).await.map_err(|e| e.to_string())?;
    Ok(ProbeResult {
        total_size: info.total_size,
        supports_range: info.supports_range,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(EngineState::default());
            Ok(())
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
            persistence::load_app_state,
            persistence::save_app_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
