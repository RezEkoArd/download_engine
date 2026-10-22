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
use tokio_util::sync::CancellationToken;

use crate::control::{DownloadHandle, DownloadOutcome};
use crate::rate_limiter::SharedRateLimiter;
use crate::resume::{partial_file_matches, ResumeState, SegmentCheckpoint};

/// Called with `(bytes_downloaded_so_far, total_bytes)` every time a chunk is written.
/// `total_bytes` is 0 until the size is known.
pub type ProgressCallback = Arc<dyn Fn(u64, u64) + Send + Sync>;

pub const DEFAULT_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

#[derive(Clone)]
pub struct DownloadOptions {
    pub url: String,
    pub output: PathBuf,
    /// Max number of parallel connections to split the file into.
    pub max_segments: u32,
    /// Don't bother splitting into segments smaller than this (bytes).
    pub min_segment_size: u64,
    /// Bandwidth cap for this download alone (bytes/sec), split evenly across
    /// its connections. `None` = unlimited.
    pub max_bytes_per_sec: Option<u64>,
    /// Cap shared with every other download using the same limiter. Applied on
    /// top of `max_bytes_per_sec`, so whichever is tighter wins.
    pub global_limiter: Option<SharedRateLimiter>,
    /// How many times a segment may retry before the download fails.
    pub max_retries: u32,
    /// Pick up a matching partial file instead of starting over. Turn off to
    /// force a clean download.
    pub allow_resume: bool,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            url: String::new(),
            output: PathBuf::from("download.bin"),
            max_segments: 8,
            min_segment_size: 1024 * 1024, // 1 MiB
            max_bytes_per_sec: None,
            global_limiter: None,
            max_retries: 5,
            allow_resume: true,
        }
    }
}

/// What a HEAD request told us about the target.
#[derive(Debug, Clone, Default)]
pub struct ProbeInfo {
    pub total_size: u64,
    pub supports_range: bool,
    /// Validators used to confirm a partial file still matches the server's
    /// copy before resuming it.
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// How often the partial download's progress is checkpointed to disk.
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy)]
struct ByteRange {
    start: u64,
    end: u64, // inclusive
}

/// Why a single streaming attempt stopped.
enum StreamStop {
    /// The server closed the stream; the segment may or may not be complete.
    Ended,
    /// Paused mid-stream, so the attempt should be re-issued on resume.
    Paused,
    Cancelled,
}

