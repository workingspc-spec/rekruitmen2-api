const express = require('express');
const db = require('../config/db');
const { isHRD } = require('../middleware/authMiddleware');
const router = express.Router();

/**
 * =====================================================================
 * MODULE: MASTER DATA
 * =====================================================================
 */

// GET /api/master/jabatan
router.get('/jabatan', async (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT jab_kode, jab_nama FROM hrd2.tjabatan';
        const params = [];
        if (search) {
            query += ' WHERE jab_nama LIKE ?';
            params.push(`%${search}%`);
        }
        const [rows] = await db.execute(query, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error Get Jabatan:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data jabatan', error: error.message });
    }
});

// ── BAGIAN ────────────────────────────────────────────────────────────────────

/**
 * GET /api/master/bagian
 *
 * Menggabungkan dua sumber:
 *   1. rekruitmen2.tbagian (master baru — bisa ditambah HRD kapan saja)
 *   2. hrd2.tkaryawan.kar_bagian (legacy — untuk backward compat)
 *
 * Hasilnya di-deduplicate berdasarkan nama (case-insensitive via LOWER).
 * Urutkan A–Z. Hanya bagian aktif dari tbagian yang ditampilkan.
 */
router.get('/bagian', async (req, res) => {
    try {
        const { search } = req.query;

        // Ambil dari master baru (rekruitmen2.tbagian)
        let masterQuery = `
            SELECT bag_nama AS bagian
            FROM rekruitmen2.tbagian
            WHERE bag_active = 1
        `;
        const masterParams = [];
        if (search) {
            masterQuery += ' AND bag_nama LIKE ?';
            masterParams.push(`%${search}%`);
        }

        // Ambil dari legacy tkaryawan (fallback / pelengkap)
        let legacyQuery = `
            SELECT DISTINCT TRIM(kar_bagian) AS bagian
            FROM hrd2.tkaryawan
            WHERE kar_bagian IS NOT NULL AND TRIM(kar_bagian) != ''
        `;
        const legacyParams = [];
        if (search) {
            legacyQuery += ' AND kar_bagian LIKE ?';
            legacyParams.push(`%${search}%`);
        }

        const [[masterRows], [legacyRows]] = await Promise.all([
            db.execute(masterQuery, masterParams),
            db.execute(legacyQuery, legacyParams),
        ]);

        // Gabung & deduplicate (case-insensitive)
        const seen = new Set();
        const combined = [];
        for (const row of [...masterRows, ...legacyRows]) {
            const key = (row.bagian || '').trim().toLowerCase();
            if (key && !seen.has(key)) {
                seen.add(key);
                combined.push({ kar_bagian: row.bagian.trim() });
            }
        }

        // Sort A–Z
        combined.sort((a, b) => a.kar_bagian.localeCompare(b.kar_bagian, 'id'));

        res.json({ success: true, data: combined });
    } catch (error) {
        console.error('Error Get Bagian:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data bagian', error: error.message });
    }
});

/**
 * GET /api/master/bagian/list
 * HRD only — lihat daftar master tbagian (termasuk status aktif/nonaktif)
 */
