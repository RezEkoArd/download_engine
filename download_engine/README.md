# download_engine

Core download engine bergaya IDM (Internet Download Manager), ditulis di Rust. Download file lewat beberapa koneksi paralel (segmented download) untuk memanfaatkan bandwidth lebih maksimal, dengan auto-retry, pause/resume, dan fallback otomatis kalau server tidak mendukung Range request.

## Overview

Fitur utamanya:

- **Segmented download** — file dibagi ke beberapa koneksi paralel (default 8) lewat HTTP Range request.
- **Retry per segmen** dengan backoff, lanjut dari byte terakhir yang berhasil ditulis.
- **Fallback otomatis** ke satu koneksi streaming biasa kalau server tidak mendukung Range.
- **Pause / resume / cancel** pada download yang sedang jalan, lewat `DownloadHandle`.
- **Resume lintas sesi** — progress dicatat ke sidecar, jadi download bisa dilanjutkan setelah proses mati.
- **Bandwidth limiter** per file maupun global (dibagi ke semua download yang memakai limiter yang sama).
- **Queue multi-file** dengan batas concurrency.

Engine ini berupa library (`src/lib.rs`), bukan hanya binary CLI, supaya bisa dipakai dari GUI desktop tanpa menulis ulang logic download-nya. GUI-nya sudah ada: lihat [`download_engine_gui`](../download_engine_gui/README.md).

## Setup Environment

Build Rust di Windows butuh linker C/C++. Kalau Visual Studio Build Tools (MSVC) belum terinstall, pakai toolchain **GNU** sebagai gantinya:

1. Install MinGW-w64 GCC lewat winget: `BrechtSanders.WinLibs.POSIX.UCRT`
2. Set toolchain default Rust ke GNU: `rustup default stable-x86_64-pc-windows-gnu`

