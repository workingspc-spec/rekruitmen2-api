const express = require('express');
const db = require('../config/db');
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

// GET /api/master/bagian
router.get('/bagian', async (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT DISTINCT kar_bagian FROM hrd2.tkaryawan';
        const params = [];
        if (search) {
            query += ' WHERE kar_bagian LIKE ?';
            params.push(`%${search}%`);
        }
        const [rows] = await db.execute(query, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error Get Bagian:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data bagian', error: error.message });
    }
});

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
 * Mengembalikan daftar tanggal libur dari tharilibur.
 * Query param:
 *   - year (opsional): tahun spesifik, mis. ?year=2026
 *   - Jika tidak ada, kembalikan tahun ini + tahun depan (cukup untuk validasi form)
 *
 * hl_status = 1  → hari libur umum (termasuk Minggu)
 * Endpoint ini tidak butuh auth karena hanya data kalender publik.
 */
router.get('/holidays', async (req, res) => {
    try {
        const requestedYear = parseInt(req.query.year) || null;
        const currentYear = new Date().getFullYear();

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