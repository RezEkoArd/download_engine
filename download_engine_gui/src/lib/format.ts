import type { FileCategory, Job } from "../types";

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function detectCategory(name: string): FileCategory {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["zip", "rar", "7z", "tar", "gz", "dat"].includes(ext)) return "compressed";
  if (["pdf", "doc", "docx", "txt"].includes(ext)) return "documents";
  if (["mp4", "mkv", "avi", "mp3", "webm"].includes(ext)) return "video";
  if (["exe", "msi", "iso", "dmg", "deb"].includes(ext)) return "programs";
  return "other";
}

export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || "download.bin";
  } catch {
    return url.split("/").pop() || "download.bin";
  }
}

export function calculateEta(job: Job): string {
  if (job.status !== "downloading" || job.speedBytes <= 0 || job.sizeBytes <= 0) return "-";
  const remaining = job.sizeBytes - job.downloadedBytes;
  const seconds = Math.ceil(remaining / job.speedBytes);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${seconds % 60}s`;
}

export function progressPercent(job: Job): number {
  if (job.status === "completed") return 100;
  if (job.sizeBytes <= 0) return 0;
  return Math.min(100, Math.round((job.downloadedBytes / job.sizeBytes) * 100));
}
