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

### Link duplikat & tabrakan nama file

Saat URL di form sudah ada di daftar, peringatan kuning muncul di bawah field URL berisi nama dan status job yang lama.

Peringatannya **tidak memblokir**: mengunduh ulang link yang file-nya sudah berubah di server itu kebutuhan yang sah, jadi keputusannya diserahkan ke user. Yang dijamin aplikasi adalah file lama tidak ditimpa.

Perbandingannya memakai bentuk URL yang sudah dinormalkan:

| Dianggap sama | Dianggap beda |
| --- | --- |
| scheme & host beda huruf besar/kecil (`HTTP://Example.com` = `http://example.com`) | path beda huruf besar/kecil — path itu case-sensitive |
| port default ditulis eksplisit (`https://a:443/x` = `https://a/x`) | query string beda — sering jadi pembeda file (token, versi, id) |
| cuma beda fragment `#...` — bagian itu tidak pernah dikirim ke server | |

Terpisah dari itu, dua job tidak akan pernah menulis ke file yang sama. Kalau path tujuan sudah dipakai job lain, ` (1)`, ` (2)`, dan seterusnya disisipkan sebelum ekstensi — seperti perilaku browser. Ini juga menangani kasus dua URL berbeda yang kebetulan nama filenya sama, yang kalau dibiarkan akan membuat dua job saling menimpa byte dan merusak kedua file.

> Pengaman nama file ini hanya aktif kalau folder tujuan diketahui (dari form atau *Default Output Dir*). Tanpa folder, engine yang menentukan nama file sendiri dan frontend tidak bisa memeriksanya lebih dulu — satu alasan lagi untuk mengisi *Default Output Dir*.

### Drag-and-drop link

Tarik link dari browser (atau teks berisi URL) ke mana saja di jendela aplikasi. Overlay muncul saat drag masuk, dan yang terjadi setelah dilepas tergantung jumlahnya:

- **Satu link** → form New Download terbuka dengan URL-nya sudah terisi, jadi drop yang tidak sengaja masih bisa dibatalkan atau disesuaikan dulu.
- **Beberapa link** → semuanya langsung masuk queue dengan default dari Settings, karena form itu cuma bisa menampung satu URL.

Hanya `http` dan `https` yang diterima; skema lain diabaikan. URL yang sama di satu drop di-*dedupe*, karena menarik blok teks berisi link yang berulang itu hal biasa.

Link yang sudah ada di daftar tidak ikut masuk; jumlah yang dilewati muncul sebagai notifikasi kecil di kanan bawah.

> **Menarik file tidak diterima.** Agar drag-and-drop HTML5 bisa jalan di WebView2, handler drag-drop bawaan Tauri harus dimatikan (`dragDropEnabled: false` di `tauri.conf.json`) — dan konsekuensinya aplikasi tidak lagi menerima event file-drop level OS. Saat menarik file, kursor akan menampilkan tanda "tidak boleh". Ini pertukaran yang disengaja: fiturnya memang untuk link, bukan file.

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

### Aksi borongan (multi-select)

Centang kolom paling kiri untuk memilih beberapa job sekaligus:

- **Checkbox di header** memilih/melepas semua baris yang sedang terlihat. Kalau pilihannya sebagian, checkbox-nya tampil *indeterminate*.
- **Shift+klik** memilih satu rentang sekaligus, seperti di file manager.

Begitu ada yang dipilih, muncul bar aksi berisi **Lanjutkan**, **Jeda**, **Batalkan**, **Ulangi**, dan **Hapus**.

Angka di tiap tombol menunjukkan berapa job yang benar-benar terkena aksi itu, dan tombolnya nonaktif kalau tidak ada yang cocok. Jadi memilih campuran status tetap aman: **Jeda** hanya menyentuh yang *downloading*, **Lanjutkan** hanya yang *paused*, dan sisanya dibiarkan — bukan error.

**Hapus** minta konfirmasi lebih dulu, berbeda dari tombol hapus per baris, dan menyebutkan berapa job yang masih punya file parsial yang akan ikut dibuang. Menghapus banyak job sekaligus bisa membuang data jauh lebih banyak daripada sekali klik yang tidak sengaja.

Pilihan selalu dijaga hanya berisi baris yang **sedang terlihat**. Job yang dihapus atau tersaring keluar oleh filter/pencarian otomatis lepas dari pilihan, supaya aksi borongan tidak pernah mengenai sesuatu yang tidak kamu lihat di layar.

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
| Pantau Clipboard | aktifkan clipboard monitor (default **mati**) |

### Clipboard monitor

Kalau diaktifkan di Settings, setiap kali kamu meng-copy link `http(s)` muncul kartu kecil di kanan bawah: **Download** membuka form dengan URL-nya sudah terisi, **Abaikan** menutupnya.

Satu isi clipboard hanya ditawarkan sekali. Link yang sudah ada di daftar job tidak ditawarkan sama sekali — logika duplikat yang sama dengan form dipakai di sini.

Pemantauan **dijeda selama form New Download terbuka**, supaya link yang kamu paste sendiri ke form itu tidak kembali muncul sebagai tawaran. Saat form ditutup, isi clipboard saat itu dijadikan baseline baru, bukan ditawarkan.

Begitu juga saat monitor baru dinyalakan: bacaan pertama hanya dipakai sebagai baseline, jadi apa pun yang sudah lebih dulu ada di clipboard tidak langsung nongol.

> **Kenapa default-nya mati.** Clipboard tidak punya event "berubah", jadi satu-satunya cara adalah membacanya berkala (tiap 1,5 detik) — dan itu berarti **semua** isi clipboard terbaca, termasuk password yang kebetulan sedang kamu copy dari password manager. Yang dilakukan aplikasi: teks dibaca, dicek apakah URL http(s), dan kalau bukan langsung dibuang dari memori. Tidak ditulis ke `app-state.json`, tidak dikirim ke jaringan, tidak di-log. Tetap saja, karena ini keputusan privasi dan bukan keputusan teknis, fitur ini harus kamu nyalakan sendiri.

Permission `clipboard-manager:allow-read-text` hanya ada di capability karena fitur ini. Kalau kamu tidak memerlukannya, mencabut baris itu dari `src-tauri/capabilities/default.json` akan membuat pembacaan clipboard gagal di level Tauri, apa pun isi Settings.

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
| `src/lib/format.ts` | format byte, ETA, deteksi kategori file, nama file anti-tabrakan |
| `src/lib/persistence.ts` | load/save state + penandaan status *interrupted* |
| `src/lib/notifications.ts` | notifikasi selesai/gagal, hasil cek izin di-cache |
| `src/lib/jobActions.ts` | buka folder (reveal), copy ke clipboard, baca clipboard |
| `src/lib/urls.ts` | validasi URL http(s), normalisasi untuk cek duplikat, parsing payload drag-and-drop |
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
| Pilihan hilang sendiri saat filter diubah | memang disengaja — pilihan dijaga hanya berisi baris yang terlihat | pilih ulang setelah filternya pas |
| Menarik file ke jendela ditolak | handler drag-drop OS dimatikan supaya drag link bisa jalan | pakai **New Download** untuk file lokal, drag hanya untuk link |
| Drag link tidak bereaksi sama sekali | `dragDropEnabled` kembali `true` di `tauri.conf.json` | set ke `false` |
| Klik ikon aplikasi tidak membuka jendela baru | single-instance guard | jendela instance yang sudah jalan yang dimunculkan |

## Setup IDE

[VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
