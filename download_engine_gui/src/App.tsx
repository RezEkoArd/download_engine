import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import { CLIPBOARD_POLL_MS, SPEED_LIMIT_OPTIONS } from "./types";
import type { AppSettings, FileCategory, Job, JobResult, JobStatus, NewJobInput, ResumeInfo } from "./types";
import { baseName, calculateEta, detectCategory, formatBytes, nameFromUrl, progressPercent, uniqueOutputPath } from "./lib/format";
import { loadState, saveState } from "./lib/persistence";
import { notifyDownloadComplete, notifyDownloadFailed } from "./lib/notifications";
import { readClipboardText } from "./lib/jobActions";
import { dragHasText, extractUrls, findByUrl, isHttpUrl } from "./lib/urls";
import NewDownloadModal from "./components/NewDownloadModal";
import SettingsModal from "./components/SettingsModal";
import InspectorDrawer from "./components/InspectorDrawer";

const appWindow = getCurrentWindow();

const DEFAULT_SETTINGS: AppSettings = {
  defaultSegments: 8,
  defaultLimit: "",
  defaultOutputDir: "",
  concurrency: 1,
  maxRetries: 5,
  userAgent: "",
  clipboardMonitor: false,
};

const STATUS_FILTERS: { key: "all" | JobStatus; label: string; icon: string }[] = [
  { key: "all", label: "All Downloads", icon: "fa-solid fa-list-ul" },
  { key: "downloading", label: "Downloading", icon: "fa-solid fa-arrow-down-long text-emerald-500" },
  { key: "queued", label: "Queued", icon: "fa-solid fa-clock text-amber-500" },
  { key: "paused", label: "Paused", icon: "fa-solid fa-pause text-blue-400" },
  { key: "interrupted", label: "Interrupted", icon: "fa-solid fa-plug-circle-xmark text-orange-500" },
  { key: "completed", label: "Completed", icon: "fa-solid fa-circle-check text-green-500" },
  { key: "cancelled", label: "Cancelled", icon: "fa-solid fa-ban text-gray-400" },
  { key: "error", label: "Failed", icon: "fa-solid fa-circle-exclamation text-red-500" },
];

const CATEGORY_FILTERS: { key: "all" | FileCategory; label: string; icon: string }[] = [
  { key: "all", label: "All Types", icon: "fa-solid fa-folder" },
  { key: "compressed", label: "Compressed (.zip, .rar)", icon: "fa-solid fa-file-zipper text-amber-500" },
  { key: "documents", label: "Documents", icon: "fa-solid fa-file-pdf text-red-500" },
  { key: "video", label: "Videos & Media", icon: "fa-solid fa-film text-purple-500" },
  { key: "programs", label: "Executables / Apps", icon: "fa-solid fa-box text-blue-500" },
];

const ACTIVE_STATUSES: JobStatus[] = ["downloading", "paused"];

/** Stopped one way or another, so there is something to re-queue. */
const RETRYABLE_STATUSES: JobStatus[] = ["error", "cancelled", "completed", "interrupted"];

/** Longest a change may sit unsaved while downloads keep firing progress events. */
const SAVE_INTERVAL_MS = 3000;
/** Quiet period after the last change before saving, when nothing is running. */
const SAVE_DEBOUNCE_MS = 600;

function fileIcon(category: FileCategory): string {
  switch (category) {
    case "compressed":
      return "fa-solid fa-file-zipper text-amber-500";
    case "documents":
      return "fa-solid fa-file-pdf text-red-500";
    case "video":
      return "fa-solid fa-file-video text-purple-500";
    case "programs":
      return "fa-solid fa-box text-blue-500";
    default:
      return "fa-solid fa-file text-gray-400";
  }
}

function progressBarClass(status: JobStatus): string {
  switch (status) {
    case "error":
      return "bg-red-500";
    case "completed":
      return "bg-emerald-500";
    case "paused":
      return "bg-amber-400";
    case "interrupted":
      return "bg-orange-400";
    case "cancelled":
      return "bg-gray-400";
    default:
      return "bg-brand-500";
  }
}

function statusBadge(job: Job) {
  const badge = "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border";
  switch (job.status) {
    case "downloading":
      return (
        <span className={`${badge} bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20`}>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Downloading
        </span>
      );
    case "paused":
      return (
        <span className={`${badge} bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20`}>
          <i className="fa-solid fa-pause text-[9px]" />
          Paused
        </span>
      );
    case "queued":
      return (
        <span className={`${badge} bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20`}>
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
          Queued
        </span>
      );
    case "completed":
      return (
        <span className={`${badge} bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20`}>
          <i className="fa-solid fa-check text-[9px]" />
          Completed
        </span>
      );
    case "cancelled":
      return (
        <span className={`${badge} bg-gray-500/10 text-gray-500 dark:text-gray-400 border-gray-500/20`}>
          <i className="fa-solid fa-ban text-[9px]" />
          Cancelled
        </span>
      );
    case "interrupted":
      return (
        <span
          className={`${badge} bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20`}
          title="App ditutup saat download berjalan — bisa dilanjutkan dari posisi terakhir"
        >
          <i className="fa-solid fa-plug-circle-xmark text-[9px]" />
          Interrupted
        </span>
      );
    case "error":
      return (
        <span className={`${badge} bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20`}>
          <i className="fa-solid fa-triangle-exclamation text-[9px]" />
          Failed
        </span>
      );
  }
}

