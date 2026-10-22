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
}

export interface NewJobInput {
  url: string;
  outputPath: string;
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
}

/** Live per-segment progress, polled from the engine while a job runs. */
export interface SegmentProgress {
  index: number;
  downloaded: number;
  total: number;
}

/** How much of a partial file is already on disk and can be continued. */
export interface ResumeInfo {
  downloaded: number;
  total: number;
}

export type JobResult = { status: "completed"; path: string } | { status: "cancelled" };

export const SPEED_LIMIT_OPTIONS = [
  { value: "", label: "Unlimited" },
  { value: "500KB", label: "500 KB/s" },
  { value: "2MB", label: "2 MB/s" },
  { value: "10MB", label: "10 MB/s" },
] as const;
