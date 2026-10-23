import { useState } from "react";
import { CLIPBOARD_POLL_MS } from "../types";
import type { AppSettings } from "../types";

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

  async function handleBrowse() {
    const picked = await onBrowse();
    if (picked) setDefaultOutputDir(picked);
  }

  function handleSave() {
    onSave({ defaultSegments, defaultLimit, defaultOutputDir, concurrency, maxRetries, userAgent, clipboardMonitor });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-darkbg-800 w-full max-w-md rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-5 space-y-4">
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
                placeholder="Current working directory"
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
