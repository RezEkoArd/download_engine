# download_engine_gui

Aplikasi desktop untuk [`download_engine`](../download_engine/README.md), dibuat dengan Tauri 2 + React 19 + TypeScript + Tailwind 4. Tampilannya mengikuti gaya IDM: toolbar di atas, filter dan kategori di kiri, tabel job di tengah, statistik di footer.

Engine dipakai sebagai **library Rust**, bukan dengan memanggil CLI-nya. Jadi pause/resume/cancel bekerja langsung di task yang sedang jalan, dan progress per segmen bisa dibaca real-time.

## Menjalankan

```powershell
pnpm install
pnpm tauri dev      # mode development
pnpm tauri build    # build installer
```

Butuh toolchain Rust + MinGW di PATH — lihat [Setup Environment di README root](../README.md#setup-environment). Error `NotAttempted("windres")` saat build artinya MinGW belum ada di PATH.

## Panduan Penggunaan

Panduan pemakaian lengkap ada di **[PENGGUNAAN.md](../PENGGUNAAN.md)** di root repo — menambah download, status job, aksi borongan, Settings, tray, clipboard monitor, dan bridge browser dari sisi pengguna semuanya di situ.

Dipisah supaya ada satu sumber saja: dokumen yang di bawah ini hanya memuat hal yang **bukan** cara memakai — aturan sanitasi nama file, batas otorisasi bridge, dan keputusan teknis yang perlu diketahui sebelum mengubah kodenya.

### Nama file dari server

Kalau field *Nama File* di form dikosongkan, nama awal diambil dari URL, lalu diganti nama dari header `Content-Disposition` begitu probe selesai. Inilah yang membuat link seperti `https://example.com/download?id=84213` tersimpan sebagai `laporan-2024.pdf`, bukan `download`.

Nama dari server adalah string yang sepenuhnya dikendalikan pemilik URL, jadi pembersihannya dilakukan di Rust — di `download_engine/src/filename.rs`, dipanggil dari `probe()` supaya nama mentah tidak pernah sampai ke pemanggil. Yang lolos hanya satu komponen path: separator, `..`, titik dan spasi di ujung, karakter kontrol (termasuk NUL), tanda bidi yang bisa menyamarkan ekstensi, serta nama device Windows (`CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) semuanya ditangani. Panjangnya dibatasi, dan nama yang tersisa kosong setelah dibersihkan jatuh kembali ke nama dari URL — tidak pernah ke sesuatu yang dipilih server.

Tesnya ada di modul yang sama (`cargo test -p download_engine`), mencakup percobaan traversal, nama device, dan bentuk RFC 5987 terenkode.

Tiga keadaan yang membuat job **tidak** diganti namanya:

- job yang namanya **diisi user** di form — pilihan user menang atas usulan server;
- job **tanpa folder tujuan**, karena nama file-nya ditentukan engine sendiri dari URL dan label di daftar harus tetap cocok dengan apa yang ditulis ke disk;
- job yang **sudah mulai menulis byte** — saat itu engine sudah membuat dan mem-prealokasi file di path lama, jadi mengganti nama job hanya akan membuat aplikasi kehilangan jejak file-nya. Karena itu probe ditunggu dulu sebelum scheduler diizinkan menjalankan job baru: latch `startingRef` yang sama dengan yang dipakai scheduler, dilepas **sebelum** `setJobs` yang menyusul — kalau dilepas sesudahnya, scheduler sudah selesai memeriksa dan job-nya menggantung di queue tanpa ada lagi yang membangunkannya.

Pengaman tabrakan nama (`uniqueOutputPath`) tetap dijalankan, jadi nama dari server yang kebetulan sama dengan tujuan job lain dapat ` (1)`, bukan menimpa.

### Bridge extension browser

Kalau diaktifkan di Settings, aplikasi membuka listener HTTP di **`127.0.0.1:47283`**. Extension browser mengirim link ke situ, job langsung masuk daftar seperti kalau kamu menambahkannya sendiri (masuk antrian — scheduler yang memutuskan kapan mulai, menghormati batas Concurrency).

Extension-nya ada di [`browser-extension/`](../browser-extension/README.md) — pemasangan dan pairing-nya dijelaskan di situ.

Settings juga menampilkan **token pairing**: tempelkan ke halaman opsi extension. Token dibuat sekali dari 32 byte acak OS lalu disimpan di `bridge-token` di app data dir, jadi pairing-nya tidak hilang tiap restart.

**Apa yang menjaganya.** Socket loopback bisa dihubungi oleh setiap proses di komputer ini *dan* oleh JavaScript di halaman web mana pun yang kamu buka — "cuma localhost" bukan model keamanan. Ada tiga lapis:

1. Bind ke `127.0.0.1`, bukan `0.0.0.0`. Tidak ada apa pun di jaringan yang bisa menjangkaunya.
2. **`Origin` harus origin extension.** Saat JS halaman web memanggil loopback, browser melampirkan `Origin` yang tidak bisa dipalsukan halaman itu, jadi menolak `http(s)://` menutup seluruh kasus drive-by. `null` (iframe sandbox) juga ditolak.
3. **Token di request header.** Perlu karena cek `Origin` hanya mengikat pemanggil yang memang browser — proses lokal biasa bisa mengaku origin apa saja. Tokennya wajib lewat header, bukan query string: header non-standar memaksa CORS preflight yang tidak bisa dipenuhi halaman web, jadi ini sekaligus pertahanan CSRF.

Endpoint-nya dua: `GET /ping` (untuk membedakan "app tidak jalan" dari "app jalan tapi belum pairing") dan `POST /download` dengan body `{"url": "...", "headers": {...}}`. Body dibatasi 64 KB. URL wajib `http`/`https` — engine sendiri mau menerima string apa pun, jadi pembatasan skema di sini yang mencegah pemanggil luar mengarahkannya ke `file://`.

Respons lengkapnya, kalau kamu menulis client sendiri:

| Permintaan | Balasan |
| --- | --- |
| Token tidak ada / salah / beda panjang | `401 {"error":"invalid token"}` |
| `Origin` berupa `http(s)://` atau `null` | `403 {"error":"origin not allowed"}` |
| `OPTIONS` dari origin extension, **tanpa** token | `204`, dengan `Access-Control-Allow-Origin` di-echo |
| `OPTIONS` dari halaman web | `403` — preflight tidak jadi celah |
| `GET /ping` + token benar | `200 {"app":"download-engine","version":"…"}` |
| `POST /download` + URL bukan `http(s)` atau JSON rusak | `400` |
| Body > 64 KiB | `413 {"error":"body too large"}` |
| Path lain, atau method yang tidak cocok | `404 {"error":"not found"}` |
| `POST /download` yang sah | `202 {"ok":true}` |

`Access-Control-Allow-Origin` hanya di-echo untuk origin extension — permintaan yang ditolak tidak mendapatkannya sama sekali, jadi tidak ada iframe yang bisa memanen preflight yang berfungsi. `Vary: origin` selalu dikirim supaya cache tidak menyajikan respons satu extension ke extension lain.

Preflight dijawab **sebelum** token diperiksa, dan itu memang harus begitu: preflight adalah cara browser menanyakan apakah ia boleh mengirim header token, jadi ia tidak mungkin sudah membawanya.

Tes manual tanpa extension:

```powershell
$token = Get-Content "$env:APPDATA\com.rezek.download_engine_gui\bridge-token"
curl.exe -i -X POST http://127.0.0.1:47283/download `
  -H "content-type: application/json" `
  -H "x-download-engine-token: $token" `
  -d '{\"url\":\"https://example.com/file.zip\"}'
```

**Header per job tidak disimpan ke disk.** Cookie sesi yang dikirim extension hanya hidup di memori selama aplikasi jalan, tidak ikut masuk `app-state.json`. Konsekuensinya: job dari extension yang kamu lanjutkan setelah aplikasi restart akan mencoba tanpa cookie-nya dan bisa gagal — kirim ulang dari browser untuk dapat cookie yang masih berlaku. Itu disengaja; menaruh kredensial login di file JSON plaintext harganya lebih besar daripada kenyamanan resume.

> **Kenapa default-nya mati.** Membuka port adalah hal yang tidak pantas dilakukan aplikasi di belakang punggung penggunanya. Selama toggle-nya mati, tidak ada socket yang dibuka sama sekali.

### Catatan Implementasi

Keputusan yang terlihat sebagai batasan di UI, tapi sebenarnya pertukaran yang disengaja. Dicatat di sini supaya tidak "diperbaiki" tanpa tahu harganya.

**Drag file tidak diterima.** Agar drag-and-drop HTML5 bisa jalan di WebView2, handler drag-drop bawaan Tauri harus dimatikan (`dragDropEnabled: false` di `tauri.conf.json`) — dan konsekuensinya aplikasi tidak lagi menerima event file-drop level OS. Saat menarik file, kursor menampilkan tanda "tidak boleh". Kalau `dragDropEnabled` dikembalikan ke `true`, drag link berhenti bereaksi sama sekali.

**Tidak ada aksi "buka file".** Itu butuh izin `opener:allow-open-path`, yang memberi webview kemampuan membuka **sembarang** path dengan aplikasi default-nya — terlalu luas untuk manfaat yang sudah bisa didapat dengan dua klik dari **Buka Folder**.

**Aksi file ada di inspector, bukan di kolom Aksi.** Kolom itu sudah menampung sampai enam tombol; menambah tiga lagi membuatnya melebihi lebar kolom.

**Tabelnya enam kolom, bukan delapan.** Progress dan status dulu punya kolom sendiri. Progress bar sekarang duduk di bawah nama berkas — di situ ia sudah berpasangan dengan apa yang sedang diunduh — dan lencana status menempati kolom **Sisa waktu** selama job-nya tidak berjalan, karena sisa waktu memang hanya punya angka saat job berjalan. Dua kolom yang hilang itu dipakai untuk memberi nama berkas ruang yang cukup supaya tidak terpotong.

**Footer hanya berisi angka yang bergerak.** Dulu ada tiga label tetap di sana — "Range Request Probe: Active", "Disk Pre-allocation: Enabled", "Engine Mode: Parallel Segmented". Ketiganya tidak pernah berubah isinya, jadi yang tersisa cuma hiasan yang tetap memakan tempat; sekarang baris itu menampilkan kecepatan total, download aktif berbanding slot concurrency, jumlah segmen yang bekerja, dan jumlah baris di daftar.

**Clipboard monitor punya dua saklar.** Permission `clipboard-manager:allow-read-text` ada di capability hanya karena fitur ini. Mencabut baris itu dari `src-tauri/capabilities/default.json` membuat pembacaan clipboard gagal di level Tauri, apa pun isi Settings — toggle di Settings tidak bisa menghidupkannya kembali.

**Nama file tidak pernah diambil dari pemanggil bridge.** Nama dari luar akan digabungkan ke folder tujuan, dan `..\..\` di dalamnya berarti penulisan ke mana pun si pemanggil mau. Yang dipakai adalah nama dari URL, lalu nama dari server yang sudah disanitasi engine — lihat [Nama file dari server](#nama-file-dari-server).

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
| `src/lib/paths.ts` | folder tujuan default (`<Downloads>\Download-Engine`) |
| `src/lib/persistence.ts` | load/save state + penandaan status *interrupted* |
| `src/lib/notifications.ts` | notifikasi selesai/gagal, hasil cek izin di-cache |
| `src/lib/jobActions.ts` | buka folder (reveal), copy ke clipboard, baca clipboard |
| `src/lib/urls.ts` | validasi URL http(s), normalisasi untuk cek duplikat, parsing payload drag-and-drop |
| `src/components/NewDownloadModal.tsx` | form tambah download |
| `src/components/SettingsModal.tsx` | form setting |
| `src/components/InspectorDrawer.tsx` | panel progress per segmen + aksi per job |
| `src/lib/bridge.ts` | wrapper command bridge (info + on/off) |
| `src-tauri/src/lib.rs` | Tauri commands, tray, jembatan ke engine |
| `src-tauri/src/bridge.rs` | listener HTTP loopback untuk extension browser |
| `bridge_guard/src/lib.rs` | cek `Origin`, perbandingan token, pembuatan token — crate terpisah tanpa dependensi Tauri, satu-satunya tempat tes bisa jalan (lihat [Menjalankan tes](../README.md#menjalankan-tes)) |
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
| `bridge_info` | port + token pairing, tanpa menjalankan listener |
| `set_bridge_enabled` | buka/tutup listener loopback |
| `load_app_state` / `save_app_state` | persistensi state UI |

`probe_url` dan `start_download` menerima argumen `headers` opsional. Isinya difilter terhadap allowlist (`cookie`, `referer`, `user-agent`, `authorization`, `accept`, `accept-language`, `origin`) — allowlist dan bukan blocklist, karena sumbernya ada di luar kendali aplikasi. Entri yang tidak lolos dibuang, bukan menggagalkan seluruh request.

Event dari Rust ke UI: `job-progress` (progress per job), `bridge-download` (link dari extension), serta `tray-start-all`, `tray-pause-all`, `tray-quit` dari menu tray.

Entri tray yang bergantung pada daftar job dikirim sebagai event, bukan dikerjakan di Rust, karena daftar job tinggal di frontend.

## Troubleshooting

Masalah saat **build**. Gejala saat **memakai** aplikasinya ada di [Kalau ada yang tidak beres](../PENGGUNAAN.md#kalau-ada-yang-tidak-beres).

| Gejala | Penyebab | Solusi |
| --- | --- | --- |
| Build gagal: `NotAttempted("windres")` | MinGW belum ada di PATH. Build script ikut jalan ulang setiap `tauri.conf.json` atau `capabilities/` disentuh, jadi error ini bisa muncul setelah perubahan yang kelihatannya tak berhubungan | tambahkan `mingw64\bin` ke PATH |
| Build gagal: `linker link.exe not found` | toolchain default masih MSVC padahal Build Tools belum ada | `rustup default stable-x86_64-pc-windows-gnu` |
| Drag link tidak bereaksi sama sekali | `dragDropEnabled` kembali `true` di `tauri.conf.json` | set ke `false` |

## Setup IDE

[VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

### Tema dan warna aksen: satu atribut, bukan ratusan kelas

Warna aksen tidak diterapkan dengan kelas kondisional. Tailwind v4 mengompilasi `bg-brand-600` menjadi `background-color: var(--color-brand-600)`, jadi mendefinisikan ulang variabel itu di `:root[data-accent="teal"]` mengecat ulang **semua** yang berwarna brand sekaligus — dan `App.css` juga dipakai jendela notch, jadi notch ikut berganti tanpa tahu ada pemilih aksen. Alternatifnya berarti menyentuh beberapa ratus kelas `brand-*` di seluruh UI.

`:root[data-accent=…]` mengalahkan `:root` polos yang dikeluarkan Tailwind, jadi biru di `@theme` tetap jadi default dan tidak perlu bloknya sendiri.

Tema disimpan sebagai **mode** (`light` / `dark` / `system`), bukan boolean, dan yang dikirim ke notch adalah hasil **resolusinya**. Notch tidak punya setting sendiri; kalau ia bertanya sendiri ke OS, pilihan Terang atau Gelap yang eksplisit akan diabaikan dan ia bisa jadi pucat di atas jendela gelap. `system` juga berarti *tetap* mengikuti: `matchMedia` didengarkan terus, karena Windows berganti tema di tengah hari dan aplikasi yang membaca preferensi sekali saat start akan jadi satu-satunya yang tertinggal.

Berkas state lama menyimpan tema sebagai `dark: boolean` di luar settings. Itu masih dibaca sekali saat restore dan diterjemahkan ke `themeMode`, supaya upgrade tidak diam-diam mengembalikan semua orang ke gelap.

### Notch: kenapa jendelanya diurus dari Rust

Notch adalah jendela Tauri kedua (`island.html`), dan seluruh penanganan jendelanya — ukuran, posisi, tampil, sembunyi — ada di `src-tauri/src/island.rs`, bukan di frontend.

Alasannya ACL. Menggerakkan jendela dari JavaScript berarti memberi webview `core:window:allow-show`, `allow-hide`, `allow-set-position`, dan `allow-set-size`. Capability memang bisa dibatasi ke satu label jendela, tapi command-command itu menerima **label sebagai argumen** — jadi webview yang memegangnya tetap bisa mengarahkannya ke jendela utama. Menyimpan kemampuan itu di Rust membuat satu-satunya jendela yang bisa disentuh adalah notch-nya sendiri.

Capability notch-nya sendiri (`capabilities/island.json`) cuma berisi `core:event:allow-listen` dan `allow-unlisten`. Ia tidak perlu lebih: angkanya datang sebagai event, dan setiap tombolnya memanggil command aplikasi, yang berada di luar ACL.

Angka-angkanya dihitung di jendela utama, bukan di notch. Notch yang menurunkan sendiri progresnya bisa berbeda dengan daftar job di belakangnya, dan dua angka berbeda untuk satu download lebih buruk daripada tidak ada notch sama sekali. Hal yang sama berlaku untuk **mode**-nya: mode menentukan ukuran *jendela*, dan hanya Rust yang bisa mengubah itu — membalik flag lokal akan menggambar panel 400px di dalam jendela 56px.

Pengirimannya di-throttle 250 ms — event progres datang jauh lebih cepat daripada yang bisa dibaca mata — tapi apa pun yang mengubah **bentuk** notch (mode, fase, berkas yang ditampilkan) selalu dikirim seketika: jendela yang berubah ukuran terlambat seperempat detik terlihat, angka byte yang basi tidak.

Ukuran jendelanya pas dengan bentuk yang digambar, tidak lebih. Jendelanya transparan dan selalu di atas, jadi setiap piksel kelonggaran akan menelan klik yang ditujukan ke apa pun di belakangnya — yaitu deretan tab browser, yang letaknya persis di situ.

Tombol-tombolnya tidak bisa mengerjakan sendiri apa yang mereka minta: menjeda job butuh daftar job, dan membuka folder butuh izin opener — keduanya ada di jendela utama. `island_action` meneruskannya ke sana lewat satu event.

Menggesernya tidak memakai drag loop milik OS. Notch cuma bergerak mendatar di sepanjang tepi atas, dan drag bebas harus di-snap kembali sesudahnya — padahal Tauri tidak punya event "drag selesai" untuk menggantungkan snap itu. Jadi frontend melacak pointer-nya sendiri (dengan pointer capture, supaya event tetap datang saat kursor sudah keluar dari jendela) dan Rust memilih monitor **di bawah kursor**, bukan di bawah jendela — itulah yang membuat menyeret ke layar kedua berhasil.

`tauri_plugin_window_state` disuruh melewati label `island` (`skip_initial_state`). Posisi notch disimpan sendiri di `island-spot.json` sebagai titik tengah relatif terhadap origin monitornya — titik tengah, bukan tepi kiri, supaya ia tidak bergeser saat ganti mode mengubah lebarnya.

Vite membangun dua halaman. Menyebut satu input di `build.rollupOptions.input` **menggantikan** default Vite, bukan menambahnya — jadi `index.html` harus ikut disebut, kalau tidak hanya overlay-nya yang terbangun.
