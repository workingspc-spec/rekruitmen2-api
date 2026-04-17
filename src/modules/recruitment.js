// src/modules/recruitment.js
const express = require('express');
const db = require('../config/db');
const router = express.Router();
const { authenticate, isHRD, isManager } = require('../middleware/authMiddleware');
const { addWorkdays, countWorkdays, formatDateSafe } = require('../utils/workdayCalculator');

// ── update the destructure at top of file ──
const {
    upsertRow      : syncUpsert,
    updateApproval : syncApproval,
    deleteRows     : syncDeleteRows,
    fullSync       : syncAllIndex,   // ← ADD THIS
} = require('../utils/tpkIndexSync');

// [FIX H4] Konstanta batas panjang sla_notes — terpusat di satu tempat
const MAX_NOTES_LENGTH = 3000;

/**
 * =====================================================================
 * MODULE: RECRUITMENT REQUEST
 * =====================================================================
 */

/**
 * VALIDASI TANGGAL BUTUH DARI DATABASE
 * [FIX K1] Tambahkan prefix hrd2. pada FROM tjabatan agar query tidak
 * bergantung pada DB_NAME default (rekruitmen2) yang tidak memiliki tabel ini.
 */
async function validateTglButuhFromDB(connection, jab_kode, tgl_butuh, ignoreLeadTime = false) {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [y, m, d] = tgl_butuh.split('-').map(Number);
        const requestedDate = new Date(y, m - 1, d, 0, 0, 0, 0);

        if (ignoreLeadTime) {
            if (requestedDate < today) {
                return { valid: false, message: 'Untuk re-schedule, tanggal minimal adalah hari ini.' };
            }
            return { valid: true };
        }

        // [FIX K1] hrd2.tjabatan (bukan tjabatan saja)
        const [rows] = await connection.execute(
            `SELECT COALESCE(jlt.jlt_min_days, 7) as min_days, 
                    COALESCE(jlt.jlt_is_flexible, 0) as is_flexible
             FROM hrd2.tjabatan j
             LEFT JOIN rekruitmen2.job_lead_time_master jlt 
                ON jlt.jlt_job_code = j.jab_kode AND jlt.jlt_active = 1
             WHERE j.jab_kode = ?`,
            [jab_kode]
        );

        if (rows.length === 0) return { valid: false, message: 'Jabatan tidak ditemukan' };

        const { min_days, is_flexible } = rows[0];
        if (is_flexible === 1) return { valid: true };

        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const minDateObj = addWorkdays(tomorrow, min_days - 1);
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

// ── ADD: Manual Sync state (module-level, lives in Node.js RAM) ──
let _isSyncing    = false;
let _lastSyncTime = 0;
const MANUAL_SYNC_COOLDOWN_MS = 30_000; // 30 detik

/**
 * POST /api/recruitment/sync-manual
 * Dipanggil saat user Pull-to-Refresh di Android atau klik Refresh di Web.
 * Hanya men-sync shadow table (tpk_index_helper), BUKAN menjalankan SLA cron.
 *
 * Anti-spam: mutex lock + 30-detik cooldown.
 * Meski 100 user ngeklik refresh bersamaan, DB hanya dipukul 1x per window.
 */
router.post('/sync-manual', authenticate, async (req, res) => {
    const now = Date.now();

    // Cooldown: belum 30 detik dari sync terakhir — skip DB, langsung OK
    if (now - _lastSyncTime < MANUAL_SYNC_COOLDOWN_MS) {
        return res.json({
            success: true,
            synced:  false,
            message: 'Data masih segar, sinkronisasi dilewati.'
        });
    }

    // Mutex: sudah ada sync yang sedang jalan saat ini
    if (_isSyncing) {
        return res.json({
            success: true,
            synced:  false,
            message: 'Sinkronisasi sedang berjalan di background.'
        });
    }

    try {
        _isSyncing = true;
        await syncAllIndex(db);
        _lastSyncTime = Date.now();
        _isSyncing    = false;

        return res.json({
            success: true,
            synced:  true,
            message: 'Sinkronisasi manual berhasil.'
        });
    } catch (error) {
        _isSyncing = false;
        console.error('❌ Manual sync error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Gagal sinkronisasi data.',
            error:   error.message
        });
    }
});

// =====================================================================

/**
 * GET /api/recruitment/jabatan-rules
 * [FIX K2] Tambahkan prefix hrd2. pada FROM tjabatan agar query tidak
 * bergantung pada DB_NAME default (rekruitmen2) yang tidak memiliki tabel ini.
 */
