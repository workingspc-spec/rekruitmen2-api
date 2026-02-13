// src/modules/recruitment.js
const express = require('express');
const db = require('../config/db');
const router = express.Router();
const { authenticate, isHRD, isManager } = require('../middleware/authMiddleware');
const { addWorkdays, countWorkdays, formatDateSafe } = require('../utils/workdayCalculator');

/**
 * =====================================================================
 * VALIDASI DINAMIS (MENGGUNAKAN DATABASE)
 * =====================================================================
 */
async function validateTglButuhFromDB(connection, jab_kode, tgl_butuh) {
    try {
        const [rows] = await connection.execute(
            `SELECT COALESCE(jlt.jlt_min_days, 7) as min_days, COALESCE(jlt.jlt_is_flexible, 0) as is_flexible
             FROM tjabatan j
             LEFT JOIN job_lead_time_master jlt ON jlt.jlt_job_code = j.jab_kode AND jlt.jlt_active = 1
             WHERE j.jab_kode = ?`,
            [jab_kode]
        );

        if (rows.length === 0) return { valid: false, message: 'Jabatan tidak ditemukan' };

        const { min_days, is_flexible } = rows[0];
        if (is_flexible === 1) return { valid: true };

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const minDateObj = addWorkdays(tomorrow, min_days);

        // 1. FIX: Parsing input tanpa bias UTC
        const [y, m, d] = tgl_butuh.split('-').map(Number);
        const requestedDate = new Date(y, m - 1, d, 0, 0, 0, 0);

        // 2. ✅ FIX: Gunakan formatDateSafe alih-alih manual formatting
        const minDateStr = formatDateSafe(minDateObj);

        if (requestedDate < minDateObj) {
            return {
                valid: false,
                message: `Tanggal butuh untuk jabatan ini minimal ${min_days} hari kerja dari besok. Tanggal minimal: ${minDateStr}`,
                minDate: minDateStr
            };
        }

        return { valid: true, minDate: minDateStr };

    } catch (error) {
        return { valid: false, message: error.message };
    }
}

/**
 * GET /api/recruitment/jabatan-rules
 * ✅ Ambil rules dari database
 */
router.get('/jabatan-rules', authenticate, async (req, res) => {
    try {
        const sql = `
            SELECT 
                j.jab_kode,
                j.jab_nama,
                COALESCE(jlt.jlt_min_days, 7) as min_days,
                jlt.jlt_max_days as max_days,
                COALESCE(jlt.jlt_is_flexible, 0) as is_flexible,
                CASE 
                    WHEN jlt.jlt_is_flexible = 1 THEN 'Fleksibel'
                    ELSE CONCAT('Minimal ', COALESCE(jlt.jlt_min_days, 7), ' hari kerja')
                END as label
            FROM tjabatan j
            LEFT JOIN job_lead_time_master jlt ON jlt.jlt_job_code = j.jab_kode AND jlt.jlt_active = 1
            ORDER BY j.jab_nama
        `;

        const [rows] = await db.execute(sql);

        res.json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error('❌ Error jabatan-rules:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil aturan jabatan',
            error: error.message
        });
    }
});

/**
 * GET /api/recruitment/my-requests
 */