router.get('/bagian/list', isHRD, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT bag_id, bag_nama, bag_active, bag_created_at, bag_created_by
            FROM rekruitmen2.tbagian
            ORDER BY bag_nama ASC
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/master/bagian
 * HRD only — tambah bagian baru ke master
 * Body: { bag_nama: string }
 */
router.post('/bagian', isHRD, async (req, res) => {
    const { bag_nama } = req.body;
    const userKode = req.user?.user_kode;

    if (!bag_nama || !bag_nama.trim()) {
        return res.status(400).json({ success: false, message: 'Nama bagian wajib diisi' });
    }
    if (bag_nama.trim().length > 100) {
        return res.status(400).json({ success: false, message: 'Nama bagian maksimal 100 karakter' });
    }

    try {
        await db.execute(
            `INSERT INTO rekruitmen2.tbagian (bag_nama, bag_created_by) VALUES (?, ?)`,
            [bag_nama.trim(), userKode]
        );
        res.json({ success: true, message: 'Bagian berhasil ditambahkan' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Nama bagian sudah ada' });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * PATCH /api/master/bagian/:id
 * HRD only — ubah nama atau status aktif bagian
 * Body: { bag_nama?: string, bag_active?: 0|1 }
 */
router.patch('/bagian/:id', isHRD, async (req, res) => {
    const { id } = req.params;
    const { bag_nama, bag_active } = req.body;

    const updates = [];
    const params  = [];

    if (bag_nama !== undefined) {
        if (!bag_nama.trim()) return res.status(400).json({ success: false, message: 'Nama tidak boleh kosong' });
        updates.push('bag_nama = ?');
        params.push(bag_nama.trim());
    }
    if (bag_active !== undefined) {
        updates.push('bag_active = ?');
        params.push(bag_active ? 1 : 0);
    }
    if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'Tidak ada field yang diubah' });
    }

    params.push(id);
    try {
        const [result] = await db.execute(
            `UPDATE rekruitmen2.tbagian SET ${updates.join(', ')} WHERE bag_id = ?`,
            params
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Bagian tidak ditemukan' });
        res.json({ success: true, message: 'Bagian berhasil diupdate' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Nama bagian sudah ada' });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── BYPASS USERS ──────────────────────────────────────────────────────────────

/**
 * GET /api/master/bypass-users
 * HRD only — lihat semua NIK yang bypass persetujuan atasan
 */
router.get('/bypass-users', isHRD, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                b.bu_nik,
                b.bu_keterangan,
                b.bu_active,
                b.bu_created_at,
                b.bu_created_by,
                k.kar_nama,
                k.kar_bagian,
                j.jab_nama
            FROM rekruitmen2.t_bypass_users b
            LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = b.bu_nik
            LEFT JOIN hrd2.tjabatan j  ON j.jab_kode = k.kar_jab_kode
            ORDER BY b.bu_active DESC, k.kar_nama ASC
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/master/bypass-users
 * HRD only — daftarkan NIK sebagai bypass user
 * Body: { bu_nik: string, bu_keterangan?: string }
 */
router.post('/bypass-users', isHRD, async (req, res) => {
    const { bu_nik, bu_keterangan } = req.body;
    const createdBy = req.user?.user_kode;

    if (!bu_nik || !bu_nik.trim()) {
        return res.status(400).json({ success: false, message: 'NIK wajib diisi' });
    }

    try {
        // Verifikasi NIK ada di hrd2.tkaryawan (opsional tapi bagus untuk UX)
        const [karCheck] = await db.execute(
            'SELECT kar_nama FROM hrd2.tkaryawan WHERE kar_Nik = ?',
            [bu_nik.trim()]
        );
        if (karCheck.length === 0) {
            return res.status(404).json({ success: false, message: `NIK ${bu_nik} tidak ditemukan di data karyawan` });
        }

        await db.execute(
            `INSERT INTO rekruitmen2.t_bypass_users (bu_nik, bu_keterangan, bu_active, bu_created_by)
             VALUES (?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE
                bu_keterangan = VALUES(bu_keterangan),
                bu_active     = 1,
                bu_created_by = VALUES(bu_created_by)`,
            [bu_nik.trim(), bu_keterangan?.trim() || null, createdBy]
        );

        res.json({
            success: true,
            message: `${karCheck[0].kar_nama} berhasil didaftarkan sebagai bypass user`
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * PATCH /api/master/bypass-users/:nik
 * HRD only — aktifkan / nonaktifkan bypass user
 * Body: { bu_active: 0|1, bu_keterangan?: string }
 */
router.patch('/bypass-users/:nik', isHRD, async (req, res) => {
    const { nik } = req.params;
    const { bu_active, bu_keterangan } = req.body;

    if (bu_active === undefined) {
        return res.status(400).json({ success: false, message: 'bu_active (0 atau 1) wajib diisi' });
    }

    try {
        const updates = ['bu_active = ?'];
        const params  = [bu_active ? 1 : 0];

        if (bu_keterangan !== undefined) {
            updates.push('bu_keterangan = ?');
            params.push(bu_keterangan?.trim() || null);
        }
        params.push(nik);

        const [result] = await db.execute(
            `UPDATE rekruitmen2.t_bypass_users SET ${updates.join(', ')} WHERE bu_nik = ?`,
            params
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'NIK tidak ditemukan di daftar bypass' });
        }
        res.json({
            success: true,
            message: bu_active ? 'Bypass diaktifkan' : 'Bypass dinonaktifkan'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * DELETE /api/master/bypass-users/:nik
 * HRD only — hapus permanen dari daftar bypass
 */
router.delete('/bypass-users/:nik', isHRD, async (req, res) => {
    const { nik } = req.params;
    try {
        const [result] = await db.execute(
            'DELETE FROM rekruitmen2.t_bypass_users WHERE bu_nik = ?',
            [nik]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'NIK tidak ditemukan' });
        }
        res.json({ success: true, message: 'Bypass user dihapus' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── LAINNYA ───────────────────────────────────────────────────────────────────

// GET /api/master/cari-jabatan
router.get('/cari-jabatan', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT jab_kode, jab_nama FROM hrd2.tjabatan');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error Cari Jabatan:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data jabatan', error: error.message });
    }
});

/**
 * GET /api/master/holidays
 */
router.get('/holidays', async (req, res) => {
    try {
        const requestedYear = parseInt(req.query.year) || null;
        const currentYear   = new Date().getFullYear();

        let yearFrom, yearTo;
        if (requestedYear) {
            yearFrom = requestedYear;
            yearTo   = requestedYear;
        } else {
            yearFrom = currentYear;
            yearTo   = currentYear + 1;
        }

        const [rows] = await db.execute(
            `SELECT DATE_FORMAT(hl_tanggal, '%Y-%m-%d') AS date
             FROM hrd2.tharilibur
             WHERE hl_status = 1
               AND YEAR(hl_tanggal) BETWEEN ? AND ?
             ORDER BY hl_tanggal ASC`,
            [yearFrom, yearTo]
        );

        res.json({
            success: true,
            data: rows.map(r => r.date),
            meta: { yearFrom, yearTo, count: rows.length }
        });
    } catch (error) {
        console.error('Error Get Holidays:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data libur', error: error.message });
    }
});

module.exports = router;