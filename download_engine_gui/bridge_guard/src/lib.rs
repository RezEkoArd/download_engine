//! The browser bridge's authorisation boundary, kept apart from the app.
//!
//! These are the checks that stand between a caller on loopback and a queued
//! download; `bridge.rs` in the GUI crate explains why the bridge is shaped the
//! way it is and what each check is defending against.
//!
//! ## Why its own crate
//!
//! Purely so the checks can be tested. The GUI crate links Tauri, and on
//! Windows that means a static import of `TaskDialogIndirect` from Common
//! Controls v6 plus a `WebView2Loader.dll` at load time. The application
//! manifest that redirects `comctl32.dll` to v6 is embedded only into *binary*
//! targets — `embed_resource::compile` emits `cargo:rustc-link-arg-bins` — so a
//! `cargo test --lib` harness for that crate is a binary with no manifest, and
//! the Windows loader kills it with `STATUS_ENTRYPOINT_NOT_FOUND` before a
//! single test runs. That is toolchain-independent: it is a Cargo directive, so
//! MSVC fails the same way.
//!
//! These functions are pure and need none of that, so they live here, where the
//! test harness links `http` and `getrandom` and nothing else.

use http::header::{HeaderMap, HeaderValue, ORIGIN};

/// Where the token is carried. A non-standard name on purpose: it is what
/// forces the preflight that keeps web pages out.
pub const TOKEN_HEADER: &str = "x-download-engine-token";

/// 32 random bytes as hex.
///
/// Failure is returned rather than papered over with a time-based fallback: a
/// guessable token is worse than no bridge at all.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("no OS random source, refusing to invent a token: {e}"))?;
    Ok(bytes.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write;
        let _ = write!(acc, "{b:02x}");
        acc
    }))
}

/// Compares without an early exit, so how long the check takes says nothing
/// about how many leading bytes were right. The length comparison is fine to
/// leak: the token's length is fixed and public.
pub fn token_matches(expected: &str, provided: &[u8]) -> bool {
    let expected = expected.as_bytes();
    if expected.len() != provided.len() {
        return false;
    }
    expected.iter().zip(provided).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

pub enum OriginCheck {
    /// Carries the value to echo back, or `None` when no `Origin` was sent.
    Allowed(Option<HeaderValue>),
    Rejected,
}

/// Accepts extension origins, and requests with no `Origin` at all.
///
/// The missing-origin case has to pass: Chrome does not always attach one to a
/// fetch from an extension service worker, and command-line testing with curl
/// sends none either. That is safe because a browser *always* attaches an
/// `Origin` to a cross-origin fetch from a page, so "absent" is never a web
/// page — and the token is still required regardless.
///
/// `null` is rejected along with `http(s)`: that is what a sandboxed iframe
/// gets, and echoing it back would hand that iframe a working preflight.
pub fn check_origin(headers: &HeaderMap) -> OriginCheck {
    let Some(value) = headers.get(ORIGIN) else {
        return OriginCheck::Allowed(None);
    };
    let Ok(origin) = value.to_str() else {
        return OriginCheck::Rejected;
    };
    if origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://") {
        OriginCheck::Allowed(Some(value.clone()))
    } else {
        OriginCheck::Rejected
    }
}

/// The only tests in the project so far, because these two functions are the
/// whole authorisation boundary: everything past them can queue a download.
/// They're also pure, so they're testable without standing up a listener.
#[cfg(test)]
mod tests {
    use super::*;

    fn with_origin(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, HeaderValue::from_str(value).unwrap());
        headers
    }

    fn allowed(headers: &HeaderMap) -> bool {
        matches!(check_origin(headers), OriginCheck::Allowed(_))
    }

    #[test]
    fn extension_origins_pass() {
        assert!(allowed(&with_origin("chrome-extension://abcdefghijklmnop")));
        assert!(allowed(&with_origin("moz-extension://abcdefghijklmnop")));
    }

    #[test]
    fn web_page_origins_are_rejected() {
        assert!(!allowed(&with_origin("https://evil.example")));
        assert!(!allowed(&with_origin("http://localhost:3000")));
        // A sandboxed iframe reports this; echoing it back would give it a
        // preflight that works.
        assert!(!allowed(&with_origin("null")));
    }

    #[test]
    fn a_missing_origin_passes_because_the_token_still_guards_it() {
        assert!(allowed(&HeaderMap::new()));
    }

    #[test]
    fn origin_prefix_cannot_be_spoofed_by_a_hostname() {
        // Without anchoring on the scheme, a host *named* like an extension
        // would sail through.
        assert!(!allowed(&with_origin("https://chrome-extension.evil.example")));
    }

    #[test]
    fn token_comparison() {
        let token = "a".repeat(64);
        assert!(token_matches(&token, token.as_bytes()));
        assert!(!token_matches(&token, b""));
        assert!(!token_matches(&token, "a".repeat(63).as_bytes()));
        assert!(!token_matches(&token, format!("{}b", "a".repeat(63)).as_bytes()));
    }

    #[test]
    fn generated_tokens_are_hex_and_differ() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
