# Panduan Penggunaan — Download Engine

Cara memakai Download Engine sehari-hari. Tidak perlu paham isi kodenya.

> **Versi 0.1.0 jalan di Windows 10/11 saja**, dan extension browser-nya untuk **Chrome**. Aplikasinya sendiri tidak butuh browser apa pun — ia aplikasi desktop, bukan halaman web.

Belum terpasang? Unduh `Download Engine_0.1.0_x64-setup.exe` dari [Releases](https://github.com/RezEkoArd/download_engine/releases/latest), atau ikuti [INSTALL.md](INSTALL.md) yang juga mencakup extension browser. Dokumen ini mengambil alih dari titik aplikasinya sudah bisa dibuka.

| Kalau yang kamu cari | Baca |
| --- | --- |
| memasang aplikasi & extension | [INSTALL.md](INSTALL.md) |
| **cara memakai aplikasinya** | dokumen ini |
| memakai engine dari terminal atau sebagai library Rust | [download_engine/README.md](download_engine/README.md) |
| detail extension browser (izin, pairing, log) | [browser-extension/README.md](browser-extension/README.md) |
| kenapa sesuatu dirancang begitu, atau mau ikut mengembangkan | [README root](README.md) & [README GUI](download_engine_gui/README.md) |

---

## Isi

- [Mengenali jendelanya](#mengenali-jendelanya)
- [Menambah download](#menambah-download)
- [Nama file](#nama-file)
- [Mengelola job yang sudah ada](#mengelola-job-yang-sudah-ada)
- [Inspector: progress per segmen & aksi file](#inspector-progress-per-segmen--aksi-file)
- [Aksi borongan](#aksi-borongan)
- [Mengatur kecepatan & jumlah download bersamaan](#mengatur-kecepatan--jumlah-download-bersamaan)
- [Settings](#settings)
- [Clipboard monitor](#clipboard-monitor)
- [Download dari browser](#download-dari-browser)
- [Tray & menutup aplikasi](#tray--menutup-aplikasi)
- [Menutup aplikasi di tengah download](#menutup-aplikasi-di-tengah-download)
- [Memakai dari terminal (CLI)](#memakai-dari-terminal-cli)
- [Kalau ada yang tidak beres](#kalau-ada-yang-tidak-beres)

---

## Mengenali jendelanya

Tata letaknya mengikuti gaya IDM:

| Bagian | Isi |
| --- | --- |
| **Title bar** | nama aplikasi, toggle tema terang/gelap, minimize/maximize/close |
| **Toolbar** | **New Download**, **Start All Queued**, **Pause All**, **Speed Limit**, kolom **Search**, tombol **Settings** |
| **Sidebar kiri** | filter berdasarkan status (dengan jumlahnya) dan kategori file — compressed, documents, video, programs. Di bawahnya: kecepatan total, jumlah segmen aktif, dan pemakaian slot concurrency |
| **Tabel tengah** | satu baris per job: nama file, ukuran, status, progress, kecepatan, ETA, tombol aksi |
| **Inspector** | panel kanan, muncul saat sebuah baris diklik |

Toggle tema tersimpan antar sesi dan **tidak** mengikuti tema Windows — toggle inilah yang menentukan.

---

## Menambah download

Ada empat jalan, semuanya berakhir di daftar job yang sama.

### 1. Form New Download

**New Download** di toolbar membuka form:

| Field | Keterangan |
| --- | --- |
| **Download URL** | wajib |
| **Save To Folder** | folder tujuan. Sudah terisi *Default Output Dir* dan bisa diedit. Dikosongkan = nilai default itu juga yang dipakai |
| **Nama File** | opsional. Kosong = nama ditentukan otomatis (lihat [Nama file](#nama-file)); diisi = nama itu yang dipakai |
| **Connections** | jumlah koneksi paralel, 1–32. Default dari Settings |
| **Bandwidth Limit** | cap kecepatan khusus job ini |
| **Start Delay** | tunda N detik sebelum job dimasukkan ke daftar |

Dua tombolnya berbeda arti:

- **Download Now** — langsung jalan, mengabaikan batas Concurrency.
- **Add to Queue** — masuk daftar berstatus *Queued*, baru jalan saat ada slot kosong.

Begitu job masuk, URL-nya langsung di-probe untuk mengambil ukuran file, dukungan Range request, dan nama file yang diminta server. Jadi kolom **Size** sudah terisi sebelum byte pertama turun.

> **Folder tujuan terisi sendiri.** Saat pertama dijalankan, *Default Output Dir* diisi ke **`<Downloads>\Download-Engine`**, jadi tidak perlu disetel dulu. Foldernya dibuat otomatis saat download pertama.
>
> Sengaja subfolder, bukan Downloads langsung: pengaman tabrakan nama hanya tahu job di daftar aplikasi ini, bukan isi folder di disk. Kalau tujuannya Downloads root, `installer.exe` yang tadi diunduh browser bisa tertimpa tanpa peringatan.

### 2. Drag-and-drop link

Tarik link dari browser (atau teks yang memuat URL) ke mana saja di jendela aplikasi. Overlay muncul saat drag masuk, dan yang terjadi setelah dilepas tergantung jumlahnya:

- **Satu link** → form New Download terbuka dengan URL-nya sudah terisi, jadi drop yang tidak sengaja masih bisa dibatalkan atau disesuaikan dulu.
- **Beberapa link** → semuanya langsung masuk queue dengan default dari Settings, karena form hanya bisa menampung satu URL.

Hanya `http` dan `https` yang diterima. URL kembar dalam satu drop dibuang, dan link yang sudah ada di daftar tidak ikut masuk — jumlah yang dilewati muncul sebagai notifikasi kecil di kanan bawah.

> **Menarik file tidak diterima.** Saat kamu menarik file, kursor menampilkan tanda "tidak boleh". Fitur ini memang untuk link; untuk file lokal tidak ada yang perlu diunduh. Alasan teknisnya ada di [README GUI](download_engine_gui/README.md#catatan-implementasi).

### 3. Clipboard monitor

Nyalakan di Settings, lalu setiap link yang kamu copy ditawarkan sendiri. Lihat [Clipboard monitor](#clipboard-monitor).

### 4. Dari browser

Lewat extension Chrome. Lihat [Download dari browser](#download-dari-browser).

---

## Nama file

### Kalau field *Nama File* dikosongkan

Nama awal diambil dari URL, lalu **diganti nama yang diminta server** (header `Content-Disposition`) begitu probe selesai. Inilah yang membuat link seperti:

```
https://example.com/download?id=84213
```

tersimpan sebagai `laporan-2024.pdf`, bukan `download`.

Nama dari server dibersihkan dulu di sisi engine sebelum dipakai: hanya nama file-nya yang lolos, tanpa separator, `..`, titik/spasi di ujung, karakter kontrol, atau nama device Windows (`CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`). Panjangnya dibatasi, dan nama yang habis setelah dibersihkan jatuh kembali ke nama dari URL — **tidak pernah** ke sesuatu yang dipilih server. Aturan lengkapnya di [README GUI](download_engine_gui/README.md#nama-file-dari-server).

Tiga keadaan yang membuat nama **tidak** diganti:

| Keadaan | Kenapa |
| --- | --- |
| Field *Nama File* kamu isi | pilihan kamu menang atas usulan server |
| Tidak ada folder tujuan (form dan *Default Output Dir* sama-sama kosong) | nama file ditentukan engine sendiri dari URL, dan label di daftar harus tetap cocok dengan yang ditulis ke disk |
| Download sudah mulai menulis byte | file-nya sudah dibuat di path lama; mengganti nama job hanya akan membuat aplikasi kehilangan jejaknya |

> Karena itu job baru menunggu probe selesai lebih dulu sebelum dijalankan — jeda satu permintaan HEAD, supaya namanya sudah benar sejak file dibuat.

### Dua job tidak akan pernah menulis ke file yang sama

Kalau path tujuan sudah dipakai job lain, ` (1)`, ` (2)`, dan seterusnya disisipkan sebelum ekstensi — seperti perilaku browser. Ini juga berlaku untuk nama yang datang dari server: yang bertabrakan dapat ` (1)`, bukan menimpa.

> Pengaman ini hanya aktif kalau folder tujuan diketahui. Satu alasan lagi untuk mengisi *Default Output Dir*.

### Link yang sudah ada di daftar

Peringatan kuning muncul di bawah field URL, berisi nama dan status job yang lama. Peringatannya **tidak memblokir** — mengunduh ulang link yang filenya sudah berubah di server itu kebutuhan yang sah. Yang dijamin aplikasi: file lama tidak ditimpa.

Perbandingan URL-nya memakai bentuk yang sudah dinormalkan:

| Dianggap sama | Dianggap beda |
| --- | --- |
| scheme & host beda huruf besar/kecil (`HTTP://Example.com` = `http://example.com`) | path beda huruf besar/kecil — path itu case-sensitive |
| port default ditulis eksplisit (`https://a:443/x` = `https://a/x`) | query string beda — sering jadi pembeda file (token, versi, id) |
| cuma beda fragment `#...` — bagian itu tidak pernah dikirim ke server | |

---

## Mengelola job yang sudah ada

### Status

| Status | Arti |
| --- | --- |
| **Queued** | menunggu slot concurrency |
| **Downloading** | sedang jalan |
| **Paused** | dijeda. Koneksinya diparkir, tapi slot concurrency-nya tetap dipegang |
| **Completed** | selesai |
| **Cancelled** | dihentikan sendiri olehmu |
| **Failed** | gagal setelah retry habis. Penyebabnya ada di inspector |
| **Interrupted** | sedang jalan atau dijeda saat aplikasi terakhir ditutup. Bisa dilanjutkan dari byte terakhir |

### Tombol per baris

Tombol yang muncul menyesuaikan status:

| Tombol | Muncul saat | Fungsi |
| --- | --- | --- |
| **Pause** | downloading | jeda di batas chunk berikutnya; byte yang sudah ditulis tetap aman |
| **Resume** | paused | lanjutkan |
| **Cancel** | downloading / paused | hentikan permanen |
| **Continue / Retry** | completed, failed, cancelled, interrupted | masukkan ulang ke queue. Ikon **play** kalau ada byte yang bisa dilanjutkan, **rotate** kalau mulai dari nol |
| **Inspect** | selalu | buka panel progress per segmen |
| **Delete** | selalu | hapus dari daftar |

**Delete** berbeda perlakuan menurut status: job yang belum selesai ikut membuang file parsial dan sidecar-nya, karena file setengah jadi tidak ada gunanya dan bisa memakan puluhan GB. Job yang sudah **Completed** hanya hilang dari daftar — filenya milikmu dan tidak disentuh.

---

## Inspector: progress per segmen & aksi file

Klik baris job mana pun. Panel kanan menampilkan progress tiap segmen secara real-time, plus pesan error lengkap kalau job-nya gagal.

Di bawah nama file ada tiga aksi:

| Aksi | Fungsi | Nonaktif saat |
| --- | --- | --- |
| **Buka Folder** | tampilkan file di File Explorer dengan filenya tersorot | job masih *Queued*, jadi belum ada file di disk |
| **Copy Link** | copy URL download ke clipboard | — |
| **Copy Path** | copy path file output ke clipboard | job tidak punya path output eksplisit |

Konfirmasi (atau pesan error) muncul sebentar di bawah tombolnya, lalu hilang sendiri.

> Tidak ada aksi "buka file" yang langsung menjalankan filenya — itu keputusan yang disengaja, alasannya di [README GUI](download_engine_gui/README.md#catatan-implementasi). Dari **Buka Folder**, filenya sudah tersorot dan tinggal dua klik.

---

## Aksi borongan

Centang kolom paling kiri untuk memilih beberapa job sekaligus:

- **Checkbox di header** memilih/melepas semua baris yang sedang terlihat. Kalau pilihannya sebagian, checkbox-nya tampil *indeterminate*.
- **Shift+klik** memilih satu rentang sekaligus, seperti di file manager.

Begitu ada yang dipilih, muncul bar aksi: **Lanjutkan**, **Jeda**, **Batalkan**, **Ulangi**, **Hapus**.

Angka di tiap tombol menunjukkan berapa job yang benar-benar terkena aksi itu, dan tombolnya nonaktif kalau tidak ada yang cocok. Jadi memilih campuran status tetap aman: **Jeda** hanya menyentuh yang *Downloading*, **Lanjutkan** hanya yang *Paused*, sisanya dibiarkan — bukan error.

**Hapus** minta konfirmasi lebih dulu (berbeda dari tombol hapus per baris) dan menyebutkan berapa job yang masih punya file parsial yang akan ikut dibuang.

Pilihan selalu dijaga hanya berisi baris yang **sedang terlihat**. Job yang dihapus atau tersaring keluar oleh filter/pencarian otomatis lepas dari pilihan, supaya aksi borongan tidak pernah mengenai sesuatu yang tidak kamu lihat di layar. Kalau pilihanmu hilang sendiri setelah mengubah filter, itu sebabnya.

---

## Mengatur kecepatan & jumlah download bersamaan

Ada tiga pengatur yang berlapis:

| Pengatur | Tempat | Cakupan |
| --- | --- | --- |
| **Bandwidth Limit** | form New Download | satu job itu saja |
| **Speed Limit** | toolbar | gabungan **semua** download sekaligus |
| **Concurrency** | Settings | berapa job boleh aktif bersamaan |

Yang paling ketat yang berlaku. **Speed Limit** di toolbar bisa diubah saat download sedang jalan dan langsung berlaku tanpa perlu restart job.

Soal **Connections**: engine memecah file jadi beberapa koneksi paralel, dan tiap koneksi meminta potongan 8 MiB sekaligus, bukan satu range raksasa. Angka besar tidak selalu lebih cepat — banyak server membatasi jumlah koneksi per klien, dan beberapa menolak range besar. Kalau sebuah situs sering gagal, turunkan Connections-nya lebih dulu.

Job **Paused** tetap menghitung terhadap batas Concurrency: koneksinya cuma diparkir, bukan dilepas. Kalau queue terasa macet, cek apakah ada job yang masih dijeda.

---

## Settings

| Setting | Pengaruh |
| --- | --- |
| **Default Segments** | nilai awal Connections di form |
| **Default Limit** | nilai awal Bandwidth Limit di form |
| **Default Output Dir** | folder tujuan kalau form dibiarkan kosong. Terisi otomatis ke `<Downloads>\Download-Engine` saat pertama jalan |
| **Concurrency** | berapa job boleh aktif bersamaan. Job *Paused* tetap menghitung |
| **Max Retries** | percobaan ulang per segmen sebelum job dinyatakan gagal |
| **User Agent** | mengganti User-Agent. Berguna untuk server yang menolak client tak dikenal |
| **Pantau Clipboard** | aktifkan clipboard monitor. Default **mati** |
| **Terima Link dari Extension Browser** | aktifkan bridge HTTP lokal. Default **mati**. Di sini juga token pairing-nya ditampilkan |

---

## Clipboard monitor

Setelah dinyalakan di Settings, setiap kali kamu meng-copy link `http(s)` muncul kartu kecil di kanan bawah: **Download** membuka form dengan URL-nya sudah terisi, **Abaikan** menutupnya.

Yang perlu diketahui:

- Satu isi clipboard hanya ditawarkan **sekali**.
- Link yang sudah ada di daftar job tidak ditawarkan sama sekali.
- Pemantauan **dijeda selama form New Download terbuka**, supaya link yang kamu paste sendiri ke form itu tidak kembali muncul sebagai tawaran.
- Saat monitor baru dinyalakan, bacaan pertama hanya dipakai sebagai baseline — apa pun yang sudah lebih dulu ada di clipboard tidak langsung nongol.

> **Kenapa default-nya mati.** Clipboard tidak punya event "berubah", jadi satu-satunya cara adalah membacanya berkala (tiap 1,5 detik) — dan itu berarti **semua** isi clipboard terbaca, termasuk password yang kebetulan sedang kamu copy. Yang dilakukan aplikasi: teks dibaca, dicek apakah URL http(s), kalau bukan langsung dibuang dari memori. Tidak ditulis ke disk, tidak dikirim ke jaringan, tidak di-log. Tetap saja, karena ini keputusan privasi dan bukan keputusan teknis, fitur ini harus kamu nyalakan sendiri.

---

## Download dari browser

Butuh extension Chrome — pemasangan dan pairing token-nya di [browser-extension/README.md](browser-extension/README.md). Pairing wajib sekali di awal: tanpa token, permintaan ditolak.

Nyalakan dulu **Terima Link dari Extension Browser** di Settings. Aplikasi lalu membuka listener di `127.0.0.1:47283`, dan selama toggle-nya mati tidak ada socket yang dibuka sama sekali.

Tiga cara mengirim link:

| Cara | Kapan dipakai |
| --- | --- |
| **Klik kanan** link, video, audio, atau gambar → *Download with Download Engine* | cara biasa |
| **Popup extension** → tempel URL di *Kirim Link Manual* | untuk URL yang kamu dapat dari tempat lain |
| **Ambil Alih Download Browser** (izin opsional) | tombol "Download" yang bukan link, atau URL final setelah redirect |

Menu klik-kanan hanya muncul di atas link dan media, bukan di area kosong halaman. Tombol "Download" di banyak situs bukan link (ia men-submit form), jadi tidak ada yang bisa diklik-kanan di sana — untuk kasus itu pakai ambil-alih otomatis, atau salin URL finalnya dari `chrome://downloads` (klik kanan nama file → **Copy link address**) lalu tempel di popup.

Hasilnya muncul sebagai badge kecil di ikon extension: ✓ hijau kalau diterima, ! merah kalau tidak, dengan alasannya di tooltip.

Job dari browser masuk **antrian** seperti yang kamu tambahkan sendiri — scheduler aplikasi yang menentukan kapan mulai, menghormati batas Concurrency.

> **Cookie sesi tidak disimpan ke disk.** Cookie yang dikirim extension hanya hidup di memori selama aplikasi jalan. Konsekuensinya: job dari extension yang kamu lanjutkan **setelah aplikasi restart** akan mencoba tanpa cookie-nya dan bisa gagal — kirim ulang dari browser untuk mendapat cookie yang masih berlaku. Itu disengaja; menaruh kredensial login di file JSON plaintext harganya lebih besar daripada kenyamanan resume.

---

## Tray & menutup aplikasi

Menutup jendela dengan tombol **X tidak mengakhiri aplikasi** — jendelanya disembunyikan ke tray dan download tetap berjalan.

| Aksi | Hasil |
| --- | --- |
| Klik kiri ikon tray | memunculkan jendela |
| Klik kanan ikon tray | menu: **Tampilkan Jendela**, **Mulai Semua**, **Jeda Semua**, **Keluar** |
| **Keluar** dari menu tray | keluar untuk sebenarnya |

Menjalankan aplikasi dua kali tidak membuat instance kedua; jendela instance yang sudah jalan yang dimunculkan. Ini mencegah dua proses saling menimpa daftar job yang tersimpan — jadi kalau klik ikon aplikasi "tidak membuka apa-apa", kemungkinan jendelanya baru saja dimunculkan di tempat lain.

**Notifikasi** sistem muncul saat download selesai atau gagal. Job yang kamu cancel sendiri tidak memunculkan notifikasi. Izinnya diminta sekali saat pertama dibutuhkan.

---

## Menutup aplikasi di tengah download

Yang tersimpan antar sesi: daftar job, semua Settings, pilihan tema, global speed limit, serta ukuran dan posisi window.

Job yang berstatus *Downloading* atau *Paused* saat aplikasi ditutup kembali sebagai **Interrupted**. Tekan **Continue** untuk melanjutkan — engine menemukan file parsialnya sendiri lewat sidecar `.dengine-part` di sebelah file output. Progress bar langsung menunjukkan angka yang benar, karena aplikasi menanyakan dulu berapa byte yang sungguh ada di disk alih-alih mulai dari 0 lalu melompat.

Resume dibatalkan otomatis dan download mulai dari awal kalau:

- ETag atau Last-Modified server berubah,
- ukuran file berbeda dari yang tercatat,
- file parsialnya sudah tidak utuh.

Jadi **Continue** yang mulai dari 0% biasanya bukan bug: file di server memang sudah berganti, dan mengunduh ulang adalah satu-satunya cara aman untuk tidak menghasilkan file rusak.

---

## Memakai dari terminal (CLI)

Engine-nya juga punya CLI, berguna untuk sekali-jalan atau dipanggil dari script:

```powershell
cargo run -p download_engine -- "https://example.com/file.zip"
```

Flag `-p` wajib karena workspace ini punya lebih dari satu binary.

Beberapa flag yang sering dipakai:

| Flag | Fungsi |
| --- | --- |
| `-o`, `--output` | path file output (hanya untuk satu URL) |
| `-n`, `--segments` | jumlah koneksi paralel (default 8) |
| `-r`, `--limit` | cap kecepatan, mis. `500KB`, `2MB`, `1GB` |
| `-c`, `--concurrency` | berapa file diunduh bersamaan saat URL-nya banyak |
| `--start-in` | tunda N detik sebelum queue mulai |
| `--retries` | percobaan ulang per segmen (default 5) |
| `--user-agent` | ganti User-Agent |
| `--no-resume` | abaikan file parsial, unduh dari awal |

Daftar lengkap plus cara memakainya sebagai library Rust ada di [download_engine/README.md](download_engine/README.md).

---

## Kalau ada yang tidak beres

| Gejala | Penyebab | Yang bisa dilakukan |
| --- | --- | --- |
| File hasil download entah di mana | folder tujuan dan *Default Output Dir* sama-sama kosong | set **Default Output Dir** di Settings |
| File terunduh hanya beberapa KB dan isinya HTML | server membalas halaman error (kuota, login, atau captcha), bukan file | buka filenya dengan Notepad untuk melihat pesannya. Untuk link yang butuh login, kirim lewat extension dengan cookie aktif |
| Job gagal: `status 200 OK, not 206` | server menolak melayani permintaan range — biasanya kuota atau pembatasan | sengaja dilaporkan gagal, bukan disimpan sebagai file rusak. Coba turunkan **Connections** ke 1 |
| Download dari Google Drive gagal | file public yang lewat batas kuota hanya bisa diunduh dalam keadaan login | nyalakan **Sertakan Cookie Situs** di extension |
| **Continue** mulai dari 0% | sidecar sudah tidak cocok (file di server berubah) atau server tidak mendukung Range | normal — satu-satunya cara aman adalah mengunduh ulang |
| Nama file tetap jelek padahal server mengirim nama | field *Nama File* terisi, folder tujuan kosong, atau job sudah mulai menulis byte | lihat [tiga keadaan di atas](#kalau-field-nama-file-dikosongkan). Hapus job-nya dan tambahkan ulang dengan *Nama File* dibiarkan kosong |
| Queue tidak maju padahal ada slot | job *Paused* tetap memakai slot concurrency | lanjutkan atau batalkan yang dijeda, atau naikkan **Concurrency** |
| Aplikasi hilang setelah ditekan X | disembunyikan ke tray, bukan ditutup | klik ikon tray, atau **Keluar** dari menu tray |
| Notifikasi tidak muncul | izin notifikasi Windows ditolak | aktifkan di Windows Settings → Notifications |
| Tombol **Buka Folder** nonaktif | job masih *Queued*, filenya belum dibuat | jalankan dulu job-nya |
| Pilihan hilang sendiri saat filter diubah | disengaja — pilihan dijaga hanya berisi baris yang terlihat | pilih ulang setelah filternya pas |
| Menarik file ke jendela ditolak | handler drag-drop OS dimatikan supaya drag link bisa jalan | pakai **New Download**; drag hanya untuk link |
| Extension tidak muncul di menu klik-kanan | yang diklik area kosong atau sebuah tombol, bukan link | pakai popup extension atau ambil-alih otomatis |
| Job dari extension gagal setelah aplikasi restart | cookie sesi memang tidak disimpan ke disk | kirim ulang linknya dari browser |

Gejala yang berkaitan dengan **build** (`NotAttempted("windres")`, `linker link.exe not found`) ada di [Troubleshooting README GUI](download_engine_gui/README.md#troubleshooting).
