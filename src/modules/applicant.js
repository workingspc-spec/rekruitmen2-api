// src/modules/applicant.js
const express = require('express');
const db = require('../config/db');
const { authenticate, isHRD } = require('../middleware/authMiddleware'); // ✅ IMPORT
const router = express.Router();

/**
 * =====================================================================
 * MODULE: APPLICANT MANAGEMENT
 * Mengelola data pelamar dari Google Form (t_applicant)
 * 
 * ✅ SECURITY UPDATE:
 * - PUBLIC: /job-openings, /submit-form
 * - HRD ONLY: /list, /detail, /status, /stats, /rekruitmen/*
 * =====================================================================
 */

// =====================================================================
// SECTION 1: PUBLIC ENDPOINTS (No Auth Required)
// =====================================================================

/**
 * GET /api/applicant/job-openings
 * ✅ PUBLIC - List lowongan yang sudah approve HRD (untuk pelamar)
 */
router.get('/job-openings', async (req, res) => {
    const { filter } = req.query;
    
    try {
        let sql = `
            SELECT 
                p.tpk_nomor, 
                j.jab_nama, 
                p.tpk_bagian, 
                p.tpk_jumlah, 
                p.tpk_approveHRD,
                DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
                DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
                (SELECT COUNT(*) FROM tlistpelamar WHERE tlp_tpk_nomor = p.tpk_nomor) as jmlpelamar
            FROM tpermintaankaryawan p
            INNER JOIN tjabatan j ON j.jab_kode = p.tpk_jab_kode 
            WHERE p.tpk_approveHRD = 1
        `;

        if (filter === 'belum') {
            sql += ` HAVING jmlpelamar = 0`;
        } else if (filter === 'sudah') {
            sql += ` HAVING jmlpelamar > 0`;
        }
        
        sql += ` ORDER BY p.tpk_tanggal DESC`;
        
        const [rows] = await db.execute(sql);
        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error job-openings:', error.message);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data lowongan', 
            error: error.message 
        });
    }
});

/**
 * POST /api/applicant/submit-form
 * ✅ PUBLIC - Endpoint untuk menerima data dari Google Forms
 */
router.post('/submit-form', async (req, res) => {
    const {
        timestamp,
        nik, nama, jenis_kelamin, tempat_lahir, tanggal_lahir,
        alamat_ktp, domisili, status_kawin, telp, email, posisi,
        ukuran_baju, pendidikan, jurusan, pengalaman, cv, gaji, golongan_darah
    } = req.body;

    // Validasi field wajib
    if (!nik || !nama || !jenis_kelamin) {
        return res.status(400).json({
            success: false,
            message: 'NIK, Nama, dan Jenis Kelamin wajib diisi',
            received: { nik, nama, jenis_kelamin }
        });
    }

    try {
        // Cek duplikasi NIK
        const [checkNik] = await db.execute(
            'SELECT applicant_id FROM t_applicant WHERE nik = ?',
            [nik]
        );

        if (checkNik.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'NIK sudah terdaftar dalam sistem'
            });
        }

        // Insert ke t_applicant
        const sql = `
            INSERT INTO t_applicant (
                applicant_timestamp,
                nik, nama_lengkap, jenis_kelamin, tempat_lahir, tanggal_lahir,
                alamat_ktp, domisili, status_pernikahan, nomor_telepon, email,
                posisi_dilamar, ukuran_baju, golongan_darah, pendidikan_terakhir, jurusan,
                pengalaman_text, cv_link, ekspektasi_gaji, status_applicant,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', NOW(), NOW())
        `;

        const ts = timestamp ? new Date(timestamp) : new Date();

        const [result] = await db.execute(sql, [
            ts,
            nik, nama, jenis_kelamin, tempat_lahir || null, tanggal_lahir || null,
            alamat_ktp || null, domisili || null, status_kawin || null,
            telp || null, email || null, posisi || null,
            ukuran_baju || null, golongan_darah || null,
            pendidikan || null, jurusan || null,
            pengalaman || null, cv || null, gaji || null
        ]);

        res.status(201).json({
            success: true,
            message: 'Data pelamar berhasil disimpan',
            data: {
                applicant_id: result.insertId,
                nik: nik,
                nama: nama
            }
        });

    } catch (error) {
        console.error('❌ Error submit form:', error.message);
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({
                success: false,
                message: 'NIK sudah terdaftar'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Gagal menyimpan data pelamar',
            error: error.message
        });
    }
});

