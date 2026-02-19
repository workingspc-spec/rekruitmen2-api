const cron = require('node-cron');
const { google } = require('googleapis');
const db = require('../config/db');
const {
    parseTempatTanggal,
    parseSheetTimestamp,
    mapStatusNikah
} = require('../utils/dateParser');

const credentials = require('../../service-account.json');

// ✅ 3. Scheduler Overlap Protection (Flag Global)
let isRunning = false;

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Form Responses 1';

async function syncJob() {
    // ✅ 3. Cek apakah job sebelumnya masih jalan
    if (isRunning) {
        console.log('⏭ [Sync] Skip — Proses sebelumnya belum selesai (Overlap Protection)');
        return;
    }

    // ✅ 1. Guard SPREADSHEET_ID
    if (!SPREADSHEET_ID) {
        console.error('❌ [Sync] Fatal Error: SPREADSHEET_ID tidak ditemukan di environment (.env)');
        return;
    }

    isRunning = true; // Tandai proses dimulai
    console.log('⏳ [Sync] Memulai sinkronisasi otomatis...');

    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:Q`,
        });

        const rows = response.data.values;

        // ✅ 2. Validasi rows (Hardening)
        if (!Array.isArray(rows) || rows.length === 0) {
            console.log('✅ [Sync] Tidak ada data baru atau spreadsheet kosong.');
            return;
        }

        let newRecords = 0;
        let updatedRecords = 0;

        for (const row of rows) {
            if (!row || row.length < 3) continue;

            const [
                timestamp, nik, nama, gender, tempatTglLahir,
                alamatKtp, domisili, statusNikah, telp, posisi,
                baju, darah, email, pendidikan, pengalaman,
                gaji, cv
            ] = row;

            if (!nik || !nama) continue;

            const parsedTimestamp = parseSheetTimestamp(timestamp);
            const { tempat, tanggal } = parseTempatTanggal(tempatTglLahir);

            const sql = `
                INSERT INTO t_applicant (
                    applicant_timestamp, nik, nama_lengkap, jenis_kelamin, 
                    tempat_lahir, tanggal_lahir, alamat_ktp, domisili, 
                    status_pernikahan, nomor_telepon, email, posisi_dilamar, 
                    ukuran_baju, golongan_darah, pendidikan_terakhir, jurusan,
                    pengalaman_text, cv_link, ekspektasi_gaji, status_applicant
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW')
                ON DUPLICATE KEY UPDATE
                    nama_lengkap = VALUES(nama_lengkap),
                    jenis_kelamin = VALUES(jenis_kelamin),
                    tempat_lahir = VALUES(tempat_lahir),
                    tanggal_lahir = VALUES(tanggal_lahir),
                    alamat_ktp = VALUES(alamat_ktp),
                    domisili = VALUES(domisili),
                    status_pernikahan = VALUES(status_pernikahan),
                    nomor_telepon = VALUES(nomor_telepon),
                    email = VALUES(email),
                    posisi_dilamar = VALUES(posisi_dilamar),
                    ukuran_baju = VALUES(ukuran_baju),
                    golongan_darah = VALUES(golongan_darah),
                    pendidikan_terakhir = VALUES(pendidikan_terakhir),
                    jurusan = VALUES(jurusan),
                    pengalaman_text = VALUES(pengalaman_text),
                    cv_link = VALUES(cv_link),
                    ekspektasi_gaji = VALUES(ekspektasi_gaji),
                    updated_at = NOW()
            `; 

            const values = [
                parsedTimestamp || new Date(),
                nik, nama, gender || null,
                tempat, tanggal, alamatKtp || null, domisili || null,
                mapStatusNikah(statusNikah), telp || null, email || null, posisi || null,
                baju || null, darah || null, pendidikan || null, pendidikan || null,
                pengalaman || null, cv || null, gaji || null
            ];

            const [result] = await db.execute(sql, values);

            if (result.affectedRows === 1) {
                newRecords++;
            } else if (result.affectedRows === 2) {
                updatedRecords++;
            }
        }

        console.log(`✅ [Sync] Selesai. [Baru: ${newRecords}] [Update: ${updatedRecords}]`);

    } catch (error) {
        console.error('❌ [Sync] Error:', error.message);
    } finally {
        // ✅ Pastikan isRunning kembali false, apapun yang terjadi (error maupun sukses)
        isRunning = false;
    }
}

const startSyncJob = () => {
    cron.schedule('*/5 * * * *', syncJob);
    console.log('🚀 [Sync] Scheduler aktif (Safety Guard Enabled)');
};

module.exports = { startSyncJob, syncJob };