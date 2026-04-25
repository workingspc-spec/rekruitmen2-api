// src/modules/recruitment.js
// [PERUBAHAN ARSITEKTUR]
// - INSERT baru → rekruitmen2.tpermintaan_draft (TIDAK ke hrd2)
// - Atasan approve → UPDATE di draft
// - HRD approve → INSERT ke hrd2.tpermintaankaryawan + DELETE dari draft
// - Legacy app hanya baca hrd2 → tidak ada efek ke legacy

const express = require('express');
const db = require('../config/db');
const router = express.Router();
const { authenticate, isHRD, isManager } = require('../middleware/authMiddleware');
const { addWorkdays, countWorkdays, formatDateSafe } = require('../utils/workdayCalculator');

const {
    upsertRow      : syncUpsert,
    updateApproval : syncApproval,
    deleteRows     : syncDeleteRows,
    fullSync       : syncAllIndex,
} = require('../utils/tpkIndexSync');

const MAX_NOTES_LENGTH = 3000;

// ── Konstanta tabel ──────────────────────────────────────────────────────────
const DRAFT_TABLE = 'rekruitmen2.tpermintaan_draft';
const LIVE_TABLE  = 'hrd2.tpermintaankaryawan';

/**
 * Helper: cari permintaan di draft dulu, lalu live.
 * Return: { row, source: 'draft'|'live' } atau null
 */
async function findPermintaan(conn, tpk_nomor) {
    const [draftRows] = await conn.execute(
        `SELECT *, 'draft' AS _source FROM ${DRAFT_TABLE} WHERE tpk_nomor = ?`,
        [tpk_nomor]
    );
    if (draftRows.length > 0) return { row: draftRows[0], source: 'draft' };

    const [liveRows] = await conn.execute(
        `SELECT *, 'live' AS _source FROM ${LIVE_TABLE} WHERE tpk_nomor = ?`,
        [tpk_nomor]
    );
    if (liveRows.length > 0) return { row: liveRows[0], source: 'live' };

    return null;
}

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
        
        // FIX: Hapus "- 1" agar benar-benar menghitung 14 hari kerja dari besok
        const minDateObj = addWorkdays(tomorrow, min_days);
        const minDateStr = formatDateSafe(minDateObj);

        if (requestedDate < minDateObj) {
            return {
                valid: false,
                message: `Tanggal butuh untuk jabatan ini minimal ${min_days} hari kerja dari besok. Saran tanggal: ${minDateStr}`,
                minDate: minDateStr
            };
        }
        return { valid: true, minDate: minDateStr };
    } catch (error) {
        return { valid: false, message: error.message };
    }
}

// ── Manual sync state ────────────────────────────────────────────────────────
let _isSyncing    = false;
let _lastSyncTime = 0;
const MANUAL_SYNC_COOLDOWN_MS = 30_000;