/// Builds an HTTP client with the engine's defaults, optionally overriding the
/// User-Agent sent to servers.
pub fn build_client(user_agent: Option<&str>) -> Result<Client> {
    Client::builder()
        .user_agent(user_agent.unwrap_or(DEFAULT_USER_AGENT))
        .build()
        .context("failed to build HTTP client")
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

/// Downloads `opts.url` to `opts.output` with no outside control over it.
///
/// Use [`download_with_handle`] when the caller needs to pause, resume, cancel
/// or watch per-segment progress.
pub async fn download(client: &Client, opts: DownloadOptions, on_progress: ProgressCallback) -> Result<DownloadOutcome> {
    download_with_handle(client, opts, DownloadHandle::new(), on_progress).await
}

/// Downloads `opts.url` to `opts.output`, splitting into multiple parallel
/// range-requested segments when the server supports it, falling back to a
/// single streamed connection otherwise.
///
/// `handle` can pause, resume or cancel the transfer while it runs, and exposes
/// each segment's progress.
pub async fn download_with_handle(
    client: &Client,
    opts: DownloadOptions,
    handle: DownloadHandle,
    on_progress: ProgressCallback,
) -> Result<DownloadOutcome> {
    ensure_parent_dir(&opts.output).await?;

    if handle.is_cancelled() {
        return Ok(DownloadOutcome::Cancelled);
    }

    let info = probe(client, &opts.url).await?;
    let total_size = info.total_size;

    if total_size == 0 || !info.supports_range {
        return download_single(client, &opts, &handle, on_progress).await;
    }

    let num_segments = opts
        .max_segments
        .min(((total_size / opts.min_segment_size).max(1)) as u32)
        .max(1);

    if num_segments <= 1 {
        return download_single(client, &opts, &handle, on_progress).await;
    }

    // Prefer an existing partial file, but only when it provably belongs to
    // the same bytes the server is serving right now.
    let checkpoints = match resumable_checkpoints(&opts, &info).await {
        Some(checkpoints) => checkpoints,
        None => {
            ResumeState::clear(&opts.output).await;
            allocate_file(&opts.output, total_size).await?;
            split_ranges(total_size, num_segments as u64)
                .into_iter()
                .map(|r| SegmentCheckpoint {
                    start: r.start,
                    end: r.end,
                    downloaded: 0,
                })
                .collect()
        }
    };

    handle.set_segments(checkpoints.iter().map(|c| (c.start, c.end, c.downloaded)));

    let already_done: u64 = checkpoints.iter().map(|c| c.downloaded).sum();
    let downloaded = Arc::new(AtomicU64::new(already_done));
    if already_done > 0 {
        // Let the caller's progress bar jump straight to where we resumed
        // instead of crawling up from zero.
        on_progress(already_done, total_size);
    }

    let checkpointer = spawn_checkpointer(&handle, &opts, &info);

    let per_segment_limiter = opts
        .max_bytes_per_sec
        .map(|rate| SharedRateLimiter::new((rate / num_segments as u64).max(1)));

    let mut tasks = JoinSet::new();
    for (id, checkpoint) in checkpoints.into_iter().enumerate() {
        let client = client.clone();
        let url = opts.url.clone();
        let output = opts.output.clone();
        let downloaded = downloaded.clone();
        let on_progress = on_progress.clone();
        let handle = handle.clone();
        let limiters = Limiters {
            per_file: per_segment_limiter.clone(),
            global: opts.global_limiter.clone(),
        };
        let max_retries = opts.max_retries;
        let range = ByteRange {
            start: checkpoint.start,
            end: checkpoint.end,
        };
        tasks.spawn(async move {
            download_range(
                &client,
                &url,
                &output,
                id,
                range,
                checkpoint.downloaded,
                downloaded,
                total_size,
                on_progress,
                &handle,
                &limiters,
                max_retries,
            )
            .await
        });
    }

    let mut outcome = DownloadOutcome::Completed;
    let mut first_error = None;
    while let Some(joined) = tasks.join_next().await {
        match joined.context("segment task panicked") {
            Ok(Ok(DownloadOutcome::Cancelled)) => outcome = DownloadOutcome::Cancelled,
            Ok(Ok(DownloadOutcome::Completed)) => {}
            Ok(Err(e)) | Err(e) => {
                // One failing segment dooms the file, so stop the rest instead
                // of letting them finish work that will be thrown away.
                handle.cancel();
                first_error.get_or_insert(e);
            }
        }
    }

    checkpointer.abort();

    match (&first_error, outcome) {
        // Finished: the sidecar has nothing left to describe.
        (None, DownloadOutcome::Completed) => ResumeState::clear(&opts.output).await,
        // Stopped early: record exactly where, so the next run can continue.
        _ => {
            let _ = snapshot_state(&handle, &opts, &info).save(&opts.output).await;
        }
    }

    if let Some(e) = first_error {
        return Err(e);
    }
    Ok(outcome)
}

/// Returns the segments to resume from, or `None` when the download has to
/// start over.
async fn resumable_checkpoints(opts: &DownloadOptions, info: &ProbeInfo) -> Option<Vec<SegmentCheckpoint>> {
    if !opts.allow_resume {
        return None;
    }
    let state = ResumeState::load(&opts.output).await?;
    if !state.is_valid_for(&opts.url, info) {
        return None;
    }
    // The sidecar can be right while the file itself was moved or truncated.
    if !partial_file_matches(&opts.output, info.total_size).await {
        return None;
    }
    Some(state.segments)
}

fn snapshot_state(handle: &DownloadHandle, opts: &DownloadOptions, info: &ProbeInfo) -> ResumeState {
    let segments = handle
        .segments()
        .into_iter()
        .map(|s| SegmentCheckpoint {
            start: s.start,
            end: s.end,
            downloaded: s.downloaded,
        })
        .collect();
    ResumeState::new(&opts.url, info, segments)
}

/// Keeps the sidecar roughly current, so a crash or power cut costs at most a
/// couple of seconds of transfer rather than the whole file.
fn spawn_checkpointer(handle: &DownloadHandle, opts: &DownloadOptions, info: &ProbeInfo) -> tokio::task::JoinHandle<()> {
    let handle = handle.clone();
    let opts = opts.clone();
    let info = info.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(CHECKPOINT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // the first tick fires immediately; skip it
        loop {
            ticker.tick().await;
            let _ = snapshot_state(&handle, &opts, &info).save(&opts.output).await;
        }
    })
}

