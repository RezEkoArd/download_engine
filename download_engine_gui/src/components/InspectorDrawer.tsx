import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job, SegmentProgress } from "../types";
import { formatBytes, progressPercent } from "../lib/format";
import { copyToClipboard, revealInFolder } from "../lib/jobActions";

interface Props {
  job: Job;
  onClose: () => void;
}

const LIVE_STATUSES = ["downloading", "paused"];

export default function InspectorDrawer({ job, onClose }: Props) {
  const pct = progressPercent(job);
  const [segments, setSegments] = useState<SegmentProgress[]>([]);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  // The engine pre-allocates the file when a job starts, so anything that has
  // run has something on disk to reveal. A queued job has nothing yet.
  const fileExists = Boolean(job.outputPath) && job.status !== "queued";

  async function runAction(message: string, action: () => Promise<void>) {
    try {
      await action();
      setFeedback({ ok: true, message });
    } catch (err) {
      setFeedback({ ok: false, message: String(err) });
    }
  }

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  // The engine tracks segments in shared memory rather than emitting an event
  // per chunk, so poll it at a rate a human can actually read.
  useEffect(() => {
    if (!LIVE_STATUSES.includes(job.status)) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const next = await invoke<SegmentProgress[]>("segment_progress", { jobId: job.id });
        if (!cancelled && next.length > 0) setSegments(next);
      } catch {
        /* job finished between renders; keep the last snapshot */
      }
    };

    poll();
    const timer = window.setInterval(poll, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job.id, job.status]);

  // A fresh job shouldn't show the previous one's segments, nor a confirmation
  // that was meant for it.
  useEffect(() => {
    setSegments([]);
    setFeedback(null);
  }, [job.id]);

  return (
    <div className="w-80 bg-gray-50 dark:bg-darkbg-800 border-l border-gray-200 dark:border-gray-700/80 flex flex-col justify-between shadow-xl">
      <div className="p-4 overflow-y-auto space-y-4">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 pb-3">
          <h3 className="font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <i className="fa-solid fa-microchip text-brand-500" /> Segment Inspector
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-white">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div>
          <div className="font-semibold text-gray-900 dark:text-gray-100 truncate text-sm">{job.name}</div>
          <div className="text-[11px] text-gray-400 truncate font-mono mt-0.5">{job.url}</div>
        </div>

        <div className="space-y-1.5">
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={() => runAction("Folder dibuka", () => revealInFolder(job.outputPath))}
              disabled={!fileExists}
              title={fileExists ? "Tampilkan file di File Explorer" : "Belum ada file di disk untuk ditampilkan"}
              className="flex flex-col items-center gap-1 py-2 rounded-lg border border-gray-200 dark:border-gray-700/60 bg-white dark:bg-darkbg-900 text-[10px] font-medium text-gray-600 dark:text-gray-300 transition hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-200 dark:disabled:hover:border-gray-700/60 disabled:hover:text-gray-600"
            >
              <i className="fa-regular fa-folder-open text-sm" />
              <span>Buka Folder</span>
            </button>
            <button
              onClick={() => runAction("Link dicopy", () => copyToClipboard(job.url))}
              title="Copy URL download ke clipboard"
              className="flex flex-col items-center gap-1 py-2 rounded-lg border border-gray-200 dark:border-gray-700/60 bg-white dark:bg-darkbg-900 text-[10px] font-medium text-gray-600 dark:text-gray-300 transition hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
            >
              <i className="fa-solid fa-link text-sm" />
              <span>Copy Link</span>
            </button>
            <button
              onClick={() => runAction("Path dicopy", () => copyToClipboard(job.outputPath))}
              disabled={!job.outputPath}
              title={job.outputPath ? "Copy path file output ke clipboard" : "Job ini tidak punya path output eksplisit"}
              className="flex flex-col items-center gap-1 py-2 rounded-lg border border-gray-200 dark:border-gray-700/60 bg-white dark:bg-darkbg-900 text-[10px] font-medium text-gray-600 dark:text-gray-300 transition hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-200 dark:disabled:hover:border-gray-700/60 disabled:hover:text-gray-600"
            >
              <i className="fa-regular fa-clipboard text-sm" />
              <span>Copy Path</span>
            </button>
          </div>

          {feedback && (
            <div
              className={`flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[10px] border break-all ${
                feedback.ok
                  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                  : "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400"
              }`}
            >
              <i className={`mt-0.5 ${feedback.ok ? "fa-solid fa-circle-check" : "fa-solid fa-circle-exclamation"}`} />
              <span>{feedback.message}</span>
            </div>
          )}
        </div>

        {/* A failed job never got a usable answer about range support, so
            `supportsRange === false` here means "unknown", not "unsupported".
            Showing the amber "Range Tidak Didukung" panel beside the real error
            invents a server capability we never observed and sends the reader
            after the wrong cause. The error below says what actually happened. */}
        {job.error ? null : job.supportsRange === null ? (
          <div className="bg-gray-500/10 border border-gray-500/20 rounded-lg p-2.5 flex items-start space-x-2">
            <i className="fa-solid fa-circle-notch fa-spin text-gray-400 mt-0.5 text-xs" />
            <div className="text-xs text-gray-500 dark:text-gray-400">Probing server...</div>
          </div>
        ) : job.supportsRange ? (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2.5 flex items-start space-x-2">
            <i className="fa-solid fa-circle-check text-emerald-500 mt-0.5 text-xs" />
            <div className="text-xs">
              <div className="font-semibold text-emerald-600 dark:text-emerald-400">Accept-Ranges Supported</div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400">Server mendukung HTTP byte-range, download dipecah jadi {job.segments} segmen paralel.</div>
            </div>
          </div>
        ) : (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5 flex items-start space-x-2">
            <i className="fa-solid fa-triangle-exclamation text-amber-500 mt-0.5 text-xs" />
            <div className="text-xs">
              <div className="font-semibold text-amber-600 dark:text-amber-400">Range Tidak Didukung</div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400">Server tidak mendukung byte-range, fallback ke satu koneksi streaming biasa.</div>
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">
            <span>Parallel Connections (-n)</span>
            <span className="font-mono">{segments.length || job.segments} Threads</span>
          </div>

          {segments.length > 0 ? (
            <div className="space-y-2">
              {segments.map((segment) => {
                const segmentPct = segment.total > 0 ? Math.min(100, Math.round((segment.downloaded / segment.total) * 100)) : 0;
                return (
                  <div key={segment.index} className="bg-white dark:bg-darkbg-900 p-2 rounded-lg border border-gray-200 dark:border-gray-700/60 space-y-1">
                    <div className="flex justify-between items-center text-[10px] font-mono">
                      <span className="text-gray-500 font-semibold">Thread #{segment.index + 1}</span>
                      <span className="text-brand-600 dark:text-brand-400">{segmentPct}%</span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${job.status === "paused" ? "bg-amber-400" : "bg-brand-500"}`}
                        style={{ width: `${segmentPct}%` }}
                      />
                    </div>
                    <div className="text-[9px] text-gray-400 font-mono">
                      {formatBytes(segment.downloaded)} / {formatBytes(segment.total)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="bg-white dark:bg-darkbg-900 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700/60 text-[11px] text-gray-400">
              {LIVE_STATUSES.includes(job.status) ? "Menunggu segmen mulai..." : "Breakdown per-segmen hanya tersedia saat download berjalan."}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-darkbg-900 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs space-y-1">
          <div className="text-gray-400 font-medium">Output Path (-o):</div>
          <div className="font-mono text-[11px] text-gray-700 dark:text-gray-300 break-all bg-gray-100 dark:bg-darkbg-800 p-1.5 rounded">{job.outputPath || "(current working directory)"}</div>
        </div>

        {job.sizeBytes > 0 && (
          <div className="bg-white dark:bg-darkbg-900 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs space-y-1">
            <div className="text-gray-400 font-medium">Total Progress:</div>
            <div className="font-mono text-[11px] text-gray-700 dark:text-gray-300">
              {formatBytes(job.downloadedBytes)} / {formatBytes(job.sizeBytes)} ({pct}%)
            </div>
          </div>
        )}

        {job.error && <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 text-xs text-red-600 dark:text-red-400 break-all">{job.error}</div>}
      </div>

      <div className="p-3 bg-gray-100 dark:bg-darkbg-900 border-t border-gray-200 dark:border-gray-700/80 text-xs">
        <button onClick={onClose} className="w-full bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 py-1.5 rounded-md transition font-medium">
          Close Inspector
        </button>
      </div>
    </div>
  );
}