// =====================================================================
// SECTION 2: PROTECTED ENDPOINTS (✅ HRD ONLY)
// =====================================================================

/**
 * GET /api/applicant/list
 * 🔒 HRD ONLY - List semua applicant dari t_applicant
 */
router.get('/list', authenticate, isHRD, async (req, res) => {
    const { search, status, posisi, sort_by } = req.query;

    try {
        let sql = `
            SELECT 
                applicant_id, nik, nama_lengkap, jenis_kelamin,
                tempat_lahir, DATE_FORMAT(tanggal_lahir, '%Y-%m-%d') as tanggal_lahir,
                alamat_ktp, domisili, status_pernikahan,
                nomor_telepon, email, posisi_dilamar,
                ukuran_baju, golongan_darah, pendidikan_terakhir, jurusan,
                pengalaman_text, cv_link, ekspektasi_gaji, status_applicant,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') as created_at,
                CASE status_applicant
                    WHEN 'NEW' THEN 'Pelamar Baru'
                    WHEN 'SCREENING' THEN 'Dalam Screening'
                    WHEN 'INTERVIEW' THEN 'Tahap Interview'
                    WHEN 'HIRED' THEN 'Diterima'
                    WHEN 'REJECT' THEN 'Ditolak'
                    ELSE 'Unknown'
                END as status_label
            FROM t_applicant
            WHERE 1=1
        `;

        const params = [];

        if (status) {
            sql += ` AND status_applicant = ?`;
            params.push(status);
        }

        if (posisi) {
            sql += ` AND posisi_dilamar LIKE ?`;
            params.push(`%${posisi}%`);
        }

        if (search) {
            sql += ` AND (
                nama_lengkap LIKE ? OR nik LIKE ? OR 
                email LIKE ? OR nomor_telepon LIKE ? OR posisi_dilamar LIKE ?
            )`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
        }

        switch (sort_by) {
            case 'nama_asc': sql += ` ORDER BY nama_lengkap ASC`; break;
            case 'nama_desc': sql += ` ORDER BY nama_lengkap DESC`; break;
            case 'terbaru': sql += ` ORDER BY created_at DESC`; break;
            case 'terlama': sql += ` ORDER BY created_at ASC`; break;
            default: sql += ` ORDER BY created_at DESC`;
        }

        const [rows] = await db.execute(sql, params);

        res.json({
            success: true,
            data: rows,
            count: rows.length
        });

    } catch (error) {
        console.error('❌ Error get applicant list:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data pelamar',
            error: error.message
        });
    }
});

/**
 * GET /api/applicant/detail/:applicant_id
 * 🔒 HRD ONLY - Detail applicant
 */
router.get('/detail/:applicant_id', authenticate, isHRD, async (req, res) => {
    const { applicant_id } = req.params;

    if (!applicant_id || applicant_id === 'undefined') {
        return res.status(400).json({
            success: false,
            message: 'Parameter applicant_id diperlukan'
        });
    }

    try {
        const sql = `
            SELECT 
                applicant_id, nik, nama_lengkap, jenis_kelamin,
                tempat_lahir, DATE_FORMAT(tanggal_lahir, '%Y-%m-%d') as tanggal_lahir,
                alamat_ktp, domisili, status_pernikahan, kewarganegaraan, agama, status_tinggal,
                nomor_telepon, email, posisi_dilamar, ukuran_baju, golongan_darah,
                pendidikan_terakhir, jurusan, pengalaman_text, cv_link, ekspektasi_gaji,
                status_applicant,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') as created_at,
                DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') as updated_at,
                CASE status_applicant
                    WHEN 'NEW' THEN 'Pelamar Baru'
                    WHEN 'SCREENING' THEN 'Dalam Screening'
                    WHEN 'INTERVIEW' THEN 'Tahap Interview'
                    WHEN 'HIRED' THEN 'Diterima'
                    WHEN 'REJECT' THEN 'Ditolak'
                    ELSE 'Unknown'
                END as status_label
            FROM t_applicant
            WHERE applicant_id = ?
        `;

        const [rows] = await db.execute(sql, [applicant_id]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Pelamar tidak ditemukan'
            });
        }

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error('❌ Error get applicant detail:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil detail pelamar',
            error: error.message
        });
    }
});

