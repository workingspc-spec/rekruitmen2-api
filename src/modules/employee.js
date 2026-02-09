// src/modules/employee.js
const express = require('express');
const db = require('../config/db');
const router = express.Router();

/**
 * =========================================================
 * MODULE: EMPLOYEE (Karyawan Tetap)
 * =========================================================
 */

/**
 * 1. GET LIST KARYAWAN (dengan filter & search)
 */
router.get('/list', async (req, res) => {
    const { 
        search, 
        status_aktif, 
        status_kerja, 
        departemen, 
        bagian, 
        jabatan, 
        pendidikan,
        gender,
        sort_by 
    } = req.query;

    try {
        let sql = `
            SELECT 
                k.kar_nik,
                k.kar_nama,
                k.kar_bagian,
                k.kar_jab_kode,
                j.jab_nama,
                k.kar_dep_kode,
                k.kar_status_aktif,
                k.kar_status_kerja,
                k.kar_jenkel,
                DATE_FORMAT(k.kar_tgl_masuk, '%Y-%m-%d') as kar_tgl_masuk,
                k.kar_nik_atasan,
                a.kar_nama as nama_atasan,
                k.kar_pendidikanterakhir,
                k.kar_notelp,
                k.kar_email,
                CASE k.kar_status_kerja
                    WHEN 0 THEN 'Harian'
                    WHEN 1 THEN 'PKWT'
                    WHEN 2 THEN 'PKWTT'
                    ELSE 'Lainnya'
                END as status_kerja_label
            FROM tkaryawan k
            LEFT JOIN tjabatan j ON j.jab_kode = k.kar_jab_kode
            LEFT JOIN tkaryawan a ON a.kar_nik = k.kar_nik_atasan
            WHERE 1=1
        `;

        const params = [];

        // ✅ FILTER STATUS AKTIF
        if (status_aktif !== undefined) {
            sql += ` AND k.kar_status_aktif = ?`;
            params.push(parseInt(status_aktif));
        }

        // ✅ FILTER STATUS KERJA
        if (status_kerja !== undefined) {
            sql += ` AND k.kar_status_kerja = ?`;
            params.push(parseInt(status_kerja));
        }

        // ✅ FILTER DEPARTEMEN
        if (departemen) {
            sql += ` AND k.kar_dep_kode = ?`;
            params.push(departemen);
        }

        // ✅ FILTER BAGIAN
        if (bagian) {
            sql += ` AND k.kar_bagian LIKE ?`;
            params.push(`%${bagian}%`);
        }

        // ✅ FILTER JABATAN
        if (jabatan) {
            sql += ` AND k.kar_jab_kode = ?`;
            params.push(jabatan);
        }

        // ✅ FILTER PENDIDIKAN
        if (pendidikan) {
            sql += ` AND k.kar_pendidikanterakhir LIKE ?`;
            params.push(`%${pendidikan}%`);
        }

        // ✅ FILTER GENDER
        if (gender !== undefined) {
            sql += ` AND k.kar_jenkel = ?`;
            params.push(parseInt(gender));
        }

        // ✅ SEARCH GLOBAL
        if (search) {
            sql += ` AND (
                k.kar_nik LIKE ? OR 
                k.kar_nama LIKE ? OR 
                k.kar_noidentitas LIKE ? OR
                k.kar_notelp LIKE ? OR
                k.kar_email LIKE ?
            )`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
        }

        // ✅ SORTING
        switch (sort_by) {
            case 'nama_asc':
                sql += ` ORDER BY k.kar_nama ASC`;
                break;
            case 'nama_desc':
                sql += ` ORDER BY k.kar_nama DESC`;
                break;
            case 'tgl_masuk_terbaru':
                sql += ` ORDER BY k.kar_tgl_masuk DESC`;
                break;
            case 'tgl_masuk_terlama':
                sql += ` ORDER BY k.kar_tgl_masuk ASC`;
                break;
            case 'jabatan_asc':
                sql += ` ORDER BY j.jab_nama ASC`;
                break;
            default:
                sql += ` ORDER BY k.kar_nama ASC`;
        }

        const [rows] = await db.execute(sql, params);

        res.json({
            success: true,
            data: rows,
            count: rows.length
        });

    } catch (error) {
        console.error('❌ Error employee list:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data karyawan',
            error: error.message
        });
    }
});

/**
 * 2. GET DETAIL KARYAWAN (FULL INFO)
 */