function App() {
  const [dark, setDark] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [globalLimit, setGlobalLimit] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | JobStatus>("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | FileCategory>("all");
  const [search, setSearch] = useState("");
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [newDownloadOpen, setNewDownloadOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const startingRef = useRef<Set<string>>(new Set());
  const [restored, setRestored] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** Anchor for shift-click range selection. */
  const lastClickedRef = useRef<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  /** Seeds the new-download form when a link is dropped onto the window. */
  const [pendingUrl, setPendingUrl] = useState("");
  /** Short-lived message for things that happen without a dialog open. */
  const [notice, setNotice] = useState("");
  /** Link spotted in the clipboard, waiting to be accepted or dismissed. */
  const [clipboardUrl, setClipboardUrl] = useState("");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Pull the last session back in before anything else touches state.
  useEffect(() => {
    let active = true;
    loadState()
      .then((saved) => {
        if (!active || !saved) return;
        if (typeof saved.dark === "boolean") setDark(saved.dark);
        if (saved.settings) setSettings({ ...DEFAULT_SETTINGS, ...saved.settings });
        if (typeof saved.globalLimit === "string") setGlobalLimit(saved.globalLimit);
        if (saved.jobs) setJobs(saved.jobs);
      })
      .finally(() => {
        if (active) setRestored(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Save on change, but throttled rather than purely debounced: progress events
  // arrive several times a second, and a plain debounce would keep resetting
  // its own timer so nothing ever hit the disk while a download was running.
  const lastSaveRef = useRef(0);
  useEffect(() => {
    if (!restored) return;
    const sinceLastSave = Date.now() - lastSaveRef.current;
    const delay = sinceLastSave > SAVE_INTERVAL_MS ? 0 : SAVE_DEBOUNCE_MS;
    const timer = window.setTimeout(() => {
      lastSaveRef.current = Date.now();
      saveState({ dark, globalLimit, settings, jobs });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [restored, dark, globalLimit, settings, jobs]);

  // A restored limit lives only in the UI until the engine is told about it.
  useEffect(() => {
    if (!restored || !globalLimit) return;
    invoke("set_global_speed_limit", { limit: globalLimit }).catch(() => {});
  }, [restored, globalLimit]);

  // The engine builds its HTTP client per call, so it needs the current UA.
  useEffect(() => {
    invoke("set_user_agent", { userAgent: settings.userAgent || null }).catch(() => {});
  }, [settings.userAgent]);

  // Progress events, tagged per job id.
  useEffect(() => {
    const unlisten = listen<{ job_id: string; downloaded: number; total: number }>("job-progress", (event) => {
      const { job_id, downloaded, total } = event.payload;
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== job_id) return j;
          const now = Date.now();
          let speedBytes = j.speedBytes;
          let lastTick = j.lastTick;
          if (j.lastTick) {
            const dt = (now - j.lastTick.time) / 1000;
            if (dt > 0.2) {
              speedBytes = Math.max(0, (downloaded - j.lastTick.downloaded) / dt);
              lastTick = { time: now, downloaded };
            }
          } else {
            lastTick = { time: now, downloaded };
          }
          return { ...j, downloadedBytes: downloaded, sizeBytes: total || j.sizeBytes, speedBytes, lastTick };
        }),
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const beginJob = useCallback(
    async (job: Job) => {
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "downloading", error: null, lastTick: null, speedBytes: 0 } : j)));
      try {
        const result = await invoke<JobResult>("start_download", {
          jobId: job.id,
          url: job.url,
          output: job.outputPath || null,
          segments: job.segments,
          limit: job.limit || null,
          retries: settings.maxRetries,
        });
        setJobs((prev) =>
          prev.map((j) => {
            if (j.id !== job.id) return j;
            if (result.status === "cancelled") {
              return { ...j, status: "cancelled", speedBytes: 0 };
            }
            return { ...j, status: "completed", outputPath: result.path, downloadedBytes: j.sizeBytes || j.downloadedBytes, speedBytes: 0 };
          }),
        );
        if (result.status === "completed") notifyDownloadComplete(job.name);
      } catch (err) {
        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "error", error: String(err), speedBytes: 0 } : j)));
        notifyDownloadFailed(job.name, String(err));
      } finally {
        startingRef.current.delete(job.id);
      }
    },
    [settings.maxRetries],
  );

  // Scheduler: whenever a concurrency slot is free, start the next queued job.
  // Paused jobs still hold their slot, since their connection is only parked.
  useEffect(() => {
    const activeCount = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).length;
    if (activeCount >= settings.concurrency) return;
    const next = jobs.find((j) => j.status === "queued" && !startingRef.current.has(j.id));
    if (!next) return;
    startingRef.current.add(next.id);
    beginJob(next);
  }, [jobs, settings.concurrency, beginJob]);

  async function probeUrlFor(id: string, url: string) {
    try {
      const result = await invoke<{ total_size: number; supports_range: boolean }>("probe_url", { url });
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, sizeBytes: result.total_size || j.sizeBytes, supportsRange: result.supports_range } : j)));
    } catch {
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, supportsRange: false } : j)));
    }
  }

  /**
   * `takenPaths` lets a batch stay collision-free: `jobs` doesn't update
   * between synchronous calls, so the caller threads one growing set through
   * them instead of re-reading state that is still stale.
   */
  function handleCreateJob(input: NewJobInput, takenPaths?: Set<string>) {
    const id = crypto.randomUUID();
    const outputDir = input.outputPath || settings.defaultOutputDir;
    const taken = takenPaths ?? new Set(jobs.map((j) => j.outputPath).filter(Boolean));
    const outputPath = outputDir ? uniqueOutputPath(`${outputDir.replace(/[\\/]+$/, "")}\\${nameFromUrl(input.url)}`, taken) : "";
    if (outputPath) taken.add(outputPath);
    // Without a folder the engine picks the file name itself, so fall back to
    // the URL for the label.
    const name = outputPath ? baseName(outputPath) : nameFromUrl(input.url);
    const baseJob: Job = {
      id,
      url: input.url,
      name,
      outputPath,
      sizeBytes: 0,
      downloadedBytes: 0,
      speedBytes: 0,
      segments: input.segments,
      limit: input.limit,
      status: "queued",
      category: detectCategory(name),
      supportsRange: null,
      error: null,
      createdAt: Date.now(),
      lastTick: null,
    };

    const addAndMaybeStart = () => {
      setJobs((prev) => [baseJob, ...prev]);
      probeUrlFor(baseJob.id, baseJob.url);
      if (input.forceStart) {
        startingRef.current.add(baseJob.id);
        beginJob(baseJob);
      }
    };

    if (input.startInSec > 0) {
      window.setTimeout(addAndMaybeStart, input.startInSec * 1000);
    } else {
      addAndMaybeStart();
    }
  }

  async function pauseJob(id: string) {
    try {
      await invoke("pause_download", { jobId: id });
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "paused", speedBytes: 0, lastTick: null } : j)));
    } catch (err) {
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, error: String(err) } : j)));
    }
  }

  async function resumeJob(id: string) {
    try {
      await invoke("resume_download", { jobId: id });
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "downloading", lastTick: null } : j)));
    } catch (err) {
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, error: String(err) } : j)));
    }
  }

  async function cancelJob(id: string) {
    // The command resolves as soon as the signal lands; `start_download` then
    // settles the job as cancelled once the segments actually wind down.
    await invoke("cancel_download", { jobId: id }).catch(() => {});
  }

  /**
   * Re-queues a stopped job. The engine picks up a matching partial file on
   * its own, so this only has to get the UI's numbers right: ask what's
   * already on disk rather than blanking the bar and letting it snap back.
   */
  async function retryJob(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;

    const resumable = job.outputPath
      ? await invoke<ResumeInfo | null>("resume_info", { output: job.outputPath }).catch(() => null)
      : null;

    setJobs((prev) =>
      prev.map((j) =>
        j.id === id
          ? {
              ...j,
              status: "queued",
              error: null,
              downloadedBytes: resumable?.downloaded ?? 0,
              sizeBytes: resumable?.total ?? j.sizeBytes,
              speedBytes: 0,
              lastTick: null,
            }
          : j,
      ),
    );
  }

  function startAllQueued() {
    jobs
      .filter((j) => j.status === "queued")
      .forEach((j) => {
        if (!startingRef.current.has(j.id)) {
          startingRef.current.add(j.id);
          beginJob(j);
        }
      });
  }

  function pauseAllRunning() {
    jobs.filter((j) => j.status === "downloading").forEach((j) => pauseJob(j.id));
  }

  async function removeJob(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (job && ACTIVE_STATUSES.includes(job.status)) {
      await cancelJob(id);
    }
    // A half-finished file is unusable on its own, so it goes with the job.
    // A completed one is the user's file and stays put.
    if (job && job.status !== "completed" && job.outputPath) {
      await invoke("discard_download", { output: job.outputPath }).catch(() => {});
    }
    setJobs((prev) => prev.filter((j) => j.id !== id));
    if (inspectedId === id) setInspectedId(null);
  }

  async function applyGlobalLimit(limit: string) {
    setGlobalLimit(limit);
    setSpeedMenuOpen(false);
    await invoke("set_global_speed_limit", { limit: limit || null }).catch(() => {});
  }

  async function browsePath(): Promise<string | null> {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  }

  /**
   * Parks the app in the tray rather than ending it, so downloads survive.
   * Still flushes first, so the saved state matches what the user last saw.
   */
  async function closeWindow() {
    if (restored) await saveState({ dark, globalLimit, settings, jobs });
    await appWindow.close();
  }

  /** The real exit, reached from the tray. Nothing else will flush after this. */
  async function quitApp() {
    if (restored) await saveState({ dark, globalLimit, settings, jobs });
    await invoke("quit_app").catch(() => {});
  }

  // Tray entries act on the job list, which lives here rather than in the
  // engine. Routing them through a ref keeps the listeners pinned to the
  // latest handlers without re-subscribing on every progress tick.
  const trayActions = useRef({ startAll: () => {}, pauseAll: () => {}, quit: async () => {} });
  useEffect(() => {
    trayActions.current = { startAll: startAllQueued, pauseAll: pauseAllRunning, quit: quitApp };
  });

  useEffect(() => {
    const unlisten = Promise.all([
      listen("tray-start-all", () => trayActions.current.startAll()),
      listen("tray-pause-all", () => trayActions.current.pauseAll()),
      listen("tray-quit", () => void trayActions.current.quit()),
    ]);
    return () => {
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  function openNewDownload(url = "") {
    setPendingUrl(url);
    setNewDownloadOpen(true);
  }

  function closeNewDownload() {
    setNewDownloadOpen(false);
    setPendingUrl("");
  }

  const dropUrlsRef = useRef<(urls: string[]) => void>(() => {});
  useEffect(() => {
    dropUrlsRef.current = (urls) => {
      if (urls.length === 0) return;
      // A single link goes through the form, so an accidental drop can still
      // be reviewed or cancelled. A batch has no place in that form, so it
      // gets queued with the current defaults instead.
      if (urls.length === 1) {
        openNewDownload(urls[0]);
        return;
      }
      // Nobody reviews a batch, so duplicates are dropped silently rather than
      // queued twice; the count is reported instead.
      const fresh = urls.filter((url) => !findByUrl(jobs, url));
      const taken = new Set(jobs.map((j) => j.outputPath).filter(Boolean));
      fresh.forEach((url) =>
        handleCreateJob(
          {
            url,
            outputPath: "",
            segments: settings.defaultSegments,
            limit: settings.defaultLimit,
            startInSec: 0,
            forceStart: false,
          },
          taken,
        ),
      );
      const skipped = urls.length - fresh.length;
      setNotice(
        skipped === 0
          ? `${fresh.length} link ditambahkan ke queue`
          : `${fresh.length} link ditambahkan, ${skipped} dilewati karena sudah ada di daftar`,
      );
    };
  });

  // Dropped links are handled on `window` so the whole app area accepts them.
  // This only works because Tauri's own OS-level drag handler is disabled in
  // tauri.conf.json; with it on, WebView2 never forwards these DOM events.
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !dragHasText(event.dataTransfer.types)) return;
      // Without preventDefault the browser refuses the drop outright — which
      // conveniently makes a file drag show a "not allowed" cursor by itself.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    };

    const onDragLeave = (event: DragEvent) => {
      // Inner elements fire this too, so only a null relatedTarget means the
      // pointer really left the window.
      if (event.relatedTarget === null) setDragActive(false);
    };

    const onDrop = (event: DragEvent) => {
      // Swallowed unconditionally, so a stray file drop can't make the webview
      // navigate away from the app.
      event.preventDefault();
      setDragActive(false);
      dropUrlsRef.current(extractUrls(event.dataTransfer));
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // Read inside the clipboard poll, which must not restart on every progress
  // tick the way a `jobs` dependency would make it.
  const jobsRef = useRef<Job[]>([]);
  useEffect(() => {
    jobsRef.current = jobs;
  });

  // Clipboard monitor. Opt-in, and everything read is discarded unless it's a
  // link — nothing is stored and nothing leaves the process.
  useEffect(() => {
    // Pausing while the form is open keeps a link the user pastes in there
    // themselves from bouncing back as a suggestion.
    if (!settings.clipboardMonitor || newDownloadOpen) {
      setClipboardUrl("");
      return;
    }

    let cancelled = false;
    let lastSeen: string | null = null;

    const poll = async () => {
      const text = (await readClipboardText()).trim();
      if (cancelled || text === lastSeen) return;
      const seeding = lastSeen === null;
      lastSeen = text;
      // Whatever was already copied before the monitor started isn't a new
      // event, so the first read only establishes the baseline.
      if (seeding) return;
      if (!isHttpUrl(text) || findByUrl(jobsRef.current, text)) return;
      setClipboardUrl(text);
    };

    void poll();
    const timer = window.setInterval(() => void poll(), CLIPBOARD_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settings.clipboardMonitor, newDownloadOpen]);

  const filteredJobs = useMemo(() => {
    const q = search.toLowerCase();
    return jobs.filter((j) => {
      const matchStatus = statusFilter === "all" || j.status === statusFilter;
      const matchCategory = categoryFilter === "all" || j.category === categoryFilter;
      const matchSearch = !q || j.name.toLowerCase().includes(q) || j.url.toLowerCase().includes(q);
      return matchStatus && matchCategory && matchSearch;
    });
  }, [jobs, statusFilter, categoryFilter, search]);

  // Selection is kept to what's actually on screen. Without this, a job could
  // stay selected after being deleted or filtered out of view, and a bulk
  // action would then hit something the user can't see.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filteredJobs.map((j) => j.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (visible.has(id)) next.add(id);
      });
      // Same contents means same state; returning a new Set would re-render
      // on every progress tick.
      return next.size === prev.size ? prev : next;
    });
  }, [filteredJobs]);

  function toggleSelect(id: string, shiftKey: boolean) {
    const ids = filteredJobs.map((j) => j.id);
    const to = ids.indexOf(id);
    const from = lastClickedRef.current ? ids.indexOf(lastClickedRef.current) : -1;
    const next = new Set(selectedIds);

    if (shiftKey && from !== -1 && to !== -1) {
      // Extend in the direction the clicked row is heading, the way file
      // managers do, rather than replacing the whole selection.
      const selecting = !selectedIds.has(id);
      const [start, end] = from < to ? [from, to] : [to, from];
      for (let i = start; i <= end; i++) {
        if (selecting) next.add(ids[i]);
        else next.delete(ids[i]);
      }
    } else if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }

    lastClickedRef.current = id;
    setSelectedIds(next);
  }

  function toggleSelectAll() {
    const allSelected = filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.has(j.id));
    lastClickedRef.current = null;
    setSelectedIds(allSelected ? new Set() : new Set(filteredJobs.map((j) => j.id)));
  }

  function clearSelection() {
    lastClickedRef.current = null;
    setSelectedIds(new Set());
  }

  const selectedJobs = useMemo(() => jobs.filter((j) => selectedIds.has(j.id)), [jobs, selectedIds]);

  // Each bulk action only touches the jobs it actually applies to, so a mixed
  // selection does the sensible thing instead of erroring on the rest.
  const bulk = useMemo(
    () => ({
      resumable: selectedJobs.filter((j) => j.status === "paused"),
      pausable: selectedJobs.filter((j) => j.status === "downloading"),
      stoppable: selectedJobs.filter((j) => ACTIVE_STATUSES.includes(j.status)),
      retryable: selectedJobs.filter((j) => RETRYABLE_STATUSES.includes(j.status)),
    }),
    [selectedJobs],
  );

  async function bulkResume() {
    await Promise.all(bulk.resumable.map((j) => resumeJob(j.id)));
  }

  async function bulkPause() {
    await Promise.all(bulk.pausable.map((j) => pauseJob(j.id)));
  }

  async function bulkCancel() {
    await Promise.all(bulk.stoppable.map((j) => cancelJob(j.id)));
  }

  async function bulkRetry() {
    await Promise.all(bulk.retryable.map((j) => retryJob(j.id)));
  }

  /**
   * Removing in bulk can throw away a lot of partial data at once, so unlike
   * the per-row delete this one asks first and says how much is at stake.
   */
  async function bulkRemove() {
    const withPartials = selectedJobs.filter((j) => j.status !== "completed" && j.outputPath).length;
    const warning = withPartials > 0 ? `\n\n${withPartials} di antaranya masih punya file parsial yang akan ikut dibuang.` : "";
    const confirmed = await confirm(`Hapus ${selectedJobs.length} job dari daftar?${warning}`, {
      title: "Hapus job terpilih",
      kind: "warning",
    });
    if (!confirmed) return;

    // Sequential: each removal may cancel a download and delete files, and
    // firing all of them at once gains nothing.
    for (const job of selectedJobs) {
      await removeJob(job.id);
    }
    clearSelection();
  }

  const counts = useMemo(
    () => ({
      all: jobs.length,
      downloading: jobs.filter((j) => j.status === "downloading").length,
      queued: jobs.filter((j) => j.status === "queued").length,
      paused: jobs.filter((j) => j.status === "paused").length,
      interrupted: jobs.filter((j) => j.status === "interrupted").length,
      completed: jobs.filter((j) => j.status === "completed").length,
      cancelled: jobs.filter((j) => j.status === "cancelled").length,
      error: jobs.filter((j) => j.status === "error").length,
    }),
    [jobs],
  );

  const totalSpeed = jobs.filter((j) => j.status === "downloading").reduce((acc, j) => acc + j.speedBytes, 0);
  const activeThreads = jobs.filter((j) => j.status === "downloading").reduce((acc, j) => acc + j.segments, 0);
  const inspectedJob = jobs.find((j) => j.id === inspectedId) ?? null;
  const activeCount = counts.downloading + counts.paused;
  const globalLimitLabel = SPEED_LIMIT_OPTIONS.find((o) => o.value === globalLimit)?.label ?? globalLimit;
  const allVisibleSelected = filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.has(j.id));

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-gray-100 dark:bg-darkbg-900 text-gray-800 dark:text-gray-100 text-sm">
      {/* Title Bar */}
      <div
        data-tauri-drag-region
        className="bg-gray-200 dark:bg-darkbg-800 text-gray-700 dark:text-gray-300 px-3 py-1.5 flex items-center justify-between border-b border-gray-300 dark:border-gray-700/60 select-none text-xs"
      >
        <div className="flex items-center space-x-2 pointer-events-none">
          <div className="bg-brand-600 text-white p-1 rounded-md text-xs font-bold leading-none">
            <i className="fa-solid fa-bolt" />
          </div>
          <span className="font-semibold tracking-wide text-gray-900 dark:text-gray-100">Download Engine</span>
          <span className="text-[10px] bg-brand-500/10 text-brand-600 dark:text-brand-400 px-1.5 py-0.5 rounded border border-brand-500/20 font-mono">v0.1.0 (Rust Core)</span>
        </div>
        <div className="flex items-center space-x-3">
          <button onClick={() => setDark((v) => !v)} className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white transition" title="Toggle Theme">
            <i className={dark ? "fa-solid fa-sun text-amber-400" : "fa-solid fa-moon"} />
          </button>
          <div className="h-3 w-[1px] bg-gray-300 dark:bg-gray-700" />
          <button onClick={() => appWindow.minimize()} className="hover:bg-gray-300 dark:hover:bg-gray-700 px-2 py-1 rounded transition text-gray-500 hover:text-gray-900 dark:hover:text-white">
            <i className="fa-solid fa-minus" />
          </button>
          <button onClick={() => appWindow.toggleMaximize()} className="hover:bg-gray-300 dark:hover:bg-gray-700 px-2 py-1 rounded transition text-gray-500 hover:text-gray-900 dark:hover:text-white">
            <i className="fa-regular fa-square" />
          </button>
          <button
            onClick={closeWindow}
            className="hover:bg-red-500 hover:text-white px-2 py-1 rounded transition text-gray-500"
            title="Sembunyikan ke tray — download tetap jalan. Keluar sepenuhnya dari menu tray."
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-white dark:bg-darkbg-800 border-b border-gray-200 dark:border-gray-700/80 px-4 py-2 flex flex-wrap items-center justify-between gap-2 shadow-sm">
        <div className="flex items-center space-x-1.5">
          <button
            onClick={() => openNewDownload()}
            className="bg-brand-600 hover:bg-brand-700 text-white font-medium px-3.5 py-1.5 rounded-lg flex items-center space-x-2 shadow-sm transition active:scale-95"
          >
            <i className="fa-solid fa-plus text-xs" />
            <span>New Download</span>
          </button>
          <div className="h-5 w-[1px] bg-gray-200 dark:bg-gray-700 mx-1" />
          <button
            onClick={startAllQueued}
            disabled={counts.queued === 0}
            className="hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-emerald-600 dark:text-emerald-400 p-1.5 px-2.5 rounded-md flex items-center space-x-1.5 transition font-medium text-xs"
          >
            <i className="fa-solid fa-play" />
            <span>Start All Queued</span>
          </button>
          <button
            onClick={pauseAllRunning}
            disabled={counts.downloading === 0}
            className="hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-amber-600 dark:text-amber-400 p-1.5 px-2.5 rounded-md flex items-center space-x-1.5 transition font-medium text-xs"
          >
            <i className="fa-solid fa-pause" />
            <span>Pause All</span>
          </button>

          <div className="h-5 w-[1px] bg-gray-200 dark:bg-gray-700 mx-1" />

          <div className="relative">
            <button
              onClick={() => setSpeedMenuOpen((v) => !v)}
              className="hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 p-1.5 px-2.5 rounded-md flex items-center space-x-1.5 transition text-xs"
            >
              <i className="fa-solid fa-gauge-high text-brand-500" />
              <span>Speed Limit: {globalLimit ? globalLimitLabel : "Off"}</span>
            </button>
            {speedMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSpeedMenuOpen(false)} />
                <div className="absolute left-0 mt-1 z-20 w-44 bg-white dark:bg-darkbg-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1">
                  <div className="px-3 py-1.5 text-[10px] text-gray-400 border-b border-gray-100 dark:border-gray-700/60">Cap across all downloads</div>
                  {SPEED_LIMIT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => applyGlobalLimit(opt.value)}
                      className={`w-full text-left px-3 py-1.5 text-xs transition hover:bg-gray-100 dark:hover:bg-darkbg-700/60 ${
                        globalLimit === opt.value ? "text-brand-600 dark:text-brand-400 font-medium" : "text-gray-700 dark:text-gray-300"
                      }`}
                    >
                      {globalLimit === opt.value && <i className="fa-solid fa-check mr-1.5 text-[10px]" />}
                      {opt.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <div className="relative">
            <i className="fa-solid fa-magnifying-glass absolute left-3 top-2.5 text-gray-400 text-xs" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="Search downloads..."
              className="bg-gray-100 dark:bg-darkbg-900 text-xs text-gray-800 dark:text-gray-200 pl-8 pr-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 focus:outline-none focus:ring-1 focus:ring-brand-500 w-48 sm:w-64 transition"
            />
          </div>
          <button onClick={() => setSettingsOpen(true)} className="hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 p-2 rounded-lg transition" title="Settings">
            <i className="fa-solid fa-gear" />
          </button>
        </div>
      </div>

      {/* Bulk action bar — only while something is selected */}
      {selectedIds.size > 0 && (
        <div className="bg-brand-500/10 border-b border-brand-500/20 px-4 py-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-semibold text-brand-700 dark:text-brand-300 mr-1">{selectedIds.size} dipilih</span>
          <div className="h-4 w-[1px] bg-brand-500/30 mx-1" />

          <button
            onClick={bulkResume}
            disabled={bulk.resumable.length === 0}
            className="px-2.5 py-1 rounded-md flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition"
          >
            <i className="fa-solid fa-play" /> Lanjutkan {bulk.resumable.length > 0 && `(${bulk.resumable.length})`}
          </button>
          <button
            onClick={bulkPause}
            disabled={bulk.pausable.length === 0}
            className="px-2.5 py-1 rounded-md flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition"
          >
            <i className="fa-solid fa-pause" /> Jeda {bulk.pausable.length > 0 && `(${bulk.pausable.length})`}
          </button>
          <button
            onClick={bulkCancel}
            disabled={bulk.stoppable.length === 0}
            className="px-2.5 py-1 rounded-md flex items-center gap-1.5 font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition"
          >
            <i className="fa-solid fa-stop" /> Batalkan {bulk.stoppable.length > 0 && `(${bulk.stoppable.length})`}
          </button>
          <button
            onClick={bulkRetry}
            disabled={bulk.retryable.length === 0}
            className="px-2.5 py-1 rounded-md flex items-center gap-1.5 font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition"
          >
            <i className="fa-solid fa-rotate-right" /> Ulangi {bulk.retryable.length > 0 && `(${bulk.retryable.length})`}
          </button>

          <div className="h-4 w-[1px] bg-brand-500/30 mx-1" />

          <button
            onClick={bulkRemove}
            className="px-2.5 py-1 rounded-md flex items-center gap-1.5 font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 transition"
          >
            <i className="fa-solid fa-trash-can" /> Hapus ({selectedIds.size})
          </button>

          <button onClick={clearSelection} className="ml-auto px-2.5 py-1 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-500/10 transition">
            Bersihkan pilihan
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-60 bg-gray-50 dark:bg-darkbg-800/60 border-r border-gray-200 dark:border-gray-700/80 p-3 flex flex-col justify-between select-none overflow-y-auto">
          <div className="space-y-4">
            <div>
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-2 mb-1.5">Status</div>
              <nav className="space-y-0.5">
                {STATUS_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setStatusFilter(f.key)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                      statusFilter === f.key ? "bg-brand-500/10 text-brand-600 dark:text-brand-400" : "text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-darkbg-700/50"
                    }`}
                  >
                    <span className="flex items-center space-x-2">
                      <i className={`${f.icon} w-4`} />
                      <span>{f.label}</span>
                    </span>
                    <span className="bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full text-[10px]">{counts[f.key]}</span>
                  </button>
                ))}
              </nav>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-2 mb-1.5">Categories</div>
              <nav className="space-y-0.5">
                {CATEGORY_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setCategoryFilter(f.key)}
                    className={`w-full flex items-center space-x-2 px-2.5 py-1.5 rounded-lg text-xs transition ${
                      categoryFilter === f.key ? "text-brand-600 dark:text-brand-400 font-medium bg-brand-500/10" : "text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-darkbg-700/50"
                    }`}
                  >
                    <i className={`${f.icon} w-4`} />
                    <span>{f.label}</span>
                  </button>
                ))}
              </nav>
            </div>
          </div>

          <div className="bg-white dark:bg-darkbg-800 p-3 rounded-xl border border-gray-200 dark:border-gray-700/70 shadow-sm space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500 dark:text-gray-400 flex items-center gap-1.5 font-medium">
                <i className="fa-solid fa-gauge-simple-high text-brand-500" /> Speed
              </span>
              <span className="font-mono font-bold text-brand-600 dark:text-brand-400">{formatBytes(totalSpeed)}/s</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
              <div className="bg-brand-500 h-full transition-all duration-300" style={{ width: `${Math.min(100, (totalSpeed / (10 * 1024 * 1024)) * 100)}%` }} />
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-gray-100 dark:border-gray-700/50 text-[11px]">
              <div>
                <div className="text-gray-400">Active Threads</div>
                <div className="font-mono font-semibold text-gray-700 dark:text-gray-200">{activeThreads} Segments</div>
              </div>
              <div>
                <div className="text-gray-400">Concurrency</div>
                <div className="font-mono font-semibold text-gray-700 dark:text-gray-200">
                  {activeCount} / {settings.concurrency} Active
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Table */}
        <main className="flex-1 flex flex-col bg-white dark:bg-darkbg-900 overflow-hidden relative">
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse">
              <thead className="bg-gray-50 dark:bg-darkbg-800/80 sticky top-0 z-10 border-b border-gray-200 dark:border-gray-700/80 text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold select-none">
                <tr>
                  <th className="py-2.5 pl-4 pr-0 w-8">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      // Partial selection reads as neither on nor off.
                      ref={(el) => {
                        if (el) el.indeterminate = selectedIds.size > 0 && !allVisibleSelected;
                      }}
                      onChange={toggleSelectAll}
                      disabled={filteredJobs.length === 0}
                      title="Pilih semua yang terlihat"
                      className="accent-brand-500 w-3.5 h-3.5 cursor-pointer disabled:cursor-not-allowed"
                    />
                  </th>
                  <th className="py-2.5 px-4">File Name</th>
                  <th className="py-2.5 px-3 w-28">Size</th>
                  <th className="py-2.5 px-3 w-32">Status</th>
                  <th className="py-2.5 px-3 w-48">Progress</th>
                  <th className="py-2.5 px-3 w-28 text-right">Speed</th>
                  <th className="py-2.5 px-3 w-24 text-right">ETA</th>
                  <th className="py-2.5 px-3 w-32 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800/60 text-xs">
                {filteredJobs.map((job) => {
                  const pct = progressPercent(job);
                  const isActive = ACTIVE_STATUSES.includes(job.status);
                  const canRetry = ["error", "cancelled", "completed", "interrupted"].includes(job.status);
                  // A stopped job that got somewhere has bytes worth keeping;
                  // a finished one has no partial file left to continue from.
                  const canContinue = canRetry && job.status !== "completed" && job.downloadedBytes > 0;
                  return (
                    <tr
                      key={job.id}
                      onClick={() => setInspectedId(job.id)}
                      className={`hover:bg-gray-50 dark:hover:bg-darkbg-800/50 transition cursor-pointer ${inspectedId === job.id ? "bg-brand-500/5 dark:bg-brand-500/10" : ""}`}
                    >
                      <td className="py-3 pl-4 pr-0" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(job.id)}
                          // onClick, not onChange: only the mouse event carries
                          // the shift key needed for range selection.
                          onClick={(e) => toggleSelect(job.id, e.shiftKey)}
                          onChange={() => {}}
                          className="accent-brand-500 w-3.5 h-3.5 cursor-pointer"
                        />
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center space-x-3">
                          <div className="p-2 rounded-lg bg-gray-100 dark:bg-darkbg-800 text-gray-500 dark:text-gray-400">
                            <i className={`${fileIcon(job.category)} text-base`} />
                          </div>
                          <div className="max-w-xs truncate">
                            <div className="font-semibold text-gray-800 dark:text-gray-100 truncate">{job.name}</div>
                            <div className="text-[10px] text-gray-400 truncate font-mono">{job.url}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-gray-600 dark:text-gray-300">{job.sizeBytes > 0 ? formatBytes(job.sizeBytes) : "-"}</td>
                      <td className="py-3 px-3">{statusBadge(job)}</td>
                      <td className="py-3 px-3">
                        <div className="space-y-1.5">
                          <div className="flex justify-between text-[10px] font-mono">
                            <span>{pct}%</span>
                            <span>
                              {formatBytes(job.downloadedBytes)} / {job.sizeBytes > 0 ? formatBytes(job.sizeBytes) : "?"}
                            </span>
                          </div>
                          <div className="w-full bg-gray-200 dark:bg-gray-700 h-2 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${progressBarClass(job.status)} ${job.status === "downloading" ? "chunk-active" : ""}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-medium text-brand-600 dark:text-brand-400">{job.status === "downloading" ? `${formatBytes(job.speedBytes)}/s` : "-"}</td>
                      <td className="py-3 px-3 text-right font-mono text-gray-500 dark:text-gray-400 text-[11px]">{calculateEta(job)}</td>
                      <td className="py-3 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center space-x-1">
                          {job.status === "downloading" && (
                            <button onClick={() => pauseJob(job.id)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-amber-500" title="Pause">
                              <i className="fa-solid fa-pause" />
                            </button>
                          )}
                          {job.status === "paused" && (
                            <button onClick={() => resumeJob(job.id)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-emerald-500" title="Resume">
                              <i className="fa-solid fa-play" />
                            </button>
                          )}
                          {isActive && (
                            <button onClick={() => cancelJob(job.id)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-red-500" title="Cancel">
                              <i className="fa-solid fa-stop" />
                            </button>
                          )}
                          {canRetry && (
                            <button
                              onClick={() => retryJob(job.id)}
                              className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-emerald-500"
                              title={canContinue ? `Lanjutkan dari ${pct}%` : "Download ulang"}
                            >
                              <i className={canContinue ? "fa-solid fa-play" : "fa-solid fa-rotate-right"} />
                            </button>
                          )}
                          <button onClick={() => setInspectedId(job.id)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-brand-500" title="Inspect">
                            <i className="fa-solid fa-circle-info" />
                          </button>
                          <button
                            onClick={() => removeJob(job.id)}
                            className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-red-500"
                            title={job.status === "completed" ? "Hapus dari daftar" : "Hapus dari daftar & buang file parsial"}
                          >
                            <i className="fa-solid fa-trash-can" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filteredJobs.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-white/80 dark:bg-darkbg-900/80 backdrop-blur-sm">
              <div className="w-16 h-16 bg-brand-500/10 text-brand-500 rounded-full flex items-center justify-center text-2xl mb-3">
                <i className="fa-solid fa-cloud-arrow-down" />
              </div>
              <h3 className="font-semibold text-base text-gray-800 dark:text-gray-200">No downloads found</h3>
              <p className="text-xs text-gray-500 max-w-sm mt-1">Tambahkan URL baru, tarik link ke jendela ini, atau ubah filter yang sedang aktif.</p>
              <button onClick={() => openNewDownload()} className="mt-4 bg-brand-600 hover:bg-brand-700 text-white px-4 py-1.5 rounded-lg text-xs font-medium transition shadow">
                <i className="fa-solid fa-plus mr-1" /> Add Download
              </button>
            </div>
          )}

          <div className="bg-gray-50 dark:bg-darkbg-800 border-t border-gray-200 dark:border-gray-700/80 px-4 py-1.5 text-xs text-gray-500 dark:text-gray-400 flex items-center justify-between select-none">
            <div className="flex items-center space-x-4">
              <span>
                <i className="fa-solid fa-hard-drive mr-1" /> {jobs.length} items in queue
              </span>
              <span>
                <i className="fa-solid fa-shield-halved text-emerald-500 mr-1" /> Range Request Probe: Active
              </span>
            </div>
            <div className="flex items-center space-x-3 font-mono text-[11px]">
              <span>Retries: {settings.maxRetries}</span>
              <span>•</span>
              <span>Disk Pre-allocation: Enabled</span>
              <span>•</span>
              <span>Engine Mode: Parallel Segmented</span>
            </div>
          </div>
        </main>

        {inspectedJob && <InspectorDrawer job={inspectedJob} onClose={() => setInspectedId(null)} />}
      </div>

      {/* Drop overlay. pointer-events-none keeps it from eating the drop. */}
      {dragActive && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/60 backdrop-blur-sm pointer-events-none">
          <div className="border-2 border-dashed border-brand-400 rounded-2xl px-10 py-8 text-center bg-white/95 dark:bg-darkbg-800/95 shadow-2xl">
            <i className="fa-solid fa-link text-3xl text-brand-500" />
            <div className="mt-3 font-semibold text-gray-900 dark:text-gray-100">Lepaskan link untuk menambah download</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Beberapa link sekaligus juga bisa</div>
          </div>
        </div>
      )}

      {(clipboardUrl || notice) && (
        <div className="fixed bottom-6 right-6 z-[70] w-80 flex flex-col gap-2">
          {clipboardUrl && (
            <div className="rounded-xl border border-brand-300 dark:border-brand-500/40 bg-white dark:bg-darkbg-800 shadow-2xl overflow-hidden">
              <div className="px-4 pt-3 pb-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-gray-800 dark:text-gray-100">
                  <i className="fa-solid fa-clipboard text-brand-500" /> Link terdeteksi di clipboard
                </div>
                <div className="mt-1.5 text-[11px] font-mono text-gray-500 dark:text-gray-400 break-all line-clamp-3">{clipboardUrl}</div>
              </div>
              <div className="flex justify-end gap-2 px-4 py-2 bg-gray-50 dark:bg-darkbg-900/50 border-t border-gray-100 dark:border-gray-700">
                <button
                  onClick={() => setClipboardUrl("")}
                  className="px-3 py-1 rounded-lg text-[11px] font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition"
                >
                  Abaikan
                </button>
                <button
                  onClick={() => openNewDownload(clipboardUrl)}
                  className="px-3 py-1 rounded-lg text-[11px] font-medium text-white bg-brand-600 hover:bg-brand-700 transition shadow"
                >
                  Download
                </button>
              </div>
            </div>
          )}
          {notice && (
            <div className="flex items-start gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-darkbg-800 px-4 py-3 shadow-2xl">
              <i className="fa-solid fa-circle-info text-brand-500 mt-0.5" />
              <span className="flex-1 text-xs text-gray-700 dark:text-gray-200">{notice}</span>
              <button onClick={() => setNotice("")} className="text-gray-400 hover:text-gray-600 dark:hover:text-white">
                <i className="fa-solid fa-xmark text-xs" />
              </button>
            </div>
          )}
        </div>
      )}

      {newDownloadOpen && (
        <NewDownloadModal
          defaultSegments={settings.defaultSegments}
          defaultLimit={settings.defaultLimit}
          initialUrl={pendingUrl}
          duplicateOf={(url) => findByUrl(jobs, url)}
          onClose={closeNewDownload}
          onSubmit={(input) => {
            handleCreateJob(input);
            closeNewDownload();
          }}
          onBrowse={browsePath}
        />
      )}

      {settingsOpen && <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)} onSave={setSettings} onBrowse={browsePath} />}
    </div>
  );
}

export default App;