/**
 * PUT /api/applicant/status
 * 🔒 HRD ONLY - Update status applicant
 */
router.put('/status', authenticate, isHRD, async (req, res) => {
    const { applicant_id, status } = req.body;
    const validStatuses = ['NEW', 'SCREENING', 'INTERVIEW', 'HIRED', 'REJECT'];

    if (!applicant_id) {
        return res.status(400).json({
            success: false,
            message: 'Parameter applicant_id diperlukan'
        });
    }

    if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: 'Status tidak valid',
            valid_statuses: validStatuses
        });
    }

    try {
        const sql = `
            UPDATE t_applicant 
            SET status_applicant = ?, updated_at = NOW()
            WHERE applicant_id = ?
        `;

        const [result] = await db.execute(sql, [status, applicant_id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'Pelamar tidak ditemukan'
            });
        }

        res.json({
            success: true,
            message: 'Status berhasil diupdate'
        });

    } catch (error) {
        console.error('❌ Error update status:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal update status',
            error: error.message
        });
    }
});

/**
 * GET /api/applicant/stats
 * 🔒 HRD ONLY - Statistik applicant untuk dashboard
 */
router.get('/stats', authenticate, isHRD, async (req, res) => {
    try {
        const sql = `
            SELECT 
                COUNT(*) as total_applicant,
                SUM(CASE WHEN status_applicant = 'NEW' THEN 1 ELSE 0 END) as new_applicant,
                SUM(CASE WHEN status_applicant = 'SCREENING' THEN 1 ELSE 0 END) as screening,
                SUM(CASE WHEN status_applicant = 'INTERVIEW' THEN 1 ELSE 0 END) as interview,
                SUM(CASE WHEN status_applicant = 'HIRED' THEN 1 ELSE 0 END) as hired,
                SUM(CASE WHEN status_applicant = 'REJECT' THEN 1 ELSE 0 END) as rejected
            FROM t_applicant
        `;

        const [rows] = await db.execute(sql);

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error('❌ Error get stats:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil statistik',
            error: error.message
        });
    }
});

// =====================================================================
// SECTION 3: LEGACY REKRUITMEN (🔒 HRD ONLY - Read-Only)
// =====================================================================

/**
 * GET /api/applicant/rekruitmen/list
 * 🔒 HRD ONLY - List kandidat dari trekruitmen (legacy)
 */
router.get('/rekruitmen/list', authenticate, isHRD, async (req, res) => {
    const { search } = req.query;

    try {
        let sql = `
            SELECT 
                r.rkt_nomor, r.rkt_nama,
                IF(r.rkt_jenkel=1, 'Laki-Laki', 'Perempuan') as rkt_jenkel_str,
                r.rkt_jenkel, r.rkt_alamat, r.rkt_telp, r.rkt_identitas,
                r.rkt_tempatlahir, DATE_FORMAT(r.rkt_tgllahir, '%Y-%m-%d') as rkt_tgllahir,
                r.rkt_email, r.rkt_posisi, r.rkt_status, r.rkt_pendidikanterakhir, r.rkt_jurusan,
                (SELECT COUNT(*) FROM trekruitmenpengalaman WHERE rktp_rkt_nomor = r.rkt_nomor) as jml_pengalaman
            FROM trekruitmen r
            WHERE r.rkt_status <> 1
        `;

        const params = [];
        
        if (search) {
            sql += ` AND (
                r.rkt_posisi LIKE ? OR r.rkt_alamat LIKE ? OR 
                r.rkt_nama LIKE ? OR r.rkt_jurusan LIKE ? OR
                r.rkt_pendidikanterakhir LIKE ?
            )`;
            const searchKw = `%${search}%`;
            params.push(searchKw, searchKw, searchKw, searchKw, searchKw);
        }

        sql += ` ORDER BY r.rkt_nama ASC`;

        const [rows] = await db.execute(sql, params);
        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error rekruitmen list:', error.message);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil data kandidat legacy', 
            error: error.message 
        });
    }
});

