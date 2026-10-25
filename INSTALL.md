# Panduan Instalasi — Download Engine

Panduan untuk memasang dan memakai Download Engine di Windows. Tidak perlu paham isi kodenya. Versi 0.1.0 ini **hanya untuk Windows 10/11 (64-bit)**, dan extension browser-nya **hanya untuk Chrome**.

Ada dua bagian, dan **bagian 2 opsional**:

1. **Aplikasi desktop** — wajib. Ini yang benar-benar mengunduh file.
2. **Extension browser** — opsional, supaya link bisa dikirim langsung dari Chrome.

---

## 1. Memasang aplikasi desktop

### Mengunduh installer

Ambil **`Download.Engine_0.1.0_x64-setup.exe`** dari halaman [Releases](https://github.com/RezEkoArd/download_engine/releases/latest), lalu jalankan. Ini pilihan yang dianjurkan: ia memasang untuk akun kamu sendiri, jadi tidak meminta hak administrator.

Di halaman yang sama ada `Download.Engine_0.1.0_x64_en-US.msi`. Isinya aplikasi yang sama, bedanya ia memasang untuk seluruh komputer dan akan meminta admin — pakai itu hanya kalau kamu memang perlu memasangnya untuk semua pengguna. Pilih salah satu, jangan dua-duanya.

Windows SmartScreen kemungkinan menampilkan **"Windows protected your PC"**. Itu karena installer-nya belum ditandatangani secara digital, bukan karena isinya bermasalah. Klik **More info → Run anyway** kalau kamu memang yang membuat atau menerima file ini dari sumber yang kamu percaya.

Setelah terpasang, aplikasinya muncul di Start Menu sebagai **Download Engine**. Tidak perlu Rust, Node, atau toolchain apa pun untuk menjalankannya.

### Kalau kamu ingin membangunnya sendiri

Tidak perlu kalau kamu cuma mau memakai aplikasinya — cukup unduh installer di atas. Untuk membangun dari source, yang dibutuhkan: **Rust**, **Node.js 20+**, dan **pnpm**.

```powershell
# Node 20+ wajib — Vite 8 memakai Rolldown yang butuh API `node:util` baru.
# Di Node 18 build berhenti dengan pesan yang tidak menyinggung versi Node sama sekali.
nvm use 22
node -v

# Linker C/C++ untuk Rust. Lewati kalau Visual Studio Build Tools sudah ada.
winget install BrechtSanders.WinLibs.POSIX.UCRT
rustup default stable-x86_64-pc-windows-gnu
```

MinGW harus ada di **PATH**, bukan sekadar terpasang — build script `tauri-winres` memanggil `windres`. Kalau belum permanen, set per sesi:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
```

Lalu:

```powershell
cd download_engine_gui
pnpm install
pnpm tauri build
```

Hasilnya ada di `target/release/bundle/`. Ini bukan build cepat: `lto = true` dan `codegen-units = 1` membuatnya hitungan belasan menit. Untuk sekadar mencoba tanpa memasang, `pnpm tauri dev` jauh lebih cepat.

---

## 2. Memasang extension browser

Extension ini **belum ada di Chrome Web Store**, jadi dipasang sebagai *unpacked extension* — mode pengembang. Konsekuensinya ada dua, dan keduanya normal:

- Chrome akan menampilkan peringatan **"Disable developer mode extensions"** setiap kali dibuka. Jangan hapus extension-nya; tutup saja peringatannya.
- Folder `browser-extension` **tidak boleh dipindah atau dihapus** setelah dipasang. Chrome memuatnya dari lokasi itu setiap kali start, bukan menyalinnya.

### Langkah

1. Buka `chrome://extensions` (atau `edge://extensions`).
2. Nyalakan **Developer mode** di pojok kanan atas.
3. **Load unpacked** → pilih folder `browser-extension`.
4. Sematkan ikonnya ke toolbar lewat ikon puzzle 🧩 agar mudah dijangkau.

### Pairing — wajib, sekali di awal

Bridge menolak setiap permintaan tanpa token, jadi extension tidak akan berfungsi sebelum langkah ini:

1. Di aplikasi desktop: **Settings → Terima Link dari Extension Browser** → nyalakan.
2. Copy **Token Pairing** yang muncul di bawahnya.
3. Klik ikon extension → **Buka Pengaturan Lengkap**.
4. Tempel token → **Simpan Token** → **Tes Koneksi**.

Badge di header harus berubah jadi hijau **"Bridge Connected (127.0.0.1:47283)"**. Kalau belum, **Tes Koneksi** akan menyebut penyebabnya — ketiga kegagalan di bawah terasa sama tapi berbeda sumbernya:

| Pesan | Artinya |
| --- | --- |
| Tidak ada jawaban | Aplikasi tidak jalan, atau bridge belum dinyalakan di Settings |
| Token ditolak | Aplikasi terhubung, tapi token tidak cocok — copy ulang |
| HTTP 4xx lain | Bridge menjawab tapi menolak; lihat Troubleshooting README GUI |

### Dua izin opsional

Keduanya mati secara default dan diminta hanya saat kamu menyalakannya sendiri.

**Sertakan Cookie Situs** — diperlukan untuk link yang hanya bisa diunduh setelah login. Tanpa ini, link seperti itu mengunduh halaman login atau gagal 403. Harganya nyata: extension jadi bisa membaca semua cookie-mu, termasuk yang `HttpOnly`.

**Ambil Alih Download Browser** — setiap unduhan yang dimulai browser diteruskan ke Download Engine lalu dibatalkan di browser. Ini satu-satunya cara menangani tombol unduh yang men-submit form dan halaman perantara, karena URL finalnya baru diketahui setelah browser menelusuri semua pengalihan. Izin `downloads` memperlihatkan seluruh aktivitas unduhanmu ke extension.

> Kalau toggle dicentang tapi statusnya tetap "tidak disentuh", **reload extension** di `chrome://extensions` (tombol ↻). Chrome membaca HTML dan JS dari disk setiap kali, tapi `manifest.json` hanya saat dimuat — jadi toggle baru bisa muncul sebelum izinnya terdaftar.

---

## Cara memakai

Ringkasnya di bawah. Panduan lengkapnya — semua field di form, aksi per job, aksi borongan, Settings, tray — ada di [PENGGUNAAN.md](PENGGUNAAN.md).

### Dari aplikasi

- **New Download** → tempel URL.
- Seret-dan-lepas URL ke jendela aplikasi.
- Nyalakan **Clipboard Monitor** di Settings supaya link yang kamu copy terdeteksi otomatis.

### Dari browser

- **Klik kanan** sebuah link, video, audio, atau gambar → **Download with Download Engine**.
- Klik ikon extension → tempel URL di **Kirim Link Manual**.
- Dengan "Ambil Alih Download Browser" aktif: unduh seperti biasa, job-nya pindah sendiri.

Menu klik-kanan hanya muncul di atas link dan media — bukan di area kosong halaman. Tombol "Download" di banyak situs bukan link (ia men-submit form), jadi tidak ada yang bisa diklik-kanan di sana. Untuk kasus itu pakai ambil-alih otomatis, atau salin URL finalnya dari `chrome://downloads` (klik kanan nama file → **Copy link address**) lalu tempel di popup.

---

## Kalau ada yang tidak beres

| Gejala | Penyebab |
| --- | --- |
| File terunduh hanya beberapa KB dan berisi HTML | Server membalas halaman error (kuota, login, atau captcha), bukan file. Buka file-nya dengan Notepad untuk melihat pesannya. |
| Download dari Google Drive gagal | File public yang lewat batas kuota hanya bisa diunduh dalam keadaan login. Nyalakan "Sertakan Cookie Situs". |
| Extension tidak muncul di menu klik-kanan | Kamu mengklik area kosong atau sebuah tombol, bukan link. |
| Job gagal dengan `status 200 OK, not 206` | Server menolak melayani permintaan range — biasanya karena kuota atau pembatasan. Ini sengaja dilaporkan gagal, bukan disimpan sebagai file rusak. |

Daftar gejala yang lebih lengkap ada di [Kalau ada yang tidak beres](PENGGUNAAN.md#kalau-ada-yang-tidak-beres).
