use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// How a download ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadOutcome {
    Completed,
    Cancelled,
}

/// Point-in-time copy of one segment's progress, safe to hand to a UI.
#[derive(Debug, Clone, Copy)]
pub struct SegmentSnapshot {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
    pub total: u64,
}

struct Segment {
    start: u64,
    end: u64,
    downloaded: AtomicU64,
}

#[derive(Default)]
struct Inner {
    cancel: CancellationToken,
    paused: AtomicBool,
    resume: Notify,
    segments: RwLock<Vec<Segment>>,
}

/// Controls and observes one running download.
///
/// Clones share the same state, so the caller can hold a handle, hand a clone
/// to [`crate::download_with_handle`], and pause, resume, cancel or read
/// per-segment progress from anywhere while the download runs.
#[derive(Clone, Default)]
pub struct DownloadHandle {
    inner: Arc<Inner>,
}

impl DownloadHandle {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stops the transfer at the next chunk boundary. Bytes already written
    /// stay on disk, so [`resume`](Self::resume) picks up where it left off.
    pub fn pause(&self) {
        self.inner.paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.inner.paused.store(false, Ordering::SeqCst);
        self.inner.resume.notify_waiters();
    }

    /// Ends the download for good; it resolves with [`DownloadOutcome::Cancelled`].
    pub fn cancel(&self) {
        self.inner.cancel.cancel();
        // Wake anything parked on pause so it can see the cancel.
        self.inner.resume.notify_waiters();
    }

    pub fn is_paused(&self) -> bool {
        self.inner.paused.load(Ordering::SeqCst)
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancel.is_cancelled()
    }

    /// Per-segment progress. Empty until the download has split the file,
    /// and single-entry when the server has no Range support.
    pub fn segments(&self) -> Vec<SegmentSnapshot> {
        let Ok(segments) = self.inner.segments.read() else {
            return Vec::new();
        };
        segments
            .iter()
            .enumerate()
            .map(|(index, segment)| SegmentSnapshot {
                index,
                start: segment.start,
                end: segment.end,
                downloaded: segment.downloaded.load(Ordering::Relaxed),
                total: segment.end.saturating_sub(segment.start) + 1,
            })
            .collect()
    }

    pub(crate) fn cancel_token(&self) -> CancellationToken {
        self.inner.cancel.clone()
    }

    /// Seeds the segment table. `downloaded` is non-zero when picking a
    /// partial file back up from a previous run.
    pub(crate) fn set_segments(&self, ranges: impl IntoIterator<Item = (u64, u64, u64)>) {
        let Ok(mut segments) = self.inner.segments.write() else {
            return;
        };
        *segments = ranges
            .into_iter()
            .map(|(start, end, downloaded)| Segment {
                start,
                end,
                downloaded: AtomicU64::new(downloaded),
            })
            .collect();
    }

    /// Records a segment's running total. Takes the cumulative count rather
    /// than a delta so a rolled-back retry can simply rewind it.
    pub(crate) fn set_segment_bytes(&self, index: usize, bytes: u64) {
        let Ok(segments) = self.inner.segments.read() else {
            return;
        };
        if let Some(segment) = segments.get(index) {
            segment.downloaded.store(bytes, Ordering::Relaxed);
        }
    }

    /// Parks until resumed or cancelled.
    pub(crate) async fn wait_while_paused(&self) {
        loop {
            if !self.is_paused() || self.is_cancelled() {
                return;
            }

            let notified = self.inner.resume.notified();
            tokio::pin!(notified);
            // Register before re-checking, otherwise a resume landing between
            // the check and the await would be missed.
            notified.as_mut().enable();

            if !self.is_paused() || self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}
