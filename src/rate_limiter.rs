use std::time::{Duration, Instant};

/// Token-bucket limiter: caps throughput at `rate_bytes_per_sec` for whatever
/// it's attached to (one instance per connection, since the limit is per-connection).
pub struct RateLimiter {
    rate_bytes_per_sec: u64,
    tokens: f64,
    last_refill: Instant,
}

impl RateLimiter {
    pub fn new(rate_bytes_per_sec: u64) -> Self {
        Self {
            rate_bytes_per_sec,
            tokens: rate_bytes_per_sec as f64,
            last_refill: Instant::now(),
        }
    }

    /// Blocks until `bytes` worth of budget is available.
    pub async fn acquire(&mut self, bytes: u64) {
        if self.rate_bytes_per_sec == 0 {
            return;
        }
        loop {
            self.refill();
            if self.tokens >= bytes as f64 {
                self.tokens -= bytes as f64;
                return;
            }
            let deficit = bytes as f64 - self.tokens;
            let wait_secs = deficit / self.rate_bytes_per_sec as f64;
            tokio::time::sleep(Duration::from_secs_f64(wait_secs)).await;
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.rate_bytes_per_sec as f64).min(self.rate_bytes_per_sec as f64);
        self.last_refill = now;
    }
}
