use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use reqwest::Client;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::task::JoinSet;

use crate::rate_limiter::RateLimiter;

/// Called with `(bytes_downloaded_so_far, total_bytes)` every time a chunk is written.
/// `total_bytes` is 0 until the size is known.
pub type ProgressCallback = Arc<dyn Fn(u64, u64) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct DownloadOptions {
    pub url: String,
    pub output: PathBuf,
    /// Max number of parallel connections to split the file into.
    pub max_segments: u32,
    /// Don't bother splitting into segments smaller than this (bytes).
    pub min_segment_size: u64,
    /// Total bandwidth cap for this download (bytes/sec), split evenly across
    /// its active connections. `None` = unlimited.
    pub max_bytes_per_sec: Option<u64>,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            url: String::new(),
            output: PathBuf::from("download.bin"),
            max_segments: 8,
            min_segment_size: 1024 * 1024, // 1 MiB
            max_bytes_per_sec: None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ByteRange {
    start: u64,
    end: u64, // inclusive
}

/// Derives a default output file name from a URL's last path segment.
pub fn guess_filename(url: &str) -> PathBuf {
    let name = url
        .rsplit('/')
        .next()
        .unwrap_or("download.bin")
        .split('?')
        .next()
        .unwrap_or("download.bin");
    if name.is_empty() {
        PathBuf::from("download.bin")
    } else {
        PathBuf::from(name)
    }
}

/// Downloads `opts.url` to `opts.output`, splitting into multiple parallel
/// range-requested segments when the server supports it, falling back to a
/// single streamed connection otherwise.
pub async fn download(client: &Client, opts: DownloadOptions, on_progress: ProgressCallback) -> Result<()> {
    ensure_parent_dir(&opts.output).await?;

    let (total_size, supports_range) = probe(client, &opts.url).await?;

    if total_size == 0 || !supports_range {
        return download_single(client, &opts, on_progress).await;
    }

    let num_segments = opts
        .max_segments
        .min(((total_size / opts.min_segment_size).max(1)) as u32)
        .max(1);

    if num_segments <= 1 {
        return download_single(client, &opts, on_progress).await;
    }

    allocate_file(&opts.output, total_size).await?;

    let ranges = split_ranges(total_size, num_segments as u64);
    let downloaded = Arc::new(AtomicU64::new(0));
    let per_segment_rate = opts.max_bytes_per_sec.map(|r| (r / num_segments as u64).max(1));

    let mut tasks = JoinSet::new();
    for (id, range) in ranges.into_iter().enumerate() {
        let client = client.clone();
        let url = opts.url.clone();
        let output = opts.output.clone();
        let downloaded = downloaded.clone();
        let on_progress = on_progress.clone();
        tasks.spawn(async move {
            download_range(&client, &url, &output, id, range, downloaded, total_size, on_progress, per_segment_rate).await
        });
    }

    while let Some(result) = tasks.join_next().await {
        result.context("segment task panicked")??;
    }

    Ok(())
}

async fn probe(client: &Client, url: &str) -> Result<(u64, bool)> {
    let resp = client.head(url).send().await.context("HEAD request failed")?;
    if !resp.status().is_success() {
        bail!("server returned {} for HEAD request", resp.status());
    }
    let total_size = resp.content_length().unwrap_or(0);
    let supports_range = resp
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .map(|v| v.as_bytes() == b"bytes")
        .unwrap_or(false);
    Ok((total_size, supports_range))
}

fn split_ranges(total_size: u64, num_segments: u64) -> Vec<ByteRange> {
    let chunk = total_size / num_segments;
    let mut ranges = Vec::with_capacity(num_segments as usize);
    let mut start = 0u64;
    for i in 0..num_segments {
        let end = if i == num_segments - 1 { total_size - 1 } else { start + chunk - 1 };
        ranges.push(ByteRange { start, end });
        start = end + 1;
    }
    ranges
}

async fn ensure_parent_dir(path: &PathBuf) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await.context("failed to create output directory")?;
        }
    }
    Ok(())
}

async fn allocate_file(path: &PathBuf, size: u64) -> Result<()> {
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .await
        .with_context(|| format!("failed to create {}", path.display()))?;
    file.set_len(size).await.context("failed to preallocate file")?;
    Ok(())
}

async fn download_range(
    client: &Client,
    url: &str,
    output: &PathBuf,
    id: usize,
    range: ByteRange,
    downloaded: Arc<AtomicU64>,
    total_size: u64,
    on_progress: ProgressCallback,
    rate_limit: Option<u64>,
) -> Result<()> {
    const MAX_RETRIES: u32 = 5;

    let segment_len = range.end - range.start + 1;
    let mut written = 0u64;
    let mut attempt = 0u32;
    let mut limiter = rate_limit.map(RateLimiter::new);

    while written < segment_len {
        let start = range.start + written;
        match download_range_once(client, url, output, start, range.end, &downloaded, total_size, &on_progress, &mut written, &mut limiter).await {
            Ok(()) => {}
            Err(e) => {
                if attempt >= MAX_RETRIES {
                    bail!("segment {id} failed after {MAX_RETRIES} retries: {e}");
                }
                attempt += 1;
                eprintln!("segment {id} error: {e} (retry {attempt}/{MAX_RETRIES})");
                tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
            }
        }
    }

    Ok(())
}

async fn download_range_once(
    client: &Client,
    url: &str,
    output: &PathBuf,
    start: u64,
    end: u64,
    downloaded: &Arc<AtomicU64>,
    total_size: u64,
    on_progress: &ProgressCallback,
    written: &mut u64,
    limiter: &mut Option<RateLimiter>,
) -> Result<()> {
    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
        .send()
        .await
        .context("GET request failed")?;

    if !resp.status().is_success() {
        bail!("unexpected status {} for range {start}-{end}", resp.status());
    }

    let mut file = OpenOptions::new()
        .write(true)
        .open(output)
        .await
        .context("failed to open output file")?;
    file.seek(std::io::SeekFrom::Start(start)).await.context("seek failed")?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("error while streaming chunk")?;
        if let Some(limiter) = limiter {
            limiter.acquire(chunk.len() as u64).await;
        }
        file.write_all(&chunk).await.context("write failed")?;

        *written += chunk.len() as u64;
        let total_downloaded = downloaded.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
        on_progress(total_downloaded, total_size);
    }
    file.flush().await.ok();

    Ok(())
}

async fn download_single(client: &Client, opts: &DownloadOptions, on_progress: ProgressCallback) -> Result<()> {
    let resp = client.get(&opts.url).send().await.context("GET request failed")?;
    if !resp.status().is_success() {
        bail!("unexpected status {}", resp.status());
    }
    let total_size = resp.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&opts.output)
        .await
        .with_context(|| format!("failed to create {}", opts.output.display()))?;

    let mut limiter = opts.max_bytes_per_sec.map(RateLimiter::new);
    let mut stream = resp.bytes_stream();
    let mut downloaded = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("error while streaming chunk")?;
        if let Some(limiter) = &mut limiter {
            limiter.acquire(chunk.len() as u64).await;
        }
        file.write_all(&chunk).await.context("write failed")?;
        downloaded += chunk.len() as u64;
        on_progress(downloaded, total_size);
    }
    file.flush().await.ok();

    Ok(())
}
