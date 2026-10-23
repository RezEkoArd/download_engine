import { downloadDir, join } from "@tauri-apps/api/path";

/** Sub-folder of the OS Downloads directory that the app writes into. */
export const DOWNLOAD_SUBFOLDER = "Download-Engine";

/**
 * Folder new downloads go to until the user picks another one.
 *
 * It's a sub-folder rather than the Downloads root on purpose: collision
 * handling only knows about jobs in this app's own list, so writing straight
 * into Downloads could silently overwrite a file the browser put there
 * earlier. Keeping to our own folder means the only files we can clobber are
 * ones we put there.
 *
 * The engine creates missing parent directories, so this doesn't have to exist
 * yet.
 */
export async function defaultDownloadDir(): Promise<string> {
  try {
    return await join(await downloadDir(), DOWNLOAD_SUBFOLDER);
  } catch {
    // No Downloads dir to resolve. Falling back to "" keeps the old behaviour
    // (engine decides) rather than failing the whole startup.
    return "";
  }
}
