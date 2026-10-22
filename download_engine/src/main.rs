use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use clap::Parser;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

use download_engine::{build_client, download, guess_filename, run_queue, DownloadOptions, QueueOptions};

/// Segmented, multi-connection downloader (IDM-style core engine).
#[derive(Parser)]
struct Cli {
    /// URL(s) of the file(s) to download. Pass more than one to queue them.
    #[arg(required = true)]
    urls: Vec<String>,

    /// Output file path (only valid with a single URL; defaults to the file name from the URL)
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// Max number of parallel connections/segments per file
    #[arg(short = 'n', long, default_value_t = 8)]
    segments: u32,

    /// Bandwidth cap per file, e.g. "500KB", "2MB", "1GB" (split across its connections)
    #[arg(short = 'r', long = "limit")]
    limit: Option<String>,

    /// How many files to download at the same time when queuing multiple URLs
    #[arg(short = 'c', long, default_value_t = 1)]
    concurrency: usize,

    /// Delay the whole queue by this many seconds before starting (simple scheduling)
    #[arg(long = "start-in")]
    start_in: Option<u64>,

    /// How many times a segment may retry before the download fails
    #[arg(long, default_value_t = 5)]
    retries: u32,

    /// Override the User-Agent sent to servers
    #[arg(long = "user-agent")]
    user_agent: Option<String>,

    /// Ignore any partial file and download from the start
    #[arg(long = "no-resume")]
    no_resume: bool,
}

/// Parses a human rate like "500KB", "2MB", "1GB" or a bare number of bytes/sec.
fn parse_rate(input: &str) -> Result<u64> {
    let input = input.trim();
    let split_at = input.find(|c: char| !c.is_ascii_digit()).unwrap_or(input.len());
    let (number, unit) = input.split_at(split_at);
    let number: u64 = number.parse().with_context(|| format!("invalid rate '{input}'"))?;
    let multiplier = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1,
        "k" | "kb" => 1024,
        "m" | "mb" => 1024 * 1024,
        "g" | "gb" => 1024 * 1024 * 1024,
        other => bail!("unknown rate unit '{other}' (use B, KB, MB or GB)"),
    };
    Ok(number * multiplier)
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.output.is_some() && cli.urls.len() > 1 {
        bail!("-o/--output can only be used with a single URL; omit it when queuing multiple files");
    }

    let max_bytes_per_sec = cli.limit.as_deref().map(parse_rate).transpose()?;

    let client = build_client(cli.user_agent.as_deref())?;

    if let Some(secs) = cli.start_in {
        println!("Scheduled to start in {secs}s...");
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
    }

    if cli.urls.len() == 1 {
        let url = cli.urls.into_iter().next().unwrap();
        let output = cli.output.unwrap_or_else(|| guess_filename(&url));

        let pb = ProgressBar::new(0);
        pb.set_style(
            ProgressStyle::with_template(
                "{spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} ({bytes_per_sec}, eta {eta})",
            )?
            .progress_chars("#>-"),
        );

        let pb_for_cb = pb.clone();
        let on_progress = Arc::new(move |downloaded: u64, total: u64| {
            if total > 0 && pb_for_cb.length() != Some(total) {
                pb_for_cb.set_length(total);
            }
            pb_for_cb.set_position(downloaded);
        });

        let opts = DownloadOptions {
            url,
            output: output.clone(),
            max_segments: cli.segments,
            max_bytes_per_sec,
            max_retries: cli.retries,
            allow_resume: !cli.no_resume,
            ..Default::default()
        };

        download(&client, opts, on_progress).await?;

        pb.finish_with_message("done");
        println!("Saved to {}", output.display());
        return Ok(());
    }

    // Multiple URLs: run as a queue, one progress bar per file.
    let multi = MultiProgress::new();
    let style = ProgressStyle::with_template("{prefix:.bold} [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} ({bytes_per_sec})")?.progress_chars("#>-");

    let mut jobs = Vec::with_capacity(cli.urls.len());
    let mut bars = Vec::with_capacity(cli.urls.len());
    let mut outputs = Vec::with_capacity(cli.urls.len());

    for url in &cli.urls {
        let output = guess_filename(url);
        let bar = multi.add(ProgressBar::new(0));
        bar.set_style(style.clone());
        bar.set_prefix(output.display().to_string());

        jobs.push(DownloadOptions {
            url: url.clone(),
            output: output.clone(),
            max_segments: cli.segments,
            max_bytes_per_sec,
            max_retries: cli.retries,
            allow_resume: !cli.no_resume,
            ..Default::default()
        });
        bars.push(bar);
        outputs.push(output);
    }

    let bars = Arc::new(bars);
    let bars_for_cb = bars.clone();
    let on_progress = Arc::new(move |index: usize, downloaded: u64, total: u64| {
        let bar = &bars_for_cb[index];
        if total > 0 && bar.length() != Some(total) {
            bar.set_length(total);
        }
        bar.set_position(downloaded);
    });

    let queue_opts = QueueOptions {
        concurrency: cli.concurrency,
    };

    let results = run_queue(&client, jobs, queue_opts, on_progress).await;

    let mut had_error = false;
    for ((result, bar), output) in results.into_iter().zip(bars.iter()).zip(outputs.iter()) {
        match result {
            Ok(_) => bar.finish_with_message(format!("done -> {}", output.display())),
            Err(e) => {
                had_error = true;
                bar.abandon_with_message(format!("failed: {e}"));
            }
        }
    }

    if had_error {
        bail!("one or more downloads in the queue failed");
    }

    Ok(())
}
