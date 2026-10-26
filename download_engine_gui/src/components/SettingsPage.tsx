import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ACCENTS, CLIPBOARD_POLL_MS } from "../types";
import type { AppSettings, BridgeInfo, ThemeMode } from "../types";
import { bridgeInfo } from "../lib/bridge";
import { copyToClipboard } from "../lib/jobActions";

// Where the extension zip lives. Hardcoded rather than built from the app
// version: /latest always points at the newest release, so this line does not
// go stale when the version bumps.
const RELEASES_URL = "https://github.com/RezEkoArd/download_engine/releases/latest";
const REPO_URL = "https://github.com/RezEkoArd/download_engine";

interface Props {
  settings: AppSettings;
  defaults: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
  onBrowse: () => Promise<string | null>;
}

type SectionId = "umum" | "download" | "tampilan" | "notch" | "browser" | "tentang";

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; icon: string }> = [
  { id: "umum", label: "Umum", icon: "fa-sliders" },
  { id: "download", label: "Download", icon: "fa-download" },
  { id: "tampilan", label: "Tampilan", icon: "fa-display" },
  { id: "notch", label: "Notch & Notifikasi", icon: "fa-bell" },
  { id: "browser", label: "Integrasi Browser", icon: "fa-link" },
  { id: "tentang", label: "Tentang", icon: "fa-circle-info" },
];

const THEMES: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Terang" },
  { value: "dark", label: "Gelap" },
  { value: "system", label: "Ikuti Sistem" },
];

/**
 * Settings, as a page that takes over the window rather than a dialog.
 *
 * There is too much here for a modal — six groups of options, one of which is
 * a theme picker you want to *see* applied. A dialog would have dimmed the
 * very window the preview is supposed to be previewing.
 *
 * Every control writes straight through `onChange`; there is no draft state
 * and no Save button. That is not only to save a click: the theme and accent
 * apply to the live window, so a draft copy would mean either previewing a
 * change that isn't saved yet or saving one the user hasn't confirmed. Letting
 * the real setting be the only setting removes the question.
 */
