# download_engine_gui

Aplikasi desktop untuk [`download_engine`](../download_engine/README.md), dibuat dengan Tauri 2 + React 19 + TypeScript + Tailwind 4. Tampilannya mengikuti gaya IDM: toolbar di atas, filter di kiri, tabel job di tengah.

Engine dipakai sebagai **library Rust**, bukan dengan memanggil CLI-nya. Jadi pause/resume/cancel bekerja langsung di task yang sedang jalan, dan progress per segmen bisa dibaca real-time.

## Menjalankan

```powershell
pnpm install
pnpm tauri dev      # mode development
pnpm tauri build    # build installer
```

Butuh toolchain Rust + MinGW di PATH — lihat [Setup Environment di README root](../README.md#setup-environment). Error `NotAttempted("windres")` saat build artinya MinGW belum ada di PATH.

## Panduan Penggunaan

### Menambah download

**New Download** di toolbar membuka form berisi:

| Field | Keterangan |
| --- | --- |
| Download URL | wajib |
| Save To Folder | folder tujuan. Kalau kosong, dipakai *Default Output Dir* dari Settings |
| Connections | jumlah koneksi paralel, 1–32 (default dari Settings) |
| Bandwidth Limit | cap kecepatan khusus job ini |
| Start Delay | tunda N detik sebelum job dimasukkan ke daftar |

Ada dua tombol dengan arti berbeda:

- **Download Now** — langsung jalan, mengabaikan batas concurrency.
- **Add to Queue** — masuk daftar berstatus *queued*, baru jalan saat ada slot kosong.

> Kalau folder tujuan **dan** *Default Output Dir* dua-duanya kosong, file jatuh ke working directory proses aplikasi — bukan folder Downloads Windows. Set *Default Output Dir* di Settings sekali saja supaya tidak perlu memikirkannya lagi.

Begitu job ditambahkan, URL-nya langsung di-probe untuk mengambil ukuran file dan dukungan Range request, jadi kolom Size terisi sebelum download mulai.

### Status job

| Status | Arti |
| --- | --- |
| **Queued** | menunggu slot concurrency |
| **Downloading** | sedang jalan |
| **Paused** | dijeda, koneksi diparkir tapi slot-nya tetap dipegang |
| **Completed** | selesai |
| **Cancelled** | dihentikan user |
| **Failed** | gagal setelah retry habis; penyebabnya ada di inspector |
| **Interrupted** | sedang jalan/dijeda saat aplikasi terakhir ditutup, jadi handle engine-nya sudah tidak ada. Bisa dilanjutkan dari byte terakhir |

### Aksi per job

Tombol yang muncul menyesuaikan status:

| Tombol | Muncul saat | Fungsi |
| --- | --- | --- |
| Pause | downloading | jeda di batas chunk berikutnya, byte yang sudah ditulis tetap aman |
| Resume | paused | lanjutkan |
| Cancel | downloading / paused | hentikan permanen |
| Continue / Retry | selesai, gagal, cancelled, interrupted | masukkan ulang ke queue. Ikonnya **play** kalau ada byte yang bisa dilanjutkan, **rotate** kalau mulai dari nol |
| Inspect | selalu | buka panel progress per segmen |
| Delete | selalu | hapus dari daftar |

Soal **Delete**: job yang belum selesai ikut membuang file parsial dan sidecar-nya, karena file setengah jadi tidak ada gunanya dan bisa memakan puluhan GB. Job yang sudah **Completed** hanya hilang dari daftar — filenya milik kamu dan tidak disentuh.

### Buka folder & copy link

Klik baris job mana pun untuk membuka inspector. Di bawah nama file ada tiga aksi:

| Aksi | Fungsi | Nonaktif saat |
| --- | --- | --- |
| **Buka Folder** | tampilkan file di File Explorer dengan filenya tersorot | job masih *queued*, jadi belum ada file di disk |
| **Copy Link** | copy URL download ke clipboard | — |
| **Copy Path** | copy path file output ke clipboard | job tidak punya path output eksplisit |

Konfirmasi (atau pesan error) muncul sebentar di bawah tombolnya, lalu hilang sendiri.

Aksi-aksi ini ditaruh di inspector, bukan di kolom Actions, karena kolom itu sudah menampung sampai enam tombol — menambah tiga lagi membuatnya melebihi lebar kolom.

Tidak ada aksi "buka file" yang langsung menjalankan filenya. Itu butuh izin `opener:allow-open-path`, yang memberi webview kemampuan membuka **sembarang** path dengan aplikasi default-nya — terlalu luas untuk manfaat yang sudah bisa didapat dengan dua klik dari **Buka Folder**.

### Toolbar & sidebar

- **Start All Queued** / **Pause All** — aksi borongan untuk semua job queued/downloading.
- **Speed Limit** — cap gabungan semua download sekaligus, terpisah dari limit per job. Bisa diubah saat download sedang jalan dan langsung berlaku.
- **Search** — filter berdasarkan nama file atau URL.
- Sidebar kiri memfilter berdasarkan status (dengan jumlahnya) dan kategori file (compressed, documents, video, programs).
- Panel bawah sidebar menampilkan kecepatan total, jumlah segmen aktif, dan pemakaian slot concurrency.

### Settings

| Setting | Pengaruh |
| --- | --- |
| Default Segments | nilai awal Connections di form |
| Default Limit | nilai awal Bandwidth Limit di form |
| Default Output Dir | folder tujuan kalau form dibiarkan kosong |
| Concurrency | berapa job boleh aktif bersamaan. Job *paused* tetap menghitung |
| Max Retries | percobaan ulang per segmen sebelum job dinyatakan gagal |
| User Agent | mengganti User-Agent. Berguna untuk server yang menolak client tak dikenal |

### System tray

Klik kiri ikon tray memunculkan jendela. Klik kanan membuka menu: **Tampilkan Jendela**, **Mulai Semua**, **Jeda Semua**, **Keluar**.

Menutup jendela (tombol X) **tidak** mengakhiri aplikasi — jendelanya disembunyikan ke tray dan download tetap berjalan. Untuk benar-benar keluar, pakai **Keluar** dari menu tray.

Menjalankan aplikasi dua kali tidak membuat instance kedua; yang terjadi adalah jendela instance yang sudah jalan dimunculkan. Ini mencegah dua proses saling menimpa daftar job yang tersimpan.

### Notifikasi

Notifikasi sistem muncul saat download **selesai** atau **gagal**. Job yang kamu cancel sendiri tidak memunculkan notifikasi. Izin notifikasi diminta sekali saat pertama kali dibutuhkan.

## Perilaku Lintas Sesi

### Yang tersimpan

Daftar job, setting, pilihan tema, dan global speed limit ditulis ke `app-state.json` di app data dir (`%APPDATA%\com.rezek.download_engine_gui` di Windows). Penyimpanannya di-*throttle*, bukan debounce murni — event progress datang beberapa kali per detik, dan debounce biasa akan terus mereset timernya sendiri sampai tidak pernah benar-benar menulis ke disk. Menutup jendela memaksa flush lebih dulu.

Ukuran dan posisi window ditangani `tauri-plugin-window-state` secara terpisah.

File ditulis ke lokasi sementara lalu di-*rename*, jadi crash di tengah penulisan tidak bisa meninggalkan file state yang terpotong. File yang korup tetap diabaikan dan aplikasi mulai dari daftar kosong, bukan gagal start.

### Melanjutkan download yang terputus

Job yang berstatus *downloading* atau *paused* saat aplikasi ditutup kembali sebagai **Interrupted**. Tekan tombol **Continue** untuk melanjutkan — engine menemukan file parsialnya sendiri lewat sidecar `.dengine-part` di sebelah file output.

Sebelum melanjutkan, UI menanyakan dulu berapa byte yang benar-benar ada di disk, supaya progress bar langsung menunjukkan angka yang benar alih-alih mulai dari 0 lalu melompat.

Resume dibatalkan otomatis dan download mulai dari awal kalau ETag/Last-Modified server berubah, ukuran file berbeda, atau file parsialnya sudah tidak utuh — lebih baik mengunduh ulang daripada menghasilkan file yang rusak. Detailnya ada di [README engine](../download_engine/README.md#resume-lintas-sesi).

## Arsitektur

Frontend memegang daftar job; engine hanya tahu soal download yang sedang jalan. Pembagiannya begitu supaya tidak ada dua sumber kebenaran untuk hal yang sama.

| Berkas | Peran |
| --- | --- |
| `src/App.tsx` | state daftar job, scheduler concurrency, filter, listener event |
| `src/types.ts` | `Job`, `AppSettings`, `JobStatus`, dan kawan-kawan |
| `src/lib/format.ts` | format byte, ETA, deteksi kategori file dari nama |
| `src/lib/persistence.ts` | load/save state + penandaan status *interrupted* |
| `src/lib/notifications.ts` | notifikasi selesai/gagal, hasil cek izin di-cache |
| `src/lib/jobActions.ts` | buka folder (reveal) + copy ke clipboard |
| `src/components/NewDownloadModal.tsx` | form tambah download |
| `src/components/SettingsModal.tsx` | form setting |
| `src/components/InspectorDrawer.tsx` | panel progress per segmen + aksi per job |
| `src-tauri/src/lib.rs` | Tauri commands, tray, jembatan ke engine |
| `src-tauri/src/persistence.rs` | baca/tulis `app-state.json` |

### Tauri commands

| Command | Fungsi |
| --- | --- |
| `probe_url` | cek ukuran file + dukungan Range sebelum download |
| `resume_info` | berapa byte file parsial yang sudah ada di disk |
| `discard_download` | buang file parsial + sidecar-nya |
| `start_download` | jalankan satu job, dikenali lewat `job_id` |
| `pause_download` / `resume_download` / `cancel_download` | kontrol job yang sedang jalan |
| `segment_progress` | progress per segmen untuk inspector |
| `set_global_speed_limit` | cap gabungan semua download |
| `set_user_agent` | ganti User-Agent untuk request berikutnya |
| `quit_app` | keluar sungguhan (dipakai menu tray setelah state di-flush) |
| `load_app_state` / `save_app_state` | persistensi state UI |

Event dari Rust ke UI: `job-progress` (progress per job), serta `tray-start-all`, `tray-pause-all`, `tray-quit` dari menu tray.

Entri tray yang bergantung pada daftar job dikirim sebagai event, bukan dikerjakan di Rust, karena daftar job tinggal di frontend.

## Troubleshooting

| Gejala | Penyebab | Solusi |
| --- | --- | --- |
| Build gagal: `NotAttempted("windres")` | MinGW belum ada di PATH. Build script ikut jalan ulang setiap `tauri.conf.json` atau `capabilities/` disentuh, jadi error ini bisa muncul setelah perubahan yang kelihatannya tak berhubungan | tambahkan `mingw64\bin` ke PATH |
| Build gagal: `linker link.exe not found` | toolchain default masih MSVC padahal Build Tools belum ada | `rustup default stable-x86_64-pc-windows-gnu` |
| File hasil download entah di mana | folder tujuan dan Default Output Dir sama-sama kosong | set **Default Output Dir** di Settings |
| Tombol Continue mulai dari 0% | sidecar sudah tidak cocok (file di server berubah) atau server tidak mendukung Range | normal — satu-satunya cara aman adalah mengunduh ulang |
| Notifikasi tidak muncul | izin notifikasi Windows ditolak | aktifkan di Settings Windows → Notifications |
| Aplikasi hilang setelah ditekan X | memang disembunyikan ke tray, bukan ditutup | klik ikon tray, atau **Keluar** dari menu tray |
| Tombol **Buka Folder** nonaktif | job masih *queued*, filenya belum dibuat | jalankan dulu job-nya |
| Klik ikon aplikasi tidak membuka jendela baru | single-instance guard | jendela instance yang sudah jalan yang dimunculkan |

## Setup IDE

[VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
