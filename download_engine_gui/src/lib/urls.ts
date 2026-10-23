/** Only schemes the engine can actually fetch. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
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