Kalau buka terminal baru dan muncul error `linker link.exe not found`, tambahkan MinGW ke PATH sesi itu:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
```

## Cara Menjalankan

Crate ini bagian dari Cargo workspace, dan workspace-nya punya lebih dari satu binary. Jadi `-p download_engine` wajib disertakan, kalau tidak cargo tidak tahu binary mana yang dimaksud:

```powershell
cargo run -p download_engine -- "https://example.com/file.zip"
```

Atau pakai binary hasil build langsung:

```powershell
.\target\debug\download_engine.exe "https://example.com/file.zip"
```

| Flag | Fungsi | Default |
| --- | --- | --- |
| `<url>...` (positional) | URL file yang mau didownload. Boleh lebih dari satu untuk queue | wajib diisi minimal 1 |
| `-o`, `--output` | Path/nama file output (hanya valid untuk 1 URL) | nama file diambil dari URL |
| `-n`, `--segments` | Jumlah koneksi paralel per file | 8 |
| `-r`, `--limit` | Bandwidth cap per file, contoh `500KB`, `2MB`, `1GB` (dibagi rata ke semua koneksinya) | tidak dibatasi |
| `-c`, `--concurrency` | Jumlah file yang didownload bersamaan saat ada banyak URL (queue) | 1 |
| `--start-in <detik>` | Tunda mulai seluruh queue selama N detik (penjadwalan sederhana) | langsung mulai |
| `--retries <n>` | Berapa kali satu segmen boleh retry sebelum download dinyatakan gagal | 5 |
| `--user-agent <ua>` | Ganti User-Agent yang dikirim ke server | User-Agent bawaan engine |
| `--no-resume` | Abaikan file parsial yang ada, download dari awal | resume aktif |

Contoh lengkap:

```powershell
cargo run -p download_engine -- "https://proof.ovh.net/files/10Mb.dat" -o "C:\Users\rezek\Downloads\10Mb.dat" -n 6
```

Kalau `-o` tidak diisi, file hasil download tersimpan relatif ke current working directory tempat command dijalankan — bukan folder Downloads bawaan Windows.

### Bandwidth limiter

Batasi total kecepatan satu file (dibagi rata ke semua koneksi paralelnya):

```powershell
cargo run -p download_engine -- "https://example.com/file.zip" -r 2MB
```

### Queue multi-file + penjadwalan

Download beberapa file sekaligus, maksimal N file aktif bersamaan, dan bisa ditunda mulainya:

```powershell
cargo run -p download_engine -- "https://example.com/a.zip" "https://example.com/b.zip" -c 2 --start-in 60
```

Nama file tiap job di queue otomatis diambil dari URL masing-masing (flag `-o` tidak berlaku saat ada lebih dari satu URL).

## Cara Kerja Engine

1. **Probe server** — kirim `HEAD` request untuk cek ukuran file (`Content-Length`), dukungan `Accept-Ranges: bytes`, plus `ETag`/`Last-Modified` untuk validasi resume.
2. **Cek file parsial** — kalau ada sidecar yang masih cocok, segmen di-seed dari posisi terakhirnya alih-alih dari nol.
3. **Split jadi segmen** — kalau Range didukung, file dibagi jadi beberapa segmen byte-range (default 8). Segmen tidak dipecah lebih kecil dari 1 MiB, karena overhead koneksinya jadi lebih mahal daripada manfaat paralelnya.
4. **Download paralel** — tiap segmen didownload bersamaan dan ditulis langsung ke offset masing-masing di file output (file di-*preallocate* dulu, jadi tidak perlu digabung manual di akhir).
5. **Checkpoint** — tiap 2 detik posisi semua segmen ditulis ke sidecar, jadi proses yang mati mendadak tetap kehilangan maksimal beberapa detik progress.
6. **Retry otomatis** — tiap segmen punya retry otomatis (default 5x dengan backoff) kalau koneksinya putus di tengah jalan, lanjut dari byte terakhir yang berhasil ditulis.
7. **Fallback** — kalau server tidak mendukung Range request, otomatis pindah ke satu koneksi streaming biasa.

### Resume lintas sesi

Progress dicatat di file sidecar `<output>.dengine-part`, sengaja diletakkan di sebelah file output supaya memindahkan download ikut memindahkan progress-nya.

Sidecar ditulis ke `.tmp` lalu di-*rename*, jadi penyimpanan yang terputus di tengah tidak bisa menimpa sidecar yang masih bagus dengan versi terpotong.

Sebelum dipakai, sidecar diverifikasi dulu. Resume **dibatalkan** dan download mulai dari awal kalau:

- URL atau ukuran total file berbeda,
- `ETag`/`Last-Modified` server tidak lagi cocok (artinya file di server sudah berubah),
- range antar segmen tidak lagi menutup seluruh file tanpa celah,
- ukuran file parsial tidak lagi sama dengan hasil preallocate (ada yang mengubah file itu dari luar),
- atau sidecar-nya ditulis oleh versi format yang berbeda.

Validator hanya dibandingkan kalau kedua sisi punya — banyak server tidak mengirim `ETag` maupun `Last-Modified`, dan mewajibkannya berarti mematikan resume di server-server itu.

Sidecar yang rusak atau tidak terbaca diperlakukan sebagai "tidak ada", bukan sebagai error yang harus diurus pemakai. Konsekuensinya cuma mulai dari awal; lebih baik begitu daripada menghasilkan file yang korup.

## Memakai sebagai Library

```rust
use std::sync::Arc;
use download_engine::{build_client, download_with_handle, DownloadHandle, DownloadOptions, DownloadOutcome};

let client = build_client(None)?;
let handle = DownloadHandle::new();

let opts = DownloadOptions {
    url: "https://example.com/file.zip".into(),
    output: "file.zip".into(),
    max_segments: 8,
    ..Default::default()
};

// Clone-nya berbagi state yang sama, jadi bisa dikontrol dari task lain.
let control = handle.clone();
tokio::spawn(async move {
    control.pause();
    control.resume();
    control.cancel();
});

let on_progress: download_engine::ProgressCallback = Arc::new(|downloaded, total| {
    println!("{downloaded}/{total}");
});

