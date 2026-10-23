//! Turning a server-supplied `Content-Disposition` into a file name that is
//! safe to join onto an output directory.
//!
//! The header is attacker-controlled: whoever owns the URL owns its value. The
//! name it carries ends up concatenated with the download folder, so a value
//! like `..\..\Startup\evil.exe` would write outside that folder entirely.
//! Everything here exists to make that impossible, and the sanitising happens
//! in [`crate::probe`] so a name can't reach a caller unchecked.

/// Longest name we'll produce, in characters.
///
/// Well under the 255-byte component limit most filesystems have, leaving room
/// for the collision suffix a caller may append and for multi-byte characters
/// to cost more than one byte each.
const MAX_FILENAME_LEN: usize = 180;

/// Longest suffix still treated as an extension worth preserving when a long
/// name has to be truncated.
const MAX_EXT_LEN: usize = 20;

/// Names Windows reserves for devices, at any directory level and with any
/// extension. Opening one talks to the device rather than creating a file.
const RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
    "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Characters that can't appear in a Windows file name. `/` and `\` are handled
/// before this, by keeping only the last path component.
const FORBIDDEN: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// Bidirectional and zero-width formatting marks. Not `char::is_control` —
/// those are the Cc category and these are Cf — but they reorder how the rest
/// of the name is displayed, which is how `photo_<RLO>gpj.exe` shows up in a UI
/// as `photo_exe.jpg`.
const BIDI_CONTROLS: &[char] = &[
    '\u{200e}', '\u{200f}', '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}', '\u{202e}', '\u{2066}', '\u{2067}',
    '\u{2068}', '\u{2069}', '\u{200b}', '\u{feff}',
];

/// Reduces an untrusted string to a bare file name, or `None` if nothing usable
/// is left.
///
/// A `None` return means the caller must keep whatever name it already had:
/// falling back to some fragment of the input would hand the choice back to
/// whoever supplied it.
pub fn sanitize_filename(raw: &str) -> Option<String> {
    // Only the final component survives, so separators can't steer the write
    // anywhere: `../../evil` and `C:\abs\path` both collapse to their last
    // segment. Done before anything else, because every later step assumes it
    // is looking at a single name.
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    // A drive-relative `C:evil.txt` has no separator to split on, and on
    // Windows would resolve against that drive's current directory rather than
    // ours. Dropping everything up to the last colon also disposes of NTFS
    // alternate-stream syntax (`file.txt:hidden`).
    let last = last.rsplit_once(':').map_or(last, |(_, after)| after);

    let filtered: String = last
        .chars()
        // Control characters (NUL included) are rejected outright by the
        // filesystem, and in a UI they can hide what the name really is.
        .filter(|c| !c.is_control() && !FORBIDDEN.contains(c) && !BIDI_CONTROLS.contains(c))
        .collect();

    // Leading and trailing dots and spaces go: Windows silently strips them, so
    // `evil.exe .` is really `evil.exe`, and a name of only dots is either `.`
    // or `..` — both directories, not files.
    let trimmed = trim_dots_and_spaces(&filtered);
    if trimmed.is_empty() {
        return None;
    }

    // Truncating can expose a new trailing dot or space, so trim once more.
    let capped = cap_length(trimmed);
    let capped = trim_dots_and_spaces(&capped);
    if capped.is_empty() {
        return None;
    }

    // A reserved stem is prefixed rather than rejected: the rest of the name is
    // still the best description of the file we have.
    if is_reserved(capped) {
        return Some(format!("_{capped}"));
    }
    Some(capped.to_string())
}

/// Extracts the file name a `Content-Disposition` header suggests, already
/// sanitised, or `None` when it carries none we can use.
///
/// Prefers the RFC 5987 `filename*` form over plain `filename`, as RFC 6266
/// requires: a server sending both means the plain one as the ASCII fallback.
pub fn filename_from_content_disposition(header: &str) -> Option<String> {
    let params = parse_params(header);

    let encoded = params
        .iter()
        .filter(|(name, _)| name == "filename*")
        .find_map(|(_, value)| decode_ext_value(value))
        .and_then(|decoded| sanitize_filename(&decoded));
    if encoded.is_some() {
        return encoded;
    }

    params
        .iter()
        .filter(|(name, _)| name == "filename")
        .find_map(|(_, value)| sanitize_filename(value))
}

