import { useState } from "react";
import type { NewJobInput } from "../types";

interface Props {
  defaultSegments: number;
  defaultLimit: string;
  /** Pre-filled when the modal was opened by dropping a link onto the window. */
  initialUrl?: string;
  /** Existing job for this URL, so the form can warn before it's submitted. */
  duplicateOf: (url: string) => { name: string; status: string } | undefined;
  onClose: () => void;
  onSubmit: (input: NewJobInput) => void;
  onBrowse: () => Promise<string | null>;
}

const LIMIT_OPTIONS = [
  { value: "", label: "Unlimited Speed" },
  { value: "500KB", label: "500 KB/s" },
  { value: "2MB", label: "2 MB/s" },
  { value: "10MB", label: "10 MB/s" },
];

export default function NewDownloadModal({ defaultSegments, defaultLimit, initialUrl = "", duplicateOf, onClose, onSubmit, onBrowse }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [outputPath, setOutputPath] = useState("");
  const [segments, setSegments] = useState(defaultSegments);
  const [limit, setLimit] = useState(defaultLimit);
  const [startInSec, setStartInSec] = useState(0);

  // Only a warning, never a block: re-downloading a link whose file changed on
  // the server is a legitimate thing to want.
  const duplicate = url.trim() ? duplicateOf(url) : undefined;

  async function handleBrowse() {
    const picked = await onBrowse();
    if (picked) setOutputPath(picked);
  }

  function submit(forceStart: boolean) {
    if (!url.trim()) return;
    onSubmit({ url: url.trim(), outputPath: outputPath.trim(), segments, limit, startInSec, forceStart });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-darkbg-800 w-full max-w-lg rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-darkbg-900/50">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 bg-brand-500/10 text-brand-500 rounded-lg">
              <i className="fa-solid fa-circle-plus text-base" />
            </div>
            <h3 className="font-bold text-gray-800 dark:text-gray-100 text-base">Add New Download Task</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-white">
            <i className="fa-solid fa-xmark text-lg" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(true);
          }}
          className="p-5 space-y-4"
        >
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Download URL <span className="text-red-500">*</span>
            </label>
            <input
              type="url"
              required
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              placeholder="https://example.com/large-file.zip"
              className="w-full bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 dark:text-gray-100"
            />
            {duplicate && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3 py-2">
                <i className="fa-solid fa-triangle-exclamation text-amber-500 mt-0.5" />
                <div className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                  Link ini sudah ada di daftar: <span className="font-semibold">{duplicate.name}</span> ({duplicate.status}). Kalau diteruskan, file
                  akan disimpan terpisah, bukan menimpa yang lama.
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Save To Folder (-o)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.currentTarget.value)}
                placeholder="Default: current working directory"
                className="flex-1 bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 dark:text-gray-100"
              />
              <button
                type="button"
                onClick={handleBrowse}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 px-3 py-2 rounded-lg text-xs font-medium transition text-gray-700 dark:text-gray-200 flex items-center gap-1"
              >
                <i className="fa-regular fa-folder-open" /> Browse
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Connections (-n)</label>
                <span className="text-xs font-mono font-bold text-brand-500">{segments}</span>
              </div>
              <input
                type="range"
                min={1}
                max={32}
                value={segments}
                onChange={(e) => setSegments(Number(e.currentTarget.value))}
                className="w-full accent-brand-500 bg-gray-200 dark:bg-gray-700 h-1.5 rounded-lg appearance-none cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                <span>1 (Single)</span>
                <span>32 (Max)</span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Bandwidth Limit (-r)</label>
              <select
                value={limit}
                onChange={(e) => setLimit(e.currentTarget.value)}
                className="w-full bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 dark:text-gray-100"
              >
                {LIMIT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Start Delay (--start-in sec)</label>
            <input
              type="number"
              min={0}
              value={startInSec}
              onChange={(e) => setStartInSec(Number(e.currentTarget.value) || 0)}
              placeholder="0 (Immediate)"
              className="w-full bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 dark:text-gray-100"
            />
          </div>

          <div className="flex items-center justify-end space-x-3 pt-3 border-t border-gray-200 dark:border-gray-700">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => submit(false)}
              className="px-4 py-2 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-200 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 transition"
            >
              Add to Queue
            </button>
            <button type="submit" className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 transition shadow">
              Download Now
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
