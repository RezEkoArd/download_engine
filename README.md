# download_engine

Core download engine bergaya IDM (Internet Download Manager), ditulis di Rust. Download file lewat beberapa koneksi paralel (segmented download) untuk memanfaatkan bandwidth lebih maksimal, dengan auto-retry dan fallback otomatis kalau server tidak mendukung Range request.

## Overview

`download_engine` adalah core engine downloader bergaya IDM, ditulis di Rust. Fitur utamanya: download tersegmentasi lewat beberapa koneksi paralel (default 8) menggunakan HTTP Range request, auto-retry per segmen dengan backoff kalau koneksi putus, dan fallback otomatis ke satu koneksi biasa kalau server tidak mendukung Range request.

Engine ini sengaja dipisah jadi library (`src/lib.rs`), bukan hanya binary CLI, supaya nanti bisa dipakai juga dari GUI desktop (rencana: Tauri) tanpa menulis ulang logic download-nya.

## Setup Environment

Build Rust di Windows butuh linker C/C++. Kalau Visual Studio Build Tools (MSVC) belum terinstall, pakai toolchain **GNU** sebagai gantinya:

1. Install MinGW-w64 GCC lewat winget: `BrechtSanders.WinLibs.POSIX.UCRT`
2. Set toolchain default Rust ke GNU: `rustup default stable-x86_64-pc-windows-gnu`

Kalau buka terminal baru dan muncul error `linker link.exe not found`, tambahkan MinGW ke PATH sesi itu:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
```

## Cara Menjalankan

Jalankan dari folder project:

```powershell
cargo run -- "https://example.com/file.zip"
```

Atau pakai binary hasil build langsung:

```powershell
.\target\debug\download_engine.exe "https://example.com/file.zip"
```

| Flag | Fungsi | Default |
| --- | --- | --- |
| `<url>` (positional) | URL file yang mau didownload | wajib diisi |
| `-o`, `--output` | Path/nama file output | nama file diambil dari URL |
| `-n`, `--segments` | Jumlah koneksi paralel | 8 |

Contoh lengkap:

```powershell
cargo run -- "https://proof.ovh.net/files/10Mb.dat" -o "C:\Users\rezek\Downloads\10Mb.dat" -n 6
```

Kalau `-o` tidak diisi, file hasil download tersimpan relatif ke current working directory tempat command dijalankan — bukan folder Downloads bawaan Windows.

## Cara Kerja Engine

1. **Probe server** — kirim `HEAD` request untuk cek ukuran file (`Content-Length`) dan dukungan `Accept-Ranges: bytes`.
2. **Split jadi segmen** — kalau Range didukung, file dibagi jadi beberapa segmen byte-range (default 8).
3. **Download paralel** — tiap segmen didownload bersamaan dan ditulis langsung ke offset masing-masing di file output (file di-*preallocate* dulu, jadi tidak perlu digabung manual di akhir).
4. **Retry otomatis** — tiap segmen punya retry otomatis (maks 5x dengan backoff) kalau koneksinya putus di tengah jalan, lanjut dari byte terakhir yang berhasil ditulis.
5. **Fallback** — kalau server tidak mendukung Range request, otomatis pindah ke satu koneksi streaming biasa.

## Struktur Project

| File | Peran |
| --- | --- |
| `Cargo.toml` | Dependencies: tokio, reqwest, clap, indicatif, anyhow, futures-util |
| `src/lib.rs` | Expose `download()`, `DownloadOptions`, `ProgressCallback` sebagai library, supaya reusable dari GUI nanti |
| `src/downloader.rs` | Core logic: probe server, split range jadi segmen, download paralel per segmen ke offset file, retry, fallback single connection |
| `src/main.rs` | CLI: parsing argumen (clap), progress bar (indicatif), memanggil `download()` dari lib |

## Troubleshooting

| Error / Pertanyaan | Penyebab | Solusi |
| --- | --- | --- |
| `linker link.exe not found` | Toolchain default masih MSVC, Visual Studio Build Tools belum ada | Install MinGW-w64 + `rustup default stable-x86_64-pc-windows-gnu` |
| `HEAD request failed` / connection error | Server menolak request tanpa header `User-Agent` | Sudah ditangani: client di `main.rs` set `User-Agent` otomatis |
| `server returned 404` saat HEAD | Endpoint tidak support HEAD request (contoh: `httpbin.org/range/N`) | Pakai URL file langsung yang support HEAD + Range, contoh `https://proof.ovh.net/files/10Mb.dat` |
| File hasil download ada di mana? | Default tanpa `-o` disimpan relatif ke current working directory | Pakai `-o "<path lengkap>"` untuk kontrol lokasi |

## Roadmap

- GUI desktop pakai Tauri (reuse `download_engine` sebagai library, frontend bisa React/Next.js)
- Bandwidth limiter (throttle kecepatan per koneksi)
- Queue multi-file + penjadwalan
- Clipboard monitor (auto-detect link download)
- Browser integration lewat Native Messaging