router.post('/sync-manual', authenticate, async (req, res) => {
    const now = Date.now();
    if (now - _lastSyncTime < MANUAL_SYNC_COOLDOWN_MS) {
        return res.json({ success: true, synced: false, message: 'Data masih segar, sinkronisasi dilewati.' });
    }
    if (_isSyncing) {
        return res.json({ success: true, synced: false, message: 'Sinkronisasi sedang berjalan di background.' });
    }
    try {
        _isSyncing = true;
        await syncAllIndex(db);
        _lastSyncTime = Date.now();
        _isSyncing    = false;
        return res.json({ success: true, synced: true, message: 'Sinkronisasi manual berhasil.' });
    } catch (error) {
        _isSyncing = false;
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ── GET jabatan-rules ────────────────────────────────────────────────────────
router.get('/jabatan-rules', authenticate, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT j.jab_kode, j.jab_nama,
                   COALESCE(jlt.jlt_min_days, 7) as min_days,
                   jlt.jlt_max_days as max_days,
                   COALESCE(jlt.jlt_is_flexible, 0) as is_flexible,
                   CASE WHEN jlt.jlt_is_flexible = 1 THEN 'Fleksibel'
                        ELSE CONCAT('Minimal ', COALESCE(jlt.jlt_min_days, 7), ' hari kerja')
                   END as label
            FROM hrd2.tjabatan j
            LEFT JOIN rekruitmen2.job_lead_time_master jlt
                ON jlt.jlt_job_code = j.jab_kode AND jlt.jlt_active = 1
            ORDER BY j.jab_nama
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── GET my-requests ──────────────────────────────────────────────────────────
// Gabungkan DRAFT (belum HRD approve) + LIVE (sudah HRD approve)
// ── GET my-requests ──────────────────────────────────────────────────────────
// Gabungkan DRAFT (belum HRD approve) + LIVE (sudah HRD approve)
router.get('/my-requests', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd    = req.user.user_hrd;

    try {
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
            COALESCE(sla.sla_status, 'LEGACY') as sla_status,
            COALESCE(sla.sla_is_editable, 0) as sla_is_editable,
            CASE WHEN sla.sla_id IS NULL THEN 1 ELSE 0 END as is_legacy
        `;

        let rows = [];

        if (is_hrd) {
            // HRD: lihat semua dari DRAFT + LIVE
            const [draftRows] = await db.execute(`
                SELECT ${SELECT_COLS}
                FROM ${DRAFT_TABLE} p
                INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
                LEFT JOIN hrd2.tkaryawan kp ON kp.kar_nik = TRIM(p.tpk_peminta)
                INNER JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor -- 🔥 FIX: INNER JOIN
                ORDER BY p.tpk_tanggal DESC
            `);
            const [liveRows] = await db.execute(`
                SELECT ${SELECT_COLS}
                FROM ${LIVE_TABLE} p
                INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
                LEFT JOIN hrd2.tkaryawan kp ON kp.kar_nik = TRIM(p.tpk_peminta)
                LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor -- 👈 GANTI KE LEFT JOIN
                ORDER BY p.tpk_tanggal DESC
            `);
            rows = [...draftRows, ...liveRows];
        } else {
            // Non-HRD: lihat milik sendiri dari DRAFT + LIVE
            const [draftRows] = await db.execute(`
                SELECT ${SELECT_COLS}
                FROM ${DRAFT_TABLE} p
                INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
                LEFT JOIN hrd2.tkaryawan kp ON kp.kar_nik = TRIM(p.tpk_peminta)
                INNER JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor -- 🔥 FIX: INNER JOIN
                WHERE TRIM(p.tpk_peminta) = ?
                ORDER BY p.tpk_tanggal DESC
            `, [user_kode]);
            // Ganti INNER JOIN menjadi LEFT JOIN di liveRows non-HRD:
// Ganti INNER JOIN menjadi LEFT JOIN dan BYPASS tpk_index_helper:
            const [liveRows] = await db.execute(`
                SELECT ${SELECT_COLS}
                FROM ${LIVE_TABLE} p
                INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
                LEFT JOIN hrd2.tkaryawan kp ON kp.kar_nik = TRIM(p.tpk_peminta)
                LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
                WHERE TRIM(p.tpk_peminta) = ?
                ORDER BY p.tpk_tanggal DESC
            `, [user_kode]);
            rows = [...draftRows, ...liveRows];
        }

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Error my-requests:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── GET detail ───────────────────────────────────────────────────────────────
router.get('/detail', authenticate, async (req, res) => {
    const { nomor } = req.query;
    if (!nomor) return res.status(400).json({ success: false, message: 'Parameter nomor diperlukan' });

    try {
        const SELECT_DETAIL = `
            t.tpk_nomor, t.tpk_peminta,
            COALESCE(k.kar_nama, t.tpk_peminta) as peminta_nama,
            DATE_FORMAT(t.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
            t.tpk_jab_kode, t.tpk_bagian,
            DATE_FORMAT(t.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
            t.tpk_jumlah, t.tpk_alasan, t.tpk_alasanlain,
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
            j.jab_nama, j.jab_kode,
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
        `;

        // Cek draft dulu
        const [draftRows] = await db.execute(`
            SELECT ${SELECT_DETAIL}
            FROM ${DRAFT_TABLE} t
            JOIN hrd2.tjabatan j ON j.jab_kode = t.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = TRIM(t.tpk_peminta)
            LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = t.tpk_nomor
            WHERE t.tpk_nomor = ?
        `, [nomor]);

        if (draftRows.length > 0) {
            return res.json({ success: true, data: draftRows[0] });
        }

        // Fallback live
        const [liveRows] = await db.execute(`
            SELECT ${SELECT_DETAIL}
            FROM ${LIVE_TABLE} t
            JOIN hrd2.tjabatan j ON j.jab_kode = t.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = TRIM(t.tpk_peminta)
            LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = t.tpk_nomor
            WHERE t.tpk_nomor = ?
        `, [nomor]);

        if (liveRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
        }
        res.json({ success: true, data: liveRows[0] });
    } catch (error) {
        console.error('❌ Error detail:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── POST save ────────────────────────────────────────────────────────────────
// INSERT baru → DRAFT ONLY. hrd2 tidak disentuh sama sekali.
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

    // Validasi input
    const validationErrors = [];
    if (jab_kode && (typeof jab_kode !== 'string' || jab_kode.length > 20))
        validationErrors.push('jab_kode tidak valid');
    if (bagian && (typeof bagian !== 'string' || bagian.length > 100))
        validationErrors.push('bagian tidak valid');
    if (tgl_butuh && !/^\d{4}-\d{2}-\d{2}$/.test(tgl_butuh))
        validationErrors.push('tgl_butuh format tidak valid');
    const jumlahNum = Number(jumlah);
    if (jumlah !== undefined && (isNaN(jumlahNum) || jumlahNum < 1 || jumlahNum > 100 || !Number.isInteger(jumlahNum)))
        validationErrors.push('jumlah harus angka bulat 1–100');
    if (validationErrors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validasi gagal', errors: validationErrors });
    }

    const user_kode  = req.user.user_kode;
    const connection = await db.getConnection();

    try {
        // ── UPDATE (edit draft atau live yang sudah approved + editable) ──────
        if (tpk_nomor) {
            await connection.beginTransaction();

            const found = await findPermintaan(connection, tpk_nomor);
            if (!found) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
            }

            const { row: current, source } = found;
            const table = source === 'draft' ? DRAFT_TABLE : LIVE_TABLE;

            if (current.tpk_peminta !== user_kode) {
                await connection.rollback();
                connection.release();
                return res.status(403).json({ success: false, message: 'Akses ditolak' });
            }

            const isDraft    = current.tpk_approveatasan === 0 && current.tpk_approveHRD === 0;
            const [slaCheck] = await connection.execute(
                'SELECT sla_is_editable FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?',
                [tpk_nomor]
            );
            const isEditable = slaCheck.length > 0 && slaCheck[0].sla_is_editable === 1;

            if (!isDraft && !isEditable) {
                await connection.rollback();
                connection.release();
                return res.status(403).json({ success: false, message: 'Edit dikunci. Hubungi HRD jika ada kebutuhan mendesak.' });
            }

            if (jab_kode && tgl_butuh) {
                const validation = await validateTglButuhFromDB(connection, jab_kode, tgl_butuh, isEditable);
                if (!validation.valid) {
                    await connection.rollback();
                    connection.release();
                    return res.status(400).json({ success: false, message: validation.message, min_date: validation.minDate });
                }
            }

            await connection.execute(`
                UPDATE ${table} SET
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
                jab_kode||null, bagian||null, tgl_butuh||null, jumlah||0,
                alasan||null, alasan_lain||null,
                tpk_keterangan||'',  tpk_keterangan2||'',  tpk_keterangan3||'',  tpk_keterangan4||'',
                tpk_keterangan5||'', tpk_keterangan6||'',  tpk_keterangan7||'',  tpk_keterangan8||'',
                tpk_keterangan9||'', tpk_keterangan10||'',
                tpk_spesifikasi||'',  tpk_spesifikasi2||'',  tpk_spesifikasi3||'',  tpk_spesifikasi4||'',
                tpk_spesifikasi5||'', tpk_spesifikasi6||'',  tpk_spesifikasi7||'',  tpk_spesifikasi8||'',
                tpk_spesifikasi9||'', tpk_spesifikasi10||'',
                tpk_nomor
            ]);

            if (isEditable) {
                await connection.execute(
                    `UPDATE rekruitmen2.t_recruitment_sla SET
                        sla_job_code = ?, sla_original_requested_date = ?, sla_system_ceiling_date = ?,
                        sla_source = CASE WHEN ? >= sla_system_floor_date THEN 'USER' ELSE sla_source END,
                        sla_final_target_date = GREATEST(COALESCE(sla_system_floor_date, CURDATE()), ?),
                        sla_max_target_date   = GREATEST(sla_max_target_date, ?),
                        sla_is_editable = 0,
                        sla_notes = LEFT(CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] Re-schedule oleh User (New Date: ', ?, ')'), ${MAX_NOTES_LENGTH})
                    WHERE sla_tpk_nomor = ?`,
                    [jab_kode, tgl_butuh, tgl_butuh, tgl_butuh, tgl_butuh, tgl_butuh, tgl_butuh, tpk_nomor]
                );
            }

            if (isDraft) {
                await connection.execute(
                    `UPDATE rekruitmen2.t_recruitment_sla
                     SET sla_job_code = ?, sla_original_requested_date = ?, sla_system_ceiling_date = ?
                     WHERE sla_tpk_nomor = ? AND sla_status = 'PENDING'`,
                    [jab_kode, tgl_butuh, tgl_butuh, tpk_nomor]
                );
            }

            const [slaIdRow] = await connection.execute(
                'SELECT sla_id FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?', [tpk_nomor]
            );
            const sla_id = slaIdRow.length > 0 ? slaIdRow[0].sla_id : null;

            const changes = [
                { field: 'tpk_jumlah',    old: current.tpk_jumlah,    new: jumlah    },
                { field: 'tpk_tgl_butuh', old: current.tpk_tgl_butuh, new: tgl_butuh },
                { field: 'tpk_jab_kode',  old: current.tpk_jab_kode,  new: jab_kode  },
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

            await connection.commit();
            connection.release();
            return res.json({ success: true, message: 'Data berhasil diupdate' });
        }

        // ── INSERT baru — hanya ke DRAFT ────────────────────────────────────
        const missingFields = [];
        if (!jab_kode)                 missingFields.push('jabatan');
        if (!bagian)                   missingFields.push('bagian');
        if (!tgl_butuh)                missingFields.push('tgl_butuh');
        if (!jumlah || jumlah <= 0)    missingFields.push('jumlah');
        if (!alasan || !alasan.trim()) missingFields.push('alasan');

        if (missingFields.length > 0) {
            connection.release();
            return res.status(400).json({ success: false, message: 'Data wajib belum lengkap', missing_fields: missingFields });
        }

        await connection.beginTransaction();

        const validation = await validateTglButuhFromDB(connection, jab_kode, tgl_butuh, false);
        if (!validation.valid) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ success: false, message: validation.message, min_date: validation.minDate });
        }

        const now   = new Date();
        const year  = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');

        await connection.execute(
            `INSERT INTO rekruitmen2.tpk_sequence (seq_year, seq_last)
             VALUES (?, 1)
             ON DUPLICATE KEY UPDATE seq_last = seq_last + 1`,
            [year]
        );
        const [[{ seq }]] = await connection.execute(
            `SELECT seq_last AS seq FROM rekruitmen2.tpk_sequence WHERE seq_year = ?`, [year]
        );
        const newNomor = `${String(seq).padStart(3, '0')}/HRD/PKAR/${month}/${year}`;

        // ── [BYPASS CHECK] Cek apakah peminta terdaftar sebagai bypass user ──
        // Jika ya → tpk_approveatasan = 9 (langsung antri HRD, skip atasan)
        // Tabel t_bypass_users ada di rekruitmen2, tidak menyentuh hrd2 sama sekali.
        const [bypassRows] = await connection.execute(
            `SELECT bu_nik FROM rekruitmen2.t_bypass_users WHERE bu_nik = ? AND bu_active = 1`,
            [user_kode]
        );
        const isBypass = bypassRows.length > 0;
        const initialApproveAtasan = isBypass ? 9 : 0;

        // ✅ INSERT ke DRAFT — bukan ke hrd2!
        await connection.execute(`
            INSERT INTO ${DRAFT_TABLE} (
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
                ?, 0
            )
        `, [
            newNomor, user_kode, jab_kode, bagian,
            tgl_butuh, jumlah, alasan||null, alasan_lain||null,
            tpk_keterangan||'',  tpk_keterangan2||'',  tpk_keterangan3||'',  tpk_keterangan4||'',
            tpk_keterangan5||'', tpk_keterangan6||'',  tpk_keterangan7||'',  tpk_keterangan8||'',
            tpk_keterangan9||'', tpk_keterangan10||'',
            tpk_spesifikasi||'',  tpk_spesifikasi2||'',  tpk_spesifikasi3||'',  tpk_spesifikasi4||'',
            tpk_spesifikasi5||'', tpk_spesifikasi6||'',  tpk_spesifikasi7||'',  tpk_spesifikasi8||'',
            tpk_spesifikasi9||'', tpk_spesifikasi10||'',
            initialApproveAtasan   // ← bypass = 9, normal = 0
        ]);

        await syncUpsert(connection, {
            tpk_nomor: newNomor, tpk_peminta: user_kode,
            tpk_approveatasan: initialApproveAtasan, tpk_approveHRD: 0,
            tpk_tanggal: new Date().toISOString().split('T')[0],
        });

        const bypassNote = isBypass
            ? '\n[AUTO] Peminta terdaftar bypass — langsung antri HRD tanpa persetujuan atasan.'
            : '';

        const [slaResult] = await connection.execute(
            `INSERT INTO rekruitmen2.t_recruitment_sla
                (sla_tpk_nomor, sla_job_code, sla_original_requested_date, sla_system_ceiling_date, sla_request_created_at, sla_status, sla_notes)
             VALUES (?, ?, ?, ?, NOW(), 'PENDING', ?)`,
            [newNomor, jab_kode, tgl_butuh, tgl_butuh, bypassNote || null]
        );
        await connection.execute(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value)
             VALUES (?, ?, ?, 'created', NULL, ?)`,
            [newNomor, slaResult.insertId, user_kode, isBypass ? 'NEW_REQUEST (BYPASS)' : 'NEW_REQUEST']
        );

        await connection.commit();
        connection.release();
        return res.json({ success: true, message: 'Permintaan berhasil dibuat', nomor: newNomor });

    } catch (error) {
        await connection.rollback();
        connection.release();

        if (error.code === 'ER_DUP_ENTRY') {
            try {
                // [FIX] Sync dari DRAFT + hrd2 agar nomor draft tidak ter-reuse
                await db.execute(`
                    INSERT INTO rekruitmen2.tpk_sequence (seq_year, seq_last)
                    SELECT YEAR(tpk_tanggal),
                           MAX(CAST(SUBSTRING_INDEX(tpk_nomor, '/', 1) AS UNSIGNED))
                    FROM (
                        SELECT tpk_nomor, tpk_tanggal FROM ${DRAFT_TABLE}
                        UNION ALL
                        SELECT tpk_nomor, tpk_tanggal FROM ${LIVE_TABLE}
                    ) AS combined
                    WHERE YEAR(tpk_tanggal) >= YEAR(CURDATE()) - 1
                    GROUP BY YEAR(tpk_tanggal)
                    ON DUPLICATE KEY UPDATE seq_last = GREATEST(seq_last, VALUES(seq_last))
                `);
                return res.status(409).json({ success: false, message: 'Nomor tersinkronisasi, silakan simpan kembali.' });
            } catch (syncErr) {
                return res.status(409).json({ success: false, message: 'Sinkronisasi gagal, coba lagi.' });
            }
        }
        console.error('❌ Error save:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── GET approval/atasan ──────────────────────────────────────────────────────
// Baca dari DRAFT saja (belum masuk hrd2 = belum HRD approve)
router.get('/approval/atasan', authenticate, isManager, async (req, res) => {
    const { status } = req.query;
    const user_kode  = req.user.user_kode;

    try {
        let statusFilter = '';
        if (status === 'pending')  statusFilter = 'AND p.tpk_approveatasan = 0';
        if (status === 'approved') statusFilter = 'AND p.tpk_approveatasan != 0';
        if (status === 'rejected') statusFilter = 'AND p.tpk_approveatasan = 2';

        const SELECT_COLS_DRAFT = `
            p.tpk_nomor, j.jab_nama, p.tpk_bagian, p.tpk_jumlah,
            p.tpk_approveatasan, p.tpk_approveHRD,
            k.kar_nama as peminta,
            DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
            DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
            DATE_FORMAT(p.tpk_tgl_approveatasan, '%Y-%m-%d') as tgl_approve_atasan,
            DATE_FORMAT(p.tpk_tgl_approveHRD, '%Y-%m-%d') as tgl_approve_hrd,
            0 as is_legacy
        `;

        const SELECT_COLS_LIVE = `
            p.tpk_nomor, j.jab_nama, p.tpk_bagian, p.tpk_jumlah,
            p.tpk_approveatasan, p.tpk_approveHRD,
            k.kar_nama as peminta,
            DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
            DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
            DATE_FORMAT(p.tpk_tgl_approveatasan, '%Y-%m-%d') as tgl_approve_atasan,
            DATE_FORMAT(p.tpk_tgl_approveHRD, '%Y-%m-%d') as tgl_approve_hrd,
            CASE WHEN sla.sla_id IS NULL THEN 1 ELSE 0 END as is_legacy
        `;

        // Ambil dari DRAFT
        const [draftRows] = await db.execute(`
            SELECT ${SELECT_COLS_DRAFT} FROM ${DRAFT_TABLE} p
            INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = p.tpk_peminta
            WHERE k.kar_nik_atasan = ? ${statusFilter}
        `, [user_kode]);

        // Ambil dari LIVE (sudah disetujui HRD) - TAMBAH LEFT JOIN SLA
        const [liveRows] = await db.execute(`
            SELECT ${SELECT_COLS_LIVE} FROM ${LIVE_TABLE} p
            INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = p.tpk_peminta
            LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            WHERE k.kar_nik_atasan = ? ${statusFilter}
        `, [user_kode]);

        // Gabungkan dan urutkan
        const rows = [...draftRows, ...liveRows];
        rows.sort((a, b) => new Date(b.tpk_tanggal) - new Date(a.tpk_tanggal));

        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── POST approval/atasan/action ──────────────────────────────────────────────
router.post('/approval/atasan/action', authenticate, isManager, async (req, res) => {
    const { tpk_nomor, action } = req.body;
    if (!tpk_nomor || !action) {
        return res.status(400).json({ success: false, message: 'Parameter diperlukan' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        let statusVal = 0;
        if (action === 'APPROVE')     statusVal = 9;
        else if (action === 'REJECT') statusVal = 2;
        else {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ success: false, message: 'Action tidak valid' });
        }

        // Ambil dari DRAFT saja
        const [checkRows] = await connection.execute(
            `SELECT p.tpk_approveatasan, p.tpk_tanggal, p.tpk_tgl_butuh,
                    p.tpk_jab_kode, p.tpk_jumlah, k.kar_nik_atasan,
                    sla.sla_id, sla.sla_original_requested_date, sla.sla_request_created_at
             FROM ${DRAFT_TABLE} p
             LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = p.tpk_peminta
             LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             WHERE p.tpk_nomor = ? FOR UPDATE`,
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
            return res.status(403).json({ success: false, message: 'Akses ditolak' });
        }
        if (data.tpk_approveatasan !== 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ success: false, message: 'Sudah pernah diproses' });
        }

        await connection.execute(
            `UPDATE ${DRAFT_TABLE} SET tpk_approveatasan = ?, tpk_tgl_approveatasan = NOW() WHERE tpk_nomor = ?`,
            [statusVal, tpk_nomor]
        );
        await syncApproval(connection, tpk_nomor, statusVal, 0);

        if (statusVal === 9) {
            await connection.execute(
                `UPDATE rekruitmen2.t_recruitment_sla SET
                    sla_notes = LEFT(CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] Disetujui Atasan. Menunggu HRD.'), ${MAX_NOTES_LENGTH})
                 WHERE sla_tpk_nomor = ? AND sla_status = 'PENDING'`,
                [tpk_nomor]
            );
            await connection.commit();
            connection.release();
            return res.json({ success: true, message: 'Di-APPROVE Atasan. Menunggu persetujuan HRD.' });
        } else {
            await connection.execute(
                `UPDATE rekruitmen2.t_recruitment_sla SET sla_status = 'CANCELLED' WHERE sla_tpk_nomor = ?`,
                [tpk_nomor]
            );
            await connection.commit();
            connection.release();
            return res.json({ success: true, message: 'Permintaan ditolak.' });
        }
    } catch (error) {
        await connection.rollback();
        connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── GET approval/hrd ─────────────────────────────────────────────────────────
// HRD hanya lihat DRAFT yang sudah disetujui atasan
router.get('/approval/hrd', authenticate, isHRD, async (req, res) => {
    const { status } = req.query;
    try {
        let draftFilter = 'AND p.tpk_approveatasan IN (1, 9)';
        let liveFilter  = 'AND p.tpk_approveatasan IN (1, 9)';

        if (status === 'pending') {
            draftFilter += ' AND p.tpk_approveHRD = 0';
            liveFilter  += ' AND p.tpk_approveHRD = 0';
        } else if (status === 'approved') {
            draftFilter += ' AND p.tpk_approveHRD != 0';
            liveFilter  += ' AND p.tpk_approveHRD != 0';
        }

        const SELECT_COLS_DRAFT = `
            p.tpk_nomor, j.jab_nama, p.tpk_bagian, p.tpk_jumlah,
            p.tpk_approveHRD, p.tpk_approveatasan,
            k.kar_nama as peminta,
            DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
            DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
            DATE_FORMAT(p.tpk_tgl_approveatasan, '%Y-%m-%d') as tgl_approve_atasan,
            DATE_FORMAT(p.tpk_tgl_approveHRD, '%Y-%m-%d') as tgl_approve_hrd,
            sla.sla_final_target_date, sla.sla_source, sla.sla_status,
            COALESCE(sla.sla_hired_count, 0) as hired_count,
            0 as is_legacy
        `;

        const SELECT_COLS_LIVE = `
            p.tpk_nomor, j.jab_nama, p.tpk_bagian, p.tpk_jumlah,
            p.tpk_approveHRD, p.tpk_approveatasan,
            k.kar_nama as peminta,
            DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') as tpk_tanggal,
            DATE_FORMAT(p.tpk_tgl_butuh, '%Y-%m-%d') as tpk_tgl_butuh,
            DATE_FORMAT(p.tpk_tgl_approveatasan, '%Y-%m-%d') as tgl_approve_atasan,
            DATE_FORMAT(p.tpk_tgl_approveHRD, '%Y-%m-%d') as tgl_approve_hrd,
            sla.sla_final_target_date, sla.sla_source, sla.sla_status,
            COALESCE(sla.sla_hired_count, 0) as hired_count,
            CASE WHEN sla.sla_id IS NULL THEN 1 ELSE 0 END as is_legacy
        `;

        // Ambil dari DRAFT
        const [draftRows] = await db.execute(`
            SELECT ${SELECT_COLS_DRAFT} FROM ${DRAFT_TABLE} p
            INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = p.tpk_peminta
            LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            WHERE 1=1 ${draftFilter}
        `);

        // Ambil dari LIVE (Untuk yang sudah Approved) -> GANTI KE LEFT JOIN
        const [liveRows] = await db.execute(`
            SELECT ${SELECT_COLS_LIVE} FROM ${LIVE_TABLE} p
            INNER JOIN hrd2.tjabatan j ON j.jab_kode = p.tpk_jab_kode
            LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = p.tpk_peminta
            LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            WHERE 1=1 ${liveFilter}
        `);
        // Gabungkan dan urutkan
        const rows = [...draftRows, ...liveRows];
        rows.sort((a, b) => new Date(b.tpk_tanggal) - new Date(a.tpk_tanggal));

        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── POST approval/hrd/action ─────────────────────────────────────────────────
// ✅ TITIK KUNCI: saat HRD approve → INSERT ke hrd2 + DELETE dari draft
router.post('/approval/hrd/action', authenticate, isHRD, async (req, res) => {
    const { tpk_nomor, action, alasan_tolak } = req.body;
    if (!tpk_nomor) return res.status(400).json({ success: false, message: 'tpk_nomor diperlukan' });
    if (!action || !['APPROVE', 'REJECT'].includes(action))
        return res.status(400).json({ success: false, message: 'Action harus APPROVE atau REJECT' });
    if (action === 'REJECT' && (!alasan_tolak || !alasan_tolak.trim()))
        return res.status(400).json({ success: false, message: 'Alasan penolakan wajib diisi' });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [checkRows] = await connection.execute(
            `SELECT p.*, sla.sla_id, sla.sla_original_requested_date, sla.sla_request_created_at
             FROM ${DRAFT_TABLE} p
             LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             WHERE p.tpk_nomor = ? FOR UPDATE`,
            [tpk_nomor]
        );

        if (checkRows.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ success: false, message: 'Permintaan tidak ditemukan di draft' });
        }

        const current = checkRows[0];

        if (current.tpk_approveatasan !== 9 && current.tpk_approveatasan !== 1) {
            await connection.rollback();
            connection.release();
            return res.status(403).json({ success: false, message: 'Belum disetujui atasan' });
        }
        if (current.tpk_approveHRD !== 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ success: false, message: 'Sudah pernah diproses HRD' });
        }

        // ── REJECT — tetap di draft, update status ───────────────────────────
        if (action === 'REJECT') {
            await connection.execute(
                `UPDATE ${DRAFT_TABLE} SET tpk_approveHRD = 2, tpk_tgl_approveHRD = NOW() WHERE tpk_nomor = ?`,
                [tpk_nomor]
            );
            await syncApproval(connection, tpk_nomor, current.tpk_approveatasan, 2);
            await connection.execute(
                `UPDATE rekruitmen2.t_recruitment_sla SET
                    sla_status = 'CANCELLED',
                    sla_notes  = LEFT(CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] Ditolak HRD. Alasan: ', ?), ${MAX_NOTES_LENGTH})
                 WHERE sla_tpk_nomor = ?`,
                [alasan_tolak.trim(), tpk_nomor]
            );
            await connection.commit();
            connection.release();
            return res.json({ success: true, message: 'Permintaan ditolak HRD.' });
        }

        // ── APPROVE — baru masuk ke hrd2 sekarang ───────────────────────────
        await connection.execute(`
            INSERT INTO ${LIVE_TABLE} (
                tpk_nomor, tpk_peminta, tpk_tanggal, tpk_jab_kode, tpk_bagian,
                tpk_tgl_butuh, tpk_jumlah, tpk_alasan, tpk_alasanlain,
                tpk_keterangan,  tpk_keterangan2,  tpk_keterangan3,  tpk_keterangan4,
                tpk_keterangan5, tpk_keterangan6,  tpk_keterangan7,  tpk_keterangan8,
                tpk_keterangan9, tpk_keterangan10,
                tpk_spesifikasi,  tpk_spesifikasi2,  tpk_spesifikasi3,  tpk_spesifikasi4,
                tpk_spesifikasi5, tpk_spesifikasi6,  tpk_spesifikasi7,  tpk_spesifikasi8,
                tpk_spesifikasi9, tpk_spesifikasi10,
                tpk_approveatasan, tpk_tgl_approveatasan,
                tpk_approveHRD,   tpk_tgl_approveHRD
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?,  /* <--- FIX: Ubah '1, ?' menjadi '?, ?' di sini */
                1, NOW()
            )
        `, [
            current.tpk_nomor, current.tpk_peminta, current.tpk_tanggal,
            current.tpk_jab_kode, current.tpk_bagian,
            current.tpk_tgl_butuh, current.tpk_jumlah,
            current.tpk_alasan, current.tpk_alasanlain,
            current.tpk_keterangan||'',  current.tpk_keterangan2||'',
            current.tpk_keterangan3||'', current.tpk_keterangan4||'',
            current.tpk_keterangan5||'', current.tpk_keterangan6||'',
            current.tpk_keterangan7||'', current.tpk_keterangan8||'',
            current.tpk_keterangan9||'', current.tpk_keterangan10||'',
            current.tpk_spesifikasi||'',  current.tpk_spesifikasi2||'',
            current.tpk_spesifikasi3||'', current.tpk_spesifikasi4||'',
            current.tpk_spesifikasi5||'', current.tpk_spesifikasi6||'',
            current.tpk_spesifikasi7||'', current.tpk_spesifikasi8||'',
            current.tpk_spesifikasi9||'', current.tpk_spesifikasi10||'',
            current.tpk_approveatasan, current.tpk_tgl_approveatasan,
        ]);

        // Hapus dari draft
        await connection.execute(`DELETE FROM ${DRAFT_TABLE} WHERE tpk_nomor = ?`, [tpk_nomor]);

        // Update shadow index → arahkan ke live
        await syncApproval(connection, tpk_nomor, 1, 1);

        // Hitung SLA
        const [masterData] = await connection.execute(
            'SELECT jlt_min_days, jlt_max_days, jlt_is_flexible FROM rekruitmen2.job_lead_time_master WHERE jlt_job_code = ? AND jlt_active = 1',
            [current.tpk_jab_kode]
        );
        let master = { jlt_min_days: 14, jlt_max_days: 30, jlt_is_flexible: 0 };
        if (masterData.length > 0) master = masterData[0];

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

        const rawOriginal = current.sla_original_requested_date?.toString().split('T')[0]
            || current.tpk_tgl_butuh?.toString().split('T')[0];
        const [ry, rm, rd] = rawOriginal.split('-').map(Number);
        const requestedDate = new Date(ry, rm - 1, rd, 0, 0, 0, 0);
        const createdAt     = new Date(current.sla_request_created_at || current.tpk_tanggal);

        let systemFloorDate, finalTargetDate, maxTargetDate, slaSource;
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

        const diffDays = countWorkdays(requestedDate, finalTargetDate);
        const bulkNote = extraDays > 0
            ? ` (Penambahan +${extraDays} hari massal ${jumlahDiminta} orang).` : '';

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
                sla_notes                     = LEFT(CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] Disetujui HRD — rekrutmen dibuka.', ?), ${MAX_NOTES_LENGTH}),
                sla_status                    = 'CALCULATED'
             WHERE sla_tpk_nomor = ?`,
            [
                master.jlt_min_days, master.jlt_max_days, master.jlt_is_flexible,
                formatDateSafe(systemFloorDate), formatDateSafe(finalTargetDate),
                formatDateSafe(maxTargetDate), formatDateSafe(requestedDate),
                slaSource, approvalDelayDays, diffDays, bulkNote, tpk_nomor
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

// ── DELETE batch-delete ──────────────────────────────────────────────────────
// Hapus dari DRAFT saja (belum approved = pasti di draft)
router.delete('/batch-delete', authenticate, async (req, res) => {
    const { tpkNomors } = req.body;
    const userKode = req.user.user_kode;

    if (!Array.isArray(tpkNomors) || tpkNomors.length === 0)
        return res.status(400).json({ success: false, message: 'Tidak ada data yang dipilih' });
    if (tpkNomors.length > 20)
        return res.status(400).json({ success: false, message: 'Maksimal 20 item per batch' });

    const placeholders = tpkNomors.map(() => '?').join(',');
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.execute(
            `SELECT tpk_nomor FROM ${DRAFT_TABLE}
             WHERE tpk_nomor IN (${placeholders})
               AND tpk_peminta = ?
               AND (tpk_approveatasan IS NULL OR tpk_approveatasan = 0)`,
            [...tpkNomors, userKode]
        );
        if (rows.length !== tpkNomors.length) {
            await conn.rollback();
            return res.status(403).json({ success: false, message: 'Beberapa permintaan tidak valid atau sudah diproses' });
        }

        const [slaRows] = await conn.query(
            `SELECT sla_tpk_nomor, sla_id FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor IN (${placeholders})`,
            tpkNomors
        );
        const slaMap = {};
        slaRows.forEach(r => { slaMap[r.sla_tpk_nomor] = r.sla_id; });

        const logValues = tpkNomors.map(nomor => [nomor, slaMap[nomor]||null, 'batch_deleted', 'PENDING', 'DELETED_BY_USER', userKode, new Date()]);
        await conn.query(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, field_name, old_value, new_value, user_kode, created_at) VALUES ?`,
            [logValues]
        );

        await conn.execute(
            `DELETE FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor IN (${placeholders}) AND sla_status = 'PENDING'`,
            tpkNomors
        );
        await conn.execute(
            `DELETE FROM ${DRAFT_TABLE} WHERE tpk_nomor IN (${placeholders}) AND (tpk_approveatasan IS NULL OR tpk_approveatasan = 0)`,
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

// ── Route post-approval (complete, log, editable, no-show, hired, cancel) ────
// Semua route ini beroperasi pada data yang sudah HRD approve (ada di hrd2)
// sehingga tidak perlu perubahan logika

router.post('/complete', authenticate, isHRD, async (req, res) => {
    const { tpk_nomor } = req.body;
    const userKode = req.user.user_kode;
    if (!tpk_nomor) return res.status(400).json({ success: false, message: 'tpk_nomor diperlukan' });
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [check] = await conn.execute(
            'SELECT sla_id, sla_status FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ? FOR UPDATE',
            [tpk_nomor]
        );
        if (check.length === 0) { await conn.rollback(); return res.status(404).json({ success: false, message: 'SLA tidak ditemukan' }); }
        if (check[0].sla_status === 'COMPLETED') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Sudah selesai' }); }
        await conn.execute(
            `UPDATE rekruitmen2.t_recruitment_sla SET sla_status='COMPLETED', sla_completed_at=NOW(), sla_is_editable=0,
             sla_notes=LEFT(CONCAT(COALESCE(sla_notes,''),'\n[',NOW(),'] Ditutup manual oleh HRD.'),${MAX_NOTES_LENGTH})
             WHERE sla_tpk_nomor=?`, [tpk_nomor]
        );
        await conn.execute(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor,sla_id,user_kode,field_name,old_value,new_value) VALUES(?,?,?,'status_sla','CALCULATED','COMPLETED (Tutup Manual)')`,
            [tpk_nomor, check[0].sla_id, userKode]
        );
        await conn.commit();
        res.json({ success: true, message: 'Permintaan berhasil ditutup' });
    } catch (error) {
        await conn.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally { conn.release(); }
});

router.get('/log/:tpk_nomor', authenticate, async (req, res) => {
    const { tpk_nomor } = req.params;
    const { user_kode, user_hrd } = req.user;
    try {
        const found = await findPermintaan(db, tpk_nomor);
        if (!found) return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });

        const peminta = found.row.tpk_peminta;
        const [karyawan] = await db.execute('SELECT kar_nik_atasan FROM hrd2.tkaryawan WHERE kar_nik = ?', [peminta]);
        const atasan = karyawan.length > 0 ? karyawan[0].kar_nik_atasan : null;

        if (user_hrd !== 1 && peminta !== user_kode && atasan !== user_kode) {
            return res.status(403).json({ success: false, message: 'Akses ditolak' });
        }

        const [slaRow] = await db.execute('SELECT sla_id FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?', [tpk_nomor]);
        const sla_id = slaRow.length > 0 ? slaRow[0].sla_id : null;
        const [logs] = await db.execute(
            `SELECT log.log_id, log.field_name, log.old_value, log.new_value, log.user_kode,
                    k.kar_nama as user_nama, DATE_FORMAT(log.created_at,'%Y-%m-%d %H:%i:%s') as created_at
             FROM rekruitmen2.t_pkar_log log
             LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = log.user_kode
             WHERE (log.sla_id = ? OR (log.sla_id IS NULL AND log.tpk_nomor = ?))
             ORDER BY log.created_at DESC`,
            [sla_id, tpk_nomor]
        );
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.patch('/:tpkNomor/editable', authenticate, isHRD, async (req, res) => {
    const { tpkNomor } = req.params;
    const { isEditable, keterangan } = req.body;
    const userKode = req.user.user_kode;
    if (isEditable === undefined || (isEditable !== 0 && isEditable !== 1))
        return res.status(400).json({ success: false, message: 'isEditable harus 0 atau 1' });
    if (isEditable === 1 && (!keterangan || keterangan.trim().length < 5))
        return res.status(400).json({ success: false, message: 'Keterangan minimal 5 karakter' });
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [slaRows] = await conn.query(
            `SELECT sla_id, sla_is_editable, sla_status FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor = ?`, [tpkNomor]
        );
        if (slaRows.length === 0) { await conn.rollback(); return res.status(404).json({ success: false, message: 'SLA tidak ditemukan' }); }
        const sla = slaRows[0];
        if (sla.sla_status !== 'CALCULATED') { await conn.rollback(); return res.status(400).json({ success: false, message: `SLA berstatus ${sla.sla_status}` }); }
        await conn.query(`UPDATE rekruitmen2.t_recruitment_sla SET sla_is_editable = ? WHERE sla_tpk_nomor = ?`, [isEditable, tpkNomor]);
        const actionLabel = isEditable === 1 ? 'edit_opened' : 'edit_closed';
        await conn.query(
            `INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value) VALUES (?,?,?,?,?,?)`,
            [tpkNomor, sla.sla_id, userKode, actionLabel, sla.sla_is_editable===1?'editable':'locked', isEditable===1?'editable':'locked']
        );
        if (isEditable === 1 && keterangan) {
            await conn.query(
                `UPDATE rekruitmen2.t_recruitment_sla SET sla_notes=LEFT(CONCAT(COALESCE(sla_notes,''),'\n[',NOW(),'] HRD minta update tanggal: ',?),${MAX_NOTES_LENGTH}) WHERE sla_tpk_nomor=?`,
                [keterangan.trim(), tpkNomor]
            );
        }
        await conn.commit();
        return res.json({ success: true, message: isEditable===1?'Izin edit dibuka.':'Izin edit ditutup.', data: { tpkNomor, isEditable, updatedBy: userKode } });
    } catch (err) {
        await conn.rollback();
        return res.status(500).json({ success: false, message: err.message });
    } finally { conn.release(); }
});

router.post('/:tpkNomor/no-show', authenticate, async (req, res) => {
    const { tpkNomor } = req.params;
    const { bufferDays, keterangan } = req.body;
    const userKode = req.user?.user_kode;
    if (req.user?.user_hrd !== 1) return res.status(403).json({ success: false, message: 'Hanya HRD' });
    if (!bufferDays||isNaN(bufferDays)||bufferDays<=0||bufferDays>30) return res.status(400).json({ success: false, message: 'bufferDays 1-30' });
    if (!keterangan||keterangan.trim().length<5) return res.status(400).json({ success: false, message: 'Keterangan minimal 5 karakter' });
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [slaRows] = await conn.query(`SELECT sla_id, sla_no_show_buffer_days, sla_status, sla_hired_count FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor=?`, [tpkNomor]);
        if (slaRows.length===0){await conn.rollback();return res.status(404).json({success:false,message:'SLA tidak ditemukan'});}
        const sla = slaRows[0];
        if (sla.sla_status==='CANCELLED'){await conn.rollback();return res.status(400).json({success:false,message:'SLA sudah CANCELLED'});}
        const oldBuffer = sla.sla_no_show_buffer_days||0;
        const newBuffer = oldBuffer+parseInt(bufferDays);
        let statusUpdateQuery = sla.sla_status==='COMPLETED'?`, sla_status='CALCULATED', sla_completed_at=NULL, sla_hired_count=GREATEST(0,sla_hired_count-1)`:'';
        await conn.query(`UPDATE rekruitmen2.t_recruitment_sla SET sla_no_show_buffer_days=? ${statusUpdateQuery} WHERE sla_tpk_nomor=?`, [newBuffer, tpkNomor]);
        await conn.query(`INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor,sla_id,user_kode,field_name,old_value,new_value) VALUES(?,?,?,'no_show_buffer',?,?)`, [tpkNomor, sla.sla_id, userKode, `${oldBuffer} hari`, `${newBuffer} hari (+${bufferDays}) — ${keterangan.trim()}`]);
        await conn.commit();
        return res.json({ success: true, message: 'Buffer no-show dicatat.' });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ success: false, message: err.message });
    } finally { conn.release(); }
});

