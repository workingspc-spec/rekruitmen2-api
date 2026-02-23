// src/modules/recruitment.js
const express = require('express');
const db = require('../config/db');
const router = express.Router();
const { authenticate, isHRD, isManager } = require('../middleware/authMiddleware');
const { addWorkdays, countWorkdays, formatDateSafe } = require('../utils/workdayCalculator');

/**
 * =====================================================================
 * MODULE: RECRUITMENT REQUEST
 * Flow: Peminta buat → Atasan approve → HRD approve
 * =====================================================================
 */

/**
 * VALIDASI TANGGAL BUTUH DARI DATABASE
 * ignoreLeadTime = true → mode Re-Schedule (hanya cek tidak boleh masa lalu)
 * ignoreLeadTime = false → mode Draft (cek full lead time)
 */
async function validateTglButuhFromDB(connection, jab_kode, tgl_butuh, ignoreLeadTime = false) {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [y, m, d] = tgl_butuh.split('-').map(Number);
        const requestedDate = new Date(y, m - 1, d, 0, 0, 0, 0);

        if (ignoreLeadTime) {
            if (requestedDate < today) {
                return {
                    valid: false,
                    message: 'Untuk re-schedule, tanggal minimal adalah hari ini.'
                };
            }
            return { valid: true };
        }

        const [rows] = await connection.execute(
            `SELECT COALESCE(jlt.jlt_min_days, 7) as min_days, 
                    COALESCE(jlt.jlt_is_flexible, 0) as is_flexible
             FROM tjabatan j
             LEFT JOIN job_lead_time_master jlt 
                ON jlt.jlt_job_code = j.jab_kode AND jlt.jlt_active = 1
             WHERE j.jab_kode = ?`,
            [jab_kode]
        );

        if (rows.length === 0) return { valid: false, message: 'Jabatan tidak ditemukan' };

        const { min_days, is_flexible } = rows[0];
        if (is_flexible === 1) return { valid: true };

        const minDateObj = addWorkdays(today, min_days);
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

// =====================================================================

/**
 * GET /api/recruitment/jabatan-rules
 * Aturan lead time per jabatan untuk validasi form di frontend
 */
router.get('/jabatan-rules', authenticate, async (req, res) => {
    try {
        const [rows] = await db.execute(`
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
            LEFT JOIN job_lead_time_master jlt 
                ON jlt.jlt_job_code = j.jab_kode AND jlt.jlt_active = 1
            ORDER BY j.jab_nama
        `);

        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error jabatan-rules:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * GET /api/recruitment/my-requests
 * Daftar permintaan — HRD lihat semua, user lihat miliknya
 */
router.get('/my-requests', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;

    try {
        const whereClause = is_hrd ? '1=1' : 'p.tpk_peminta = ?';
        const params = is_hrd ? [] : [user_kode];

        const [rows] = await db.execute(`
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
                COALESCE(sla.sla_hired_count, 0) as hired_count,
                sla.sla_final_target_date,
                sla.sla_source,
                sla.sla_status,
                sla.sla_is_editable
            FROM tpermintaankaryawan p
            INNER JOIN tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            WHERE ${whereClause}
            ORDER BY p.tpk_tanggal DESC
        `, params);

        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error my-requests:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * GET /api/recruitment/detail
 * Detail satu permintaan lengkap beserta info SLA
 */
router.get('/detail', authenticate, async (req, res) => {
    const { nomor } = req.query;

    if (!nomor) {
        return res.status(400).json({ success: false, message: 'Parameter nomor diperlukan' });
    }

    try {
        const [rows] = await db.execute(`
            SELECT 
                t.tpk_nomor,
                t.tpk_peminta,
                DATE_FORMAT(t.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
                t.tpk_jab_kode,
                t.tpk_bagian,
                DATE_FORMAT(t.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
                t.tpk_jumlah,
                t.tpk_alasan,
                t.tpk_alasanlain,
                t.tpk_keterangan,  t.tpk_keterangan2,  t.tpk_keterangan3,  t.tpk_keterangan4,
                t.tpk_keterangan5, t.tpk_keterangan6,  t.tpk_keterangan7,  t.tpk_keterangan8,
                t.tpk_keterangan9, t.tpk_keterangan10,
                t.tpk_spesifikasi,  t.tpk_spesifikasi2,  t.tpk_spesifikasi3,  t.tpk_spesifikasi4,
                t.tpk_spesifikasi5, t.tpk_spesifikasi6,  t.tpk_spesifikasi7,  t.tpk_spesifikasi8,
                t.tpk_spesifikasi9, t.tpk_spesifikasi10,
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
                sla.sla_is_editable,
                sla.sla_notes,
                sla.sla_calculated_at,
                sla.sla_completed_at,
                sla.sla_hired_count
            FROM tpermintaankaryawan t
            JOIN tjabatan j ON j.jab_kode = t.tpk_jab_kode
            LEFT JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = t.tpk_nomor
            WHERE t.tpk_nomor = ?
        `, [nomor]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
        }

        res.json({ success: true, data: rows[0] });

    } catch (error) {
        console.error('❌ Error detail:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * POST /api/recruitment/save
 * Buat permintaan baru ATAU edit permintaan yang masih draft / sla_is_editable
 */
router.post('/save', authenticate, async (req, res) => {
    const {
        tpk_nomor, jab_kode, bagian, tgl_butuh, jumlah,
        alasan, alasan_lain,
        tpk_keterangan,  tpk_keterangan2,  tpk_keterangan3,  tpk_keterangan4,
        tpk_keterangan5, tpk_keterangan6,  tpk_keterangan7,  tpk_keterangan8,
        tpk_keterangan9, tpk_keterangan10,
        tpk_spesifikasi,  tpk_spesifikasi2,  tpk_spesifikasi3,  tpk_spesifikasi4,
        tpk_spesifikasi5, tpk_spesifikasi6,  tpk_spesifikasi7,  tpk_spesifikasi8,
        tpk_spesifikasi9, tpk_spesifikasi10
    } = req.body;

    const user_kode = req.user.user_kode;
    const connection = await db.getConnection();

    try {
        // ==================== UPDATE ====================
        if (tpk_nomor) {
            await connection.beginTransaction();

            if (jab_kode && tgl_butuh) {
                const [slaCheck] = await connection.execute(
                    'SELECT sla_is_editable FROM t_recruitment_sla WHERE sla_tpk_nomor = ?',
                    [tpk_nomor]
                );
                const isReSchedule = slaCheck.length > 0 && slaCheck[0].sla_is_editable === 1;
                const validation = await validateTglButuhFromDB(connection, jab_kode, tgl_butuh, isReSchedule);

                if (!validation.valid) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({
                        success: false,
                        message: validation.message,
                        min_date: validation.minDate,
                        jab_kode
                    });
                }
            }

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
                return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
            }

            const current = rows[0];

            if (current.tpk_peminta !== user_kode) {
                await connection.rollback();
                connection.release();
                return res.status(403).json({
                    success: false,
                    message: 'Anda tidak memiliki akses untuk mengubah permintaan ini'
                });
            }

            const isDraft    = current.tpk_approveatasan === 0 && current.tpk_approveHRD === 0;
            const isEditable = current.sla_is_editable === 1;

            if (!isDraft && !isEditable) {
                await connection.rollback();
                connection.release();
                return res.status(403).json({
                    success: false,
                    message: 'Edit dikunci. Hubungi HRD jika ada kebutuhan mendesak.'
                });
            }

            // Re-schedule: update SLA dan buka kunci
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

            await connection.execute(`
                UPDATE tpermintaankaryawan SET
                    tpk_jab_kode = ?, tpk_bagian = ?, tpk_tgl_butuh = ?, tpk_jumlah = ?,
                    tpk_alasan = ?, tpk_alasanlain = ?,
                    tpk_keterangan = ?,  tpk_keterangan2 = ?,  tpk_keterangan3 = ?,  tpk_keterangan4 = ?,
                    tpk_keterangan5 = ?, tpk_keterangan6 = ?,  tpk_keterangan7 = ?,  tpk_keterangan8 = ?,
                    tpk_keterangan9 = ?, tpk_keterangan10 = ?,
                    tpk_spesifikasi = ?,  tpk_spesifikasi2 = ?,  tpk_spesifikasi3 = ?,  tpk_spesifikasi4 = ?,
                    tpk_spesifikasi5 = ?, tpk_spesifikasi6 = ?,  tpk_spesifikasi7 = ?,  tpk_spesifikasi8 = ?,
                    tpk_spesifikasi9 = ?, tpk_spesifikasi10 = ?
                WHERE tpk_nomor = ?
            `, [
                jab_kode || null, bagian || null, tgl_butuh || null, jumlah || 0,
                alasan || null, alasan_lain || null,
                tpk_keterangan  || '', tpk_keterangan2  || '', tpk_keterangan3  || '', tpk_keterangan4  || '',
                tpk_keterangan5 || '', tpk_keterangan6  || '', tpk_keterangan7  || '', tpk_keterangan8  || '',
                tpk_keterangan9 || '', tpk_keterangan10 || '',
                tpk_spesifikasi  || '', tpk_spesifikasi2  || '', tpk_spesifikasi3  || '', tpk_spesifikasi4  || '',
                tpk_spesifikasi5 || '', tpk_spesifikasi6  || '', tpk_spesifikasi7  || '', tpk_spesifikasi8  || '',
                tpk_spesifikasi9 || '', tpk_spesifikasi10 || '',
                tpk_nomor
            ]);

            // Audit log — hanya tulis jika ada perubahan
            const changes = [
                { field: 'tpk_jumlah',   old: current.tpk_jumlah,   new: jumlah    },
                { field: 'tpk_tgl_butuh', old: current.tpk_tgl_butuh, new: tgl_butuh },
                { field: 'tpk_jab_kode', old: current.tpk_jab_kode, new: jab_kode  }
            ];

            for (const c of changes) {
                if (String(c.old) !== String(c.new)) {
                    await connection.execute(
                        `INSERT INTO t_pkar_log (tpk_nomor, user_kode, field_name, old_value, new_value)
                         VALUES (?, ?, ?, ?, ?)`,
                        [tpk_nomor, user_kode, c.field,
                         c.old !== null ? String(c.old) : null,
                         c.new !== null ? String(c.new) : null]
                    );
                }
            }

            // Update SLA jika masih PENDING (draft yang belum diapprove atasan)
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

            return res.json({ success: true, message: 'Data berhasil diupdate' });

        // ==================== INSERT ====================
        } else {
            const missingFields = [];
            if (!jab_kode)                     missingFields.push('jabatan');
            if (!bagian)                        missingFields.push('bagian');
            if (!tgl_butuh)                     missingFields.push('tgl_butuh');
            if (!jumlah || jumlah <= 0)         missingFields.push('jumlah');
            if (!alasan || !alasan.trim())      missingFields.push('alasan');

            if (missingFields.length > 0) {
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: 'Data wajib belum lengkap',
                    missing_fields: missingFields
                });
            }

            await connection.beginTransaction();

            const validation = await validateTglButuhFromDB(connection, jab_kode, tgl_butuh, false);
            if (!validation.valid) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: validation.message,
                    min_date: validation.minDate,
                    jab_kode
                });
            }

            const now = new Date();
            const year  = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');

            const [maxRows] = await connection.execute(
                `SELECT MAX(CAST(LEFT(tpk_nomor, 3) AS UNSIGNED)) as max_nomor
                 FROM tpermintaankaryawan
                 WHERE YEAR(tpk_tanggal) = ?
                 FOR UPDATE`,
                [year]
            );

            const nextNomor = String((maxRows[0].max_nomor || 0) + 1).padStart(3, '0');
            const newNomor  = `${nextNomor}/HRD/PKAR/${month}/${year}`;

            await connection.execute(`
                INSERT INTO tpermintaankaryawan (
                    tpk_nomor, tpk_peminta, tpk_tanggal, tpk_jab_kode, tpk_bagian,
                    tpk_tgl_butuh, tpk_jumlah, tpk_alasan, tpk_alasanlain,
                    tpk_keterangan,  tpk_keterangan2,  tpk_keterangan3,  tpk_keterangan4,
                    tpk_keterangan5, tpk_keterangan6,  tpk_keterangan7,  tpk_keterangan8,
                    tpk_keterangan9, tpk_keterangan10,
                    tpk_spesifikasi,  tpk_spesifikasi2,  tpk_spesifikasi3,  tpk_spesifikasi4,
                    tpk_spesifikasi5, tpk_spesifikasi6,  tpk_spesifikasi7,  tpk_spesifikasi8,
                    tpk_spesifikasi9, tpk_spesifikasi10,
                    tpk_approveatasan, tpk_approveHRD
                ) VALUES (
                    ?, ?, NOW(), ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?,
                    0, 0
                )
            `, [
                newNomor, user_kode, jab_kode, bagian,
                tgl_butuh, jumlah, alasan || null, alasan_lain || null,
                tpk_keterangan  || '', tpk_keterangan2  || '', tpk_keterangan3  || '', tpk_keterangan4  || '',
                tpk_keterangan5 || '', tpk_keterangan6  || '', tpk_keterangan7  || '', tpk_keterangan8  || '',
                tpk_keterangan9 || '', tpk_keterangan10 || '',
                tpk_spesifikasi  || '', tpk_spesifikasi2  || '', tpk_spesifikasi3  || '', tpk_spesifikasi4  || '',
                tpk_spesifikasi5 || '', tpk_spesifikasi6  || '', tpk_spesifikasi7  || '', tpk_spesifikasi8  || '',
                tpk_spesifikasi9 || '', tpk_spesifikasi10 || ''
            ]);

            await connection.execute(
                `INSERT INTO t_recruitment_sla (
                    sla_tpk_nomor, sla_job_code,
                    sla_original_requested_date, sla_system_ceiling_date,
                    sla_request_created_at, sla_status
                ) VALUES (?, ?, ?, ?, NOW(), 'PENDING')`,
                [newNomor, jab_kode, tgl_butuh, tgl_butuh]
            );

            await connection.commit();
            connection.release();

            return res.json({
                success: true,
                message: 'Permintaan berhasil dibuat',
                nomor: newNomor
            });
        }

    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('❌ Error save:', error.message);
        res.status(500).json({ success: false, message: 'Gagal menyimpan data', error: error.message });
    }
});

// =====================================================================

/**
 * GET /api/recruitment/approval/atasan
 * Daftar permintaan bawahan untuk diapprove atasan
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
            LEFT JOIN tkaryawan k ON k.kar_Nik = p.tpk_peminta
            WHERE k.kar_nik_atasan = ?
        `;

        const params = [user_kode];

        if (status === 'pending')  query += ' AND p.tpk_approveatasan = 0';
        if (status === 'approved') query += ' AND p.tpk_approveatasan = 1';
        if (status === 'rejected') query += ' AND p.tpk_approveatasan = 2';

        query += ' ORDER BY p.tpk_tanggal DESC';

        const [rows] = await db.execute(query, params);
        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error approval/atasan:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * POST /api/recruitment/approval/atasan/action
 * Atasan approve atau reject — INI YANG TRIGGER KALKULASI SLA
 */
router.post('/approval/atasan/action', authenticate, isManager, async (req, res) => {
    const { tpk_nomor, action } = req.body;

    if (!tpk_nomor || !action) {
        return res.status(400).json({ success: false, message: 'Parameter tpk_nomor dan action diperlukan' });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let statusVal = 0;
        if (action === 'APPROVE')      statusVal = 1;
        else if (action === 'REJECT')  statusVal = 2;
        else {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ success: false, message: 'Action tidak valid. Gunakan APPROVE atau REJECT.' });
        }

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
             LEFT JOIN tkaryawan k ON k.kar_Nik = p.tpk_peminta
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
            return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses untuk approve permintaan ini' });
        }

        if (data.tpk_approveatasan !== 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ success: false, message: 'Permintaan sudah pernah diproses oleh atasan' });
        }

        await connection.execute(
            'UPDATE tpermintaankaryawan SET tpk_approveatasan = ?, tpk_tgl_approveatasan = NOW() WHERE tpk_nomor = ?',
            [statusVal, tpk_nomor]
        );

        // ========== APPROVE: Hitung SLA ==========
        if (statusVal === 1) {
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
            approvedAt.setHours(0, 0, 0, 0);

            const [y, m, d] = data.sla_original_requested_date.toString().split('T')[0].split('-').map(Number);
            const requestedDate = new Date(y, m - 1, d, 0, 0, 0, 0);
            const createdAt = new Date(data.sla_request_created_at);

            let systemFloorDate = null;
            let finalTargetDate = null;
            let slaSource       = null;

            const approvalDelayDays = countWorkdays(createdAt, approvedAt);

            if (master.jlt_is_flexible === 1) {
                finalTargetDate = requestedDate;
                slaSource = 'FLEXIBLE';
            } else {
                systemFloorDate = addWorkdays(approvedAt, master.jlt_min_days);

                if (systemFloorDate.getTime() > requestedDate.getTime()) {
                    // User minta terlalu cepat (misal: minta tgl 24 padahal sistem butuh min sampai tgl 26)
                    finalTargetDate = systemFloorDate;
                    slaSource = 'SYSTEM';
                } else {
                    // User minta tgl 27, sistem sanggup tgl 26.
                    // Kita samakan floor_date ke 27 agar timeline di UI sinkron (sejajar).
                    systemFloorDate = requestedDate; 
                    finalTargetDate = requestedDate;
                    slaSource = 'USER';
                }
            }

            const diffDays      = countWorkdays(requestedDate, finalTargetDate);
            const approvalNote  = approvalDelayDays > 0
                ? `Approval atasan terlambat ${approvalDelayDays} hari kerja.`
                : `Approval atasan tepat waktu.`;

            await connection.execute(
                `UPDATE t_recruitment_sla SET
                    sla_approved_at               = NOW(),
                    sla_calculated_at             = NOW(),
                    sla_min_days                  = ?,
                    sla_max_days                  = ?,
                    sla_is_flexible               = ?,
                    sla_system_floor_date         = ?,
                    sla_final_target_date         = ?,
                    sla_original_requested_date   = ?,
                    sla_source                    = ?,
                    sla_approval_delay_days       = ?,
                    sla_user_vs_system_diff_days  = ?,
                    sla_notes                     = CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] ', ?),
                    sla_status                    = 'CALCULATED'
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
                message: 'Permintaan berhasil di-APPROVE',
                data: {
                    sla_info: {
                        original_requested_date: formatDateSafe(requestedDate),
                        system_floor_date: formatDateSafe(systemFloorDate),
                        final_target_date: formatDateSafe(finalTargetDate),
                        sla_source: slaSource,
                        approval_delay_days: approvalDelayDays,
                        explanation:
                            slaSource === 'SYSTEM'   ? `Tanggal user tidak realistis. HRD butuh minimal ${master.jlt_min_days} hari kerja.`
                          : slaSource === 'FLEXIBLE' ? 'Jabatan fleksibel. HRD akan bekerja sesuai kebutuhan.'
                          :                            'Tanggal user sudah realistis. HRD akan bekerja sesuai target.'
                    }
                }
            });

        // ========== REJECT: Batalkan SLA ==========
        } else {
            await connection.execute(
                'UPDATE t_recruitment_sla SET sla_status = "CANCELLED" WHERE sla_tpk_nomor = ?',
                [tpk_nomor]
            );

            await connection.commit();
            connection.release();

            return res.json({ success: true, message: 'Permintaan berhasil di-REJECT' });
        }

    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('❌ Error approval action:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * GET /api/recruitment/approval/hrd
 * Daftar permintaan yang sudah diapprove atasan, menunggu HRD
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
                sla.sla_source,
                sla.sla_status,
                COALESCE(sla.sla_hired_count, 0) as hired_count
            FROM tpermintaankaryawan p
            INNER JOIN tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN tkaryawan k ON k.kar_Nik = p.tpk_peminta
            LEFT JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            WHERE p.tpk_approveatasan = 1
        `;

        if (status === 'pending')  query += ' AND p.tpk_approveHRD = 0';
        if (status === 'approved') query += ' AND p.tpk_approveHRD = 1';

        query += ' ORDER BY p.tpk_tanggal DESC';

        const [rows] = await db.execute(query);
        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error approval/hrd:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * POST /api/recruitment/approval/hrd/action
 * HRD approve permintaan → Recruitment resmi dibuka
 */
router.post('/approval/hrd/action', authenticate, isHRD, async (req, res) => {
    const { tpk_nomor } = req.body;

    if (!tpk_nomor) {
        return res.status(400).json({ success: false, message: 'Parameter tpk_nomor diperlukan' });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [checkRows] = await connection.execute(
            'SELECT tpk_approveatasan, tpk_approveHRD FROM tpermintaankaryawan WHERE tpk_nomor = ? FOR UPDATE',
            [tpk_nomor]
        );

        if (checkRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ success: false, message: 'Permintaan tidak ditemukan' });
        }

        const current = checkRows[0];

        if (current.tpk_approveatasan !== 1) {
            await connection.rollback();
            connection.release();
            return res.status(403).json({
                success: false,
                message: 'Permintaan belum disetujui oleh atasan atau sudah ditolak'
            });
        }

        if (current.tpk_approveHRD !== 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ success: false, message: 'Permintaan sudah pernah diproses oleh HRD' });
        }

        await connection.execute(
            'UPDATE tpermintaankaryawan SET tpk_approveHRD = 1, tpk_tgl_approveHRD = NOW() WHERE tpk_nomor = ?',
            [tpk_nomor]
        );

        // ✅ PENTING: Catat waktu HRD approve di SLA sebagai penanda rekrutmen resmi dibuka
        // Status tetap CALCULATED — akan jadi COMPLETED otomatis via trigger DB (sync_sla_hired_count)
        // atau manual via endpoint /complete
        await connection.execute(
            `UPDATE t_recruitment_sla
             SET sla_notes = CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] HRD approve — rekrutmen dibuka.')
             WHERE sla_tpk_nomor = ? AND sla_status = 'CALCULATED'`,
            [tpk_nomor]
        );

        await connection.commit();
        connection.release();

        res.json({ success: true, message: 'HRD berhasil Approve — Recruitment Dibuka' });

    } catch (error) {
        await connection.rollback();
        connection.release();
        console.error('❌ Error HRD action:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * POST /api/recruitment/complete
 * HRD menutup permintaan secara manual (fallback jika trigger DB tidak jalan)
 * Dipakai ketika rekrutmen sudah selesai di aplikasi lama tapi SLA belum COMPLETED
 */
router.post('/complete', authenticate, isHRD, async (req, res) => {
    const { tpk_nomor, hired_count } = req.body;

    if (!tpk_nomor) {
        return res.status(400).json({ success: false, message: 'tpk_nomor diperlukan' });
    }

    try {
        const [check] = await db.execute(
            'SELECT sla_status, sla_hired_count FROM t_recruitment_sla WHERE sla_tpk_nomor = ?',
            [tpk_nomor]
        );

        if (check.length === 0) {
            return res.status(404).json({ success: false, message: 'SLA tidak ditemukan' });
        }

        if (check[0].sla_status === 'COMPLETED') {
            return res.status(400).json({ success: false, message: 'Permintaan sudah selesai' });
        }

        const finalHiredCount = (hired_count !== undefined && hired_count !== null)
            ? hired_count
            : check[0].sla_hired_count;

        await db.execute(
            `UPDATE t_recruitment_sla
             SET sla_status       = 'COMPLETED',
                 sla_completed_at = NOW(),
                 sla_hired_count  = ?,
                 sla_notes        = CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] Ditutup manual oleh HRD.')
             WHERE sla_tpk_nomor = ?`,
            [finalHiredCount, tpk_nomor]
        );

        res.json({ success: true, message: 'Permintaan berhasil ditutup' });

    } catch (error) {
        console.error('❌ Error complete:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * GET /api/recruitment/log/:tpk_nomor
 * Riwayat perubahan (audit trail) untuk satu permintaan
 */
router.get('/log/:tpk_nomor', authenticate, async (req, res) => {
    const { tpk_nomor } = req.params;
    const { user_kode, user_hrd } = req.user;

    try {
        // Verifikasi akses
        const [authCheck] = await db.execute(
            `SELECT p.tpk_peminta, k.kar_nik_atasan
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             WHERE p.tpk_nomor = ?`,
            [tpk_nomor]
        );

        if (authCheck.length === 0) {
            return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
        }

        const isAuthorized =
            user_hrd === 1 ||
            authCheck[0].tpk_peminta === user_kode ||
            authCheck[0].kar_nik_atasan === user_kode;

        if (!isAuthorized) {
            return res.status(403).json({ success: false, message: 'Akses ditolak' });
        }

        const [logs] = await db.execute(
            `SELECT 
                log.log_id,
                log.field_name,
                log.old_value,
                log.new_value,
                log.user_kode,
                k.kar_nama as user_nama,
                DATE_FORMAT(log.created_at, '%Y-%m-%d %H:%i:%s') as created_at
             FROM t_pkar_log log
             LEFT JOIN tkaryawan k ON k.kar_nik = log.user_kode
             WHERE log.tpk_nomor = ?
             ORDER BY log.created_at DESC`,
            [tpk_nomor]
        );

        res.json({ success: true, data: logs });

    } catch (error) {
        console.error('❌ Error log:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.patch('/:tpkNomor/editable', authenticate, isHRD, async (req, res) => {
    const { tpkNomor } = req.params;
    const { isEditable, keterangan } = req.body;
    const userKode = req.user.user_kode;

    if (isEditable === undefined || (isEditable !== 0 && isEditable !== 1)) {
        return res.status(400).json({
            success: false,
            message: 'isEditable harus bernilai 0 atau 1'
        });
    }

    if (isEditable === 1 && (!keterangan || keterangan.trim().length < 5)) {
        return res.status(400).json({
            success: false,
            message: 'Keterangan wajib diisi minimal 5 karakter saat membuka izin edit'
        });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [slaRows] = await conn.query(
            `SELECT sla_id, sla_is_editable, sla_status
             FROM t_recruitment_sla
             WHERE sla_tpk_nomor = ?`,
            [tpkNomor]
        );

        if (slaRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: 'SLA tidak ditemukan'
            });
        }

        const sla = slaRows[0];

        if (sla.sla_status !== 'CALCULATED') {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: `Tidak dapat mengubah izin edit, SLA berstatus ${sla.sla_status}`
            });
        }

        await conn.query(
            `UPDATE t_recruitment_sla SET sla_is_editable = ? WHERE sla_tpk_nomor = ?`,
            [isEditable, tpkNomor]
        );

        const actionLabel = isEditable === 1 ? 'edit_opened' : 'edit_closed';
        const logValue = isEditable === 1
            ? `Izin edit dibuka oleh HRD — ${(keterangan || '').trim()}`
            : `Izin edit ditutup oleh HRD`;

        await conn.query(
            `INSERT INTO t_pkar_log (tpk_nomor, user_kode, field_name, old_value, new_value)
             VALUES (?, ?, ?, ?, ?)`,
            [
                tpkNomor,
                userKode,
                actionLabel,
                sla.sla_is_editable === 1 ? 'editable' : 'locked',
                isEditable === 1 ? 'editable' : 'locked'
            ]
        );

        if (isEditable === 1 && keterangan) {
            await conn.query(
                `UPDATE t_recruitment_sla
                 SET sla_notes = CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] HRD minta update tanggal: ', ?)
                 WHERE sla_tpk_nomor = ?`,
                [keterangan.trim(), tpkNomor]
            );
        }

        await conn.commit();

        return res.json({
            success: true,
            message: isEditable === 1
                ? 'Izin edit tanggal berhasil dibuka. Peminta dapat mengubah tanggal.'
                : 'Izin edit tanggal berhasil ditutup.',
            data: {
                tpkNomor,
                isEditable,
                updatedBy: userKode
            }
        });

    } catch (err) {
        await conn.rollback();
        console.error('[PATCH editable] Error:', err);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengubah izin edit',
            error: err.message
        });
    } finally {
        conn.release();
    }
});


// ============================================================
// POST /recruitment/:tpkNomor/no-show
// Akses  : HRD only (user_hrd = 1)
// Body   : { bufferDays: number, keterangan: string }
// Fungsi : Tambah buffer hari ke sla_no_show_buffer_days
//          dan catat ke t_pkar_log sebagai audit trail.
// ============================================================

/**
 * POST /recruitment/:tpkNomor/no-show
 * Akses  : HRD only (user_hrd = 1)
 * Body   : { bufferDays: number, keterangan: string }
 * Fungsi : Tambah buffer hari ke sla_no_show_buffer_days
 *          dan catat ke t_pkar_log sebagai bukti audit.
 */
router.post('/:tpkNomor/no-show', authenticate, async (req, res) => {
  const { tpkNomor } = req.params;
  const { bufferDays, keterangan } = req.body;
  const userKode = req.user?.user_kode;
  const isHrd    = req.user?.user_hrd;

  // Hanya HRD yang boleh mencatat no-show
  if (!isHrd || isHrd !== 1) {
    return res.status(403).json({
      success: false,
      message: 'Hanya HRD yang dapat mencatat no-show'
    });
  }

  // Validasi input
  if (!bufferDays || isNaN(bufferDays) || bufferDays <= 0 || bufferDays > 30) {
    return res.status(400).json({
      success: false,
      message: 'bufferDays harus angka antara 1-30'
    });
  }

  if (!keterangan || keterangan.trim().length < 5) {
    return res.status(400).json({
      success: false,
      message: 'Keterangan wajib diisi minimal 5 karakter'
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Ambil nilai buffer saat ini sekaligus validasi SLA ada
    const [slaRows] = await conn.query(
      `SELECT sla_id, sla_no_show_buffer_days, sla_status
       FROM t_recruitment_sla
       WHERE sla_tpk_nomor = ?`,
      [tpkNomor]
    );

    if (slaRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        message: 'SLA tidak ditemukan untuk permintaan ini'
      });
    }

    const sla = slaRows[0];

    // Tidak boleh tambah buffer jika sudah COMPLETED atau CANCELLED
    if (sla.sla_status === 'COMPLETED' || sla.sla_status === 'CANCELLED') {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: `Tidak dapat mencatat no-show, SLA sudah berstatus ${sla.sla_status}`
      });
    }

    const oldBuffer = sla.sla_no_show_buffer_days || 0;
    const newBuffer = oldBuffer + parseInt(bufferDays);

    // 2. Update sla_no_show_buffer_days
    await conn.query(
      `UPDATE t_recruitment_sla
       SET sla_no_show_buffer_days = ?
       WHERE sla_tpk_nomor = ?`,
      [newBuffer, tpkNomor]
    );

    // 3. Catat ke t_pkar_log sebagai bukti audit
    //    field_name = 'no_show_buffer' agar mudah difilter
    //    new_value  = gabungan angka + keterangan HRD
    await conn.query(
      `INSERT INTO t_pkar_log
         (tpk_nomor, user_kode, field_name, old_value, new_value)
       VALUES (?, ?, 'no_show_buffer', ?, ?)`,
      [
        tpkNomor,
        userKode,
        `${oldBuffer} hari`,
        `${newBuffer} hari (+${bufferDays}) — ${keterangan.trim()}`
      ]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: `Buffer no-show +${bufferDays} hari berhasil dicatat`,
      data: {
        tpkNomor,
        oldBufferDays : oldBuffer,
        newBufferDays : newBuffer,
        addedDays     : parseInt(bufferDays),
        keterangan    : keterangan.trim(),
        recordedBy    : userKode,
        recordedAt    : new Date().toISOString()
      }
    });

  } catch (err) {
    await conn.rollback();
    console.error('[POST no-show] Error:', err);
    return res.status(500).json({
      success: false,
      message: 'Gagal mencatat no-show',
      error: err.message
    });
  } finally {
    conn.release();
  }
});

module.exports = router;