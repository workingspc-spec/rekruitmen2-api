# 🚀 Sistem Rekruitmen PKAR

Proyek ini adalah sistem rekrutmen komprehensif yang terdiri dari tiga komponen utama: Backend (Express.js), Frontend Web (React/Vite), dan Mobile App (Android Kotlin). Sistem ini telah dilengkapi dengan automasi *deployment* (CI/CD) penuh dan sistem pembaruan aplikasi Android secara nirkabel (*Over-The-Air* / OTA) tanpa melalui Google Play Store.

---

## 🏗️ Arsitektur Sistem

* **Backend API:** Node.js (Express.js) dikelola menggunakan PM2.
* **Frontend Web:** React.js (Vite), di- *serve* secara statis melalui Nginx / HTTP Server.
* **Mobile App:** Android App (Kotlin).
* **Database:** MySQL (Database `rekruitmen2`).
* **Infrastruktur:** Virtual Private Server (VPS).
* **CI/CD:** GitHub Actions.

---

## ⚙️ Alur Kerja Automasi (CI/CD)

Proyek ini menggunakan **Zero-Touch Deployment**. Kamu hanya perlu menulis kode dan melakukan *push* ke *branch* `main`. GitHub Actions akan mengurus sisanya.

### 1. Web Frontend & API Backend
Setiap kali ada `git push origin main` pada *repository* Web atau API:
1. GitHub Actions akan masuk ke VPS secara otomatis via SSH.
2. Menarik kode terbaru dari repositori.
3. Menginstal *dependencies* terbaru (`npm install`).
4. Untuk Web: Melakukan *build* produksi dan memindahkan file ke direktori publik.
5. Untuk API: Me- *restart* layanan PM2.
6. Perubahan akan langsung tayang (*live*) dalam waktu ~2 menit.

### 2. Android Mobile App & OTA Update
Setiap kali ada `git push origin main` pada *repository* Android:
1. GitHub Actions akan melakukan kompilasi (*build*) APK secara otomatis di *server* GitHub.
2. *Version Code* Android akan menggunakan nomor urut otomatis dari GitHub Actions (`github.run_number`). Tidak perlu mengubah `build.gradle.kts` secara manual.
3. APK hasil *build* akan dikirim otomatis ke folder *download* di VPS via SCP.
4. GitHub Actions akan menambahkan baris baru ke tabel `t_app_version` di database MySQL.
5. **Sistem OTA:** Pengguna yang membuka aplikasi versi lama akan secara otomatis mendapat notifikasi *pop-up* untuk mengunduh dan memperbarui aplikasi langsung dari server kita.

---

## 🔑 Kredensial & Secrets Lingkungan (Environment)

Agar automasi berjalan, repositori GitHub ini membutuhkan *Secrets* berikut yang dikonfigurasi pada menu **Settings > Secrets and variables > Actions**:

| Nama Secret | Deskripsi |
| :--- | :--- |
| `VPS_HOST` | Alamat IP dari VPS Produksi. |
| `VPS_USER` | *Username* SSH untuk login ke VPS (contoh: `root` atau `ubuntu`). |
| `VPS_SSH_KEY` | *Private Key* SSH khusus (Ed25519) untuk bot akses. |
| `VPS_BACKEND_PATH` | Lokasi absolut folder Backend di VPS (contoh: `/var/www/rekruitmen2-api`). |
| `VPS_WEB_PATH` | Lokasi absolut folder Web di VPS. |
| `VPS_DOWNLOAD_PATH` | Lokasi penyimpanan APK di VPS (contoh: `/var/www/pkar-web/downloads`). |
| `VPS_DB_USER` | *Username* MySQL untuk meng- *update* tabel OTA. |
| `VPS_DB_PASSWORD` | *Password* MySQL. |

*(Penting: Jika proyek dipindahkan ke akun perusahaan, semua Secrets di atas wajib diisi ulang).*

---

## 🛠️ Panduan Perawatan (Maintenance)

### Melakukan Rilis Wajib (Mandatory Update) Android
Secara standar, pengguna bisa menunda (klik "Nanti") saat ada pembaruan Android. Jika ada perbaikan *bug* fatal dan pengguna **wajib** memperbarui aplikasi, jalankan *query* SQL berikut di *database*:

```sql
UPDATE rekruitmen2.t_app_version 
SET is_mandatory = 1 
WHERE app_id = 'pkar_android' 
ORDER BY version_code DESC LIMIT 1;