router.get('/detail/:kar_nik', async (req, res) => {
    const { kar_nik } = req.params;

    if (!kar_nik) {
        return res.status(400).json({
            success: false,
            message: 'Parameter kar_nik diperlukan'
        });
    }

    try {
        const sql = `
            SELECT 
                k.*,
                j.jab_nama,
                a.kar_nama as nama_atasan,
                DATE_FORMAT(k.kar_tgllahir, '%Y-%m-%d') as kar_tgllahir,
                DATE_FORMAT(k.kar_tgl_masuk, '%Y-%m-%d') as kar_tgl_masuk,
                DATE_FORMAT(k.kar_tgl_keluar, '%Y-%m-%d') as kar_tgl_keluar,
                DATE_FORMAT(k.kar_tglpkwt1, '%Y-%m-%d') as kar_tglpkwt1,
                DATE_FORMAT(k.kar_tglpkwt2, '%Y-%m-%d') as kar_tglpkwt2,
                DATE_FORMAT(k.kar_tgllahir2, '%Y-%m-%d') as kar_tgllahir2,
                CASE k.kar_jenkel
                    WHEN 0 THEN 'Perempuan'
                    WHEN 1 THEN 'Laki-Laki'
                    ELSE 'Tidak Diketahui'
                END as kar_jenkel_label,
                CASE k.kar_status_kerja
                    WHEN 0 THEN 'Harian'
                    WHEN 1 THEN 'PKWT'
                    WHEN 2 THEN 'PKWTT'
                    ELSE 'Lainnya'
                END as status_kerja_label,
                CASE k.kar_status_aktif
                    WHEN 0 THEN 'Tidak Aktif'
                    WHEN 1 THEN 'Aktif'
                    ELSE 'Unknown'
                END as status_aktif_label,
                CASE k.kar_status_bpjs
                    WHEN 0 THEN 'Tidak Terdaftar'
                    WHEN 1 THEN 'Terdaftar'
                    ELSE 'Unknown'
                END as status_bpjs_label,
                TIMESTAMPDIFF(YEAR, k.kar_tgl_masuk, CURDATE()) as masa_kerja_tahun,
                TIMESTAMPDIFF(MONTH, k.kar_tgl_masuk, CURDATE()) % 12 as masa_kerja_bulan
            FROM tkaryawan k
            LEFT JOIN tjabatan j ON j.jab_kode = k.kar_jab_kode
            LEFT JOIN tkaryawan a ON a.kar_nik = k.kar_nik_atasan
            WHERE k.kar_nik = ?
        `;

        const [rows] = await db.execute(sql, [kar_nik]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Data karyawan tidak ditemukan'
            });
        }

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error('❌ Error employee detail:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil detail karyawan',
            error: error.message
        });
    }
});

/**
 * 3. GET EMPLOYEE STATS (untuk Dashboard)
 */
router.get('/stats', async (req, res) => {
    try {
        const sql = `
            SELECT 
                COUNT(*) as total_karyawan,
                SUM(CASE WHEN kar_status_aktif = 1 THEN 1 ELSE 0 END) as aktif,
                SUM(CASE WHEN kar_status_aktif = 0 THEN 1 ELSE 0 END) as tidak_aktif,
                SUM(CASE WHEN kar_jenkel = 1 THEN 1 ELSE 0 END) as laki_laki,
                SUM(CASE WHEN kar_jenkel = 0 THEN 1 ELSE 0 END) as perempuan,
                SUM(CASE WHEN kar_status_kerja = 1 THEN 1 ELSE 0 END) as pkwt,
                SUM(CASE WHEN kar_status_kerja = 2 THEN 1 ELSE 0 END) as pkwtt
            FROM tkaryawan
        `;

        const [rows] = await db.execute(sql);

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error('❌ Error employee stats:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil statistik karyawan',
            error: error.message
        });
    }
});

/**
 * 4. GET FILTER OPTIONS (untuk dropdown filter)
 */
router.get('/filter-options', async (req, res) => {
    try {
        // Get unique bagian
        const [bagianRows] = await db.execute(`
            SELECT DISTINCT kar_bagian as value, kar_bagian as label 
            FROM tkaryawan 
            WHERE kar_bagian IS NOT NULL AND kar_bagian != ''
            ORDER BY kar_bagian
        `);

        // Get unique pendidikan
        const [pendidikanRows] = await db.execute(`
            SELECT DISTINCT kar_pendidikanterakhir as value, kar_pendidikanterakhir as label 
            FROM tkaryawan 
            WHERE kar_pendidikanterakhir IS NOT NULL AND kar_pendidikanterakhir != ''
            ORDER BY kar_pendidikanterakhir
        `);

        // Get jabatan from tjabatan
        const [jabatanRows] = await db.execute(`
            SELECT jab_kode as value, jab_nama as label 
            FROM tjabatan 
            ORDER BY jab_nama
        `);

        res.json({
            success: true,
            data: {
                bagian: bagianRows,
                pendidikan: pendidikanRows,
                jabatan: jabatanRows,
                status_kerja: [
                    { value: 0, label: 'Harian' },
                    { value: 1, label: 'PKWT' },
                    { value: 2, label: 'PKWTT' }
                ],
                gender: [
                    { value: 0, label: 'Perempuan' },
                    { value: 1, label: 'Laki-Laki' }
                ]
            }
        });

    } catch (error) {
        console.error('❌ Error filter options:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil opsi filter',
            error: error.message
        });
    }
});

module.exports = router;