fn trim_dots_and_spaces(name: &str) -> &str {
    name.trim_matches(|c: char| c == '.' || c.is_whitespace())
}

/// Shortens an over-long name, keeping its extension so the file still opens
/// with the right program.
fn cap_length(name: &str) -> String {
    if name.chars().count() <= MAX_FILENAME_LEN {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.chars().count() <= MAX_EXT_LEN => (stem, format!(".{ext}")),
        // No usable extension — or one so long it is really just part of a name
        // that happens to contain dots.
        _ => (name, String::new()),
    };
    let keep = MAX_FILENAME_LEN.saturating_sub(ext.chars().count());
    let mut out: String = stem.chars().take(keep).collect();
    out.push_str(&ext);
    out
}

/// Whether the name's stem is a Windows device name. Checked against the part
/// before the first dot, since `CON.txt` and `con.tar.gz` are the device too.
fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim();
    RESERVED_STEMS.iter().any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// Splits a header value into lower-cased parameter names and their unquoted
/// values.
///
/// Hand-rolled rather than split on `;`, because a quoted value may contain one
/// — `filename="part1;part2.zip"` is a single parameter, and splitting it would
/// invent a second.
fn parse_params(header: &str) -> Vec<(String, String)> {
    let mut params = Vec::new();
    let mut chars = header.chars().peekable();

    loop {
        let mut name = String::new();
        let mut has_value = false;
        for c in chars.by_ref() {
            match c {
                '=' => {
                    has_value = true;
                    break;
                }
                // A bare token: the `attachment` / `inline` disposition itself.
                ';' => break,
                _ => name.push(c),
            }
        }

        if has_value {
            let name = name.trim().to_ascii_lowercase();
            let value = read_value(&mut chars);
            if !name.is_empty() {
                params.push((name, value));
            }
        }

        if chars.peek().is_none() {
            return params;
        }
    }
}

/// Reads one parameter value and consumes the `;` that ends it.
fn read_value(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    while chars.peek().is_some_and(|c| c.is_whitespace()) {
        chars.next();
    }

    let mut value = String::new();
    if chars.peek() == Some(&'"') {
        chars.next();
        while let Some(c) = chars.next() {
            match c {
                // Inside a quoted string, the next character is literal —
                // including a `"` that would otherwise end the value.
                '\\' => value.extend(chars.next()),
                '"' => break,
                _ => value.push(c),
            }
        }
        // Skip whatever sits between the closing quote and the next parameter.
        for c in chars.by_ref() {
            if c == ';' {
                break;
            }
        }
    } else {
        for c in chars.by_ref() {
            if c == ';' {
                break;
            }
            value.push(c);
        }
    }
    value.trim().to_string()
}

/// Decodes an RFC 5987 `charset'language'percent-encoded-value`.
fn decode_ext_value(value: &str) -> Option<String> {
    let mut parts = value.splitn(3, '\'');
    let charset = parts.next()?.trim().to_ascii_lowercase();
    let _language = parts.next()?;
    let bytes = percent_decode(parts.next()?);

    match charset.as_str() {
        // An empty charset is malformed, but UTF-8 is the only sane reading of
        // the bytes that follow and is a superset of US-ASCII.
        "utf-8" | "utf8" | "us-ascii" | "" => String::from_utf8(bytes).ok(),
        // Every byte is a code point in Latin-1, so this cannot fail.
        "iso-8859-1" | "latin1" => Some(bytes.into_iter().map(char::from).collect()),
        _ => None,
    }
}