router.get('/jabatan-rules', authenticate, async (req, res) => {
    try {
        // [FIX K2] hrd2.tjabatan (bukan tjabatan saja)
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
            FROM hrd2.tjabatan j
            LEFT JOIN rekruitmen2.job_lead_time_master jlt 
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
 */
// ─── my-requests ────────────────────────────────────────────────────────────
router.get('/my-requests', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;

    try {
        let rows;

        const SELECT_COLS = `
            p.tpk_nomor,
            TRIM(p.tpk_peminta) as tpk_peminta,
            COALESCE(kp.kar_nama, TRIM(p.tpk_peminta)) as peminta_nama,
            j.jab_nama,
            p.tpk_bagian,
            p.tpk_jumlah,
            COALESCE(p.tpk_approveatasan, 0) as tpk_approveatasan,
            COALESCE(p.tpk_approveHRD, 0) as tpk_approveHRD,
            CASE 
                WHEN p.tpk_approveHRD = 2 THEN 'REJECTED HRD'
                WHEN p.tpk_approveatasan = 2 THEN 'REJECTED ATASAN'
                WHEN p.tpk_approveHRD = 1 THEN 'APPROVED HRD'
                WHEN p.tpk_approveatasan IN (1, 9) THEN 'APPROVED ATASAN'
                ELSE 'BLM APPROVE'
            END as status,
            DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
            DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
            DATE_FORMAT(p.tpk_tgl_approveatasan, '%Y-%m-%d') as tgl_approve_atasan,
            DATE_FORMAT(p.tpk_tgl_approveHRD, '%Y-%m-%d') as tgl_approve_hrd,
            COALESCE(sla.sla_hired_count, 0) as hired_count,
            sla.sla_final_target_date,
            sla.sla_source,
            COALESCE(sla.sla_status, CASE WHEN COALESCE(p.tpk_approveatasan, 0) = 0 THEN 'PENDING' ELSE 'COMPLETED' END) as sla_status,
            COALESCE(sla.sla_is_editable, 0) as sla_is_editable
        `;

        if (is_hrd) {
            [rows] = await db.execute(`
                SELECT ${SELECT_COLS}
                FROM hrd2.tpermintaankaryawan p
                INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
                LEFT JOIN hrd2.tkaryawan kp ON kp.kar_nik = TRIM(p.tpk_peminta)
                LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
                ORDER BY p.tpk_tanggal DESC
            `);
        } else {
            [rows] = await db.execute(`
                SELECT ${SELECT_COLS}
                FROM rekruitmen2.tpk_index_helper h
                INNER JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = h.tpk_nomor
                INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
                LEFT JOIN hrd2.tkaryawan kp ON kp.kar_nik = TRIM(p.tpk_peminta)
                LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
                WHERE h.tpk_peminta = ?
                ORDER BY h.tpk_tanggal DESC
            `, [user_kode]);
        }

        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error my-requests:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * GET /api/recruitment/detail
 */
// ─── detail ─────────────────────────────────────────────────────────────────
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
                COALESCE(k.kar_nama, t.tpk_peminta) as peminta_nama,
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
            FROM hrd2.tpermintaankaryawan t
            JOIN hrd2.tjabatan j ON j.jab_kode = t.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = TRIM(t.tpk_peminta)
            LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = t.tpk_nomor
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
 * [FIX H5] Tambahkan validasi input sebelum proses DB
 * [FIX H3] Ganti SELECT MAX + FOR UPDATE dengan sequence table atomic
 * [FIX H4] LEFT(CONCAT(...), MAX_NOTES_LENGTH) untuk semua update sla_notes
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

    // [FIX H5] Validasi input dasar — tanpa library eksternal
    const validationErrors = [];
    if (jab_kode && (typeof jab_kode !== 'string' || jab_kode.length > 20)) {
        validationErrors.push('jab_kode tidak valid (max 20 karakter)');
    }
    if (bagian && (typeof bagian !== 'string' || bagian.length > 100)) {
        validationErrors.push('bagian tidak valid (max 100 karakter)');
    }
    if (tgl_butuh && !/^\d{4}-\d{2}-\d{2}$/.test(tgl_butuh)) {
        validationErrors.push('tgl_butuh format tidak valid (harus YYYY-MM-DD)');
    }
    const jumlahNum = Number(jumlah);
    if (jumlah !== undefined && (isNaN(jumlahNum) || jumlahNum < 1 || jumlahNum > 100 || !Number.isInteger(jumlahNum))) {
        validationErrors.push('jumlah harus angka bulat antara 1–100');
    }
    if (alasan && typeof alasan === 'string' && alasan.length > 200) {
        validationErrors.push('alasan terlalu panjang (max 200 karakter)');
    }
    if (validationErrors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validasi gagal',
            errors: validationErrors
        });
    }

    const user_kode = req.user.user_kode;
    const connection = await db.getConnection();

    try {
        // ==================== UPDATE ====================
        if (tpk_nomor) {
            await connection.beginTransaction();

            if (jab_kode && tgl_butuh) {
                const [slaCheck] = await connection.execute(
                    'SELECT sla_is_editable FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?',
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
                FROM hrd2.tpermintaankaryawan p
                LEFT JOIN rekruitmen2.t_recruitment_sla s ON s.sla_tpk_nomor = p.tpk_nomor
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

            if (isEditable) {
                // [FIX H4] LEFT(CONCAT(...), MAX_NOTES_LENGTH)
                await connection.execute(
                    `UPDATE rekruitmen2.t_recruitment_sla SET
                        sla_job_code = ?,
                        sla_original_requested_date = ?,
                        sla_system_ceiling_date = ?,
                        sla_source = CASE 
                            WHEN ? >= sla_system_floor_date THEN 'USER' 
                            ELSE sla_source 
                        END,
                        sla_final_target_date = GREATEST(COALESCE(sla_system_floor_date, CURDATE()), ?),
                        sla_max_target_date   = GREATEST(sla_max_target_date, ?),
                        sla_is_editable = 0,
                        sla_notes = LEFT(CONCAT(
                            COALESCE(sla_notes,''),
                            '\n[', NOW(), '] Re-schedule oleh User (New Date: ', ?, ')'
                        ), ${MAX_NOTES_LENGTH})
                    WHERE sla_tpk_nomor = ?`,
                    [jab_kode, tgl_butuh, tgl_butuh, tgl_butuh, tgl_butuh, tgl_butuh, tgl_butuh, tpk_nomor]
                );
            }

            await connection.execute(`
                UPDATE hrd2.tpermintaankaryawan SET
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

            const [slaIdRow] = await connection.execute(
                'SELECT sla_id FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?',
                [tpk_nomor]
            );
            const sla_id = slaIdRow.length > 0 ? slaIdRow[0].sla_id : null;

            const changes = [
                { field: 'tpk_jumlah',   old: current.tpk_jumlah,   new: jumlah    },
                { field: 'tpk_tgl_butuh', old: current.tpk_tgl_butuh, new: tgl_butuh },
                { field: 'tpk_jab_kode', old: current.tpk_jab_kode, new: jab_kode  }
            ];

            for (const c of changes) {
                if (String(c.old) !== String(c.new)) {
                    await connection.execute(
                        `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value)
                        VALUES (?, ?, ?, ?, ?, ?)`,
                        [tpk_nomor, sla_id, user_kode, c.field,
                        c.old !== null ? String(c.old) : null,
                        c.new !== null ? String(c.new) : null]
                    );
                }
            }

            if (isDraft) {
                await connection.execute(
                    `UPDATE rekruitmen2.t_recruitment_sla
                     SET sla_job_code = ?,
                         sla_original_requested_date = ?,
                         sla_system_ceiling_date = ?
                     WHERE sla_tpk_nomor = ? AND sla_status = 'PENDING'`,
                    [jab_kode, tgl_butuh, tgl_butuh, tpk_nomor]
                );
            }

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

            // [FIX H3] Ganti SELECT MAX + FOR UPDATE dengan sequence table atomic.
            await connection.execute(
                `INSERT INTO rekruitmen2.tpk_sequence (seq_year, seq_last)
                 VALUES (?, 1)
                 ON DUPLICATE KEY UPDATE seq_last = seq_last + 1`,
                [year]
            );
            const [[{ seq }]] = await connection.execute(
                `SELECT seq_last AS seq FROM rekruitmen2.tpk_sequence WHERE seq_year = ?`,
                [year]
            );
            const nextNomor = String(seq).padStart(3, '0');
            const newNomor  = `${nextNomor}/HRD/PKAR/${month}/${year}`;

            await connection.execute(`
                INSERT INTO hrd2.tpermintaankaryawan (
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

            // Write-through ke shadow table
            await syncUpsert(connection, {
                tpk_nomor:         newNomor,
                tpk_peminta:       user_kode,
                tpk_approveatasan: 0,
                tpk_approveHRD:    0,
                tpk_tanggal:       new Date().toISOString().split('T')[0],
            });

            const [slaResult] = await connection.execute(
                `INSERT INTO rekruitmen2.t_recruitment_sla (
                    sla_tpk_nomor, sla_job_code,
                    sla_original_requested_date, sla_system_ceiling_date,
                    sla_request_created_at, sla_status
                ) VALUES (?, ?, ?, ?, NOW(), 'PENDING')`,
                [newNomor, jab_kode, tgl_butuh, tgl_butuh]
            );

            const newSlaId = slaResult.insertId;

            await connection.execute(
                `INSERT INTO rekruitmen2.t_pkar_log (
                    tpk_nomor, sla_id, user_kode, field_name, old_value, new_value
                ) VALUES (?, ?, ?, 'created', NULL, 'NEW_REQUEST')`,
                [newNomor, newSlaId, user_kode]
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

        if (error.code === 'ER_DUP_ENTRY') {
            console.warn(`⚠️ [recruitment/save] Duplicate nomor detected. Error: ${error.message}`);
            return res.status(409).json({
                success: false,
                message: 'Sistem sedang memproses permintaan lain. Silakan coba simpan sekali lagi dalam beberapa detik.'
            });
        }

        console.error('❌ Error save:', error.message);
        res.status(500).json({ success: false, message: 'Gagal menyimpan data', error: error.message });
    }
});

// =====================================================================

/**
 * GET /api/recruitment/approval/atasan
 */
router.get('/approval/atasan', authenticate, isManager, async (req, res) => {
    const { status } = req.query;
    const user_kode = req.user.user_kode;

    try {
        let shadowFilter = '';
        if (status === 'pending')  shadowFilter = 'AND h.tpk_approveatasan = 0';
        if (status === 'approved') shadowFilter = 'AND h.tpk_approveatasan IN (1, 9)';
        if (status === 'rejected') shadowFilter = 'AND h.tpk_approveatasan = 2';

        const [rows] = await db.execute(`
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
            FROM rekruitmen2.tpk_index_helper h
            INNER JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = h.tpk_nomor
            INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = p.tpk_peminta
            WHERE k.kar_nik_atasan = ?
            ${shadowFilter}
            ORDER BY p.tpk_tanggal DESC
        `, [user_kode]);

        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error approval/atasan:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * POST /api/recruitment/approval/atasan/action
 * [FIX H4] sla_notes dengan LEFT() limit
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
        if (action === 'APPROVE')      statusVal = 9;
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
                p.tpk_jumlah,
                k.kar_nik_atasan,
                sla.sla_id,
                sla.sla_original_requested_date,
                sla.sla_request_created_at
             FROM hrd2.tpermintaankaryawan p
             LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = p.tpk_peminta
             LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
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
            'UPDATE hrd2.tpermintaankaryawan SET tpk_approveatasan = ?, tpk_tgl_approveatasan = NOW() WHERE tpk_nomor = ?',
            [statusVal, tpk_nomor]
        );

        await syncApproval(connection, tpk_nomor, statusVal, 0);

        if (statusVal === 9) {
            // [FIX H4] LEFT(CONCAT(...), MAX_NOTES_LENGTH)
            await connection.execute(
                `UPDATE rekruitmen2.t_recruitment_sla SET
                    sla_notes = LEFT(CONCAT(
                        COALESCE(sla_notes,''),
                        '\n[', NOW(), '] Disetujui Atasan. Menunggu proses verifikasi HRD.'
                    ), ${MAX_NOTES_LENGTH})
                WHERE sla_tpk_nomor = ? AND sla_status = 'PENDING'`,
                [tpk_nomor]
            );

            await connection.commit();
            connection.release();

            return res.json({
                success: true,
                message: 'Permintaan berhasil di-APPROVE oleh Atasan. Menunggu persetujuan HRD.'
            });

        } else {
            await connection.execute(
                'UPDATE rekruitmen2.t_recruitment_sla SET sla_status = "CANCELLED" WHERE sla_tpk_nomor = ?',
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
 */
router.get('/approval/hrd', authenticate, isHRD, async (req, res) => {
    const { status } = req.query;

    try {
        let shadowFilter = 'AND h.tpk_approveatasan IN (1, 9)';
        if (status === 'pending')  shadowFilter += ' AND h.tpk_approveHRD = 0';
        if (status === 'approved') shadowFilter += ' AND h.tpk_approveHRD = 1';

        const [rows] = await db.execute(`
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
            FROM rekruitmen2.tpk_index_helper h
            INNER JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = h.tpk_nomor
            INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = p.tpk_peminta
            LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            WHERE 1=1 ${shadowFilter}
            ORDER BY p.tpk_tanggal DESC
        `);

        res.json({ success: true, data: rows });

    } catch (error) {
        console.error('❌ Error approval/hrd:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * POST /api/recruitment/approval/hrd/action
 * [FIX H4] sla_notes dengan LEFT() limit
 */
router.post('/approval/hrd/action', authenticate, isHRD, async (req, res) => {
    const { tpk_nomor, action, alasan_tolak } = req.body;

    if (!tpk_nomor) {
        return res.status(400).json({ success: false, message: 'Parameter tpk_nomor diperlukan' });
    }
    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
        return res.status(400).json({ success: false, message: 'Action harus APPROVE atau REJECT' });
    }
    if (action === 'REJECT' && (!alasan_tolak || !alasan_tolak.trim())) {
        return res.status(400).json({ success: false, message: 'Alasan penolakan wajib diisi' });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [checkRows] = await connection.execute(
            `SELECT
                p.tpk_approveatasan,
                p.tpk_approveHRD,
                p.tpk_tanggal,
                p.tpk_tgl_butuh,
                p.tpk_jab_kode,
                p.tpk_jumlah,
                sla.sla_id,
                sla.sla_original_requested_date,
                sla.sla_request_created_at
             FROM hrd2.tpermintaankaryawan p
             LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             WHERE p.tpk_nomor = ?
             FOR UPDATE`,
            [tpk_nomor]
        );

        if (checkRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ success: false, message: 'Permintaan tidak ditemukan' });
        }

        const current = checkRows[0];

        if (current.tpk_approveatasan !== 9 && current.tpk_approveatasan !== 1) {
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

        // ── REJECT ──
        if (action === 'REJECT') {
            await connection.execute(
                'UPDATE hrd2.tpermintaankaryawan SET tpk_approveHRD = 2, tpk_tgl_approveHRD = NOW() WHERE tpk_nomor = ?',
                [tpk_nomor]
            );

            await syncApproval(connection, tpk_nomor, current.tpk_approveatasan, 2);

            // [FIX H4] LEFT(CONCAT(...), MAX_NOTES_LENGTH)
            await connection.execute(
                `UPDATE rekruitmen2.t_recruitment_sla SET
                    sla_status = 'CANCELLED',
                    sla_notes  = LEFT(CONCAT(
                        COALESCE(sla_notes,''),
                        '\n[', NOW(), '] Ditolak HRD. Alasan: ', ?
                    ), ${MAX_NOTES_LENGTH})
                 WHERE sla_tpk_nomor = ?`,
                [alasan_tolak.trim(), tpk_nomor]
            );

            await connection.commit();
            connection.release();

            return res.json({ success: true, message: 'Permintaan ditolak oleh HRD.' });
        }

        // ── APPROVE ──
        await connection.execute(
            'UPDATE hrd2.tpermintaankaryawan SET tpk_approveHRD = 1, tpk_approveatasan = 1, tpk_tgl_approveHRD = NOW() WHERE tpk_nomor = ?',
            [tpk_nomor]
        );

        await syncApproval(connection, tpk_nomor, 1, 1);

        const [masterData] = await connection.execute(
            'SELECT jlt_min_days, jlt_max_days, jlt_is_flexible FROM rekruitmen2.job_lead_time_master WHERE jlt_job_code = ? AND jlt_active = 1',
            [current.tpk_jab_kode]
        );

        let master = { jlt_min_days: 14, jlt_max_days: 30, jlt_is_flexible: 0 };
        if (masterData.length === 0) {
            console.warn(`[WARNING] Master lead time untuk ${current.tpk_jab_kode} tidak ditemukan. Menggunakan fallback 14 hari.`);
        } else {
            master = masterData[0];
        }

        const jumlahDiminta = current.tpk_jumlah || 1;
        let extraDays = 0;
        if (jumlahDiminta > 1) {
            if      (jumlahDiminta <= 3) extraDays = 3;
            else if (jumlahDiminta <= 5) extraDays = 6;
            else                         extraDays = 6 + (jumlahDiminta - 5);
        }
        if (master.jlt_is_flexible !== 1 && extraDays > 0) {
            master.jlt_min_days += extraDays;
            master.jlt_max_days += extraDays;
        }

        const approvedAt = new Date();
        approvedAt.setHours(0, 0, 0, 0);

        const rawOriginal = current.sla_original_requested_date.toString().split('T')[0];
        const [y, m, d]   = rawOriginal.split('-').map(Number);
        const requestedDate = new Date(y, m - 1, d, 0, 0, 0, 0);
        const createdAt     = new Date(current.sla_request_created_at);

        let systemFloorDate = null;
        let finalTargetDate = null;
        let maxTargetDate   = null;
        let slaSource       = null;

        const approvalDelayDays = countWorkdays(createdAt, approvedAt);

        if (master.jlt_is_flexible === 1) {
            finalTargetDate = requestedDate;
            maxTargetDate   = requestedDate;
            slaSource = 'FLEXIBLE';
        } else {
            systemFloorDate = addWorkdays(approvedAt, master.jlt_min_days);
            maxTargetDate   = addWorkdays(approvedAt, master.jlt_max_days);

            if (systemFloorDate.getTime() > requestedDate.getTime()) {
                finalTargetDate = systemFloorDate;
                slaSource = 'SYSTEM';
            } else {
                systemFloorDate = requestedDate;
                finalTargetDate = requestedDate;
                slaSource = 'USER';
            }
        }

        const diffDays   = countWorkdays(requestedDate, finalTargetDate);
        const bulkNote   = extraDays > 0
            ? ` (Penambahan +${extraDays} hari untuk pencarian massal ${jumlahDiminta} orang).`
            : '';
        const approvalNote = `Disetujui HRD — rekrutmen resmi dibuka.`;

        // [FIX H4] LEFT(CONCAT(...), MAX_NOTES_LENGTH)
        await connection.execute(
            `UPDATE rekruitmen2.t_recruitment_sla SET
                sla_approved_at               = NOW(),
                sla_calculated_at             = NOW(),
                sla_min_days                  = ?,
                sla_max_days                  = ?,
                sla_is_flexible               = ?,
                sla_system_floor_date         = ?,
                sla_final_target_date         = ?,
                sla_max_target_date           = ?,
                sla_original_requested_date   = ?,
                sla_source                    = ?,
                sla_approval_delay_days       = ?,
                sla_user_vs_system_diff_days  = ?,
                sla_notes                     = LEFT(CONCAT(
                    COALESCE(sla_notes,''),
                    '\n[', NOW(), '] ', ?
                ), ${MAX_NOTES_LENGTH}),
                sla_status                    = 'CALCULATED'
            WHERE sla_tpk_nomor = ?`,
            [
                master.jlt_min_days,
                master.jlt_max_days,
                master.jlt_is_flexible,
                formatDateSafe(systemFloorDate),
                formatDateSafe(finalTargetDate),
                formatDateSafe(maxTargetDate),
                formatDateSafe(requestedDate),
                slaSource,
                approvalDelayDays,
                diffDays,
                approvalNote + bulkNote,
                tpk_nomor
            ]
        );

        await connection.commit();
        connection.release();

        return res.json({
            success: true,
            message: 'HRD berhasil Approve — Rekrutmen Dibuka & SLA mulai dihitung.',
            data: {
                sla_info: {
                    original_requested_date: formatDateSafe(requestedDate),
                    system_floor_date:       formatDateSafe(systemFloorDate),
                    final_target_date:       formatDateSafe(finalTargetDate),
                    sla_source:              slaSource,
                    approval_delay_days:     approvalDelayDays,
                    explanation:
                        slaSource === 'SYSTEM'
                            ? `Tanggal disesuaikan otomatis. HRD butuh minimal ${master.jlt_min_days} hari kerja.`
                        : slaSource === 'FLEXIBLE'
                            ? 'Jabatan fleksibel. HRD akan bekerja sesuai kebutuhan.'
                            : 'Tanggal sudah realistis. HRD akan bekerja sesuai target.'
                }
            }
        });

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
 * [FIX H4] sla_notes dengan LEFT() limit
 */
router.post('/complete', authenticate, isHRD, async (req, res) => {
    const { tpk_nomor } = req.body;
    const userKode = req.user.user_kode;

    if (!tpk_nomor) {
        return res.status(400).json({ success: false, message: 'tpk_nomor diperlukan' });
    }

    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();

        const [check] = await conn.execute(
            'SELECT sla_id, sla_status FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ? FOR UPDATE',
            [tpk_nomor]
        );

        if (check.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: 'SLA tidak ditemukan' });
        }

        const { sla_id, sla_status } = check[0];

        if (sla_status === 'COMPLETED') {
            await conn.rollback();
            return res.status(400).json({ success: false, message: 'Permintaan sudah selesai' });
        }

        // [FIX H4] LEFT(CONCAT(...), MAX_NOTES_LENGTH)
        await conn.execute(
            `UPDATE rekruitmen2.t_recruitment_sla
             SET sla_status       = 'COMPLETED',
                 sla_completed_at = NOW(),
                 sla_is_editable  = 0,
                 sla_notes        = LEFT(CONCAT(
                     COALESCE(sla_notes,''),
                     '\n[', NOW(), '] Ditutup manual oleh HRD. Progress sesuai data riil.'
                 ), ${MAX_NOTES_LENGTH})
             WHERE sla_tpk_nomor = ?`,
            [tpk_nomor]
        );

        await conn.execute(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value) 
             VALUES (?, ?, ?, 'status_sla', 'CALCULATED', 'COMPLETED (Tutup Manual)')`,
            [tpk_nomor, sla_id, userKode]
        );

        await conn.commit();
        res.json({ success: true, message: 'Permintaan berhasil ditutup' });

    } catch (error) {
        await conn.rollback();
        console.error('❌ Error complete:', error.message);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        conn.release();
    }
});

// =====================================================================

/**
 * GET /api/recruitment/log/:tpk_nomor
 */
router.get('/log/:tpk_nomor', authenticate, async (req, res) => {
    const { tpk_nomor } = req.params;
    const { user_kode, user_hrd } = req.user;

    try {
        const [authCheck] = await db.execute(
            `SELECT p.tpk_peminta, k.kar_nik_atasan
             FROM hrd2.tpermintaankaryawan p
             LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
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

        const [slaRow] = await db.execute(
            'SELECT sla_id FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?',
            [tpk_nomor]
        );
        const sla_id = slaRow.length > 0 ? slaRow[0].sla_id : null;

        const [logs] = await db.execute(
            `SELECT 
                log.log_id,
                log.field_name,
                log.old_value,
                log.new_value,
                log.user_kode,
                k.kar_nama as user_nama,
                DATE_FORMAT(log.created_at, '%Y-%m-%d %H:%i:%s') as created_at
             FROM rekruitmen2.t_pkar_log log
             LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = log.user_kode
             WHERE (log.sla_id = ? OR (log.sla_id IS NULL AND log.tpk_nomor = ?))
             ORDER BY log.created_at DESC`,
            [sla_id, tpk_nomor]
        );

        res.json({ success: true, data: logs });

    } catch (error) {
        console.error('❌ Error log:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================

/**
 * PATCH /api/recruitment/:tpkNomor/editable
 * [FIX H4] sla_notes dengan LEFT() limit
 */
router.patch('/:tpkNomor/editable', authenticate, isHRD, async (req, res) => {
    const { tpkNomor } = req.params;
    const { isEditable, keterangan } = req.body;
    const userKode = req.user.user_kode;

    if (isEditable === undefined || (isEditable !== 0 && isEditable !== 1)) {
        return res.status(400).json({ success: false, message: 'isEditable harus bernilai 0 atau 1' });
    }

    if (isEditable === 1 && (!keterangan || keterangan.trim().length < 5)) {
        return res.status(400).json({ success: false, message: 'Keterangan wajib diisi minimal 5 karakter saat membuka izin edit' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [slaRows] = await conn.query(
            `SELECT sla_id, sla_is_editable, sla_status FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?`,
            [tpkNomor]
        );

        if (slaRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: 'SLA tidak ditemukan' });
        }

        const sla = slaRows[0];

        if (sla.sla_status !== 'CALCULATED') {
            await conn.rollback();
            return res.status(400).json({ success: false, message: `Tidak dapat mengubah izin edit, SLA berstatus ${sla.sla_status}` });
        }

        await conn.query(
            `UPDATE rekruitmen2.t_recruitment_sla SET sla_is_editable = ? WHERE sla_tpk_nomor = ?`,
            [isEditable, tpkNomor]
        );

        const actionLabel = isEditable === 1 ? 'edit_opened' : 'edit_closed';

        await conn.query(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [tpkNomor, sla.sla_id, userKode, actionLabel,
             sla.sla_is_editable === 1 ? 'editable' : 'locked',
             isEditable === 1 ? 'editable' : 'locked']
        );

        if (isEditable === 1 && keterangan) {
            // [FIX H4] LEFT(CONCAT(...), MAX_NOTES_LENGTH)
            await conn.query(
                `UPDATE rekruitmen2.t_recruitment_sla
                 SET sla_notes = LEFT(CONCAT(
                     COALESCE(sla_notes,''),
                     '\n[', NOW(), '] HRD minta update tanggal: ', ?
                 ), ${MAX_NOTES_LENGTH})
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
            data: { tpkNomor, isEditable, updatedBy: userKode }
        });

    } catch (err) {
        await conn.rollback();
        console.error('[PATCH editable] Error:', err);
        return res.status(500).json({ success: false, message: 'Gagal mengubah izin edit', error: err.message });
    } finally {
        conn.release();
    }
});

// =====================================================================

router.post('/:tpkNomor/no-show', authenticate, async (req, res) => {
    const { tpkNomor } = req.params;
    const { bufferDays, keterangan } = req.body;
    const userKode = req.user?.user_kode;
    const isHrdUser = req.user?.user_hrd;

    if (!isHrdUser || isHrdUser !== 1) { return res.status(403).json({ success: false, message: 'Hanya HRD' }); }
    if (!bufferDays || isNaN(bufferDays) || bufferDays <= 0 || bufferDays > 30) { return res.status(400).json({ success: false, message: 'bufferDays 1-30' }); }
    if (!keterangan || keterangan.trim().length < 5) { return res.status(400).json({ success: false, message: 'Keterangan minimal 5 karakter' }); }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [slaRows] = await conn.query(
            `SELECT sla_id, sla_no_show_buffer_days, sla_status, sla_hired_count FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?`,
            [tpkNomor]
        );

        if (slaRows.length === 0) { await conn.rollback(); return res.status(404).json({ success: false, message: 'SLA tidak ditemukan' }); }

        const sla = slaRows[0];

        if (sla.sla_status === 'CANCELLED') { await conn.rollback(); return res.status(400).json({ success: false, message: `Tidak dapat mencatat no-show, SLA sudah CANCELLED` }); }

        const oldBuffer = sla.sla_no_show_buffer_days || 0;
        const newBuffer = oldBuffer + parseInt(bufferDays);

        let statusUpdateQuery = "";
        if (sla.sla_status === 'COMPLETED') {
            statusUpdateQuery = `, sla_status = 'CALCULATED', sla_completed_at = NULL, sla_hired_count = GREATEST(0, sla_hired_count - 1)`;
        }

        await conn.query(
            `UPDATE rekruitmen2.t_recruitment_sla SET sla_no_show_buffer_days = ? ${statusUpdateQuery} WHERE sla_tpk_nomor = ?`,
            [newBuffer, tpkNomor]
        );

        await conn.query(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value)
             VALUES (?, ?, ?, 'no_show_buffer', ?, ?)`,
            [tpkNomor, sla.sla_id, userKode, `${oldBuffer} hari`, `${newBuffer} hari (+${bufferDays}) — ${keterangan.trim()}`]
        );

        await conn.commit();
        return res.json({ success: true, message: `Buffer no-show berhasil dicatat.` });

    } catch (err) {
        await conn.rollback();
        res.status(500).json({ success: false, message: 'Gagal mencatat no-show', error: err.message });
    } finally {
        conn.release();
    }
});

// =====================================================================

router.get('/:tpkNomor/hired-candidates', authenticate, async (req, res) => {
    try {
        const { tpkNomor } = req.params;
        const [rows] = await db.query(`
            SELECT 
                rpk_nomor AS rkt_nomor, 
                rpk_keterangannama AS nama, 
                rpk_tanggal AS tgl_diterima,
                COALESCE(rpk_jumlah, 1) as rpk_jumlah
            FROM hrd2.triilpermintaankaryawan
            WHERE rpk_tpk_nomor = ?
        `, [tpkNomor]);

        const processedCandidates = [];

        rows.forEach(row => {
            const rawNama = row.nama || 'Tanpa Nama';
            if (rawNama.includes('\n')) {
                const splitNames = rawNama.split(/\r?\n/).filter(n => n.trim() !== '');
                splitNames.forEach(namePiece => {
                    processedCandidates.push({ rkt_nomor: row.rkt_nomor, nama: namePiece.trim(), tgl_diterima: row.tgl_diterima, is_grouped: true });
                });
            } else {
                processedCandidates.push({ rkt_nomor: row.rkt_nomor, nama: rawNama.trim(), tgl_diterima: row.tgl_diterima, is_grouped: row.rpk_jumlah > 1 });
            }
        });

        res.json({ success: true, data: processedCandidates });
    } catch (error) {
        console.error('Error fetching hired candidates:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// =====================================================================

router.post('/:tpkNomor/cancel-candidate', authenticate, async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { tpkNomor } = req.params;
        const { rktNomor, bufferDays, keterangan } = req.body;
        const userKode = req.user.user_kode;

        const [realisasi] = await connection.query(
            'SELECT rpk_keterangannama, COALESCE(rpk_jumlah, 1) as rpk_jumlah FROM hrd2.triilpermintaankaryawan WHERE rpk_tpk_nomor = ? AND rpk_nomor = ?',
            [tpkNomor, rktNomor]
        );

        if (realisasi.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Kandidat tidak ditemukan' }); }

        const namaKandidat = realisasi[0].rpk_keterangannama || '';
        if (realisasi[0].rpk_jumlah > 1 || namaKandidat.includes('\n')) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Data kandidat ini diinput secara grup (borongan) di sistem lama.' });
        }

        const [slaRow] = await connection.query('SELECT sla_id FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?', [tpkNomor]);
        const sla_id = slaRow.length > 0 ? slaRow[0].sla_id : null;

        await connection.query('DELETE FROM hrd2.triilpermintaankaryawan WHERE rpk_tpk_nomor = ? AND rpk_nomor = ?', [tpkNomor, rktNomor]);

        await connection.query(`
            UPDATE rekruitmen2.t_recruitment_sla 
            SET sla_hired_count = GREATEST(0, sla_hired_count - 1),
                sla_status = 'CALCULATED',
                sla_no_show_buffer_days = sla_no_show_buffer_days + ?,
                sla_completed_at = NULL
            WHERE sla_tpk_nomor = ?
        `, [bufferDays, tpkNomor]);

        const logNotes = `Kandidat dibatalkan (No-Show). Buffer +${bufferDays} hari ditambahkan. Alasan: ${keterangan}`;
        await connection.query(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value) VALUES (?, ?, ?, 'cancel_candidate', 'Hired', ?)`,
            [tpkNomor, sla_id, userKode, logNotes]
        );

        await connection.commit();
        res.json({ success: true, message: 'Kandidat berhasil dibatalkan', data: { addedDays: bufferDays } });

    } catch (error) {
        await connection.rollback();
        console.error('Error cancelling candidate:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        connection.release();
    }
});

// =====================================================================

/**
 * DELETE /api/recruitment/batch-delete
 */
router.delete('/batch-delete', authenticate, async (req, res) => {
    const { tpkNomors } = req.body;
    const userKode = req.user.user_kode;

    if (!Array.isArray(tpkNomors) || tpkNomors.length === 0) {
        return res.status(400).json({ success: false, message: 'Tidak ada data yang dipilih' });
    }
    if (tpkNomors.length > 20) {
        return res.status(400).json({ success: false, message: 'Maksimal 20 item per batch' });
    }

    const placeholders = tpkNomors.map(() => '?').join(',');
    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();

        const [rows] = await conn.execute(
            `SELECT tpk_nomor FROM hrd2.tpermintaankaryawan 
             WHERE tpk_nomor IN (${placeholders}) 
               AND tpk_peminta = ? 
               AND (tpk_approveatasan IS NULL OR tpk_approveatasan = 0)`,
            [...tpkNomors, userKode]
        );

        if (rows.length !== tpkNomors.length) {
            await conn.rollback();
            return res.status(403).json({ success: false, message: 'Beberapa permintaan tidak valid atau sudah diproses atasan' });
        }

        const [slaRows] = await conn.query(
            `SELECT sla_tpk_nomor, sla_id FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor IN (${placeholders})`,
            tpkNomors
        );

        const slaMap = {};
        slaRows.forEach(row => { slaMap[row.sla_tpk_nomor] = row.sla_id; });

        const logValues = tpkNomors.map(nomor => [nomor, slaMap[nomor] || null, 'batch_deleted', 'PENDING', 'DELETED_BY_USER', userKode, new Date()]);

        await conn.query(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, field_name, old_value, new_value, user_kode, created_at) VALUES ?`,
            [logValues]
        );

        await conn.execute(
            `DELETE FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor IN (${placeholders}) AND sla_status = 'PENDING'`,
            tpkNomors
        );

        await conn.execute(
            `DELETE FROM hrd2.tpermintaankaryawan WHERE tpk_nomor IN (${placeholders}) AND (tpk_approveatasan IS NULL OR tpk_approveatasan = 0)`,
            tpkNomors
        );

        await syncDeleteRows(conn, tpkNomors);

        await conn.commit();
        res.json({ success: true, deleted: tpkNomors.length });

    } catch (err) {
        await conn.rollback();
        res.status(500).json({ success: false, message: err.message });
    } finally {
        conn.release();
    }
});

module.exports = router;