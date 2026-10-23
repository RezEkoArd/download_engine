# Download Engine

Download manager bergaya IDM: engine download tersegmentasi di Rust, plus aplikasi desktop Tauri + React di atasnya.

Satu repo, dua crate yang digabung lewat Cargo workspace:

| Crate | Isi | Dokumentasi |
| --- | --- | --- |
| `download_engine` | Core engine + CLI. Segmented download, pause/resume/cancel, resume lintas sesi, bandwidth limiter, queue | [download_engine/README.md](download_engine/README.md) |
| `download_engine_gui` | Aplikasi desktop (Tauri 2 + React 19). Memakai `download_engine` sebagai library, bukan memanggil CLI-nya | [download_engine_gui/README.md](download_engine_gui/README.md) |

Engine sengaja berupa library, jadi GUI dan CLI berbagi logic download yang sama tanpa duplikasi.

## Setup Environment

Butuh **Rust**, **Node.js 20+**, dan **pnpm**.

Vite 8 memakai Rolldown, yang butuh API `node:util` yang baru ada di Node 20. Di Node 18 build-nya berhenti dengan `does not provide an export named 'styleText'` — pesannya tidak menyinggung versi Node sama sekali. Kalau pakai nvm, pastikan versinya dulu:

```powershell
nvm use 22
node -v
```

Build Rust di Windows butuh linker C/C++. Kalau Visual Studio Build Tools (MSVC) belum ada, pakai toolchain **GNU**:

```powershell
winget install BrechtSanders.WinLibs.POSIX.UCRT
rustup default stable-x86_64-pc-windows-gnu
```

MinGW harus ada di PATH, bukan cuma terinstall: build script `tauri-winres` memanggil `windres` saat meng-compile crate GUI. Kalau PATH-nya belum permanen, set per sesi:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
```

## Menjalankan

### Aplikasi desktop

```powershell
cd download_engine_gui
pnpm install
pnpm tauri dev
```

Build installer:

```powershell
pnpm tauri build
```

### CLI

```powershell
cargo run -p download_engine -- "https://example.com/file.zip"
```

Flag `-p` wajib karena workspace ini punya lebih dari satu binary — tanpa itu cargo tidak tahu mana yang harus dijalankan.

## Cek sebelum commit

Rust dan frontend dicek terpisah; keduanya perlu lewat:

```powershell
cargo check --workspace
cd download_engine_gui; pnpm exec tsc --noEmit
```

## Struktur

```
download_engine/              # core engine + CLI
  src/lib.rs                  # permukaan publik library
  src/downloader.rs           # probe, split segmen, download paralel, retry, fallback
  src/control.rs              # DownloadHandle: pause/resume/cancel + progress per segmen
  src/resume.rs               # sidecar .dengine-part buat lanjut setelah app ditutup
  src/rate_limiter.rs         # token bucket buat throttle
  src/queue.rs                # jalankan banyak job dengan batas concurrency
  src/main.rs                 # CLI (clap + indicatif)

download_engine_gui/          # aplikasi desktop
  src/                        # frontend React
  src-tauri/src/lib.rs        # Tauri commands, tray, jembatan ke engine
  src-tauri/src/persistence.rs# baca/tulis app-state.json
```

## Status Fitur

- [x] Segmented download (HTTP Range) + fallback single connection
- [x] Retry per segmen dengan backoff
- [x] Bandwidth limiter per file dan global
- [x] Queue multi-file + penjadwalan
- [x] Pause / resume / cancel
- [x] Resume lintas sesi (lanjut setelah app ditutup)
- [x] GUI desktop (Tauri)
- [x] Daftar job, setting, dan posisi window tersimpan antar sesi
- [x] Notifikasi sistem saat download selesai/gagal
- [x] System tray (close ke tray, download tetap jalan)
- [x] Aksi buka folder / copy link per job
- [x] Multi-select job (bulk pause/cancel/retry)
- [x] Drag-and-drop URL ke window
- [x] Deteksi URL duplikat + nama file anti-tabrakan
- [x] Clipboard monitor (auto-detect link, opt-in)
- [ ] Browser integration lewat Native Messaging