router.get('/my-requests', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd; // Ambil status HRD dari token

    try {
        // Jika HRD, ambil semua. Jika bukan, ambil milik sendiri.
        const whereClause = is_hrd ? '1=1' : 'p.tpk_peminta = ?';
        const params = is_hrd ? [] : [user_kode];
        const query = `
            SELECT 
                p.tpk_nomor, 
                j.jab_nama, 
                p.tpk_bagian, 
                p.tpk_jumlah,
                p.tpk_approveatasan,
                p.tpk_approveHRD,
                CASE 
                    WHEN p.tpk_approveHRD = 1 THEN 'APPROVED HRD'
                    WHEN p.tpk_approveatasan = 1 THEN 'APPROVED ATASAN'
                    WHEN p.tpk_approveatasan = 2 THEN 'REJECTED ATASAN'
                    ELSE 'BLM APPROVE'
                END as status,
                DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
                DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
                DATE_FORMAT(p.tpk_tgl_approveatasan, '%Y-%m-%d') as tgl_approve_atasan,
                DATE_FORMAT(p.tpk_tgl_approveHRD, '%Y-%m-%d') as tgl_approve_hrd,
                (SELECT COUNT(*) FROM tlistpelamar WHERE tlp_tpk_nomor = p.tpk_nomor) as jml_pelamar,
                sla.sla_final_target_date,
                sla.sla_source,
                sla.sla_status
            FROM tpermintaankaryawan p
            INNER JOIN tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            WHERE ${whereClause} 
            ORDER BY p.tpk_tanggal DESC
        `;

        const [rows] = await db.execute(query, params);
        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error my-requests:', error.message);
        res.status(500).json({ 
            success: false,
            message: 'Error get requests', 
            error: error.message 
        });
    }
});

/**
 * GET /api/recruitment/detail
 */
router.get('/detail', authenticate, async (req, res) => {
    const { nomor } = req.query;

    if (!nomor) {
        return res.status(400).json({ 
            success: false,
            message: 'Parameter nomor diperlukan' 
        });
    }

    try {
        const [rows] = await db.execute(
            `SELECT 
                t.tpk_nomor,
                t.tpk_peminta,
                DATE_FORMAT(t.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
                t.tpk_jab_kode,
                t.tpk_bagian,
                DATE_FORMAT(t.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
                t.tpk_jumlah,
                t.tpk_alasan,
                t.tpk_alasanlain,
                t.tpk_keterangan,
                t.tpk_keterangan2,
                t.tpk_keterangan3,
                t.tpk_keterangan4,
                t.tpk_keterangan5,
                t.tpk_keterangan6,
                t.tpk_keterangan7,
                t.tpk_keterangan8,
                t.tpk_keterangan9,
                t.tpk_keterangan10,
                t.tpk_spesifikasi,
                t.tpk_spesifikasi2,
                t.tpk_spesifikasi3,
                t.tpk_spesifikasi4,
                t.tpk_spesifikasi5,
                t.tpk_spesifikasi6,
                t.tpk_spesifikasi7,
                t.tpk_spesifikasi8,
                t.tpk_spesifikasi9,
                t.tpk_spesifikasi10,
                t.tpk_approveatasan,
                DATE_FORMAT(t.tpk_tgl_approveatasan, '%Y-%m-%d') as tpk_tgl_approveatasan,
                t.tpk_approveHRD,
                DATE_FORMAT(t.tpk_tgl_approveHRD, '%Y-%m-%d') as tpk_tgl_approveHRD,
                j.jab_nama, 
                j.jab_kode,
                sla.sla_original_requested_date,
                sla.sla_system_floor_date,
                sla.sla_final_target_date,
                sla.sla_source,
                sla.sla_approval_delay_days,
                sla.sla_user_vs_system_diff_days,
                sla.sla_min_days,
                sla.sla_status,
                sla.sla_calculated_at,
                sla.sla_completed_at
             FROM tpermintaankaryawan t 
             JOIN tjabatan j ON j.jab_kode = t.tpk_jab_kode
             LEFT JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = t.tpk_nomor
             WHERE t.tpk_nomor = ?`,
            [nomor]
        );

        if (rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'Data tidak ditemukan' 
            });
        }

        res.json({ success: true, data: rows[0] });

    } catch (error) {
        console.error('❌ Error detail:', error.message);
        res.status(500).json({ 
            success: false,
            message: error.message 
        });
    }
});

/**
 * POST /api/recruitment/save
 * ✅ 100% BENAR: Validasi dalam transaksi + Notification fail-safe
 */
