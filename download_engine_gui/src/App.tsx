import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import { CLIPBOARD_POLL_MS, SPEED_LIMIT_OPTIONS } from "./types";
import type { AppSettings, FileCategory, IslandMode, IslandPhase, Job, JobHeaders, JobResult, JobStatus, NewJobInput, ProbeResult, ResumeInfo } from "./types";
import { baseName, calculateEta, detectCategory, formatBytes, joinPath, nameFromUrl, progressPercent, uniqueOutputPath } from "./lib/format";
import { loadState, saveState } from "./lib/persistence";
import { notifyDownloadComplete, notifyDownloadFailed } from "./lib/notifications";
import { readClipboardText, revealInFolder } from "./lib/jobActions";
import { setBridgeEnabled } from "./lib/bridge";
import { defaultDownloadDir } from "./lib/paths";
import { dragHasText, extractUrls, findByUrl, isHttpUrl } from "./lib/urls";
import NewDownloadModal from "./components/NewDownloadModal";
import SettingsPage from "./components/SettingsPage";
import InspectorDrawer from "./components/InspectorDrawer";

const appWindow = getCurrentWindow();

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The OS preference right now, for the first render of "Ikuti Sistem". */
const prefersDark = typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches;

const DEFAULT_SETTINGS: AppSettings = {
  defaultSegments: 8,
  defaultLimit: "",
  defaultOutputDir: "",
  concurrency: 1,
  maxRetries: 5,
  userAgent: "",
  clipboardMonitor: false,
  browserBridge: false,
  themeMode: "dark",
  accent: "blue",
  dynamicIsland: true,
  notchAlwaysVisible: false,
};

const STATUS_FILTERS: { key: "all" | JobStatus; label: string; icon: string }[] = [
  { key: "all", label: "Semua Download", icon: "fa-solid fa-list-ul" },
  { key: "downloading", label: "Berjalan", icon: "fa-solid fa-arrow-down-long text-emerald-500" },
  { key: "queued", label: "Antrean", icon: "fa-solid fa-clock text-amber-500" },
  { key: "paused", label: "Dijeda", icon: "fa-solid fa-pause text-blue-400" },
  { key: "interrupted", label: "Terputus", icon: "fa-solid fa-plug-circle-xmark text-orange-500" },
  { key: "completed", label: "Selesai", icon: "fa-solid fa-circle-check text-green-500" },
  { key: "cancelled", label: "Dibatalkan", icon: "fa-solid fa-ban text-gray-400" },
  { key: "error", label: "Gagal", icon: "fa-solid fa-circle-exclamation text-red-500" },
];

const CATEGORY_FILTERS: { key: "all" | FileCategory; label: string; icon: string }[] = [
  { key: "all", label: "Semua Jenis", icon: "fa-solid fa-folder" },
  { key: "compressed", label: "Arsip (zip, rar)", icon: "fa-solid fa-file-zipper text-amber-500" },
  { key: "documents", label: "Dokumen", icon: "fa-solid fa-file-pdf text-red-500" },
  { key: "video", label: "Video & Media", icon: "fa-solid fa-film text-purple-500" },
  { key: "programs", label: "Aplikasi", icon: "fa-solid fa-box text-blue-500" },
];

const ACTIVE_STATUSES: JobStatus[] = ["downloading", "paused"];

/**
 * What the notch's panel lists. Wider than `ACTIVE_STATUSES` on purpose: the
 * panel is a queue view, and one that hid what is waiting would be misleading
 * in a way the toolbar counts are not.
 */
const NOTCH_STATUSES: JobStatus[] = ["downloading", "paused", "queued"];

/** How long the notch keeps saying a download finished. */
const DONE_NOTICE_MS = 8000;

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

/**
 * Tint for the tile behind a row's file icon.
 *
 * Deliberately *not* the accent colour: the accent means "this is the app
 * speaking" — buttons, progress, the active filter — and a column of accent
 * tiles would make every row look selected. These are categories, so they get
 * fixed hues that happen to match the icons.
 */
