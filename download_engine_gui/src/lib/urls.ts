/** Only schemes the engine can actually fetch. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A comparable form of a URL, for telling two jobs apart.
 *
 * `URL` already lowercases the scheme and host, drops a default port, and
 * resolves `..`. The fragment is cleared by hand because nothing after `#` is
 * ever sent to the server, so two links differing only there fetch the same
 * bytes. Path and query are left alone: both are case-sensitive, and the query
 * is often what identifies the file (token, version, id).
 */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const u = new URL(trimmed);
    u.hash = "";
    return u.href;
  } catch {
    return trimmed;
  }
}

/** The first item already pointing at the same URL, if any. */
export function findByUrl<T extends { url: string }>(items: readonly T[], url: string): T | undefined {
  const target = normalizeUrl(url);
  return items.find((item) => normalizeUrl(item.url) === target);
}

/** Drag payloads that could plausibly hold a URL. */
const URL_MIME_TYPES = ["text/uri-list", "text/plain"];

export function dragHasText(types: readonly string[]): boolean {
  return types.some((type) => URL_MIME_TYPES.includes(type));
}

/**
 * Pulls every usable URL out of a drop.
 *
 * `text/uri-list` is the richer format and can carry several URLs plus
 * `#` comment lines, so it's preferred over `text/plain` and parsed per line.
 */
export function extractUrls(data: DataTransfer | null): string[] {
  if (!data) return [];
  const raw = data.getData("text/uri-list") || data.getData("text/plain") || "";
  const urls = raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter(isHttpUrl);
  // Dragging a selection can repeat the same link; queue it once.
  return [...new Set(urls)];
}
