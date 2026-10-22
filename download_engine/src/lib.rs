mod control;
mod downloader;
mod rate_limiter;
mod resume;
pub mod queue;

pub use control::{DownloadHandle, DownloadOutcome, SegmentSnapshot};
pub use downloader::{
    build_client, download, download_with_handle, guess_filename, probe, DownloadOptions, ProbeInfo,
    ProgressCallback, DEFAULT_USER_AGENT,
};
pub use resume::{discard_partial, sidecar_path, ResumeState, SegmentCheckpoint};
pub use queue::{run_queue, QueueOptions, QueueProgressCallback};
pub use rate_limiter::SharedRateLimiter;
