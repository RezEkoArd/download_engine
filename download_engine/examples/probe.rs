//! Prints what the engine learns from a HEAD request, for diagnosing why a
//! given server does or doesn't get the segmented path.
//!
//! cargo run -p download_engine --example probe -- <url>

use anyhow::Result;
use download_engine::{build_client, probe};

#[tokio::main]
async fn main() -> Result<()> {
    let url = std::env::args().nth(1).expect("usage: probe <url>");
    let client = build_client(None)?;
    let info = probe(&client, &url).await?;

    println!("total_size     : {}", info.total_size);
    println!("supports_range : {}", info.supports_range);
    println!("etag           : {:?}", info.etag);
    println!("last_modified  : {:?}", info.last_modified);
    Ok(())
}
