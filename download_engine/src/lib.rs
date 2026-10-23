mod control;
mod downloader;
mod filename;
mod rate_limiter;
mod resume;
pub mod queue;

pub use control::{DownloadHandle, DownloadOutcome, SegmentSnapshot};
pub use downloader::{
    build_client, download, download_with_handle, guess_filename, probe, DownloadOptions, ProbeInfo,
    ProgressCallback, DEFAULT_USER_AGENT,
};
/// Exported so a caller that takes a file name from anywhere untrusted — a
/// browser extension, a config file — can put it through the same check the
/// engine applies to `Content-Disposition`.
pub use filename::{filename_from_content_disposition, sanitize_filename};
/// Re-exported so callers can fill `DownloadOptions::headers` without taking
/// their own dependency on reqwest, and without risking a version mismatch
/// against the one the engine is built with.
pub use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
pub use resume::{discard_partial, sidecar_path, ResumeState, SegmentCheckpoint};
pub use queue::{run_queue, QueueOptions, QueueProgressCallback};
pub use rate_limiter::SharedRateLimiter;
