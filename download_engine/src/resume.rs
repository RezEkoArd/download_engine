use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::downloader::ProbeInfo;

/// Bumped when the on-disk shape changes; older files are then ignored.
const FORMAT_VERSION: u32 = 1;
const SIDECAR_SUFFIX: &str = ".dengine-part";
const SIDECAR_TMP_SUFFIX: &str = ".dengine-part.tmp";

/// How far one segment has got, so a later run can pick it up mid-range.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentCheckpoint {
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
}

impl SegmentCheckpoint {
    pub fn total(&self) -> u64 {
        self.end.saturating_sub(self.start) + 1
    }

    fn is_sane(&self) -> bool {
        self.end >= self.start && self.downloaded <= self.total()
    }
}

/// Sidecar written next to a partial download so it can continue after the
/// app closes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeState {
    version: u32,
    pub url: String,
    pub total_size: u64,
    /// Validators captured when the download started. If the server now
    /// reports different ones the file changed underneath us.
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub segments: Vec<SegmentCheckpoint>,
}

/// `<output>.dengine-part`, kept beside the file so moving the download moves
/// its progress too.
pub fn sidecar_path(output: &Path) -> PathBuf {
    suffixed(output, SIDECAR_SUFFIX)
}

/// Staging file for an atomic sidecar write. Built by appending rather than
/// `with_extension`, which would turn `foo.zip.dengine-part` into `foo.zip.tmp`
/// and risk clobbering something else.
fn sidecar_tmp_path(output: &Path) -> PathBuf {
    suffixed(output, SIDECAR_TMP_SUFFIX)
}

fn suffixed(output: &Path, suffix: &str) -> PathBuf {
    let mut name = output.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    output.with_file_name(name)
}

impl ResumeState {
    pub fn new(url: &str, info: &ProbeInfo, segments: Vec<SegmentCheckpoint>) -> Self {
        Self {
            version: FORMAT_VERSION,
            url: url.to_string(),
            total_size: info.total_size,
            etag: info.etag.clone(),
            last_modified: info.last_modified.clone(),
            segments,
        }
    }

    pub fn downloaded(&self) -> u64 {
        self.segments.iter().map(|s| s.downloaded).sum()
    }

    /// Reads the sidecar, or `None` when it's absent, unreadable or written by
    /// a different version. A bad sidecar just means starting over, never an
    /// error the user has to deal with.
    pub async fn load(output: &Path) -> Option<Self> {
        let raw = tokio::fs::read_to_string(sidecar_path(output)).await.ok()?;
        let state: Self = serde_json::from_str(&raw).ok()?;
        (state.version == FORMAT_VERSION).then_some(state)
    }

    pub async fn save(&self, output: &Path) -> Result<()> {
        let path = sidecar_path(output);
        let raw = serde_json::to_string(self).context("failed to encode resume state")?;

        // Write then rename, so an interrupted save can't replace a good
        // sidecar with a truncated one.
        let tmp = sidecar_tmp_path(output);
        tokio::fs::write(&tmp, raw)
            .await
            .with_context(|| format!("failed to write {}", tmp.display()))?;
        tokio::fs::rename(&tmp, &path)
            .await
            .with_context(|| format!("failed to replace {}", path.display()))?;
        Ok(())
    }

    pub async fn clear(output: &Path) {
        let _ = tokio::fs::remove_file(sidecar_path(output)).await;
        // A save aborted between write and rename leaves this behind.
        let _ = tokio::fs::remove_file(sidecar_tmp_path(output)).await;
    }

    /// Whether this sidecar still describes the file the server is offering.
    ///
    /// Validators are only compared when both sides have one: plenty of
    /// servers send neither, and demanding them would disable resume there.
    pub fn is_valid_for(&self, url: &str, info: &ProbeInfo) -> bool {
        if self.url != url || self.total_size != info.total_size || self.segments.is_empty() {
            return false;
        }
        if !self.segments.iter().all(SegmentCheckpoint::is_sane) {
            return false;
        }
        // Ranges must still tile the whole file, or the gaps would be left
        // as whatever bytes the filesystem had there.
        if !self.covers_whole_file() {
            return false;
        }
        if let (Some(theirs), Some(ours)) = (&info.etag, &self.etag) {
            if theirs != ours {
                return false;
            }
        }
        if let (Some(theirs), Some(ours)) = (&info.last_modified, &self.last_modified) {
            if theirs != ours {
                return false;
            }
        }
        true
    }

    fn covers_whole_file(&self) -> bool {
        let mut expected_start = 0u64;
        for segment in &self.segments {
            if segment.start != expected_start {
                return false;
            }
            expected_start = segment.end + 1;
        }
        expected_start == self.total_size
    }
}

/// Confirms the partial file is still the pre-allocated size we left it at.
/// A shorter file means something else touched it, so resuming would write
/// into the wrong offsets.
pub async fn partial_file_matches(output: &Path, total_size: u64) -> bool {
    tokio::fs::metadata(output)
        .await
        .map(|meta| meta.len() == total_size)
        .unwrap_or(false)
}

/// Removes a download's partial file along with its sidecar.
pub async fn discard_partial(output: &Path) {
    let _ = tokio::fs::remove_file(output).await;
    ResumeState::clear(output).await;
}
