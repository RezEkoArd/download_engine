use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::Client;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::control::{DownloadHandle, DownloadOutcome};
use crate::filename::{filename_from_content_disposition, sanitize_filename};
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
    /// Extra headers sent with every request this download makes — the probe
    /// and each segment alike.
    ///
    /// Exists for links that only resolve with the browser's context: a session
    /// `Cookie`, a `Referer` the server checks, or a `User-Agent` it expects.
    /// Fetching those with a bare request usually returns a login page or a
    /// 403 rather than the file.
    ///
    /// Safe across redirects: reqwest drops `Cookie` and `Authorization` when a
    /// redirect changes host, port, or scheme, so credentials put here don't
    /// follow a link off to another origin.
    pub headers: HeaderMap,
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
            headers: HeaderMap::new(),
        }
    }
}

/// What the server told us about the target, without downloading it.
#[derive(Debug, Clone, Default)]
pub struct ProbeInfo {
    pub total_size: u64,
    pub supports_range: bool,
    /// Validators used to confirm a partial file still matches the server's
    /// copy before resuming it.
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    /// File name the server asked for via `Content-Disposition`, already
    /// reduced to a safe single component by [`sanitize_filename`].
    ///
    /// Only a suggestion: a caller that already has a name the *user* chose
    /// should keep it. `None` means the server offered nothing usable, and the
    /// URL-derived [`guess_filename`] stands.
    pub suggested_filename: Option<String>,
}

/// How often the partial download's progress is checkpointed to disk.
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(2);

/// Largest byte range asked for in a single request.
///
/// A segment is fetched as a run of these rather than as one range spanning the
/// whole segment. Some servers cap how much they will serve per request and
/// answer anything larger with an error page instead of a 206 — Google Drive
/// refuses past roughly 32 MiB on a quota-limited file — which splitting a
/// 1 GiB file into eight 128 MiB ranges walks straight into.
///
/// It also narrows what a dropped connection costs: a stall rewinds to the last
/// completed slice, not to the start of a segment.
const MAX_RANGE_CHUNK: u64 = 8 * 1024 * 1024;

/// Inclusive end of the next slice to request, starting at `start`.
///
/// Never past `segment_end` — the segments must not overlap, or they would
/// write over each other's bytes.
fn chunk_end(start: u64, segment_end: u64) -> u64 {
    segment_end.min(start.saturating_add(MAX_RANGE_CHUNK - 1))
}

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
///
/// The URL is as untrusted as any header, so the segment goes through
/// [`sanitize_filename`] too; `download.bin` covers everything that leaves
/// nothing usable behind.
pub fn guess_filename(url: &str) -> PathBuf {
    let name = url.rsplit('/').next().unwrap_or_default().split('?').next().unwrap_or_default();
    PathBuf::from(sanitize_filename(name).unwrap_or_else(|| "download.bin".to_string()))
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
    // Range belongs to the engine: it sets one per segment. reqwest's `header`
    // appends rather than replaces, so a caller-supplied Range wouldn't
    // override ours, it would ride along beside it and leave the server to
    // guess. Drop it once here rather than at each request site.
    let mut opts = opts;
    opts.headers.remove(reqwest::header::RANGE);

    ensure_parent_dir(&opts.output).await?;

    if handle.is_cancelled() {
        return Ok(DownloadOutcome::Cancelled);
    }

    let info = probe(client, &opts.url, &opts.headers).await?;
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
        let extra_headers = opts.headers.clone();
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
                &extra_headers,
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
///
/// `extra_headers` has to match what the segments will send. A probe made
/// without the caller's cookies can answer about a login page instead of the
/// file, and the whole download would then be planned around the wrong size.
pub async fn probe(client: &Client, url: &str, extra_headers: &HeaderMap) -> Result<ProbeInfo> {
    let head = client.head(url).headers(extra_headers.clone()).send().await;

    let from_head = match &head {
        Ok(resp) if resp.status().is_success() => Some(probe_info_from_headers(resp.headers(), None)),
        _ => None,
    };

    // A HEAD answer is kept only when it actually describes the file. Servers
    // that answer HEAD with a stub — no size, no `Accept-Ranges` — are common,
    // and Google Drive goes further: it answers HEAD and plain GET with an
    // HTML quota page while serving the real bytes to a ranged GET. Believing
    // the stub drops us to one unresumable connection and, worse, downloads
    // that error page as if it were the file.
    if let Some(info) = &from_head {
        if info.total_size > 0 && info.supports_range {
            return Ok(from_head.expect("checked by the `if let` above"));
        }
    }

    // So ask the way the segments themselves will. A 206 answers both questions
    // at once and leaves no room for interpretation: the server demonstrably
    // honoured a range, and `Content-Range` carries the total size. One byte of
    // body is a cheaper price than a corrupt download.
    let ranged = client
        .get(url)
        .headers(extra_headers.clone())
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await;

    if let Ok(resp) = &ranged {
        if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            return Ok(probe_info_from_headers(resp.headers(), Some(resp.status())));
        }
    }

    // Neither request proved range support. A usable HEAD answer still beats
    // failing outright — a small file served without `Accept-Ranges` downloads
    // fine on one connection.
    if let Some(info) = from_head {
        return Ok(info);
    }

    match head {
        Ok(resp) => bail!("server returned {} for HEAD request", resp.status()),
        Err(err) => Err(err).context("HEAD request failed"),
    }
}