router.post('/save', authenticate, async (req, res) => {
    const data = req.body;
    const {
        tpk_nomor, jab_kode, bagian, tgl_butuh, jumlah,
        alasan, alasan_lain,
        tpk_keterangan, tpk_keterangan2, tpk_keterangan3, tpk_keterangan4,
        tpk_keterangan5, tpk_keterangan6, tpk_keterangan7, tpk_keterangan8,
        tpk_keterangan9, tpk_keterangan10,
        tpk_spesifikasi, tpk_spesifikasi2, tpk_spesifikasi3, tpk_spesifikasi4,
        tpk_spesifikasi5, tpk_spesifikasi6, tpk_spesifikasi7, tpk_spesifikasi8,
        tpk_spesifikasi9, tpk_spesifikasi10
    } = data;

    const user_kode = req.user.user_kode;
    const connection = await db.getConnection();

    try {
        if (tpk_nomor) {
            // ========== UPDATE LOGIC ==========
            await connection.beginTransaction();

            // ✅ FIX #1: Validasi DI DALAM transaksi
            if (jab_kode && tgl_butuh) {
                const validation = await validateTglButuhFromDB(connection, jab_kode, tgl_butuh);
                
                if (!validation.valid) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({
                        success: false,
                        message: validation.message,
                        min_date: validation.minDate,
                        jab_kode: jab_kode
                    });
                }
            }

            // 1️⃣ LOCK + SNAPSHOT (SEKALI SAJA)
            const [rows] = await connection.execute(
                `SELECT
                    p.tpk_peminta,
                    p.tpk_approveatasan,
                    p.tpk_approveHRD,
                    p.tpk_jumlah,
                    p.tpk_tgl_butuh,
                    p.tpk_jab_kode,
                    s.sla_is_editable
                FROM tpermintaankaryawan p
                LEFT JOIN t_recruitment_sla s ON s.sla_tpk_nomor = p.tpk_nomor
                WHERE p.tpk_nomor = ?
                FOR UPDATE`,
                [tpk_nomor]
            );

            if (rows.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ success: false });
            }

            const current = rows[0];
            const old = rows[0]; // ✅ Gunakan data yang sama untuk audit

            if (current.tpk_peminta !== user_kode) {
                await connection.rollback();
                connection.release();
                return res.status(403).json({
                    success: false,
                    message: 'Anda tidak memiliki akses untuk mengubah permintaan ini'
                });
            }

            const isEditable = current.sla_is_editable === 1;
            const isDraft = current.tpk_approveatasan === 0 && current.tpk_approveHRD === 0;

            if (!isDraft && !isEditable) {
                await connection.rollback();
                connection.release();
                return res.status(403).json({
                    success: false,
                    message: 'Edit dikunci. Hubungi HRD jika ada kebutuhan mendesak.'
                });
            }

            // Jika edit diizinkan karena No-Show, reset flag setelah update
            if (isEditable) {
                await connection.execute(
                    `UPDATE t_recruitment_sla SET 
                        sla_job_code = ?, 
                        sla_original_requested_date = ?,
                        sla_system_ceiling_date = ?,
                        sla_final_target_date = GREATEST(COALESCE(sla_system_floor_date, CURDATE()), ?),
                        sla_is_editable = 0,
                        sla_notes = CONCAT(
                            COALESCE(sla_notes,''), 
                            '\n[', NOW(), '] Re-schedule oleh User (New Date: ', ?, ')'
                        )
                    WHERE sla_tpk_nomor = ?`,
                    [jab_kode, tgl_butuh, tgl_butuh, tgl_butuh, tgl_butuh, tpk_nomor]
                );
            }

            // 2️⃣ UPDATE DATA UTAMA
            const sqlUpdate = `
                UPDATE tpermintaankaryawan SET
                    tpk_jab_kode = ?, tpk_bagian = ?, tpk_tgl_butuh = ?, tpk_jumlah = ?,
                    tpk_alasan = ?, tpk_alasanlain = ?,
                    tpk_keterangan = ?, tpk_keterangan2 = ?, tpk_keterangan3 = ?, tpk_keterangan4 = ?,
                    tpk_keterangan5 = ?, tpk_keterangan6 = ?, tpk_keterangan7 = ?, tpk_keterangan8 = ?,
                    tpk_keterangan9 = ?, tpk_keterangan10 = ?,
                    tpk_spesifikasi = ?, tpk_spesifikasi2 = ?, tpk_spesifikasi3 = ?, tpk_spesifikasi4 = ?,
                    tpk_spesifikasi5 = ?, tpk_spesifikasi6 = ?, tpk_spesifikasi7 = ?, tpk_spesifikasi8 = ?,
                    tpk_spesifikasi9 = ?, tpk_spesifikasi10 = ?
                WHERE tpk_nomor = ?
            `;

            const params = [
                jab_kode || null, bagian || null, tgl_butuh || null, jumlah || 0,
                alasan || null, alasan_lain || null,
                tpk_keterangan || '', tpk_keterangan2 || '', tpk_keterangan3 || '', tpk_keterangan4 || '',
                tpk_keterangan5 || '', tpk_keterangan6 || '', tpk_keterangan7 || '', tpk_keterangan8 || '',
                tpk_keterangan9 || '', tpk_keterangan10 || '',
                tpk_spesifikasi || '', tpk_spesifikasi2 || '', tpk_spesifikasi3 || '', tpk_spesifikasi4 || '',
                tpk_spesifikasi5 || '', tpk_spesifikasi6 || '', tpk_spesifikasi7 || '', tpk_spesifikasi8 || '',
                tpk_spesifikasi9 || '', tpk_spesifikasi10 || '',
                tpk_nomor
            ];

            await connection.execute(sqlUpdate, params);

            // 3️⃣ AUDIT LOG (MENGGUNAKAN DATA DARI SNAPSHOT PERTAMA)
            const changes = [
                { field: 'tpk_jumlah', old: old.tpk_jumlah, new: jumlah },
                { field: 'tpk_tgl_butuh', old: old.tpk_tgl_butuh, new: tgl_butuh },
                { field: 'tpk_jab_kode', old: old.tpk_jab_kode, new: jab_kode }
            ];

            for (const c of changes) {
                if (String(c.old) !== String(c.new)) {
                    await connection.execute(
                        `INSERT INTO t_pkar_log 
                        (tpk_nomor, user_kode, field_name, old_value, new_value)
                        VALUES (?, ?, ?, ?, ?)`,
                        [
                            tpk_nomor,
                            user_kode,
                            c.field,
                            c.old !== null ? String(c.old) : null,
                            c.new !== null ? String(c.new) : null
                        ]
                    );
                }
            }

            // 4️⃣ UPDATE SLA TABLE
            await connection.execute(
                `UPDATE t_recruitment_sla 
                 SET sla_job_code = ?, 
                     sla_original_requested_date = ?,
                     sla_system_ceiling_date = ?
                 WHERE sla_tpk_nomor = ? AND sla_status = 'PENDING'`,
                [jab_kode, tgl_butuh, tgl_butuh, tpk_nomor]
            );

            await connection.commit();
            connection.release();

            res.json({ success: true, message: 'Data berhasil diupdate' });

        } else {
            // ========== INSERT LOGIC ==========
            const missingFields = [];

            if (!jab_kode) missingFields.push('jabatan');
            if (!bagian) missingFields.push('bagian');
            if (!tgl_butuh) missingFields.push('tgl_butuh');
            if (!jumlah || jumlah <= 0) missingFields.push('jumlah');
            if (!alasan || alasan.trim() === '') missingFields.push('alasan');

            if (missingFields.length > 0) {
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: 'Data wajib belum lengkap',
                    missing_fields: missingFields
                });
            }

            await connection.beginTransaction();

            // ✅ FIX #1: Validasi DI DALAM transaksi
            const validation = await validateTglButuhFromDB(connection, jab_kode, tgl_butuh);
            
            if (!validation.valid) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: validation.message,
                    min_date: validation.minDate,
                    jab_kode: jab_kode
                });
            }

            const newDate = new Date();
            const year = newDate.getFullYear();
            const month = String(newDate.getMonth() + 1).padStart(2, '0');

            const sqlMax = `
                SELECT MAX(CAST(LEFT(tpk_nomor, 3) AS UNSIGNED)) as max_nomor 
                FROM tpermintaankaryawan 
                WHERE YEAR(tpk_tanggal) = ?
                FOR UPDATE
            `;

            const [rows] = await connection.execute(sqlMax, [year]);
            const maxNomor = rows[0].max_nomor || 0;
            const nextNomor = String(maxNomor + 1).padStart(3, '0');
            const newNomor = `${nextNomor}/HRD/PKAR/${month}/${year}`;

            // INSERT ke tpermintaankaryawan
            const sqlInsert = `
                INSERT INTO tpermintaankaryawan (
                    tpk_nomor, tpk_peminta, tpk_tanggal, tpk_jab_kode, tpk_bagian, tpk_tgl_butuh, tpk_jumlah,
                    tpk_alasan, tpk_alasanlain, 
                    tpk_keterangan, tpk_keterangan2, tpk_keterangan3, tpk_keterangan4,
                    tpk_keterangan5, tpk_keterangan6, tpk_keterangan7, tpk_keterangan8,
                    tpk_keterangan9, tpk_keterangan10,
                    tpk_spesifikasi, tpk_spesifikasi2, tpk_spesifikasi3, tpk_spesifikasi4,
                    tpk_spesifikasi5, tpk_spesifikasi6, tpk_spesifikasi7, tpk_spesifikasi8,
                    tpk_spesifikasi9, tpk_spesifikasi10,
                    tpk_approveatasan, tpk_approveHRD 
                ) VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
            `;

            const params = [
                newNomor, user_kode,
                jab_kode, bagian, tgl_butuh, jumlah,
                alasan || null, alasan_lain || null,
                tpk_keterangan || '', tpk_keterangan2 || '', tpk_keterangan3 || '', tpk_keterangan4 || '',
                tpk_keterangan5 || '', tpk_keterangan6 || '', tpk_keterangan7 || '', tpk_keterangan8 || '',
                tpk_keterangan9 || '', tpk_keterangan10 || '',
                tpk_spesifikasi || '', tpk_spesifikasi2 || '', tpk_spesifikasi3 || '', tpk_spesifikasi4 || '',
                tpk_spesifikasi5 || '', tpk_spesifikasi6 || '', tpk_spesifikasi7 || '', tpk_spesifikasi8 || '',
                tpk_spesifikasi9 || '', tpk_spesifikasi10 || ''
            ];

            await connection.execute(sqlInsert, params);

            // INSERT ke t_recruitment_sla
            const sqlInsertSLA = `
                INSERT INTO t_recruitment_sla (
                    sla_tpk_nomor,
                    sla_job_code,
                    sla_original_requested_date,
                    sla_system_ceiling_date,
                    sla_request_created_at,
                    sla_status
                ) VALUES (?, ?, ?, ?, NOW(), 'PENDING')
            `;

            await connection.execute(sqlInsertSLA, [newNomor, jab_kode, tgl_butuh, tgl_butuh]);

            // ✅ FIX #2: NOTIFICATION ENGINE FAIL-SAFE
            try {
                const [atasanData] = await connection.execute(
                    `SELECT kar_nik_atasan, kar_nama 
                     FROM tkaryawan 
                     WHERE kar_nik = ?`,
                    [user_kode]
                );

                if (atasanData.length > 0 && atasanData[0].kar_nik_atasan) {
                    const atasan_nik = atasanData[0].kar_nik_atasan;
                    const peminta_nama = atasanData[0].kar_nama;

                    // Insert notifikasi ke tabel notifikasi
                    await connection.execute(
                        `INSERT INTO t_notifications 
                        (notif_user_kode, notif_type, notif_title, notif_message, notif_link, notif_created_at)
                        VALUES (?, 'APPROVAL_REQUEST', ?, ?, ?, NOW())`,
                        [
                            atasan_nik,
                            'Permintaan Karyawan Baru',
                            `${peminta_nama} mengajukan permintaan karyawan baru (${newNomor}) untuk posisi ${jab_kode}`,
                            `/approval/atasan?nomor=${newNomor}`
                        ]
                    );

                    console.log(`✅ Notifikasi terkirim ke atasan: ${atasan_nik}`);
                }
            } catch (notifError) {
                // ❗ JANGAN throw - Notifikasi gagal tidak boleh menggagalkan transaksi utama
                console.warn('⚠️ Notifikasi gagal dikirim:', notifError.message);
            }

            await connection.commit();
            connection.release();

            res.json({
                success: true,
                message: 'Permintaan berhasil dibuat',
                nomor: newNomor
            });
        }
    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('❌ Error save:', error.message);
        res.status(500).json({ 
            success: false,
            message: 'Gagal menyimpan data', 
            error: error.message 
        });
    }
});