match download_with_handle(&client, opts, handle, on_progress).await? {
    DownloadOutcome::Completed => println!("selesai"),
    DownloadOutcome::Cancelled => println!("dibatalkan"),
}
```

### Permukaan publik

| Item | Fungsi |
| --- | --- |
| `download` | Download satu file, tanpa kontrol pause/cancel |
| `download_with_handle` | Sama, tapi bisa dikontrol dan diamati lewat `DownloadHandle` |
| `DownloadHandle` | `pause`, `resume`, `cancel`, `is_paused`, `is_cancelled`, `segments` |
| `DownloadOutcome` | `Completed` atau `Cancelled` |
| `SegmentSnapshot` | Progress satu segmen pada satu titik waktu, aman diserahkan ke UI |
| `DownloadOptions` | Konfigurasi job (lihat tabel di bawah) |
| `probe` / `ProbeInfo` | Cek ukuran, dukungan Range, dan validator sebelum download |
| `ResumeState` / `SegmentCheckpoint` | Isi sidecar, bisa dibaca untuk tahu berapa byte yang sudah ada |
| `discard_partial` / `sidecar_path` | Buang file parsial + sidecar, atau cari lokasi sidecar-nya |
| `run_queue` / `QueueOptions` | Jalankan banyak job dengan batas concurrency |
| `SharedRateLimiter` | Limiter yang bisa dibagi antar beberapa download sekaligus |
| `build_client` / `guess_filename` / `DEFAULT_USER_AGENT` | Helper |

### `DownloadOptions`

| Field | Fungsi | Default |
| --- | --- | --- |
| `url` | URL sumber | `""` |
| `output` | Path file tujuan | `download.bin` |
| `max_segments` | Jumlah koneksi paralel maksimum | 8 |
| `min_segment_size` | Batas bawah ukuran segmen; di bawah ini tidak dipecah lagi | 1 MiB |
| `max_bytes_per_sec` | Cap kecepatan khusus download ini | `None` (tanpa batas) |
| `global_limiter` | Cap yang dibagi dengan download lain. Berlaku di atas `max_bytes_per_sec`, yang lebih ketat yang menang | `None` |
| `max_retries` | Retry per segmen sebelum gagal | 5 |
| `allow_resume` | Pakai file parsial yang cocok kalau ada | `true` |

## Struktur Project

| File | Peran |
| --- | --- |
| `Cargo.toml` | Dependencies: tokio, reqwest, clap, indicatif, anyhow, futures-util, serde, serde_json, tokio-util |
| `src/lib.rs` | Permukaan publik library, supaya reusable dari GUI |
| `src/downloader.rs` | Core logic: probe server, split range jadi segmen, download paralel per segmen ke offset file, retry, fallback single connection, checkpoint, bandwidth limiter per koneksi |
| `src/control.rs` | `DownloadHandle`: pause/resume/cancel + progress per segmen, dibagi antar clone lewat `Arc` |
| `src/resume.rs` | Sidecar `.dengine-part`: tulis atomic, validasi, dan pembuangan file parsial |
| `src/rate_limiter.rs` | Token-bucket rate limiter buat throttle kecepatan per koneksi |
| `src/queue.rs` | Jalankan banyak `DownloadOptions` sekaligus dengan batas concurrency (`run_queue`) |
| `src/main.rs` | CLI: parsing argumen (clap), progress bar (indicatif), mode single-file & queue multi-file |

## Troubleshooting

| Error / Pertanyaan | Penyebab | Solusi |
| --- | --- | --- |
| `linker link.exe not found` | Toolchain default masih MSVC, Visual Studio Build Tools belum ada | Install MinGW-w64 + `rustup default stable-x86_64-pc-windows-gnu` |
| `cargo run` minta `-p` / bingung binary mana | Workspace punya lebih dari satu binary | Pakai `cargo run -p download_engine -- <args>` |
| `HEAD request failed` / connection error | Server menolak request tanpa header `User-Agent` | Sudah ditangani: `build_client` set `User-Agent` otomatis. Kalau masih ditolak, coba `--user-agent` |
| `server returned 404` saat HEAD | Endpoint tidak support HEAD request (contoh: `httpbin.org/range/N`) | Pakai URL file langsung yang support HEAD + Range, contoh `https://proof.ovh.net/files/10Mb.dat` |
| File hasil download ada di mana? | Default tanpa `-o` disimpan relatif ke current working directory | Pakai `-o "<path lengkap>"` untuk kontrol lokasi |
| Resume mulai dari 0 padahal file parsial ada | Sidecar tidak lolos validasi (file di server berubah, atau filenya disentuh dari luar) | Normal dan disengaja — melanjutkan file yang tidak cocok akan menghasilkan file rusak |
| Download tetap jalan satu koneksi walau `-n 8` | Server tidak mengirim `Accept-Ranges: bytes`, atau filenya lebih kecil dari `min_segment_size` | Tidak ada yang bisa dilakukan dari sisi client |
| File `.dengine-part` menumpuk | Download dibatalkan tanpa membuang file parsialnya | Hapus manual, atau panggil `discard_partial` |

## Roadmap

- [x] Bandwidth limiter (throttle kecepatan per koneksi)
- [x] Queue multi-file + penjadwalan
- [x] Pause / resume / cancel
- [x] Resume lintas sesi (sidecar + validasi)
- [x] GUI desktop pakai Tauri (reuse `download_engine` sebagai library)
- [ ] Clipboard monitor (auto-detect link download)
- [ ] Browser integration lewat Native Messaging