function fileTint(category: FileCategory): string {
  switch (category) {
    case "compressed":
      return "bg-amber-500/10";
    case "documents":
      return "bg-red-500/10";
    case "video":
      return "bg-purple-500/10";
    case "programs":
      return "bg-blue-500/10";
    default:
      return "bg-gray-500/10";
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
          Berjalan
        </span>
      );
    case "paused":
      return (
        <span className={`${badge} bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20`}>
          <i className="fa-solid fa-pause text-[9px]" />
          Dijeda
        </span>
      );
    case "queued":
      return (
        <span className={`${badge} bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20`}>
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
          Antrean
        </span>
      );
    case "completed":
      return (
        <span className={`${badge} bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20`}>
          <i className="fa-solid fa-check text-[9px]" />
          Selesai
        </span>
      );
    case "cancelled":
      return (
        <span className={`${badge} bg-gray-500/10 text-gray-500 dark:text-gray-400 border-gray-500/20`}>
          <i className="fa-solid fa-ban text-[9px]" />
          Dibatalkan
        </span>
      );
    case "interrupted":
      return (
        <span
          className={`${badge} bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20`}
          title="App ditutup saat download berjalan — bisa dilanjutkan dari posisi terakhir"
        >
          <i className="fa-solid fa-plug-circle-xmark text-[9px]" />
          Terputus
        </span>
      );
    case "error":
      return (
        <span className={`${badge} bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20`}>
          <i className="fa-solid fa-triangle-exclamation text-[9px]" />
          Gagal
        </span>
      );
  }
}

/**
 * Folds a probe result into a job: its size, whether it can be segmented, and
 * the file name the server would rather we used.
 *
 * The rename is deliberately narrow, and skipped when:
 * - the user named the file themselves — their choice outranks the server's;
 * - there is no output folder, since the engine then derives the name from the
 *   URL itself and the label has to keep matching what it will write;
 * - the download is no longer merely queued, because by then the engine has
 *   created and preallocated the file at the old path and the bytes are landing
 *   there. Renaming the job would only lose track of the file.
 *
 * `uniqueOutputPath` still applies, so a suggestion that happens to land on
 * another job's target gets a " (1)" instead of two jobs writing one file.
 *
 * A failed probe is not treated as "no Range support unknown": it reports
 * `supportsRange: false`, which is what the old inline handler did.
 */
function applyProbe(job: Job, result: ProbeResult | null, outputDir: string, otherPaths: ReadonlySet<string>): Job {
  if (!result) return { ...job, supportsRange: false };

  const probed: Job = { ...job, sizeBytes: result.total_size || job.sizeBytes, supportsRange: result.supports_range };

  const suggested = result.suggested_filename;
  if (!suggested || job.nameFromUser || !outputDir || job.status !== "queued" || job.downloadedBytes > 0) return probed;

  // Safe to join: the engine has already reduced this to a single path
  // component, so it cannot climb out of `outputDir`.
  const outputPath = uniqueOutputPath(joinPath(outputDir, suggested), otherPaths);
  if (outputPath === job.outputPath) return probed;

  const name = baseName(outputPath);
  return { ...probed, outputPath, name, category: detectCategory(name) };
}

