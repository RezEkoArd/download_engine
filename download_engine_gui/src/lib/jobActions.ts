import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Shows the file in the OS file manager with it selected.
 *
 * Only reveals; it deliberately stops short of launching the file, since
 * opening arbitrary paths with their default application would need a much
 * broader permission than this app has any reason to hold.
 */
export async function revealInFolder(outputPath: string) {
  await revealItemInDir(outputPath);
}

export async function copyToClipboard(value: string) {
  await writeText(value);
}

/**
 * Current clipboard text, or "" when there is none.
 *
 * Reading throws when the clipboard holds something that isn't text (an image,
 * a file list). That's an ordinary state for a poll to run into, not an error
 * worth surfacing, so it collapses to an empty string.
 */
export async function readClipboardText(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    return "";
  }
}
