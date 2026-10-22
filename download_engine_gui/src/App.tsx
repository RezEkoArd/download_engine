import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type DownloadProgress = {
  downloaded: number;
  total: number;
};

type QueueProgress = {
  index: number;
  downloaded: number;
  total: number;
};

type QueueJobResult = {
  url: string;
  output: string;
  error: string | null;
};

type Status = "idle" | "downloading" | "done" | "error";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function parseUrls(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function App() {
  const [urlsText, setUrlsText] = useState("");
  const [output, setOutput] = useState("");
  const [segments, setSegments] = useState("8");
  const [limit, setLimit] = useState("");
  const [concurrency, setConcurrency] = useState("1");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [singleProgress, setSingleProgress] = useState<DownloadProgress>({ downloaded: 0, total: 0 });
  const [queueProgress, setQueueProgress] = useState<Record<number, DownloadProgress>>({});
  const [queueResults, setQueueResults] = useState<QueueJobResult[] | null>(null);
  const [message, setMessage] = useState("");
  const startedAt = useRef<number>(0);

  const urls = parseUrls(urlsText);
  const isQueue = urls.length > 1;

  useEffect(() => {
    const unlistenSingle = listen<DownloadProgress>("download-progress", (event) => {
      setSingleProgress(event.payload);
    });
    const unlistenQueue = listen<QueueProgress>("queue-progress", (event) => {
      const { index, downloaded, total } = event.payload;
      setQueueProgress((prev) => ({ ...prev, [index]: { downloaded, total } }));
    });
    return () => {
      unlistenSingle.then((fn) => fn());
      unlistenQueue.then((fn) => fn());
    };
  }, []);

  async function handleDownload(e: React.FormEvent) {
    e.preventDefault();
    if (urls.length === 0) return;

    setStatus("downloading");
    setMessage("");
    setSingleProgress({ downloaded: 0, total: 0 });
    setQueueProgress({});
    setQueueResults(null);
    startedAt.current = Date.now();

    try {
      if (isQueue) {
        const results = await invoke<QueueJobResult[]>("start_queue", {
          urls,
          segments: Number(segments) || 8,
          limit: limit.trim() || null,
          concurrency: Number(concurrency) || 1,
        });
        setQueueResults(results);
        const failed = results.filter((r) => r.error);
        setStatus(failed.length > 0 ? "error" : "done");
        setMessage(failed.length > 0 ? `${failed.length} dari ${results.length} file gagal` : `${results.length} file selesai didownload`);
      } else {
        const savedPath = await invoke<string>("start_download", {
          url: urls[0],
          output: output.trim() || null,
          segments: Number(segments) || 8,
          limit: limit.trim() || null,
        });
        setStatus("done");
        setMessage(`Tersimpan di ${savedPath}`);
      }
    } catch (err) {
      setStatus("error");
      setMessage(String(err));
    }
  }

  const percent = singleProgress.total > 0 ? Math.min(100, (singleProgress.downloaded / singleProgress.total) * 100) : 0;
  const elapsedSec = (Date.now() - startedAt.current) / 1000;
  const speed = status === "downloading" && elapsedSec > 0 ? singleProgress.downloaded / elapsedSec : 0;

  return (
    <main className="container">
      <div className="header-row">
        <div>
          <h1>Download Engine</h1>
          <p className="subtitle">Segmented downloader — multi-connection, bandwidth limiter, auto-retry</p>
        </div>
        <button type="button" className="settings-toggle" onClick={() => setSettingsOpen((v) => !v)} aria-label="Pengaturan">
          ⚙ Pengaturan
        </button>
      </div>

      <form className="download-form" onSubmit={handleDownload}>
        <div className="field">
          <label htmlFor="url-input">URL File</label>
          <textarea
            id="url-input"
            placeholder={"https://example.com/file.zip\n(satu URL per baris untuk download banyak file sekaligus)"}
            value={urlsText}
            onChange={(e) => setUrlsText(e.currentTarget.value)}
            disabled={status === "downloading"}
            rows={isQueue ? Math.min(urls.length + 1, 5) : 2}
          />
        </div>

        {settingsOpen && (
          <div className="settings-panel">
            <div className="field">
              <label htmlFor="output-input">Output Path {isQueue && <span className="hint">(diabaikan untuk banyak file, nama otomatis dari URL)</span>}</label>
              <input
                id="output-input"
                type="text"
                placeholder="Nama file otomatis dari URL kalau dikosongkan"
                value={output}
                onChange={(e) => setOutput(e.currentTarget.value)}
                disabled={status === "downloading" || isQueue}
              />
            </div>

            <div className="settings-grid">
              <div className="field">
                <label htmlFor="segments-input">Jumlah Segmen</label>
                <input
                  id="segments-input"
                  type="number"
                  min={1}
                  max={32}
                  value={segments}
                  onChange={(e) => setSegments(e.currentTarget.value)}
                  disabled={status === "downloading"}
                />
                <span className="hint">Jumlah koneksi paralel per file (default 8)</span>
              </div>

              <div className="field">
                <label htmlFor="limit-input">Batas Bandwidth</label>
                <input
                  id="limit-input"
                  type="text"
                  placeholder="cth. 2MB, 500KB"
                  value={limit}
                  onChange={(e) => setLimit(e.currentTarget.value)}
                  disabled={status === "downloading"}
                />
                <span className="hint">Kosongkan untuk tanpa batas</span>
              </div>

              <div className="field">
                <label htmlFor="concurrency-input">Concurrency</label>
                <input
                  id="concurrency-input"
                  type="number"
                  min={1}
                  max={10}
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.currentTarget.value)}
                  disabled={status === "downloading" || !isQueue}
                />
                <span className="hint">Jumlah file didownload bersamaan (hanya berlaku untuk banyak file)</span>
              </div>
            </div>
          </div>
        )}

        <button type="submit" disabled={status === "downloading" || urls.length === 0}>
          {status === "downloading" ? "Mengunduh..." : isQueue ? `Download ${urls.length} File` : "Download"}
        </button>
      </form>

      {status !== "idle" && !isQueue && (
        <div className="progress-section">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="progress-stats">
            <span>{percent.toFixed(1)}%</span>
            <span>
              {formatBytes(singleProgress.downloaded)} / {singleProgress.total > 0 ? formatBytes(singleProgress.total) : "?"}
            </span>
            {status === "downloading" && <span>{formatBytes(speed)}/s</span>}
          </div>
        </div>
      )}

      {status !== "idle" && isQueue && (
        <div className="queue-list">
          {urls.map((u, i) => {
            const p = queueProgress[i] ?? { downloaded: 0, total: 0 };
            const pct = p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;
            const result = queueResults?.[i];
            return (
              <div className="queue-item" key={i}>
                <div className="queue-item-name">{u.split("/").pop() || u}</div>
                <div className="progress-bar small">
                  <div className={`progress-fill ${result?.error ? "error" : ""}`} style={{ width: `${result ? 100 : pct}%` }} />
                </div>
                <div className="queue-item-status">
                  {result ? (result.error ? `Gagal: ${result.error}` : "Selesai") : `${pct.toFixed(0)}%`}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {message && <p className={`message ${status}`}>{message}</p>}
    </main>
  );
}

export default App;