export default function SettingsPage({ settings, defaults, onChange, onClose, onBrowse }: Props) {
  const [section, setSection] = useState<SectionId>("umum");
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

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  async function handleBrowse() {
    const picked = await onBrowse();
    if (picked) set("defaultOutputDir", picked);
  }

  async function handleCopyToken() {
    if (!bridge) return;
    await copyToClipboard(bridge.token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function restoreDefaults() {
    // The output folder is left alone: it was filled in from the OS Downloads
    // directory on first run, and resetting it to the empty default would send
    // files to the process working directory instead.
    onChange({ ...defaults, defaultOutputDir: settings.defaultOutputDir });
  }

  return (
    <div className="absolute inset-0 z-40 flex bg-gray-100 dark:bg-darkbg-900">
      <nav className="w-60 shrink-0 flex flex-col border-r border-gray-200 dark:border-gray-700/60 bg-white dark:bg-darkbg-800">
        <button
          onClick={onClose}
          className="flex items-center gap-2.5 px-4 py-3.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-darkbg-700/60 transition"
        >
          <i className="fa-solid fa-arrow-left" /> Kembali ke Download
        </button>

        <div className="px-4 pb-1.5 pt-2 text-[10px] uppercase tracking-wider text-gray-400">Pengaturan</div>

        <div className="px-2 space-y-0.5">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs transition ${
                section === item.id
                  ? "bg-brand-500/10 text-brand-600 dark:text-brand-400 font-semibold"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-darkbg-700/60"
              }`}
            >
              <i className={`fa-solid ${item.icon} w-4 text-center`} />
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-auto px-4 py-3 border-t border-gray-200 dark:border-gray-700/60 flex items-center gap-2 text-[10px] text-gray-400">
          <span className="w-5 h-5 rounded bg-brand-600 text-white flex items-center justify-center">
            <i className="fa-solid fa-bolt text-[9px]" />
          </span>
          Download Engine · v{__APP_VERSION__}
        </div>
      </nav>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto px-8 py-7">
          {section === "umum" && (
            <Section title="Umum" lead="Perilaku dasar aplikasi.">
              <NumberField
                label="Concurrency"
                hint="Berapa file boleh aktif bersamaan. File di antrean otomatis mulai saat slot tersedia. Job yang dijeda tetap menghitung."
                value={settings.concurrency}
                min={1}
                max={10}
                onChange={(v) => set("concurrency", v || 1)}
              />
              <NumberField
                label="Percobaan ulang per segmen"
                hint="Berapa kali satu segmen dicoba ulang dengan backoff sebelum job dinyatakan gagal."
                value={settings.maxRetries}
                min={0}
                max={20}
                onChange={(v) => set("maxRetries", v)}
              />
              <Toggle
                label="Pantau Clipboard"
                hint={`Saat kamu meng-copy link http(s), aplikasi menawarkan untuk mengunduhnya. Isi clipboard dibaca tiap ${
                  CLIPBOARD_POLL_MS / 1000
                } detik dan langsung dibuang kalau bukan link — tidak disimpan, tidak dikirim ke mana pun. Matikan kalau kamu sering meng-copy data sensitif.`}
                checked={settings.clipboardMonitor}
                onChange={(v) => set("clipboardMonitor", v)}
              />
              <Row label="Pre-alokasi berkas di disk">
                <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                  Selalu aktif
                </span>
              </Row>
            </Section>
          )}

          {section === "download" && (
            <Section title="Download" lead="Nilai awal yang dipakai form New Download.">
              <div>
                <FieldLabel>Folder tujuan</FieldLabel>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.defaultOutputDir}
                    onChange={(e) => set("defaultOutputDir", e.currentTarget.value)}
                    placeholder="Kosong = working directory aplikasi"
                    className={`${inputClass} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={handleBrowse}
                    className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 px-3.5 rounded-lg text-gray-700 dark:text-gray-200"
                  >
                    <i className="fa-regular fa-folder-open" />
                  </button>
                </div>
              </div>
              <NumberField
                label="Jumlah koneksi paralel"
                hint="Berapa segmen dipakai untuk satu berkas. Server yang menolak permintaan range tetap diunduh satu aliran."
                value={settings.defaultSegments}
                min={1}
                max={32}
                onChange={(v) => set("defaultSegments", v || 8)}
              />
              <TextField
                label="Batas kecepatan"
                hint="Contoh: 2MB. Kosong berarti tanpa batas."
                value={settings.defaultLimit}
                placeholder="cth. 2MB"
                onChange={(v) => set("defaultLimit", v)}
              />
              <TextField
                label="User-Agent"
                hint="Berguna untuk server yang menolak client tak dikenal. Berlaku untuk download berikutnya, bukan yang sedang berjalan."
                value={settings.userAgent}
                placeholder="Kosongkan untuk pakai default engine"
                onChange={(v) => set("userAgent", v)}
              />
            </Section>
          )}

          {section === "tampilan" && (
            <Section title="Tampilan" lead="Sesuaikan tampilan aplikasi dengan kenyamananmu.">
              <div>
                <FieldLabel>Tema aplikasi</FieldLabel>
                <div className="grid grid-cols-3 gap-3">
                  {THEMES.map((theme) => (
                    <button
                      key={theme.value}
                      onClick={() => set("themeMode", theme.value)}
                      className={`rounded-xl border-2 p-2.5 text-left transition ${
                        settings.themeMode === theme.value
                          ? "border-brand-500 bg-brand-500/5"
                          : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                      }`}
                    >
                      <ThemePreview mode={theme.value} />
                      <div className="flex items-center gap-2 mt-2.5 text-xs">
                        <i
                          className={
                            settings.themeMode === theme.value
                              ? "fa-solid fa-circle-check text-brand-500"
                              : "fa-regular fa-circle text-gray-300 dark:text-gray-600"
                          }
                        />
                        {theme.label}
                      </div>
                    </button>
                  ))}
                </div>
                <Hint>Tema diterapkan ke seluruh aplikasi, termasuk notch.</Hint>
              </div>

              <div>
                <FieldLabel>Warna aksen</FieldLabel>
                <div className="grid grid-cols-2 gap-3">
                  {ACCENTS.map((accent) => (
                    <AccentButton
                      key={accent.value}
                      accent={accent}
                      selected={settings.accent === accent.value}
                      onSelect={() => set("accent", accent.value)}
                    />
                  ))}
                </div>
                <Hint>Dipakai tombol, progres, menu aktif, dan progres di notch.</Hint>
              </div>

              <div>
                <FieldLabel>Pratinjau</FieldLabel>
                <div className="flex items-center gap-3 bg-white dark:bg-darkbg-800 border border-gray-200 dark:border-gray-700 rounded-xl p-3">
                  <span className="w-8 h-8 rounded-lg bg-brand-600 text-white flex items-center justify-center shrink-0">
                    <i className="fa-solid fa-bolt text-xs" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">Project-assets.zip</div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: "64%" }} />
                    </div>
                  </div>
                  <span className="font-mono text-xs font-semibold text-brand-600 dark:text-brand-400">64%</span>
                  <span className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium">Tambah Download</span>
                </div>
              </div>
            </Section>
          )}

          {section === "notch" && (
            <Section title="Notch & Notifikasi" lead="Strip yang menempel di tepi atas layar.">
              <Toggle
                label="Tampilkan notch"
                hint="Nama berkas, persen, kecepatan, dan sisa waktu selagi ada download berjalan. Selalu di atas jendela lain, muncul dan hilang sendiri. Tarik untuk memindahkannya — termasuk ke monitor lain — dan posisinya diingat."
                checked={settings.dynamicIsland}
                onChange={(v) => set("dynamicIsland", v)}
              />
              {settings.dynamicIsland && (
                <div className="ml-6">
                  <Toggle
                    label="Biarkan tetap tampak saat menganggur"
                    hint="Supaya notch bisa digeser kapan saja, bukan cuma saat ada download. Sadari harganya: ia duduk persis di tempat deretan tab browser, dan klik yang mengenainya tidak sampai ke jendela di belakangnya."
                    checked={settings.notchAlwaysVisible}
                    onChange={(v) => set("notchAlwaysVisible", v)}
                  />
                </div>
              )}
              <Hint>
                Notifikasi sistem untuk download selesai dan gagal selalu aktif, dan diatur dari pengaturan notifikasi Windows — bukan dari sini.
              </Hint>
            </Section>
          )}

          {section === "browser" && (
            <Section title="Integrasi Browser" lead="Menerima link langsung dari extension.">
              <Toggle
                label="Terima link dari extension browser"
                hint={`Membuka port ${bridge?.port ?? "-"} di 127.0.0.1 — hanya bisa dihubungi dari komputer ini, bukan dari jaringan. Extension wajib mengirim token di bawah; tanpa itu permintaan ditolak.`}
                checked={settings.browserBridge}
                onChange={(v) => set("browserBridge", v)}
              />

              {settings.browserBridge && (
                <div className="ml-6 space-y-2">
                  <FieldLabel>Token pairing</FieldLabel>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      // Masked until asked for: this is a credential, and the
                      // settings screen is exactly what ends up in a
                      // screenshot or a shared screen.
                      value={bridge ? (tokenVisible ? bridge.token : "•".repeat(32)) : "memuat…"}
                      onFocus={(e) => e.currentTarget.select()}
                      className={`${inputClass} flex-1 min-w-0 text-[11px] truncate`}
                    />
                    <IconBtn
                      icon={tokenVisible ? "fa-regular fa-eye-slash" : "fa-regular fa-eye"}
                      title={tokenVisible ? "Sembunyikan" : "Tampilkan"}
                      onClick={() => setTokenVisible((v) => !v)}
                    />
                    <IconBtn
                      icon={copied ? "fa-solid fa-check text-emerald-500" : "fa-regular fa-copy"}
                      title="Copy token"
                      disabled={!bridge}
                      onClick={handleCopyToken}
                    />
                  </div>
                  <Hint>
                    Tempelkan token ini di halaman opsi extension. Jangan dibagikan: siapa pun di komputer ini yang punya token bisa menambahkan
                    download.
                  </Hint>
                  <Hint>
                    Belum punya extension-nya?{" "}
                    <Link url={RELEASES_URL}>
                      Unduh <span className="font-mono">browser-extension.zip</span> di halaman Releases
                    </Link>
                    , ekstrak, lalu muat lewat <span className="font-mono">chrome://extensions</span> &rarr; Load unpacked.
                  </Hint>
                </div>
              )}
            </Section>
          )}

          {section === "tentang" && (
            <Section title="Tentang" lead="Download Engine — pengunduh bersegmen dengan inti Rust.">
              <Row label="Versi">
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">v{__APP_VERSION__}</span>
              </Row>
              <Row label="Kode sumber">
                <Link url={REPO_URL}>github.com/RezEkoArd/download_engine</Link>
              </Row>
              <Row label="Rilis & extension">
                <Link url={RELEASES_URL}>Halaman Releases</Link>
              </Row>
            </Section>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700/60 bg-white dark:bg-darkbg-800 px-8 py-3 flex items-center justify-between text-xs">
          <span className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <i className="fa-solid fa-circle-check text-emerald-500" /> Perubahan tersimpan otomatis
          </span>
          <button
            onClick={restoreDefaults}
            className="flex items-center gap-2 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition"
          >
            <i className="fa-solid fa-rotate-left" /> Kembalikan default
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- pieces */

const inputClass =
  "bg-gray-50 dark:bg-darkbg-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-xs font-mono dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-brand-500";

function Section({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{lead}</p>
      </div>
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">{children}</label>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400 mt-1.5">{children}</p>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-t border-gray-200 dark:border-gray-700/60">
      <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</span>
      {children}
    </div>
  );
}

function TextField({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={`${inputClass} w-full`}
      />
      <Hint>{hint}</Hint>
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className={`${inputClass} w-32`}
      />
      <Hint>{hint}</Hint>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} className="mt-0.5 accent-brand-500 w-4 h-4" />
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-gray-700 dark:text-gray-300">{label}</span>
        <Hint>{hint}</Hint>
      </span>
    </label>
  );
}

function IconBtn({ icon, title, onClick, disabled }: { icon: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-40 px-3.5 rounded-lg text-gray-700 dark:text-gray-200"
    >
      <i className={icon} />
    </button>
  );
}

function Link({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => {
        void openUrl(url).catch(() => {});
      }}
      className="text-brand-600 dark:text-brand-400 hover:underline text-left"
    >
      {children}
    </button>
  );
}

function AccentButton({
  accent,
  selected,
  onSelect,
}: {
  accent: (typeof ACCENTS)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-xl border-2 p-3 transition ${
        selected ? "border-brand-500" : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
      }`}
    >
      {/*
        The swatch is painted from the palette's own value rather than a
        `brand-*` class: those resolve to the accent that is *currently*
        applied, so every swatch would show the same colour.
      */}
      <span className="w-7 h-7 rounded-full shrink-0" style={{ background: accent.swatch }} />
      <i className={selected ? "fa-solid fa-circle-check text-brand-500" : "fa-regular fa-circle text-gray-300 dark:text-gray-600"} />
      <span className="text-xs">{accent.label}</span>
    </button>
  );
}

/**
 * The miniature in each theme card.
 *
 * Drawn with fixed colours instead of theme classes, because its whole job is
 * to show what a theme looks like *while you are not in it* — a preview built
 * from `dark:` classes would show the current theme three times over. "Ikuti
 * Sistem" gets both halves, which is the only honest picture of a setting
 * whose answer changes during the day.
 */
function ThemePreview({ mode }: { mode: ThemeMode }) {
  if (mode === "system") {
    return (
      <div className="h-16 rounded-lg overflow-hidden flex border border-gray-200 dark:border-gray-700">
        <div className="w-1/2 overflow-hidden">
          <Mini dark={false} />
        </div>
        <div className="w-1/2 overflow-hidden">
          <Mini dark />
        </div>
      </div>
    );
  }
  return (
    <div className="h-16 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      <Mini dark={mode === "dark"} />
    </div>
  );
}

function Mini({ dark }: { dark: boolean }) {
  const page = dark ? "#0f172a" : "#f3f4f6";
  const panel = dark ? "#1e293b" : "#ffffff";
  const bar = dark ? "#334155" : "#e5e7eb";
  return (
    <div className="h-16 w-full flex" style={{ background: page }}>
      <div className="w-1/4 h-full" style={{ background: panel }} />
      <div className="flex-1 p-1.5 space-y-1">
        <div className="h-1.5 w-2/3 rounded-full bg-brand-500" />
        {[0.85, 0.6, 0.72].map((width, i) => (
          <div key={i} className="h-1.5 rounded-full" style={{ background: bar, width: `${width * 100}%` }} />
        ))}
      </div>
    </div>
  );
}