function App() {
  const [systemDark, setSystemDark] = useState(prefersDark);
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
  /**
   * Per-job request headers, kept out of `jobs` on purpose.
   *
   * These arrive from the browser extension and contain session cookies.
   * `jobs` is written to `app-state.json` as plain text, so putting them there
   * would mean parking live credentials on disk for as long as the job row
   * survives. Holding them in memory means a bridge job that outlives a
   * restart retries without its cookie and fails — which is the honest
   * outcome: the user re-sends it from the browser and gets a fresh one.
   */
  const jobHeadersRef = useRef<Map<string, JobHeaders>>(new Map());

  /*
   * "Ikuti Sistem" has to keep following it, not just read it once at startup:
   * Windows flips the whole desktop between light and dark on a schedule, and
   * an app that sampled the preference at launch would be the only thing left
   * behind.
   */
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const dark = settings.themeMode === "system" ? systemDark : settings.themeMode === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    // Swaps the `--color-brand-*` variables every `brand-*` class resolves
    // through, so one attribute recolours the whole window — see `App.css`.
    document.documentElement.dataset.accent = settings.accent;
  }, [dark, settings.accent]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Pull the last session back in before anything else touches state.
  useEffect(() => {
    let active = true;
    loadState()
      .then(async (saved) => {
        if (!active) return;
        if (typeof saved?.globalLimit === "string") setGlobalLimit(saved.globalLimit);
        if (saved?.jobs) setJobs(saved.jobs);

        const restoredSettings = { ...DEFAULT_SETTINGS, ...saved?.settings };
        // The theme used to be a boolean beside the settings rather than a
        // mode inside them. Files written before that change still carry it,
        // and dropping it would silently reset everyone to dark on upgrade.
        if (!saved?.settings?.themeMode && typeof saved?.dark === "boolean") {
          restoredSettings.themeMode = saved.dark ? "dark" : "light";
        }
        // An empty output dir means files land in the process working
        // directory, which is wherever the app happened to be launched from —
        // effectively "lost". Fill it in on first run instead.
        if (!restoredSettings.defaultOutputDir) {
          const fallback = await defaultDownloadDir();
          if (!active) return;
          restoredSettings.defaultOutputDir = fallback;
        }
        setSettings(restoredSettings);
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

  /**
   * Feeds the notch — the strip at the top of the screen.
   *
   * Everything it shows is decided here, including which mode it is in, so
   * there is one source of truth for what is downloading. The notch cannot
   * work out its own mode anyway: the mode is what sizes its *window*, and
   * only Rust can do that.
   */
  const [notchExpanded, setNotchExpanded] = useState(false);
  const [doneNotice, setDoneNotice] = useState<{ id: string; name: string; outputPath: string } | null>(null);

  // Last status seen per job, so a finish can be spotted as a transition. The
  // job list carries no completion time, and adding one would mean migrating
  // every saved job for a notice that lives eight seconds.
  const seenStatusRef = useRef(new Map<string, JobStatus>());
  useEffect(() => {
    const seen = seenStatusRef.current;
    let finished: Job | null = null;
    for (const job of jobs) {
      const before = seen.get(job.id);
      seen.set(job.id, job.status);
      // The newest finish wins when two land in the same tick: it is the one
      // the user just watched reach 100%.
      if (before && before !== "completed" && job.status === "completed") {
        if (!finished || job.createdAt > finished.createdAt) finished = job;
      }
    }
    for (const id of [...seen.keys()]) {
      if (!jobs.some((j) => j.id === id)) seen.delete(id);
    }
    if (finished) setDoneNotice({ id: finished.id, name: finished.name, outputPath: finished.outputPath });
  }, [jobs]);

  // The finished notice clears itself: it reports something that already
  // happened, so leaving it up would make the notch look stuck.
  useEffect(() => {
    if (!doneNotice) return;
    const timer = setTimeout(() => setDoneNotice(null), DONE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [doneNotice]);

  /*
   * Throttled, because progress events arrive many times a second and each one
   * would otherwise cost an IPC call plus a window emit — for a readout nobody
   * can read that fast. Anything that changes the notch's *shape* goes through
   * immediately: a window that resizes a quarter-second late is visible in a
   * way that a stale byte count is not.
   */
  const islandRef = useRef({ at: 0, shape: "" });
  useEffect(() => {
    const active = jobs.filter((j) => j.status === "downloading");
    // The longest-running job, not the furthest along: picking by progress
    // makes the notch swap files whenever one overtakes another.
    const lead = active.reduce<Job | null>((best, j) => (!best || j.createdAt < best.createdAt ? j : best), null);

    const phase: IslandPhase = lead ? "downloading" : doneNotice ? "done" : "idle";
    const mode: IslandMode = notchExpanded ? "expanded" : phase === "idle" ? "compact" : "active";

    // Idle and collapsed, the notch is only on screen if the user asked for it
    // to stay there — it sits over a browser's tab strip, so the default is to
    // get out of the way.
    const wanted = settings.dynamicIsland && (phase !== "idle" || notchExpanded || settings.notchAlwaysVisible);

    const state = wanted
      ? {
          mode,
          phase,
          // Resolved here, not in the notch: it has no settings of its own,
          // and asking the OS there could disagree with this window.
          theme: dark ? ("dark" as const) : ("light" as const),
          accent: settings.accent,
          name: lead ? lead.name : (doneNotice?.name ?? ""),
          percent: lead ? progressPercent(lead) : 100,
          speed_bytes: lead ? Math.round(lead.speedBytes) : 0,
          downloaded_bytes: lead ? lead.downloadedBytes : 0,
          total_bytes: lead ? lead.sizeBytes : 0,
          // `calculateEta` says "-" when there is nothing to go on; the notch
          // shows nothing at all rather than a dash with no label beside it.
          eta: lead && calculateEta(lead) !== "-" ? calculateEta(lead) : "",
          active_count: active.length,
          // Only the expanded panel has anywhere to put this, and the list is
          // re-serialised on every progress tick.
          items:
            mode === "expanded"
              ? jobs
                  .filter((j) => NOTCH_STATUSES.includes(j.status))
                  .map((j) => ({
                    id: j.id,
                    name: j.name,
                    percent: progressPercent(j),
                    speed_bytes: Math.round(j.speedBytes),
                    status: j.status,
                  }))
              : [],
        }
      : null;

    const shape = `${wanted}|${dark}|${settings.accent}|${mode}|${phase}|${lead?.id ?? doneNotice?.id ?? ""}|${state?.items.length ?? 0}`;
    const now = Date.now();
    if (shape === islandRef.current.shape && now - islandRef.current.at < 250) return;

    islandRef.current = { at: now, shape };
    invoke("island_update", { state }).catch(() => {});
  }, [jobs, doneNotice, notchExpanded, dark, settings.accent, settings.dynamicIsland, settings.notchAlwaysVisible]);

  // What the notch asks the app to do on its behalf. It holds no job list and
  // no opener permission, so every one of its buttons lands here.
  const notchActions = useRef<(action: string) => void>(() => {});
  useEffect(() => {
    notchActions.current = (action: string) => {
      if (action === "expand") setNotchExpanded(true);
      else if (action === "collapse") setNotchExpanded(false);
      else if (action === "pause-all") pauseAllRunning();
      else if (action === "dismiss") setDoneNotice(null);
      else if (action === "reveal" && doneNotice?.outputPath) {
        void revealInFolder(doneNotice.outputPath).catch(() => {});
      }
    };
  });

  useEffect(() => {
    const unlisten = listen<[string, string | null]>("island-action", (event) => {
      notchActions.current(event.payload[0]);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

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
          headers: jobHeadersRef.current.get(job.id) ?? null,
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

  async function probeJob(job: Job): Promise<ProbeResult | null> {
    try {
      // The probe needs the same headers the download will use: without the
      // cookie, a gated link answers about a login page and the size shown
      // would describe the wrong response entirely.
      return await invoke<ProbeResult>("probe_url", {
        url: job.url,
        headers: jobHeadersRef.current.get(job.id) ?? null,
      });
    } catch {
      return null;
    }
  }

  /**
   * `takenPaths` lets a batch stay collision-free: `jobs` doesn't update
   * between synchronous calls, so the caller threads one growing set through
   * them instead of re-reading state that is still stale.
   */
  function handleCreateJob(input: NewJobInput, takenPaths?: Set<string>, headers?: JobHeaders) {
    const id = crypto.randomUUID();
    // Registered before the probe fires, since that is the first request to go
    // out and it needs them too.
    if (headers && Object.keys(headers).length > 0) jobHeadersRef.current.set(id, headers);
    const outputDir = input.outputPath || settings.defaultOutputDir;
    const taken = takenPaths ?? new Set(jobs.map((j) => j.outputPath).filter(Boolean));
    // A name the user typed is confined to a file name — a path they entered
    // here would otherwise nest the file somewhere other than the folder shown
    // right above it in the form.
    const typedName = baseName(input.fileName);
    // The URL name is only a placeholder when the user left the name blank:
    // the probe replaces it with the server's own, which is the whole point for
    // a link like "/download?id=84213".
    const fileName = typedName || nameFromUrl(input.url);
    const outputPath = outputDir ? uniqueOutputPath(joinPath(outputDir, fileName), taken) : "";
    if (outputPath) taken.add(outputPath);
    // Without a folder the engine picks the file name itself, so the label
    // falls back to the name we derived rather than a path.
    const name = outputPath ? baseName(outputPath) : fileName;
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
      nameFromUser: typedName.length > 0,
    };

    const addAndMaybeStart = async () => {
      // The probe gets to decide the final name, and starting the download
      // settles it for good — the engine creates and preallocates the output
      // file, and a rename after that would just lose track of it. So the
      // scheduler is held off until the probe has answered, using the same
      // latch it already honours. Taken before the job is visible to it.
      startingRef.current.add(id);
      setJobs((prev) => [baseJob, ...prev]);
      const result = await probeJob(baseJob);

      // Removed while the probe was in flight: nothing left to correct, and
      // re-adding it through `setJobs` would resurrect a deleted row.
      if (!jobsRef.current.some((j) => j.id === id)) {
        startingRef.current.delete(id);
        return;
      }

      // `jobsRef` rather than `jobs`: this runs a network round trip after the
      // render that added the job, so the ref is current where the closed-over
      // `jobs` is a snapshot from before it existed.
      const current = jobsRef.current.find((j) => j.id === id) ?? baseJob;
      const otherPaths = new Set(
        jobsRef.current
          .filter((j) => j.id !== id)
          .map((j) => j.outputPath)
          .filter(Boolean),
      );
      const probed = applyProbe(current, result, outputDir, otherPaths);

      // Released before the state update, not after: the scheduler re-checks on
      // the render that update triggers, and a hold still set at that point
      // would leave the job sitting in the queue with nothing left to wake it.
      if (!input.forceStart) startingRef.current.delete(id);
      setJobs((prev) => prev.map((j) => (j.id === id ? probed : j)));
      // Handed the probed job, so the engine is told the corrected path rather
      // than the URL-derived one it has just replaced.
      if (input.forceStart) beginJob(probed);
    };

    if (input.startInSec > 0) {
      window.setTimeout(() => void addAndMaybeStart(), input.startInSec * 1000);
    } else {
      void addAndMaybeStart();
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
    jobHeadersRef.current.delete(id);
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
            // A dropped batch is never reviewed, so there is no name to take
            // from the user; the server's own is the best one available.
            fileName: "",
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

  // Opening a port follows the setting, including turning it back off again.
  // A failure flips the switch back rather than leaving the UI claiming the
  // bridge is up while nothing is listening.
  useEffect(() => {
    if (!restored) return;
    let active = true;
    setBridgeEnabled(settings.browserBridge).catch((err) => {
      if (!active || !settings.browserBridge) return;
      setSettings((prev) => ({ ...prev, browserBridge: false }));
      setNotice(`Bridge browser gagal dijalankan: ${err}`);
    });
    return () => {
      active = false;
    };
  }, [restored, settings.browserBridge]);

  // Links handed over by the extension. Routed through a ref for the same
  // reason the drop handler is: the listener must not re-subscribe on every
  // progress tick.
  const bridgeDownloadRef = useRef<(url: string, headers: JobHeaders) => void>(() => {});
  useEffect(() => {
    bridgeDownloadRef.current = (url, headers) => {
      if (!isHttpUrl(url)) return;
      const existing = findByUrl(jobs, url);
      if (existing) {
        setNotice(`Link dari browser sudah ada di daftar: ${existing.name}`);
        return;
      }
      handleCreateJob(
        {
          url,
          outputPath: "",
          // The extension deliberately sends no name — see its README. The
          // server's `Content-Disposition`, sanitised by the engine, is what
          // fills the gap for a link whose URL carries no usable name.
          fileName: "",
          segments: settings.defaultSegments,
          limit: settings.defaultLimit,
          startInSec: 0,
          // Queued, not force-started: the scheduler begins it right away if a
          // slot is free, and respects the concurrency limit if not.
          forceStart: false,
        },
        undefined,
        headers,
      );
      setNotice(`Ditambahkan dari browser: ${nameFromUrl(url)}`);
    };
  });

  useEffect(() => {
    const unlisten = listen<{ url: string; headers: JobHeaders }>("bridge-download", (event) => {
      bridgeDownloadRef.current(event.payload.url, event.payload.headers ?? {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

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

  /** What the heading says the list is. Both filters, because either can hide rows. */
  const viewTitle = [
    STATUS_FILTERS.find((f) => f.key === statusFilter)?.label ?? "Semua Download",
    categoryFilter === "all" ? null : CATEGORY_FILTERS.find((f) => f.key === categoryFilter)?.label,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="relative flex flex-col h-screen w-screen overflow-hidden bg-gray-100 dark:bg-darkbg-900 text-gray-800 dark:text-gray-100 text-sm">
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
          <span className="text-[10px] bg-brand-500/10 text-brand-600 dark:text-brand-400 px-1.5 py-0.5 rounded border border-brand-500/20 font-mono">v{__APP_VERSION__} (Rust Core)</span>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setSettings((prev) => ({ ...prev, themeMode: dark ? "light" : "dark" }))}
            className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white transition"
            title={dark ? "Pakai tema terang" : "Pakai tema gelap"}
          >
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

      {/*
        Everything below the title bar, as its own positioning context. The
        settings page covers this and nothing else: the window has no OS
        decorations, so the title bar above is the only way to minimise or
        close it, and an overlay across the whole window would take those
        buttons away.
      */}
      <div className="relative flex-1 flex flex-col min-h-0">
        {/* Heading + toolbar */}
        <div className="bg-white dark:bg-darkbg-800 border-b border-gray-200 dark:border-gray-700/80 px-5 pt-4 pb-3 shadow-sm">
          <div className="flex items-start justify-between gap-4 mb-3">
            {/* Names the view, so a filtered list never looks like the whole
                list — which is the one way a download manager can quietly lie. */}
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 leading-tight">{viewTitle}</h1>
            <div className="relative shrink-0">
              <i className="fa-solid fa-magnifying-glass absolute left-3 top-2.5 text-gray-400 text-xs" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="Cari download…"
                className="bg-gray-100 dark:bg-darkbg-900 text-xs text-gray-800 dark:text-gray-200 pl-8 pr-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 focus:outline-none focus:ring-1 focus:ring-brand-500 w-48 sm:w-64 transition"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => openNewDownload()}
              className="bg-brand-600 hover:bg-brand-700 text-white font-medium px-3.5 py-1.5 rounded-lg flex items-center space-x-2 shadow-sm transition active:scale-95"
            >
              <i className="fa-solid fa-plus text-xs" />
              <span>Tambah Download</span>
            </button>
            <div className="h-5 w-[1px] bg-gray-200 dark:bg-gray-700 mx-1" />
            <button
              onClick={startAllQueued}
              disabled={counts.queued === 0}
              className="hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-emerald-600 dark:text-emerald-400 p-1.5 px-2.5 rounded-md flex items-center space-x-1.5 transition font-medium text-xs"
            >
              <i className="fa-solid fa-play" />
              <span>Mulai Semua</span>
            </button>
            <button
              onClick={pauseAllRunning}
              disabled={counts.downloading === 0}
              className="hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-amber-600 dark:text-amber-400 p-1.5 px-2.5 rounded-md flex items-center space-x-1.5 transition font-medium text-xs"
            >
              <i className="fa-solid fa-pause" />
              <span>Jeda Semua</span>
            </button>
            <button
              onClick={bulkRemove}
              disabled={selectedIds.size === 0}
              title={selectedIds.size === 0 ? "Pilih dulu baris yang mau dihapus" : `Hapus ${selectedIds.size} yang dipilih`}
              className="hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-red-600 dark:text-red-400 p-1.5 px-2.5 rounded-md flex items-center space-x-1.5 transition font-medium text-xs"
            >
              <i className="fa-solid fa-trash-can" />
              <span>Hapus{selectedIds.size > 0 && ` (${selectedIds.size})`}</span>
            </button>

            <div className="h-5 w-[1px] bg-gray-200 dark:bg-gray-700 mx-1" />

            <div className="relative">
              <button
                onClick={() => setSpeedMenuOpen((v) => !v)}
                className="hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 p-1.5 px-2.5 rounded-md flex items-center space-x-1.5 transition text-xs"
              >
                <i className="fa-solid fa-gauge-high text-brand-500" />
                <span>Batas kecepatan: {globalLimit ? globalLimitLabel : "Nonaktif"}</span>
              </button>
              {speedMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSpeedMenuOpen(false)} />
                  <div className="absolute left-0 mt-1 z-20 w-44 bg-white dark:bg-darkbg-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1">
                    <div className="px-3 py-1.5 text-[10px] text-gray-400 border-b border-gray-100 dark:border-gray-700/60">Batas untuk semua download</div>
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
        <aside className="w-60 shrink-0 bg-gray-50 dark:bg-darkbg-800/60 border-r border-gray-200 dark:border-gray-700/80 flex flex-col select-none">
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            <nav className="space-y-0.5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`relative w-full flex items-center justify-between pl-3 pr-2.5 py-2 rounded-lg text-xs font-medium transition ${
                    statusFilter === f.key ? "bg-brand-500/10 text-brand-600 dark:text-brand-400" : "text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-darkbg-700/50"
                  }`}
                >
                  {/* A tint alone is easy to miss at a glance across eight
                      rows; the bar is what makes the current view obvious. */}
                  {statusFilter === f.key && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-brand-500" />}
                  <span className="flex items-center space-x-2.5">
                    <i className={`${f.icon} w-4`} />
                    <span>{f.label}</span>
                  </span>
                  <span className="bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full text-[10px] font-mono">{counts[f.key]}</span>
                </button>
              ))}
            </nav>

            <div>
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-2 mb-1.5">Kategori</div>
              <nav className="space-y-0.5">
                {CATEGORY_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setCategoryFilter(f.key)}
                    className={`relative w-full flex items-center space-x-2.5 pl-3 pr-2.5 py-2 rounded-lg text-xs transition ${
                      categoryFilter === f.key ? "text-brand-600 dark:text-brand-400 font-medium bg-brand-500/10" : "text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-darkbg-700/50"
                    }`}
                  >
                    {categoryFilter === f.key && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-brand-500" />}
                    <i className={`${f.icon} w-4`} />
                    <span>{f.label}</span>
                  </button>
                ))}
              </nav>
            </div>
          </div>

          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-700/80 text-left text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-darkbg-700/50 transition"
          >
            <i className="fa-solid fa-gear w-4 text-center" />
            <span className="min-w-0">
              <span className="block text-xs font-medium">Pengaturan</span>
              <span className="block text-[10px] text-gray-400 truncate">Umum, download &amp; tampilan</span>
            </span>
          </button>
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
                  <th className="py-2.5 px-4">Nama file</th>
                  <th className="py-2.5 px-3 w-44">Ukuran</th>
                  <th className="py-2.5 px-3 w-28 text-right">Kecepatan</th>
                  {/*
                    One column, not two. "Sisa waktu" only means anything while
                    a job is running; for every other state the useful thing to
                    show in that space is the state itself.
                  */}
                  <th className="py-2.5 px-3 w-32">Sisa waktu</th>
                  <th className="py-2.5 px-3 w-32 text-center">Aksi</th>
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
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center ${fileTint(job.category)}`}>
                            <i className={`${fileIcon(job.category)} text-base`} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-gray-800 dark:text-gray-100 truncate" title={job.url}>
                              {job.name}
                            </div>
                            {/* The bar sits under the name rather than in a
                                column of its own: progress belongs to the file,
                                and pairing them frees the width that the old
                                Progress and Status columns took. */}
                            <div className="flex items-center gap-2 mt-1.5">
                              <div className="flex-1 bg-gray-200 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
                                <div
                                  className={`h-full transition-all duration-300 ${progressBarClass(job.status)} ${job.status === "downloading" ? "chunk-active" : ""}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400 w-9 text-right">{pct}%</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-[11px] text-gray-600 dark:text-gray-300">
                        {formatBytes(job.downloadedBytes)} / {job.sizeBytes > 0 ? formatBytes(job.sizeBytes) : "?"}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-medium text-brand-600 dark:text-brand-400">{job.status === "downloading" ? `${formatBytes(job.speedBytes)}/s` : "-"}</td>
                      <td className="py-3 px-3">
                        {job.status === "downloading" ? (
                          <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">{calculateEta(job)}</span>
                        ) : (
                          statusBadge(job)
                        )}
                      </td>
                      <td className="py-3 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center space-x-1">
                          {job.status === "downloading" && (
                            <button onClick={() => pauseJob(job.id)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-amber-500" title="Jeda">
                              <i className="fa-solid fa-pause" />
                            </button>
                          )}
                          {job.status === "paused" && (
                            <button onClick={() => resumeJob(job.id)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-emerald-500" title="Lanjutkan">
                              <i className="fa-solid fa-play" />
                            </button>
                          )}
                          {isActive && (
                            <button onClick={() => cancelJob(job.id)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-red-500" title="Batalkan">
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
                          <button onClick={() => setInspectedId(job.id)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-brand-500" title="Lihat detail">
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
              <h3 className="font-semibold text-base text-gray-800 dark:text-gray-200">Belum ada download</h3>
              <p className="text-xs text-gray-500 max-w-sm mt-1">Tambahkan URL baru, tarik link ke jendela ini, atau ubah filter yang sedang aktif.</p>
              <button onClick={() => openNewDownload()} className="mt-4 bg-brand-600 hover:bg-brand-700 text-white px-4 py-1.5 rounded-lg text-xs font-medium transition shadow">
                <i className="fa-solid fa-plus mr-1" /> Tambah Download
              </button>
            </div>
          )}

          {/*
            Live numbers only. The strings that used to sit here — "Range
            Request Probe: Active", "Disk Pre-allocation: Enabled", "Engine
            Mode: Parallel Segmented" — were constants, and a status bar that
            never changes teaches you to stop reading it.
          */}
          <div className="bg-gray-50 dark:bg-darkbg-800 border-t border-gray-200 dark:border-gray-700/80 px-5 py-2 text-xs text-gray-500 dark:text-gray-400 flex items-center justify-between gap-4 select-none">
            <div className="flex items-center gap-5">
              <span className="flex items-center gap-2">
                <i className="fa-solid fa-bolt text-brand-500" />
                Kecepatan total: <span className="font-mono font-bold text-brand-600 dark:text-brand-400">{formatBytes(totalSpeed)}/s</span>
              </span>
              <span className="hidden sm:flex items-center gap-2">
                <i className="fa-regular fa-file" />
                <span className="font-mono">
                  {activeCount} / {settings.concurrency}
                </span>{" "}
                download aktif
              </span>
            </div>
            <div className="flex items-center gap-3 font-mono text-[11px]">
              <span>{activeThreads} segmen</span>
              <span className="opacity-40">•</span>
              <span>{jobs.length} di daftar</span>
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
          defaultOutputDir={settings.defaultOutputDir}
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

        {settingsOpen && (
          <SettingsPage settings={settings} defaults={DEFAULT_SETTINGS} onChange={setSettings} onClose={() => setSettingsOpen(false)} onBrowse={browsePath} />
        )}
      </div>
    </div>
  );
}

export default App;
