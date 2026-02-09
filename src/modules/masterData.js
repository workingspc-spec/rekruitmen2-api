const express = require('express');
const db = require('../config/db');
const router = express.Router();

/**
 * =====================================================================
 * MODULE: MASTER DATA
 * Migrasi dari: uListJabatan.pas, uListBagian.pas, uCariJabatan.pas
 * =====================================================================
 */

// ---------------------------------------------------------------------
// 1. GET LIST JABATAN (Pengganti uListJabatan.pas)
// ---------------------------------------------------------------------
router.get('/jabatan', async (req, res) => {
    try {
        const { search } = req.query;
        
        let query = 'SELECT jab_kode, jab_nama FROM rekruitmen.tjabatan';
        let params = [];

        // Logic sesuai Delphi:
        // - FormShow: tanpa WHERE
        // - Button1Click: dengan WHERE jab_nama LIKE
        if (search) {
            query += ' WHERE jab_nama LIKE ?';
            params.push(`%${search}%`);
        }

        const [rows] = await db.execute(query, params);

        res.json({
            success: true,
            data: rows  // [{jab_kode: '...', jab_nama: '...'}, ...]
        });

    } catch (error) {
        console.error('Error Get Jabatan:', error);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data jabatan', 
            error: error.message 
        });
    }
});

// ---------------------------------------------------------------------
// 2. GET LIST BAGIAN (Pengganti uListBagian.pas)
// ---------------------------------------------------------------------
router.get('/bagian', async (req, res) => {
    try {
        const { search } = req.query;

        let query = 'SELECT DISTINCT kar_bagian FROM rekruitmen.tkaryawan';
        let params = [];

        // Logic sesuai Delphi:
        // - FormShow: SELECT distinct kar_bagian (tanpa WHERE)
        // - Button1Click: WHERE kar_bagian LIKE
        if (search) {
            query += ' WHERE kar_bagian LIKE ?';
            params.push(`%${search}%`);
        }

        const [rows] = await db.execute(query, params);

        res.json({
            success: true,
            data: rows  // [{kar_bagian: '...'}, ...]
        });

    } catch (error) {
        console.error('Error Get Bagian:', error);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data bagian',
            error: error.message 
        });
    }
});

// ---------------------------------------------------------------------
// 3. GET CARI JABATAN (Pengganti uCariJabatan.pas)
// ---------------------------------------------------------------------
// Note: Query asli di uCariJabatan.pas ada typo (jaba_nama),
// tapi kita ikuti yang benar: jab_nama
router.get('/cari-jabatan', async (req, res) => {
    try {
        // Query sesuai FirstShow procedure di uCariJabatan.pas
        // Original: SELECT jab_kode,jaba_nama from tjabatan (ada typo)
        // Yang benar: SELECT jab_kode,jab_nama from tjabatan
        const query = 'SELECT jab_kode, jab_nama FROM rekruitmen.tjabatan';
        
        const [rows] = await db.execute(query);

        res.json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error('Error Cari Jabatan:', error);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data jabatan',
            error: error.message 
        });
    }
});

module.exports = router;