router.get('/:tpkNomor/hired-candidates', authenticate, async (req, res) => {
    try {
        const { tpkNomor } = req.params;
        const [rows] = await db.query(`
            SELECT rpk_nomor AS rkt_nomor, rpk_keterangannama AS nama,
                   rpk_tanggal AS tgl_diterima, COALESCE(rpk_jumlah,1) as rpk_jumlah
            FROM hrd2.triilpermintaankaryawan WHERE rpk_tpk_nomor = ?
        `, [tpkNomor]);
        const processedCandidates = [];
        rows.forEach(row => {
            const rawNama = row.nama||'Tanpa Nama';
            if (rawNama.includes('\n')) {
                rawNama.split(/\r?\n/).filter(n=>n.trim()!=='').forEach(namePiece => {
                    processedCandidates.push({rkt_nomor:row.rkt_nomor,nama:namePiece.trim(),tgl_diterima:row.tgl_diterima,is_grouped:true});
                });
            } else {
                processedCandidates.push({rkt_nomor:row.rkt_nomor,nama:rawNama.trim(),tgl_diterima:row.tgl_diterima,is_grouped:row.rpk_jumlah>1});
            }
        });
        res.json({ success: true, data: processedCandidates });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/:tpkNomor/cancel-candidate', authenticate, async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { tpkNomor } = req.params;
        const { rktNomor, bufferDays, keterangan } = req.body;
        const userKode = req.user.user_kode;
        const [realisasi] = await connection.query('SELECT rpk_keterangannama, COALESCE(rpk_jumlah,1) as rpk_jumlah FROM hrd2.triilpermintaankaryawan WHERE rpk_tpk_nomor=? AND rpk_nomor=?', [tpkNomor, rktNomor]);
        if (realisasi.length===0){await connection.rollback();return res.status(404).json({success:false,message:'Kandidat tidak ditemukan'});}
        const namaKandidat = realisasi[0].rpk_keterangannama||'';
        if (realisasi[0].rpk_jumlah>1||namaKandidat.includes('\n')){await connection.rollback();return res.status(400).json({success:false,message:'Data kandidat grup tidak bisa dibatalkan.'});}
        const [slaRow] = await connection.query('SELECT sla_id FROM rekruitmen2.t_recruitment_sla WHERE sla_tpk_nomor=?',[tpkNomor]);
        const sla_id = slaRow.length>0?slaRow[0].sla_id:null;
        await connection.query('DELETE FROM hrd2.triilpermintaankaryawan WHERE rpk_tpk_nomor=? AND rpk_nomor=?',[tpkNomor,rktNomor]);
        await connection.query(`UPDATE rekruitmen2.t_recruitment_sla SET sla_hired_count=GREATEST(0,sla_hired_count-1),sla_status='CALCULATED',sla_no_show_buffer_days=sla_no_show_buffer_days+?,sla_completed_at=NULL WHERE sla_tpk_nomor=?`,[bufferDays,tpkNomor]);
        const logNotes = `Kandidat dibatalkan (No-Show). Buffer +${bufferDays} hari. Alasan: ${keterangan}`;
        await connection.query(`INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor,sla_id,user_kode,field_name,old_value,new_value) VALUES(?,?,?,'cancel_candidate','Hired',?)`,[tpkNomor,sla_id,userKode,logNotes]);
        await connection.commit();
        res.json({ success: true, message: 'Kandidat dibatalkan', data: { addedDays: bufferDays } });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: 'Server error' });
    } finally { connection.release(); }
});

module.exports = router;