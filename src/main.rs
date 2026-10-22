use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::Client;

use download_engine::{download, DownloadOptions};

/// Segmented, multi-connection downloader (IDM-style core engine).
#[derive(Parser)]
struct Cli {
    /// URL of the file to download
    url: String,

    /// Output file path (defaults to the file name from the URL)
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// Max number of parallel connections/segments
    #[arg(short = 'n', long, default_value_t = 8)]
    segments: u32,
}

fn guess_filename(url: &str) -> PathBuf {
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

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let output = cli.output.unwrap_or_else(|| guess_filename(&cli.url));

    let client = Client::builder()
        .user_agent(concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION")))
        .build()?;

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
        url: cli.url,
        output: output.clone(),
        max_segments: cli.segments,
        ..Default::default()
    };

    download(&client, opts, on_progress).await?;

    pb.finish_with_message("done");
    println!("Saved to {}", output.display());

    Ok(())
}
