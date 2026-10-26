# Panduan Penggunaan — Download Engine

Cara memakai Download Engine sehari-hari. Tidak perlu paham isi kodenya.

> **Versi ini jalan di Windows 10/11 saja**, dan extension browser-nya untuk **Chrome**. Aplikasinya sendiri tidak butuh browser apa pun — ia aplikasi desktop, bukan halaman web.

Belum terpasang? Unduh berkas `.exe` dari [Releases](https://github.com/RezEkoArd/download_engine/releases/latest), atau ikuti [INSTALL.md](INSTALL.md) yang juga mencakup extension browser. Dokumen ini mengambil alih dari titik aplikasinya sudah bisa dibuka.

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
  - [Tema dan warna aksen](#tema-dan-warna-aksen)
- [Notch](#notch)
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
| **Title bar** | nama aplikasi, tombol pengaturan, tombol tema, minimize/maximize/close |
| **Judul halaman** | mengikuti filter yang sedang aktif — "Semua Download", "Berjalan", "Arsip (zip, rar)", dan seterusnya; kolom **Cari download** ada di sebelah kanannya |
| **Toolbar** | **Tambah Download**, **Mulai Semua**, **Jeda Semua**, **Hapus** (membuang baris yang dicentang), **Batas kecepatan** |
| **Sidebar kiri** | filter status dengan jumlahnya masing-masing (Semua Download, Berjalan, Antrean, Dijeda, Terputus, Selesai, Dibatalkan, Gagal), lalu grup **Kategori** (Semua Jenis, Arsip, Dokumen, Video & Media, Aplikasi). Filter yang aktif ditandai garis warna aksen di tepi kiri. Paling bawah: tombol **Pengaturan** |
| **Tabel tengah** | enam kolom: kotak centang, **Nama file** (ikon berwarna per jenis berkas, dengan progress bar di bawah namanya), **Ukuran** (terunduh / total), **Kecepatan**, **Sisa waktu** (berisi lencana status kalau job-nya tidak sedang berjalan), **Aksi** |
| **Inspector** | panel kanan, muncul saat sebuah baris diklik |
| **Footer** | kecepatan total, jumlah download aktif berbanding slot concurrency, jumlah segmen yang sedang bekerja, dan jumlah baris di daftar |

Tombol tema di title bar berputar Terang → Gelap → Ikut sistem. Pilihannya tersimpan antar sesi; hanya mode **Ikut sistem** yang mengikuti tema Windows.

---

## Menambah download

Ada empat jalan, semuanya berakhir di daftar job yang sama.

### 1. Form Tambah Download

**Tambah Download** di toolbar membuka form:

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

- **Satu link** → form Tambah Download terbuka dengan URL-nya sudah terisi, jadi drop yang tidak sengaja masih bisa dibatalkan atau disesuaikan dulu.
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
| **Bandwidth Limit** | form Tambah Download | satu job itu saja |
| **Batas kecepatan** | toolbar | gabungan **semua** download sekaligus |
| **Concurrency** | Settings | berapa job boleh aktif bersamaan |

Yang paling ketat yang berlaku. **Batas kecepatan** di toolbar bisa diubah saat download sedang jalan dan langsung berlaku tanpa perlu restart job.

Soal **Connections**: engine memecah file jadi beberapa koneksi paralel, dan tiap koneksi meminta potongan 8 MiB sekaligus, bukan satu range raksasa. Angka besar tidak selalu lebih cepat — banyak server membatasi jumlah koneksi per klien, dan beberapa menolak range besar. Kalau sebuah situs sering gagal, turunkan Connections-nya lebih dulu.

Job **Paused** tetap menghitung terhadap batas Concurrency: koneksinya cuma diparkir, bukan dilepas. Kalau queue terasa macet, cek apakah ada job yang masih dijeda.

---

## Settings

Ikon gerigi di kanan atas membuka halaman Pengaturan — satu layar penuh dengan enam bagian di kiri, bukan dialog. **Tidak ada tombol Save**: setiap perubahan langsung berlaku dan langsung tersimpan. **Kembalikan default** di kanan bawah mengembalikan semuanya kecuali folder tujuan, yang dibiarkan karena ia diisi dari folder Downloads-mu saat pertama jalan.

| Bagian | Isi |
| --- | --- |
| **Umum** | Concurrency (berapa job aktif bersamaan — job *Paused* tetap menghitung), percobaan ulang per segmen, dan Pantau Clipboard |
| **Download** | folder tujuan, jumlah koneksi paralel, batas kecepatan, dan User-Agent — semuanya nilai awal untuk form Tambah Download |
| **Tampilan** | tema dan warna aksen. Lihat di bawah |
| **Notch & Notifikasi** | menyalakan notch dan memilih apakah ia tetap tampak saat menganggur |
| **Integrasi Browser** | menyalakan bridge HTTP lokal dan menampilkan token pairing-nya |
| **Tentang** | versi, dan tautan ke kode sumber serta halaman Releases |

### Tema dan warna aksen

**Tema aplikasi** punya tiga pilihan: Terang, Gelap, dan **Ikuti Sistem**. Yang terakhir benar-benar mengikuti: kalau Windows berganti tema di tengah hari, aplikasinya ikut berganti saat itu juga, bukan menunggu dijalankan ulang.

**Warna aksen** — Biru, Teal, Ungu, Oranye — mengganti warna tombol, bar progres, menu aktif, dan angka persen. Keduanya berlaku ke **seluruh aplikasi termasuk notch**, jadi strip di tepi atas layar tidak lagi memakai palet sendiri.

Tombol matahari/bulan di title bar tetap ada sebagai jalan pintas Terang ⇄ Gelap. Menekannya memilih tema secara eksplisit — artinya ia juga mematikan "Ikuti Sistem", karena memilih sendiri dan mengikuti OS tidak bisa dua-duanya.

---

## Notch

Strip yang menempel di **tepi atas layar** selama ada download berjalan, selalu di atas jendela lain. Isinya nama berkas, persen, kecepatan, dan sisa waktu.

Ia muncul sendiri saat download pertama mulai dan hilang sendiri saat tidak ada lagi yang berjalan. Saat sebuah download selesai, ia berganti sebentar jadi pemberitahuan **"Download selesai"** dengan tombol **Buka Folder**, lalu menghilang setelah delapan detik.

Kalau ada lebih dari satu download berjalan, yang ditampilkan adalah **yang paling lama berjalan**, dengan keterangan `+N lagi` di sampingnya. Dipilih begitu, bukan yang progresnya paling jauh, supaya tampilannya tidak berganti-ganti berkas setiap kali satu menyalip yang lain.

### Memindahkannya

**Tarik notch-nya** ke kiri atau kanan. Ia selalu menempel di tepi atas, jadi yang bisa kamu atur cuma posisi mendatarnya — termasuk **menyeretnya ke monitor lain**: notch mengikuti kursor melewati batas layar dan menempel di tepi atas monitor tempat kursor berada saat kamu lepas. Posisinya diingat dan dipakai lagi saat berikutnya ia muncul.

Kalau monitor itu dicabut, posisi tersimpannya tidak cocok lagi dengan monitor mana pun, dan notch kembali ke tengah layar jendela utama — bukan tertinggal di koordinat yang sudah tidak ada.

### Panel

Tombol **⋯** (atau **⌄** saat menganggur) membuka panel: daftar semua yang sedang berjalan, dijeda, dan mengantre, lengkap dengan progres masing-masing. Tombol **⧉** di dalamnya membawa jendela utama ke depan, dan **✕** menutup panelnya lagi.

Tombol **jeda** di notch menjeda **semua** yang sedang berjalan sekaligus, sama seperti *Jeda Semua* di jendela utama.

### Dua hal yang perlu disadari

Notch tidak muncul di taskbar maupun Alt-Tab — ia bacaan, bukan jendela yang kamu tuju.

Jendelanya **menelan klik** yang mengenainya. Ia duduk persis di tempat deretan tab browser, jadi secara bawaan ia hanya ada di layar selagi ada download. Kalau kamu ingin ia selalu tampak supaya bisa digeser kapan saja, nyalakan **Settings → Notch & Notifikasi → Biarkan tetap tampak saat menganggur** — dan ingat harga itu.

Notch memakai tema dan warna aksen yang sama dengan jendela utama — termasuk "Ikuti Sistem". Atur di **Settings → Tampilan**.

Matikan sepenuhnya lewat **Settings → Notch & Notifikasi**.

---

## Clipboard monitor

Setelah dinyalakan di Settings, setiap kali kamu meng-copy link `http(s)` muncul kartu kecil di kanan bawah: **Download** membuka form dengan URL-nya sudah terisi, **Abaikan** menutupnya.

Yang perlu diketahui:

- Satu isi clipboard hanya ditawarkan **sekali**.
- Link yang sudah ada di daftar job tidak ditawarkan sama sekali.
- Pemantauan **dijeda selama form Tambah Download terbuka**, supaya link yang kamu paste sendiri ke form itu tidak kembali muncul sebagai tawaran.
- Saat monitor baru dinyalakan, bacaan pertama hanya dipakai sebagai baseline — apa pun yang sudah lebih dulu ada di clipboard tidak langsung nongol.

> **Kenapa default-nya mati.** Clipboard tidak punya event "berubah", jadi satu-satunya cara adalah membacanya berkala (tiap 1,5 detik) — dan itu berarti **semua** isi clipboard terbaca, termasuk password yang kebetulan sedang kamu copy. Yang dilakukan aplikasi: teks dibaca, dicek apakah URL http(s), kalau bukan langsung dibuang dari memori. Tidak ditulis ke disk, tidak dikirim ke jaringan, tidak di-log. Tetap saja, karena ini keputusan privasi dan bukan keputusan teknis, fitur ini harus kamu nyalakan sendiri.

---

## Download dari browser

Butuh extension Chrome. Unduh `browser-extension.zip` dari [Releases](https://github.com/RezEkoArd/download_engine/releases/latest), ekstrak ke folder permanen, lalu pasang lewat *Load unpacked* di `chrome://extensions`. Langkah lengkapnya di [browser-extension/README.md](browser-extension/README.md). Pairing token wajib sekali di awal: tanpa token, permintaan ditolak.

Nyalakan dulu **Terima Link dari Extension Browser** di Settings. Aplikasi lalu membuka listener di `127.0.0.1:47283`, dan selama toggle-nya mati tidak ada socket yang dibuka sama sekali.

Tiga cara mengirim link:

| Cara | Kapan dipakai |
| --- | --- |
| **Klik kanan** link, video, audio, atau gambar → *Download with Download Engine* | cara biasa |
| **Popup extension** → tempel URL di *Kirim Link Manual* | untuk URL yang kamu dapat dari tempat lain |
| **Ambil Alih Download Browser** (izin opsional) | tombol "Download" yang bukan link, atau URL final setelah redirect |

Menu klik-kanan hanya muncul di atas link dan media, bukan di area kosong halaman. Tombol "Download" di banyak situs bukan link (ia men-submit form), jadi tidak ada yang bisa diklik-kanan di sana — untuk kasus itu pakai ambil-alih otomatis, atau salin URL finalnya dari `chrome://downloads` (klik kanan nama file → **Copy link address**) lalu tempel di popup.

Hasilnya muncul sebagai badge kecil di ikon extension: ✓ hijau kalau diterima, ! merah kalau tidak, dengan alasannya di tooltip.

### Dialog konfirmasi

Kalau **Ambil Alih Download Browser** aktif, unduhan yang tertangkap tidak langsung berpindah. Browser dijeda dulu, lalu popup extension terbuka sendiri di bawah ikonnya di toolbar, berisi nama berkas, ukuran, dan alamat asalnya, dengan dua tombol:

| Tombol | Akibatnya |
| --- | --- |
| **Unduh dengan Engine** | unduhan browser dibatalkan, job-nya pindah ke Download Engine |
| **Biarkan Browser** | jeda dilepas, browser melanjutkan seperti tidak terjadi apa-apa |

Enter memilih yang pertama, Esc yang kedua. Mengklik di luar popup tanpa memilih sama saja dengan menekan *Biarkan Browser* — tidak ada unduhan yang hilang karena kamu mengabaikan pertanyaannya.

Kalau dua download mulai berbarengan, pertanyaannya diajukan bergantian: yang kedua tetap terjeda sampai yang pertama dijawab.

Centang **Jangan tanya lagi** di dialog itu, atau matikan **Tanya Dulu** di popup extension, kalau kamu ingin semua unduhan langsung berpindah. Konsekuensinya: baris unduhan di browser akan hilang begitu saja tanpa pemberitahuan apa pun.

Berkas yang sangat kecil kadang sudah selesai sebelum sempat dijeda. Itu dibiarkan di browser — berkas yang sudah ada di tanganmu tidak dibatalkan hanya supaya bisa diunduh ulang.

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
| Menarik file ke jendela ditolak | handler drag-drop OS dimatikan supaya drag link bisa jalan | pakai **Tambah Download**; drag hanya untuk link |
| Extension tidak muncul di menu klik-kanan | yang diklik area kosong atau sebuah tombol, bukan link | pakai popup extension atau ambil-alih otomatis |
| Job dari extension gagal setelah aplikasi restart | cookie sesi memang tidak disimpan ke disk | kirim ulang linknya dari browser |

Gejala yang berkaitan dengan **build** (`NotAttempted("windres")`, `linker link.exe not found`) ada di [Troubleshooting README GUI](download_engine_gui/README.md#troubleshooting).
