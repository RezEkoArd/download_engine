use std::path::PathBuf;
use std::sync::Arc;

use download_engine::{download, guess_filename, run_queue, DownloadOptions, QueueOptions};
use reqwest::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct QueueProgress {
    index: usize,
    downloaded: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct QueueJobResult {
    url: String,
    output: String,
    error: Option<String>,
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

fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_download(app: AppHandle, url: String, output: Option<String>, segments: Option<u32>, limit: Option<String>) -> Result<String, String> {
    let output: PathBuf = output.map(PathBuf::from).unwrap_or_else(|| guess_filename(&url));
    let max_bytes_per_sec = limit.as_deref().map(parse_rate).transpose()?;
    let client = build_client()?;

    let opts = DownloadOptions {
        url,
        output: output.clone(),
        max_segments: segments.unwrap_or(8),
        max_bytes_per_sec,
        ..Default::default()
    };

    let app_for_progress = app.clone();
    let on_progress: download_engine::ProgressCallback = Arc::new(move |downloaded, total| {
        let _ = app_for_progress.emit("download-progress", DownloadProgress { downloaded, total });
    });

    download(&client, opts, on_progress).await.map_err(|e| e.to_string())?;

    Ok(output.display().to_string())
}

#[tauri::command]
async fn start_queue(app: AppHandle, urls: Vec<String>, segments: Option<u32>, limit: Option<String>, concurrency: Option<usize>) -> Result<Vec<QueueJobResult>, String> {
    let max_bytes_per_sec = limit.as_deref().map(parse_rate).transpose()?;
    let client = build_client()?;

    let mut outputs = Vec::with_capacity(urls.len());
    let mut jobs = Vec::with_capacity(urls.len());
    for url in &urls {
        let output = guess_filename(url);
        outputs.push(output.display().to_string());
        jobs.push(DownloadOptions {
            url: url.clone(),
            output,
            max_segments: segments.unwrap_or(8),
            max_bytes_per_sec,
            ..Default::default()
        });
    }

    let app_for_progress = app.clone();
    let on_progress: download_engine::QueueProgressCallback = Arc::new(move |index, downloaded, total| {
        let _ = app_for_progress.emit("queue-progress", QueueProgress { index, downloaded, total });
    });

    let queue_opts = QueueOptions {
        concurrency: concurrency.unwrap_or(1),
    };
    let results = run_queue(&client, jobs, queue_opts, on_progress).await;

    Ok(urls
        .into_iter()
        .zip(outputs)
        .zip(results)
        .map(|((url, output), result)| QueueJobResult {
            url,
            output,
            error: result.err().map(|e| e.to_string()),
        })
        .collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![start_download, start_queue])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