/**
 * GET /api/applicant/rekruitmen/detail/:rkt_nomor
 * 🔒 HRD ONLY - Detail kandidat dari trekruitmen
 */
router.get('/rekruitmen/detail', authenticate, isHRD, async (req, res) => {
    const { rkt_nomor } = req.query;

    if (!rkt_nomor || rkt_nomor === 'undefined') {
        return res.status(400).json({ 
            success: false,
            message: 'Parameter rkt_nomor diperlukan' 
        });
    }

    try {
        const sql = `
            SELECT 
                rkt_nomor, rkt_tanggal, rkt_nama, rkt_jenkel,
                IF(rkt_jenkel=1, 'Laki-Laki', 'Perempuan') as rkt_jenkel_str,
                rkt_alamat, rkt_telp, rkt_identitas, rkt_tempatlahir,
                DATE_FORMAT(rkt_tgllahir, '%Y-%m-%d') as rkt_tgllahir,
                rkt_ibukandung, rkt_email, rkt_status, rkt_posisi,
                rkt_warganegara, rkt_agama, rkt_status_kawin, rkt_gol_darah,
                rkt_status_tinggal, rkt_pendidikanterakhir, rkt_keterangan, rkt_jurusan
            FROM trekruitmen 
            WHERE rkt_nomor = ?
        `;

        const [rows] = await db.execute(sql, [rkt_nomor]);
        
        if (rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'Kandidat tidak ditemukan' 
            });
        }

        res.json({ success: true, data: rows[0] });

    } catch (error) {
        console.error('❌ Error kandidat detail:', error.message);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil detail kandidat', 
            error: error.message 
        });
    }
});

/**
 * GET /api/applicant/rekruitmen/experience/:rkt_nomor
 * 🔒 HRD ONLY - Pengalaman kerja dari trekruitmenpengalaman
 */
router.get('/rekruitmen/experience/:rkt_nomor', authenticate, isHRD, async (req, res) => {
    const { rkt_nomor } = req.params;

    if (!rkt_nomor || rkt_nomor === 'undefined') {
        return res.status(400).json({ 
            success: false,
            message: 'Parameter rkt_nomor diperlukan' 
        });
    }

    try {
        const sql = `
            SELECT 
                rktp_rkt_nomor, rktp_namaperusahaan, rktp_bidangusaha,
                rktp_kota, rktp_jabatanterakhir,
                DATE_FORMAT(rktp_tglmasuk, '%Y-%m-%d') as rktp_tgl_masuk,
                DATE_FORMAT(rktp_tglkeluar, '%Y-%m-%d') as rktp_tgl_keluar
            FROM trekruitmenpengalaman 
            WHERE rktp_rkt_nomor = ?
            ORDER BY rktp_tglmasuk DESC
        `;

        const [rows] = await db.execute(sql, [rkt_nomor]);
        
        res.status(200).json({ 
            success: true, 
            data: rows,
            count: rows.length 
        });

    } catch (error) {
        console.error('❌ Error experience:', error.message);
        res.status(500).json({ 
            success: false,
            message: 'Gagal mengambil pengalaman kerja', 
            error: error.message 
        });
    }
});

module.exports = router;