/// Asks the server for a file's size, Range support and change validators,
/// without downloading anything.
pub async fn probe(client: &Client, url: &str) -> Result<ProbeInfo> {
    let resp = client.head(url).send().await.context("HEAD request failed")?;
    if !resp.status().is_success() {
        bail!("server returned {} for HEAD request", resp.status());
    }

    let headers = resp.headers();
    let header_string = |name: reqwest::header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);

    // Read Content-Length off the headers rather than trusting
    // `Response::content_length()`: that reports the *body* size, and a HEAD
    // response has no body, so some servers leave it at zero. Taking the zero
    // at face value would quietly drop us to a single unresumable connection.
    let declared_size = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    let supports_range = headers
        .get(reqwest::header::ACCEPT_RANGES)
        .map(|v| v.as_bytes() == b"bytes")
        .unwrap_or(false);
    let etag = header_string(reqwest::header::ETAG);
    let last_modified = header_string(reqwest::header::LAST_MODIFIED);

    Ok(ProbeInfo {
        total_size: declared_size.or_else(|| resp.content_length()).unwrap_or(0),
        supports_range,
        etag,
        last_modified,
    })
}

struct Limiters {
    per_file: Option<SharedRateLimiter>,
    global: Option<SharedRateLimiter>,
}

impl Limiters {
    async fn acquire(&self, bytes: u64) {
        if let Some(limiter) = &self.per_file {
            limiter.acquire(bytes).await;
        }
        if let Some(limiter) = &self.global {
            limiter.acquire(bytes).await;
        }
    }
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

#[allow(clippy::too_many_arguments)]
async fn download_range(
    client: &Client,
    url: &str,
    output: &PathBuf,
    id: usize,
    range: ByteRange,
    resume_from: u64,
    downloaded: Arc<AtomicU64>,
    total_size: u64,
    on_progress: ProgressCallback,
    handle: &DownloadHandle,
    limiters: &Limiters,
    max_retries: u32,
) -> Result<DownloadOutcome> {
    let segment_len = range.end - range.start + 1;
    let mut written = resume_from.min(segment_len);
    let mut attempt = 0u32;
    let cancel = handle.cancel_token();

    while written < segment_len {
        handle.wait_while_paused().await;
        if handle.is_cancelled() {
            return Ok(DownloadOutcome::Cancelled);
        }

        let before = written;
        let start = range.start + written;
        let result = download_range_once(
            client,
            url,
            output,
            id,
            start,
            range.end,
            &downloaded,
            total_size,
            &on_progress,
            &mut written,
            handle,
            &cancel,
            limiters,
        )
        .await;

        match result {
            Ok(StreamStop::Cancelled) => return Ok(DownloadOutcome::Cancelled),
            Ok(StreamStop::Paused) => continue,
            Ok(StreamStop::Ended) => {
                if written >= segment_len {
                    break;
                }
                // The server hung up early. Treat it as a failed attempt so a
                // server that keeps truncating can't spin here forever.
                if attempt >= max_retries {
                    bail!("segment {id} ended {} bytes short after {max_retries} retries", segment_len - written);
                }
                attempt += 1;
                backoff(attempt).await;
            }
            Err(e) => {
                // Roll the counter back to the last byte we know landed on disk.
                downloaded.fetch_sub(written - before, Ordering::Relaxed);
                handle.set_segment_bytes(id, before);
                written = before;

                if attempt >= max_retries {
                    bail!("segment {id} failed after {max_retries} retries: {e}");
                }
                attempt += 1;
                eprintln!("segment {id} error: {e} (retry {attempt}/{max_retries})");
                backoff(attempt).await;
            }
        }

        // Any progress at all means the connection is usable again, so don't
        // hold earlier blips against it.
        if written > before {
            attempt = 0;
        }
    }

    Ok(DownloadOutcome::Completed)
}

async fn backoff(attempt: u32) {
    tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
}

#[allow(clippy::too_many_arguments)]
async fn download_range_once(
    client: &Client,
    url: &str,
    output: &PathBuf,
    id: usize,
    start: u64,
    end: u64,
    downloaded: &Arc<AtomicU64>,
    total_size: u64,
    on_progress: &ProgressCallback,
    written: &mut u64,
    handle: &DownloadHandle,
    cancel: &CancellationToken,
    limiters: &Limiters,
) -> Result<StreamStop> {
    let resp = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(StreamStop::Cancelled),
        resp = client
            .get(url)
            .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
            .send() => resp.context("GET request failed")?,
    };

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
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                file.flush().await.ok();
                return Ok(StreamStop::Cancelled);
            }
            chunk = stream.next() => chunk,
        };

        let Some(chunk) = next else { break };
        let chunk = chunk.context("error while streaming chunk")?;

        limiters.acquire(chunk.len() as u64).await;
        file.write_all(&chunk).await.context("write failed")?;

        let len = chunk.len() as u64;
        *written += len;
        handle.set_segment_bytes(id, *written);
        let total_downloaded = downloaded.fetch_add(len, Ordering::Relaxed) + len;
        on_progress(total_downloaded, total_size);

        if handle.is_paused() {
            file.flush().await.ok();
            return Ok(StreamStop::Paused);
        }
    }

    file.flush().await.ok();
    Ok(StreamStop::Ended)
}