/// Reads a [`ProbeInfo`] out of response headers.
///
/// `ranged_status` is the status of a `Range` request when these headers came
/// from one, and `None` when they came from HEAD. It is what distinguishes a
/// server that *claims* range support from one that just showed it.
fn probe_info_from_headers(headers: &HeaderMap, ranged_status: Option<reqwest::StatusCode>) -> ProbeInfo {
    let header_string = |name: reqwest::header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);

    let is_partial = ranged_status == Some(reqwest::StatusCode::PARTIAL_CONTENT);

    // On a 206 the only size that means anything is the total in
    // `Content-Range`; `Content-Length` there describes the one byte we asked
    // for. Off a HEAD, read `Content-Length` from the headers rather than
    // `Response::content_length()`, which reports the (absent) body size.
    let declared_size = if is_partial {
        header_string(reqwest::header::CONTENT_RANGE)
            .as_deref()
            .and_then(total_from_content_range)
    } else {
        headers
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
    };

    let supports_range = is_partial
        || headers
            .get(reqwest::header::ACCEPT_RANGES)
            .map(|v| v.as_bytes() == b"bytes")
            .unwrap_or(false);

    // Sanitised here rather than at the caller: this is where an attacker-chosen
    // string crosses into the engine, and a `ProbeInfo` that could carry
    // `..\..\evil.exe` would make every consumer responsible for remembering.
    let suggested_filename = header_string(reqwest::header::CONTENT_DISPOSITION)
        .as_deref()
        .and_then(filename_from_content_disposition);

    ProbeInfo {
        total_size: declared_size.unwrap_or(0),
        supports_range,
        etag: header_string(reqwest::header::ETAG),
        last_modified: header_string(reqwest::header::LAST_MODIFIED),
        suggested_filename,
    }
}

/// Total size out of `Content-Range: bytes 0-0/1305405360`.
///
/// `None` for the `*/` form, which a server sends when it is honouring the
/// range but does not know the total — a value we must not invent.
fn total_from_content_range(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.trim().parse().ok()
}