fn percent_decode(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        // Not a valid escape: keep the byte as it stands rather than dropping
        // it, so a stray `%` doesn't silently eat the next two characters.
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_plain_name() {
        assert_eq!(sanitize_filename("report.pdf").as_deref(), Some("report.pdf"));
        assert_eq!(sanitize_filename("my file (1).tar.gz").as_deref(), Some("my file (1).tar.gz"));
    }

    #[test]
    fn strips_unix_traversal() {
        assert_eq!(sanitize_filename("../../evil").as_deref(), Some("evil"));
        assert_eq!(sanitize_filename("/etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(sanitize_filename("a/b/c/payload.exe").as_deref(), Some("payload.exe"));
    }

    #[test]
    fn strips_windows_traversal() {
        assert_eq!(sanitize_filename("..\\..\\evil").as_deref(), Some("evil"));
        assert_eq!(sanitize_filename("C:\\abs\\path").as_deref(), Some("path"));
        assert_eq!(sanitize_filename("\\\\server\\share\\file.bin").as_deref(), Some("file.bin"));
        // Mixed separators: whichever comes last still ends the traversal.
        assert_eq!(sanitize_filename("..\\../evil.exe").as_deref(), Some("evil.exe"));
    }

    #[test]
    fn rejects_names_that_are_only_traversal() {
        assert_eq!(sanitize_filename(".."), None);
        assert_eq!(sanitize_filename("."), None);
        assert_eq!(sanitize_filename("../"), None);
        assert_eq!(sanitize_filename("..\\"), None);
        assert_eq!(sanitize_filename(""), None);
        assert_eq!(sanitize_filename("   "), None);
        assert_eq!(sanitize_filename("..."), None);
    }

    #[test]
    fn drops_drive_relative_and_stream_syntax() {
        // Would resolve against C:'s current directory, not the output folder.
        assert_eq!(sanitize_filename("C:evil.txt").as_deref(), Some("evil.txt"));
        // NTFS alternate data stream: the bytes would land out of sight.
        assert_eq!(sanitize_filename("report.pdf:hidden").as_deref(), Some("hidden"));
    }

    #[test]
    fn strips_control_characters_and_nul() {
        assert_eq!(sanitize_filename("re\0port.pdf").as_deref(), Some("report.pdf"));
        assert_eq!(sanitize_filename("re\nport\t.pdf").as_deref(), Some("report.pdf"));
        // Right-to-left override, used to make "exe.pdf" read as "fdp.exe".
        assert_eq!(sanitize_filename("photo_\u{202e}gpj.exe").as_deref(), Some("photo_gpj.exe"));
    }

    #[test]
    fn strips_leading_and_trailing_dots_and_spaces() {
        // Windows drops the trailing dot, so the real target is "evil.exe".
        assert_eq!(sanitize_filename("evil.exe .").as_deref(), Some("evil.exe"));
        assert_eq!(sanitize_filename("  spaced.txt  ").as_deref(), Some("spaced.txt"));
        assert_eq!(sanitize_filename(".hidden").as_deref(), Some("hidden"));
    }

    #[test]
    fn prefixes_reserved_device_names() {
        assert_eq!(sanitize_filename("CON").as_deref(), Some("_CON"));
        assert_eq!(sanitize_filename("nul.txt").as_deref(), Some("_nul.txt"));
        assert_eq!(sanitize_filename("COM1.tar.gz").as_deref(), Some("_COM1.tar.gz"));
        assert_eq!(sanitize_filename("LPT9").as_deref(), Some("_LPT9"));
        assert_eq!(sanitize_filename("aux").as_deref(), Some("_aux"));
        // Only the exact stems are devices; these are ordinary files.
        assert_eq!(sanitize_filename("CONSOLE.txt").as_deref(), Some("CONSOLE.txt"));
        assert_eq!(sanitize_filename("COM10").as_deref(), Some("COM10"));
        assert_eq!(sanitize_filename("my-con.txt").as_deref(), Some("my-con.txt"));
    }

    #[test]
    fn caps_length_but_keeps_the_extension() {
        let long = format!("{}.zip", "a".repeat(500));
        let capped = sanitize_filename(&long).expect("a long name is still usable");
        assert_eq!(capped.chars().count(), MAX_FILENAME_LEN);
        assert!(capped.ends_with(".zip"));

        // No extension to preserve: just cut it short.
        let no_ext = sanitize_filename(&"b".repeat(500)).expect("usable");
        assert_eq!(no_ext.chars().count(), MAX_FILENAME_LEN);

        // Multi-byte characters are counted as characters, not bytes, so the
        // cut can never land inside one.
        let unicode = sanitize_filename(&"é".repeat(500)).expect("usable");
        assert_eq!(unicode.chars().count(), MAX_FILENAME_LEN);
    }

    #[test]
    fn parses_plain_filename() {
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"report 2024.pdf\"").as_deref(),
            Some("report 2024.pdf")
        );
        // Unquoted token form.
        assert_eq!(
            filename_from_content_disposition("attachment; filename=report.pdf").as_deref(),
            Some("report.pdf")
        );
        // Case-insensitive parameter name, extra parameters around it.
        assert_eq!(
            filename_from_content_disposition("inline; size=42; FileName=\"a.bin\"; creation-date=\"now\"").as_deref(),
            Some("a.bin")
        );
    }

    #[test]
    fn parses_rfc5987_encoded_filename() {
        assert_eq!(
            filename_from_content_disposition("attachment; filename*=UTF-8''laporan%20keuangan.pdf").as_deref(),
            Some("laporan keuangan.pdf")
        );
        assert_eq!(
            filename_from_content_disposition("attachment; filename*=UTF-8''%E2%82%AC%20rates.csv").as_deref(),
            Some("€ rates.csv")
        );
        assert_eq!(
            filename_from_content_disposition("attachment; filename*=iso-8859-1'en'%A3100.txt").as_deref(),
            Some("£100.txt")
        );
    }

    #[test]
    fn encoded_filename_wins_over_plain() {
        // RFC 6266: the plain form is the fallback for clients that can't read
        // the encoded one, so it must not override it.
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"fallback.pdf\"; filename*=UTF-8''r%C3%A9el.pdf")
                .as_deref(),
            Some("réel.pdf")
        );
        // ...but an undecodable encoded form falls back rather than giving up.
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"fallback.pdf\"; filename*=shift_jis''%82%A0.txt")
                .as_deref(),
            Some("fallback.pdf")
        );
    }

    #[test]
    fn sanitises_the_header_too() {
        // The whole point: a traversal arriving by header is no different from
        // one arriving any other way.
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"../../../Startup/evil.exe\"").as_deref(),
            Some("evil.exe")
        );
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"..\\\\..\\\\evil.exe\"").as_deref(),
            Some("evil.exe")
        );
        assert_eq!(
            filename_from_content_disposition("attachment; filename*=UTF-8''..%2F..%2Fevil.exe").as_deref(),
            Some("evil.exe")
        );
        // Percent-encoded separators and NUL, the encoded form's equivalents.
        assert_eq!(
            filename_from_content_disposition("attachment; filename*=UTF-8''..%5C..%5Cevil.exe").as_deref(),
            Some("evil.exe")
        );
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"..\"").as_deref(),
            None
        );
        assert_eq!(filename_from_content_disposition("attachment; filename=\"nul.txt\"").as_deref(), Some("_nul.txt"));
    }

    #[test]
    fn handles_values_with_separators_and_escapes() {
        // A quoted `;` is part of the name, not a parameter boundary.
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"part1;part2.zip\"").as_deref(),
            Some("part1;part2.zip")
        );
        // An escaped quote inside the value.
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"say \\\"hi\\\".txt\"").as_deref(),
            // The bare quotes themselves can't live in a file name.
            Some("say hi.txt")
        );
    }

    #[test]
    fn returns_none_without_a_usable_filename() {
        assert_eq!(filename_from_content_disposition("attachment"), None);
        assert_eq!(filename_from_content_disposition("inline"), None);
        assert_eq!(filename_from_content_disposition(""), None);
        assert_eq!(filename_from_content_disposition("attachment; filename="), None);
        assert_eq!(filename_from_content_disposition("attachment; filename=\"\""), None);
        // Not a filename parameter at all.
        assert_eq!(filename_from_content_disposition("form-data; name=\"field\""), None);
    }
}