async fn download_single(
    client: &Client,
    opts: &DownloadOptions,
    handle: &DownloadHandle,
    on_progress: ProgressCallback,
) -> Result<DownloadOutcome> {
    let cancel = handle.cancel_token();

    let resp = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(DownloadOutcome::Cancelled),
        resp = client.get(&opts.url).send() => resp.context("GET request failed")?,
    };
    if !resp.status().is_success() {
        bail!("unexpected status {}", resp.status());
    }
    let total_size = resp.content_length().unwrap_or(0);

    // Without Range support the whole file is one segment, so report it as one.
    // There's nothing to resume from either, hence the zero.
    handle.set_segments([(0, total_size.saturating_sub(1), 0)]);

    let mut file = tokio::fs::File::create(&opts.output)
        .await
        .with_context(|| format!("failed to create {}", opts.output.display()))?;

    let limiters = Limiters {
        per_file: opts.max_bytes_per_sec.map(SharedRateLimiter::new),
        global: opts.global_limiter.clone(),
    };

    let mut stream = resp.bytes_stream();
    let mut downloaded = 0u64;
    loop {
        // A single connection can't be resumed from an offset, so pausing here
        // just stalls the read rather than tearing the connection down.
        handle.wait_while_paused().await;

        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                file.flush().await.ok();
                return Ok(DownloadOutcome::Cancelled);
            }
            chunk = stream.next() => chunk,
        };

        let Some(chunk) = next else { break };
        let chunk = chunk.context("error while streaming chunk")?;

        limiters.acquire(chunk.len() as u64).await;
        file.write_all(&chunk).await.context("write failed")?;

        downloaded += chunk.len() as u64;
        handle.set_segment_bytes(0, downloaded);
        on_progress(downloaded, total_size);
    }
    file.flush().await.ok();

    Ok(DownloadOutcome::Completed)
}
