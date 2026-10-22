use std::sync::Arc;

use anyhow::Result;
use reqwest::Client;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::{download, DownloadOptions, DownloadOutcome, ProgressCallback};

#[derive(Debug, Clone)]
pub struct QueueOptions {
    /// Max number of files downloading at the same time.
    pub concurrency: usize,
}

impl Default for QueueOptions {
    fn default() -> Self {
        Self { concurrency: 1 }
    }
}

/// Called with `(job_index, bytes_downloaded_so_far, total_bytes)` as each job progresses.
pub type QueueProgressCallback = Arc<dyn Fn(usize, u64, u64) + Send + Sync>;

/// Runs a batch of downloads with at most `concurrency` active at once.
/// Returns one result per job, in the same order the jobs were given.
pub async fn run_queue(
    client: &Client,
    jobs: Vec<DownloadOptions>,
    queue_opts: QueueOptions,
    on_progress: QueueProgressCallback,
) -> Vec<Result<DownloadOutcome>> {
    let semaphore = Arc::new(Semaphore::new(queue_opts.concurrency.max(1)));
    let num_jobs = jobs.len();
    let mut tasks = JoinSet::new();

    for (index, opts) in jobs.into_iter().enumerate() {
        let client = client.clone();
        let semaphore = semaphore.clone();
        let on_progress = on_progress.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.expect("semaphore closed");
            let cb: ProgressCallback = Arc::new(move |downloaded, total| {
                on_progress(index, downloaded, total);
            });
            (index, download(&client, opts, cb).await)
        });
    }

    let mut results: Vec<Option<Result<DownloadOutcome>>> = (0..num_jobs).map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok((index, result)) => results[index] = Some(result),
            Err(e) => eprintln!("a queue job panicked: {e}"),
        }
    }

    results.into_iter().map(|r| r.unwrap_or_else(|| Err(anyhow::anyhow!("job task panicked")))).collect()
}
