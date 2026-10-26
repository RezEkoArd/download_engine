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

export type ThemeMode = "light" | "dark" | "system";

export type AccentName = "blue" | "teal" | "purple" | "orange";

/**
 * The accent choices, with the swatch each one shows in Settings.
 *
 * The swatch is `brand-500` of that palette — the same value the CSS sets — so
 * the dot in the picker is literally the colour being picked. Keeping the two
 * in one place is what stops them drifting apart; see the `[data-accent]`
 * blocks in `App.css`.
 */
export const ACCENTS: ReadonlyArray<{ value: AccentName; label: string; swatch: string }> = [
  { value: "blue", label: "Biru", swatch: "#3b82f6" },
  { value: "teal", label: "Teal", swatch: "#14b8a6" },
  { value: "purple", label: "Ungu", swatch: "#a855f7" },
  { value: "orange", label: "Oranye", swatch: "#f97316" },
];

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
  /**
   * Show the always-on-top progress overlay while something is downloading.
   * On by default: it only appears when there is progress to report, and
   * disappears on its own.
   */
  /**
   * Light, dark, or whatever the OS is set to. The notch is sent the
   * *resolved* answer rather than this, because it has no business asking the
   * OS a second time and getting a different one.
   */
  themeMode: ThemeMode;
  accent: AccentName;
  dynamicIsland: boolean;
  /**
   * Keep the notch on screen even with nothing running, so it can be grabbed
   * and moved at any time. Off by default: it sits exactly where a browser
   * puts its tab strip, and the window swallows the clicks under it.
   */
  notchAlwaysVisible: boolean;
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

/**
 * How much of the notch is on screen. Rust turns this into a window size, so
 * it is the mode — not a CSS class — that decides how much room the panel has.
 */
export type IslandMode = "compact" | "active" | "expanded";

export type IslandPhase = "idle" | "downloading" | "done";

/**
 * What the notch shows. Mirrors `IslandState` in `src-tauri/src/island.rs`,
 * which forwards it to the notch window — `snake_case` because it crosses that
 * boundary as-is.
 */
export interface IslandState {
  mode: IslandMode;
  phase: IslandPhase;
  /** Already resolved — "system" never reaches the notch. */
  theme: "light" | "dark";
  accent: AccentName;
  name: string;
  percent: number;
  speed_bytes: number;
  downloaded_bytes: number;
  total_bytes: number;
  /** Time left, already formatted. Empty when it cannot be worked out. */
  eta: string;
  /** Jobs downloading right now, the one being shown included. */
  active_count: number;
  /** Only filled in for `expanded`; the other modes have nowhere to show it. */
  items: IslandItem[];
}

export interface IslandItem {
  id: string;
  name: string;
  percent: number;
  speed_bytes: number;
  status: JobStatus;
}
