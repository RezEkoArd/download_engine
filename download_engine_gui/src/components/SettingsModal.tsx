import { useEffect, useState } from "react";
import { CLIPBOARD_POLL_MS } from "../types";
import type { AppSettings, BridgeInfo } from "../types";
import { bridgeInfo } from "../lib/bridge";
import { copyToClipboard } from "../lib/jobActions";

interface Props {
  settings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  onBrowse: () => Promise<string | null>;
}

export default function SettingsModal({ settings, onClose, onSave, onBrowse }: Props) {
  const [defaultSegments, setDefaultSegments] = useState(settings.defaultSegments);
  const [defaultLimit, setDefaultLimit] = useState(settings.defaultLimit);
  const [defaultOutputDir, setDefaultOutputDir] = useState(settings.defaultOutputDir);
  const [concurrency, setConcurrency] = useState(settings.concurrency);
  const [maxRetries, setMaxRetries] = useState(settings.maxRetries);
  const [userAgent, setUserAgent] = useState(settings.userAgent);
  const [clipboardMonitor, setClipboardMonitor] = useState(settings.clipboardMonitor);
  const [browserBridge, setBrowserBridge] = useState(settings.browserBridge);
  const [bridge, setBridge] = useState<BridgeInfo | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetched rather than passed in: the token is only ever needed on this
  // screen, so there's no reason for it to sit in app state.
  useEffect(() => {
    let active = true;
    bridgeInfo()
      .then((info) => {
        if (active) setBridge(info);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function handleBrowse() {
    const picked = await onBrowse();
    if (picked) setDefaultOutputDir(picked);
  }

  async function handleCopyToken() {
    if (!bridge) return;
    await copyToClipboard(bridge.token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function handleSave() {
    onSave({ defaultSegments, defaultLimit, defaultOutputDir, concurrency, maxRetries, userAgent, clipboardMonitor, browserBridge });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      {/* Scrolls: the options list is now taller than a short window. */}
      <div className="bg-white dark:bg-darkbg-800 w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-5 space-y-4">
        <div className="flex justify-between items-center border-b border-gray-200 dark:border-gray-700 pb-3">
          <h3 className="font-bold text-gray-800 dark:text-gray-100 text-base flex items-center gap-2">
            <i className="fa-solid fa-sliders text-brand-500" /> Download Engine Preferences
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-white">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-gray-700 dark:text-gray-300 mb-1">Default Parallel Threads (-n)</label>
            <input
              type="number"
              min={1}
              max={32}
              value={defaultSegments}
              onChange={(e) => setDefaultSegments(Number(e.currentTarget.value) || 8)}
              className="w-full bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg p-2 font-mono dark:text-gray-100"
            />
          </div>

          <div>
            <label className="block font-medium text-gray-700 dark:text-gray-300 mb-1">Default Bandwidth Limit (-r)</label>
            <input
              type="text"
              value={defaultLimit}
              onChange={(e) => setDefaultLimit(e.currentTarget.value)}
              placeholder="cth. 2MB (kosong = unlimited)"
              className="w-full bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg p-2 font-mono dark:text-gray-100"
            />
          </div>

          <div>
            <label className="block font-medium text-gray-700 dark:text-gray-300 mb-1">Default Output Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={defaultOutputDir}
                onChange={(e) => setDefaultOutputDir(e.currentTarget.value)}
                placeholder="Kosong = working directory aplikasi"
                className="flex-1 bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg p-2 font-mono dark:text-gray-100"
              />
              <button type="button" onClick={handleBrowse} className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 px-3 rounded-lg text-gray-700 dark:text-gray-200">
                <i className="fa-regular fa-folder-open" />
              </button>
            </div>
          </div>

          <div>
            <label className="block font-medium text-gray-700 dark:text-gray-300 mb-1">Concurrency (jumlah file aktif bersamaan)</label>
            <input
              type="number"
              min={1}
              max={10}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.currentTarget.value) || 1)}
              className="w-full bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg p-2 font-mono dark:text-gray-100"
            />
            <span className="text-[10px] text-gray-400">File di antrian otomatis mulai saat slot tersedia.</span>
          </div>

          <div>
            <label className="block font-medium text-gray-700 dark:text-gray-300 mb-1">Segment Retry Count</label>
            <input
              type="number"
              min={0}
              max={20}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Number(e.currentTarget.value) || 0)}
              className="w-full bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg p-2 font-mono dark:text-gray-100"
            />
            <span className="text-[10px] text-gray-400">Percobaan ulang per segmen dengan backoff saat koneksi putus.</span>
          </div>

          <div>
            <label className="block font-medium text-gray-700 dark:text-gray-300 mb-1">Custom User-Agent</label>
            <input
              type="text"
              value={userAgent}
              onChange={(e) => setUserAgent(e.currentTarget.value)}
              placeholder="Kosongkan untuk pakai default engine"
              className="w-full bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg p-2 font-mono text-[11px] dark:text-gray-100"
            />
            <span className="text-[10px] text-gray-400">Berlaku untuk download berikutnya, bukan yang sedang berjalan.</span>
          </div>

          <div className="pt-2 border-t border-gray-100 dark:border-gray-700/50">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={clipboardMonitor}
                onChange={(e) => setClipboardMonitor(e.currentTarget.checked)}
                className="mt-0.5 accent-brand-500 w-3.5 h-3.5"
              />
              <span>
                <span className="font-medium text-gray-700 dark:text-gray-300">Pantau Clipboard</span>
                <span className="block text-[10px] text-gray-400 mt-0.5">
                  Saat kamu meng-copy link http(s), aplikasi menawarkan untuk mengunduhnya. Isi clipboard dibaca tiap{" "}
                  {CLIPBOARD_POLL_MS / 1000} detik dan langsung dibuang kalau bukan link — tidak disimpan, tidak dikirim ke mana pun. Matikan saja kalau
                  kamu sering meng-copy data sensitif.
                </span>
              </span>
            </label>
          </div>

          <div className="pt-2 border-t border-gray-100 dark:border-gray-700/50">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={browserBridge}
                onChange={(e) => setBrowserBridge(e.currentTarget.checked)}
                className="mt-0.5 accent-brand-500 w-3.5 h-3.5"
              />
              <span>
                <span className="font-medium text-gray-700 dark:text-gray-300">Terima Link dari Extension Browser</span>
                <span className="block text-[10px] text-gray-400 mt-0.5">
                  Membuka port <span className="font-mono">{bridge?.port ?? "-"}</span> di <span className="font-mono">127.0.0.1</span> — hanya bisa dihubungi dari
                  komputer ini, bukan dari jaringan. Extension wajib mengirim token di bawah; tanpa itu permintaan ditolak.
                </span>
              </span>
            </label>

            {browserBridge && (
              <div className="mt-2 ml-5 space-y-1.5">
                <label className="block font-medium text-gray-700 dark:text-gray-300">Token Pairing</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    // Masked until asked for: this is a credential, and the
                    // settings screen is exactly what ends up in a screenshot
                    // or a shared screen.
                    value={bridge ? (tokenVisible ? bridge.token : "•".repeat(32)) : "memuat…"}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg p-2 font-mono text-[10px] dark:text-gray-100 truncate"
                  />
                  <button
                    type="button"
                    onClick={() => setTokenVisible((v) => !v)}
                    title={tokenVisible ? "Sembunyikan" : "Tampilkan"}
                    className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 px-3 rounded-lg text-gray-700 dark:text-gray-200"
                  >
                    <i className={tokenVisible ? "fa-regular fa-eye-slash" : "fa-regular fa-eye"} />
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyToken}
                    disabled={!bridge}
                    title="Copy token"
                    className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-40 px-3 rounded-lg text-gray-700 dark:text-gray-200"
                  >
                    <i className={copied ? "fa-solid fa-check text-emerald-500" : "fa-regular fa-copy"} />
                  </button>
                </div>
                <span className="block text-[10px] text-gray-400">
                  Tempelkan token ini di halaman opsi extension. Jangan dibagikan: siapa pun di komputer ini yang punya token bisa menambahkan download.
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-gray-100 dark:border-gray-700/50">
            <span className="font-medium text-gray-700 dark:text-gray-300">Disk File Pre-allocation</span>
            <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">Always Enabled</span>
          </div>
        </div>

        <div className="flex justify-end pt-3 border-t border-gray-200 dark:border-gray-700">
          <button onClick={handleSave} className="px-4 py-1.5 rounded-lg text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 shadow">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