/// First byte offset out of `Content-Range: bytes 500000000-500000199/1305405360`.
///
/// `None` when the server states no concrete range, which is not evidence of a
/// mismatch and so must not be treated as one.
fn start_from_content_range(value: &str) -> Option<u64> {
    let range = value.split('/').next()?.trim();
    let range = range.strip_prefix("bytes").unwrap_or(range).trim();
    range.split('-').next()?.trim().parse().ok()
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
#[allow(clippy::too_many_arguments)]
async fn download_range(
    client: &Client,
    url: &str,
    extra_headers: &HeaderMap,
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
        let slice_end = chunk_end(start, range.end);
        let slice_len = slice_end - start + 1;
        let result = download_range_once(
            client,
            url,
            extra_headers,
            output,
            id,
            start,
            slice_end,
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
                // A slice that arrived whole is a chunk boundary, not a
                // truncation: the next pass picks up where it left off. Without
                // this the normal case would be charged as a retry and a
                // segment longer than a few chunks could never finish.
                if written - before >= slice_len {
                    attempt = 0;
                    continue;
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
#[allow(clippy::too_many_arguments)]
async fn download_range_once(
    client: &Client,
    url: &str,
    extra_headers: &HeaderMap,
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
            .headers(extra_headers.clone())
            .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
            .send() => resp.context("GET request failed")?,
    };

    // Only a 206 may be written here. A 200 means the server did not honour the
    // Range and is sending something else entirely — the whole file, or an error
    // page — and dropping that at offset `start` corrupts the download silently.
    // Google Drive does exactly this once a file hits its download quota, and
    // `is_success()` waved the HTML through into the middle of the file while
    // the job still reported success.
    if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        bail!("server answered range {start}-{end} with status {}, not 206", resp.status());
    }

    // A server or proxy that honours Range but returns a different window would
    // corrupt the file just as quietly, so trust the offset it states over the
    // one we asked for.
    if let Some(actual) = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(start_from_content_range)
    {
        if actual != start {
            bail!("server returned range starting at {actual}, not {start}");
        }
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
        resp = client.get(&opts.url).headers(opts.headers.clone()).send() => resp.context("GET request failed")?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderName, HeaderValue};
    use reqwest::StatusCode;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn head_with_accept_ranges_and_length_is_enough() {
        let info = probe_info_from_headers(&headers(&[("content-length", "4096"), ("accept-ranges", "bytes")]), None);
        assert_eq!(info.total_size, 4096);
        assert!(info.supports_range);
    }

    #[test]
    fn head_without_accept_ranges_does_not_claim_range_support() {
        let info = probe_info_from_headers(&headers(&[("content-length", "4096")]), None);
        assert_eq!(info.total_size, 4096);
        assert!(!info.supports_range);
    }

    /// `Accept-Ranges: none` is an explicit refusal, not an omission.
    #[test]
    fn accept_ranges_none_is_not_range_support() {
        let info = probe_info_from_headers(&headers(&[("accept-ranges", "none")]), None);
        assert!(!info.supports_range);
    }

    /// The Google Drive quota page: HEAD answers 200 with no size and no
    /// `Accept-Ranges`, which is exactly the answer `probe` must refuse to
    /// settle for.
    #[test]
    fn useless_head_answer_is_recognisable_as_useless() {
        let info = probe_info_from_headers(&headers(&[("content-type", "text/html; charset=utf-8"), ("content-length", "0")]), None);
        assert_eq!(info.total_size, 0);
        assert!(!info.supports_range);
    }

    /// A 206 proves range support even though `Accept-Ranges` never appeared,
    /// and the size comes from `Content-Range`, not the one-byte body.
    #[test]
    fn partial_content_supplies_total_size_and_range_support() {
        let info = probe_info_from_headers(
            &headers(&[
                ("content-length", "1"),
                ("content-range", "bytes 0-0/1305405360"),
                ("content-disposition", "attachment; filename=\"Otakudesu.net_NtRu_720p.rar\""),
            ]),
            Some(StatusCode::PARTIAL_CONTENT),
        );
        assert_eq!(info.total_size, 1_305_405_360);
        assert!(info.supports_range);
        assert_eq!(info.suggested_filename.as_deref(), Some("Otakudesu.net_NtRu_720p.rar"));
    }

    #[test]
    fn unknown_total_in_content_range_is_not_invented() {
        let info = probe_info_from_headers(&headers(&[("content-range", "bytes 0-0/*")]), Some(StatusCode::PARTIAL_CONTENT));
        assert_eq!(info.total_size, 0);
        assert!(info.supports_range);
    }

    #[test]
    fn content_range_total_is_parsed() {
        assert_eq!(total_from_content_range("bytes 0-0/1305405360"), Some(1_305_405_360));
        assert_eq!(total_from_content_range("bytes 0-0/*"), None);
        assert_eq!(total_from_content_range("bytes */1024"), Some(1024));
        assert_eq!(total_from_content_range("garbage"), None);
    }

    #[test]
    fn chunks_never_exceed_the_cap() {
        assert_eq!(chunk_end(0, 1_305_405_359), MAX_RANGE_CHUNK - 1);
        assert_eq!(chunk_end(MAX_RANGE_CHUNK, 1_305_405_359), 2 * MAX_RANGE_CHUNK - 1);
    }

    /// The last slice of a segment is short, and must stop at the segment's own
    /// end — running past it would overwrite the next segment's bytes.
    #[test]
    fn chunks_stop_at_the_segment_end() {
        assert_eq!(chunk_end(100, 199), 199);
        assert_eq!(chunk_end(0, u64::MAX), MAX_RANGE_CHUNK - 1);
    }

    /// Walking a segment slice by slice must land exactly on its end, with no
    /// gap and no overlap.
    #[test]
    fn chunks_tile_a_segment_exactly() {
        let (start, end) = (163_175_670u64, 326_351_339u64);
        let mut at = start;
        let mut slices = 0;
        while at <= end {
            let stop = chunk_end(at, end);
            assert!(stop >= at && stop <= end);
            at = stop + 1;
            slices += 1;
        }
        assert_eq!(at, end + 1);
        assert_eq!(slices, 20);
    }

    #[test]
    fn content_range_start_is_parsed() {
        assert_eq!(start_from_content_range("bytes 500000000-500000199/1305405360"), Some(500_000_000));
        assert_eq!(start_from_content_range("bytes 0-0/*"), Some(0));
        // No concrete range stated: unknown, not a mismatch.
        assert_eq!(start_from_content_range("bytes */1024"), None);
        assert_eq!(start_from_content_range("garbage"), None);
    }

    #[test]
    fn validators_survive_both_paths() {
        let pairs = [("etag", "\"abc\""), ("last-modified", "Wed, 21 Oct 2026 07:28:00 GMT")];
        for status in [None, Some(StatusCode::PARTIAL_CONTENT)] {
            let info = probe_info_from_headers(&headers(&pairs), status);
            assert_eq!(info.etag.as_deref(), Some("\"abc\""));
            assert_eq!(info.last_modified.as_deref(), Some("Wed, 21 Oct 2026 07:28:00 GMT"));
        }
    }
}
