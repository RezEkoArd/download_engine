export type JobStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "cancelled"
  | "error"
  /** Was running when the app last closed, so it has no engine handle anymore. */
  | "interrupted";

export type FileCategory = "compressed" | "documents" | "video" | "programs" | "other";

export interface Job {
  id: string;
  url: string;
  name: string;
  outputPath: string;
  sizeBytes: number;
  downloadedBytes: number;
  speedBytes: number;
  segments: number;
  limit: string;
  status: JobStatus;
  category: FileCategory;
  supportsRange: boolean | null;
  error: string | null;
  createdAt: number;
  lastTick: { time: number; downloaded: number } | null;
  /**
   * The user named this file themselves, so the probe must not rename it.
   * Without this a `Content-Disposition` would quietly overrule the name they
   * typed into the form.
   */
  nameFromUser: boolean;
}

export interface NewJobInput {
  url: string;
  /** Folder to save into. Empty falls back to `settings.defaultOutputDir`. */
  outputPath: string;
  /**
   * File name the user typed. Empty means "work it out": the URL supplies a
   * placeholder and the server's suggestion replaces it once the probe lands.
   */
  fileName: string;
  segments: number;
  limit: string;
  startInSec: number;
  forceStart: boolean;
}

export interface AppSettings {
  defaultSegments: number;
  defaultLimit: string;
  defaultOutputDir: string;
  concurrency: number;
  maxRetries: number;
  userAgent: string;
  /** Watch the clipboard for links. Off by default — see the GUI README. */
  clipboardMonitor: boolean;
  /** Listen for links from the browser extension. Off by default: it opens a port. */
  browserBridge: boolean;
}

/** Where the browser extension should connect, and the token it must present. */
export interface BridgeInfo {
  port: number;
  token: string;
  running: boolean;
}

/**
 * Extra request headers a job needs to resolve — a session `Cookie`, a
 * `Referer` the server checks. Only ever supplied by the browser extension.
 */
export type JobHeaders = Record<string, string>;

/** Live per-segment progress, polled from the engine while a job runs. */
export interface SegmentProgress {
  index: number;
  downloaded: number;
  total: number;
}

/** What a HEAD request told the engine about a URL, before anything is saved. */
export interface ProbeResult {
  total_size: number;
  supports_range: boolean;
  /**
   * The server's preferred file name, from `Content-Disposition`.
   *
   * Already sanitised by the engine into a single path component — it cannot
   * contain a separator or `..` — so it is safe to join onto the output folder.
   */
  suggested_filename: string | null;
}

/** How much of a partial file is already on disk and can be continued. */
export interface ResumeInfo {
  downloaded: number;
  total: number;
}

export type JobResult = { status: "completed"; path: string } | { status: "cancelled" };

/**
 * The clipboard has no change event, so it has to be polled. Shared with the
 * settings copy, so what the user is told matches what actually happens.
 */
export const CLIPBOARD_POLL_MS = 1500;

export const SPEED_LIMIT_OPTIONS = [
  { value: "", label: "Unlimited" },
  { value: "500KB", label: "500 KB/s" },
  { value: "2MB", label: "2 MB/s" },
  { value: "10MB", label: "10 MB/s" },
] as const;
