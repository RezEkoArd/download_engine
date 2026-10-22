use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Token-bucket throttle that several downloads can share.
///
/// Cloning gives another handle to the *same* bucket, so one instance can cap
/// the whole app while another caps a single file. The rate can be changed
/// while downloads are running; `0` means unlimited.
#[derive(Clone)]
pub struct SharedRateLimiter {
    rate: Arc<AtomicU64>,
    bucket: Arc<Mutex<Bucket>>,
}

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

impl SharedRateLimiter {
    pub fn new(bytes_per_sec: u64) -> Self {
        Self {
            rate: Arc::new(AtomicU64::new(bytes_per_sec)),
            bucket: Arc::new(Mutex::new(Bucket {
                tokens: bytes_per_sec as f64,
                last_refill: Instant::now(),
            })),
        }
    }

    /// Unlimited until `set_rate` says otherwise.
    pub fn unlimited() -> Self {
        Self::new(0)
    }

    pub fn rate(&self) -> u64 {
        self.rate.load(Ordering::Relaxed)
    }

    /// Changes the cap for every download sharing this limiter. `0` lifts it.
    pub fn set_rate(&self, bytes_per_sec: u64) {
        self.rate.store(bytes_per_sec, Ordering::Relaxed);
        if let Ok(mut bucket) = self.bucket.lock() {
            // Re-anchor so a changed cap takes effect now instead of paying off
            // debt accrued under the old one.
            bucket.tokens = bucket.tokens.min(bytes_per_sec as f64);
            bucket.last_refill = Instant::now();
        }
    }

    /// Blocks until `bytes` worth of budget is available.
    pub async fn acquire(&self, bytes: u64) {
        loop {
            let wait = {
                let rate = self.rate.load(Ordering::Relaxed);
                if rate == 0 {
                    return;
                }
                let Ok(mut bucket) = self.bucket.lock() else { return };

                let now = Instant::now();
                let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
                bucket.tokens = (bucket.tokens + elapsed * rate as f64).min(rate as f64);
                bucket.last_refill = now;

                if bucket.tokens >= bytes as f64 {
                    bucket.tokens -= bytes as f64;
                    return;
                }
                // A chunk larger than the bucket itself would never fit, so wait
                // for as much as the bucket can hold rather than the full chunk.
                let needed = (bytes as f64).min(rate as f64) - bucket.tokens;
                Duration::from_secs_f64((needed / rate as f64).max(0.0))
            };

            tokio::time::sleep(wait).await;
        }
    }
}

impl Default for SharedRateLimiter {
    fn default() -> Self {
        Self::unlimited()
    }
}