/**
 * GET /api/recruitment/approval/atasan
 * ✅ UPDATED: Menggunakan nilai stabil dari enum ("pending", "approved")
 */
router.get('/approval/atasan', authenticate, isManager, async (req, res) => {
    const { status } = req.query;
    const user_kode = req.user.user_kode;

    try {
        let query = `
            SELECT 
                p.tpk_nomor, 
                j.jab_nama, 
                p.tpk_bagian, 
                p.tpk_jumlah, 
                p.tpk_approveatasan, 
                p.tpk_approveHRD,
                k.kar_nama as peminta,
                DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
                DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
                DATE_FORMAT(p.tpk_tgl_approveatasan, '%Y-%m-%d') as tgl_approve_atasan,
                DATE_FORMAT(p.tpk_tgl_approveHRD, '%Y-%m-%d') as tgl_approve_hrd
            FROM tpermintaankaryawan p
            INNER JOIN tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            WHERE k.kar_nik_atasan = ?
        `;

        const params = [user_kode];

        // ✅ GUNAKAN NILAI STABIL, BUKAN TEKS UI
        if (status === 'pending') {
            query += ' AND p.tpk_approveatasan = 0';
        } else if (status === 'approved') {
            query += ' AND p.tpk_approveatasan = 1';
        } else if (status === 'rejected') {
            query += ' AND p.tpk_approveatasan = 2';
        }
        // else: status null atau 'all' -> tidak ada filter tambahan

        query += ' ORDER BY p.tpk_tanggal DESC';

        const [rows] = await db.execute(query, params);
        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error approval/atasan:', error.message);
        res.status(500).json({ 
            success: false,
            message: error.message 
        });
    }
});

