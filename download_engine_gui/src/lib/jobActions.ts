import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

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