/**
 * POST /api/recruitment/approval/atasan/action
 * ✅ KRITIS: INI YANG TRIGGER SLA CALCULATION
 */
router.post('/approval/atasan/action', authenticate, isManager, async (req, res) => {
    const { tpk_nomor, action } = req.body;

    if (!tpk_nomor || !action) {
        return res.status(400).json({ 
            success: false,
            message: 'Parameter tpk_nomor dan action diperlukan' 
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let statusVal = 0;
        if (action === 'APPROVE') statusVal = 1;
        else if (action === 'REJECT') statusVal = 2;
        else {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ success: false, message: 'Invalid action' });
        }

        // GET DATA PERMINTAAN
        const [checkRows] = await connection.execute(
            `SELECT 
                p.tpk_approveatasan,
                p.tpk_tanggal,
                p.tpk_tgl_butuh,
                p.tpk_jab_kode,
                k.kar_nik_atasan,
                sla.sla_id,
                sla.sla_original_requested_date,
                sla.sla_request_created_at
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             LEFT JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             WHERE p.tpk_nomor = ?
             FOR UPDATE`,
            [tpk_nomor]
        );

        if (checkRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ success: false, message: 'Permintaan tidak ditemukan' });
        }

        const data = checkRows[0];

        if (data.kar_nik_atasan !== req.user.user_kode) {
            await connection.rollback();
            connection.release();
            return res.status(403).json({
                success: false,
                message: 'Anda tidak memiliki akses untuk approve permintaan ini'
            });
        }

        if (data.tpk_approveatasan !== 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({
                success: false,
                message: 'Permintaan sudah pernah diproses oleh atasan'
            });
        }

        // UPDATE TABEL LAMA
        await connection.execute(
            'UPDATE tpermintaankaryawan SET tpk_approveatasan = ?, tpk_tgl_approveatasan = NOW() WHERE tpk_nomor = ?',
            [statusVal, tpk_nomor]
        );

        // HITUNG SLA (HANYA JIKA APPROVE)
        if (statusVal === 1) {
            // Get master lead time
            const [masterData] = await connection.execute(
                'SELECT jlt_min_days, jlt_max_days, jlt_is_flexible FROM job_lead_time_master WHERE jlt_job_code = ? AND jlt_active = 1',
                [data.tpk_jab_kode]
            );

            if (masterData.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(500).json({
                    success: false,
                    message: `Master lead time untuk jabatan ${data.tpk_jab_kode} tidak ditemukan. Hubungi admin.`
                });
            }

            const master = masterData[0];
            const approvedAt = new Date();
            const requestedDate = new Date(data.sla_original_requested_date);
            const createdAt = new Date(data.sla_request_created_at);

            let systemFloorDate = null;
            let finalTargetDate = null;
            let slaSource = null;

            // Hitung approval delay
            const approvalDelayDays = countWorkdays(createdAt, approvedAt);

            if (master.jlt_is_flexible === 1) {
                // Jabatan fleksibel (DIR/KOR)
                systemFloorDate = null;
                finalTargetDate = requestedDate;
                slaSource = 'FLEXIBLE';
            } else {
                // Jabatan non-fleksibel
                systemFloorDate = addWorkdays(approvedAt, master.jlt_min_days);
                
                if (systemFloorDate > requestedDate) {
                    finalTargetDate = systemFloorDate;
                    slaSource = 'SYSTEM';
                } else {
                    finalTargetDate = requestedDate;
                    slaSource = 'USER';
                }
            }

            // Hitung selisih user vs system
            const diffDays = countWorkdays(requestedDate, finalTargetDate);

            // ✅ APPROVAL DELAY AUDIT TRAIL
            const approvalNote =
                approvalDelayDays > 0
                    ? `Approval atasan terlambat ${approvalDelayDays} hari kerja.`
                    : `Approval atasan tepat waktu.`;

            // ✅ UPDATE t_recruitment_sla dengan TIMEZONE-SAFE FORMATTING
            await connection.execute(
                `UPDATE t_recruitment_sla 
                SET sla_approved_at = NOW(),
                    sla_calculated_at = NOW(),
                    sla_min_days = ?,
                    sla_max_days = ?,
                    sla_is_flexible = ?,
                    sla_system_floor_date = ?,
                    sla_final_target_date = ?,
                    sla_original_requested_date = ?, 
                    sla_source = ?,
                    sla_approval_delay_days = ?,
                    sla_user_vs_system_diff_days = ?,
                    sla_notes = CONCAT(
                        COALESCE(sla_notes,''), 
                        '\n[', NOW(), '] ', ?
                    ),
                    sla_status = 'CALCULATED'
                WHERE sla_tpk_nomor = ?`,
                [
                    master.jlt_min_days,
                    master.jlt_max_days,
                    master.jlt_is_flexible,
                    formatDateSafe(systemFloorDate),
                    formatDateSafe(finalTargetDate),
                    formatDateSafe(requestedDate),
                    slaSource,
                    approvalDelayDays,
                    diffDays,
                    approvalNote,
                    tpk_nomor
                ]
            );

            await connection.commit();
            connection.release();

            return res.json({ 
                success: true, 
                message: 'Berhasil APPROVE Permintaan',
                data: {
                    sla_info: {
                        original_requested_date: formatDateSafe(requestedDate),
                        system_floor_date: formatDateSafe(systemFloorDate),
                        final_target_date: formatDateSafe(finalTargetDate),
                        sla_source: slaSource,
                        approval_delay_days: approvalDelayDays,
                        explanation: slaSource === 'SYSTEM' 
                            ? `Tanggal user tidak realistis. HRD butuh minimal ${master.jlt_min_days} hari kerja.`
                            : slaSource === 'FLEXIBLE'
                            ? 'Jabatan fleksibel. HRD akan bekerja sesuai kebutuhan.'
                            : 'Tanggal user sudah realistis. HRD akan bekerja sesuai target.'
                    }
                }
            });

        } else {
            // REJECT case
            await connection.execute(
                'UPDATE t_recruitment_sla SET sla_status = "CANCELLED" WHERE sla_tpk_nomor = ?',
                [tpk_nomor]
            );

            await connection.commit();
            connection.release();

            return res.json({ 
                success: true, 
                message: 'Berhasil REJECT Permintaan',
                data: {
                    message: 'Permintaan berhasil ditolak',
                    sla_info: null
                }
            });
        }

    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('❌ Error approval action:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/recruitment/approval/hrd
 * ✅ UPDATED: Menggunakan nilai stabil dari enum ("pending", "approved")
 */
router.get('/approval/hrd', authenticate, isHRD, async (req, res) => {
    const { status } = req.query;

    try {
        let query = `
            SELECT 
                p.tpk_nomor, 
                j.jab_nama, 
                p.tpk_bagian, 
                p.tpk_jumlah, 
                p.tpk_approveHRD, 
                p.tpk_approveatasan,
                k.kar_nama as peminta,
                DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
                DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
                DATE_FORMAT(p.tpk_tgl_approveatasan, '%Y-%m-%d') as tgl_approve_atasan,
                DATE_FORMAT(p.tpk_tgl_approveHRD, '%Y-%m-%d') as tgl_approve_hrd,
                sla.sla_final_target_date,
                sla.sla_source
            FROM tpermintaankaryawan p
            INNER JOIN tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            LEFT JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            WHERE p.tpk_approveatasan = 1
        `;

        // ✅ GUNAKAN NILAI STABIL, BUKAN TEKS UI
        if (status === 'pending') {
            query += ' AND p.tpk_approveHRD = 0';
        } else if (status === 'approved') {
            query += ' AND p.tpk_approveHRD = 1';
        }
        // else: status null atau 'all' -> tidak ada filter tambahan

        query += ' ORDER BY p.tpk_tanggal DESC';

        const [rows] = await db.execute(query);
        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error approval/hrd:', error.message);
        res.status(500).json({ 
            success: false,
            message: error.message 
        });
    }
});

/**
 * POST /api/recruitment/approval/hrd/action
 */
router.post('/approval/hrd/action', authenticate, isHRD, async (req, res) => {
    const { tpk_nomor } = req.body;

    if (!tpk_nomor) {
        return res.status(400).json({ 
            success: false,
            message: 'Parameter tpk_nomor diperlukan' 
        });
    }

    try {
        const [checkRows] = await db.execute(
            'SELECT tpk_approveatasan, tpk_approveHRD FROM tpermintaankaryawan WHERE tpk_nomor = ?',
            [tpk_nomor]
        );

        if (checkRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Permintaan tidak ditemukan'
            });
        }

        const current = checkRows[0];
        if (current.tpk_approveatasan !== 1) {
            return res.status(403).json({
                success: false,
                message: 'DITOLAK: Permintaan belum disetujui oleh atasan atau sudah ditolak'
            });
        }

        if (current.tpk_approveHRD !== 0) {
            return res.status(400).json({
                success: false,
                message: 'Permintaan sudah pernah diproses oleh HRD'
            });
        }

        const sql = `UPDATE tpermintaankaryawan 
                     SET tpk_approveHRD = 1, tpk_tgl_approveHRD = NOW() 
                     WHERE tpk_nomor = ?`;
        
        await db.execute(sql, [tpk_nomor]);

        res.json({
            success: true,
            message: 'HRD Berhasil Approve - Recruitment Dibuka'
        });

    } catch (error) {
        console.error('❌ Error HRD action:', error.message);
        res.status(500).json({ 
            success: false,
            message: error.message 
        });
    }
});

module.exports = router;