// src/modules/selection.js
const express = require('express');
const db = require('../config/db');
const router = express.Router();

/**
 * =====================================================================
 * MODULE: SELECTION PROCESS (TRIGGER-ALIGNED VERSION)
 * =====================================================================
 * LATEST UPDATES (2026-02-13):
 * ✅ CRITICAL FIX: Removed manual INSERT to triilpermintaankaryawan
 * ✅ CRITICAL FIX: Shadow record creation BEFORE trigger execution
 * ✅ CRITICAL FIX: Consistent kar_Nik casing (capital N)
 * ✅ No-Show Buffer Days — Otomatis adjust SLA saat kandidat tidak datang
 * ✅ Re-open Edit Tanggal — User bisa edit setelah No-Show
 * ✅ Fair KPI Calculation — HRD tidak di-penalti karena kandidat flaky
 * 
 * STATUS FLOW:
 * 0: Belum diputuskan
 * 1: Diterima - Sudah Jadi Karyawan (Hired & Onboarded)
 * 2: Tidak Diterima (Rejected)
 * 3: Dipanggil Tidak Datang (No Show) ← TRIGGER SLA ADJUSTMENT
 * 4: Pelatihan (Training - Pending)
 * 5: Diterima - Menunggu Onboarding (Approved, Not Yet Hired)
 * 6: Diterima - Gagal Onboarding (Approved but Failed to Join)
 * 
 * TRIGGER INTEGRATION:
 * - tlistpelamar_after_update: AUTO INSERT triilpermintaankaryawan (status=1)
 * - tlistpelamar_after_update: AUTO UPDATE tgl_diterima/tgl_tidakditerima
 * - tlistpelamar_after_update: AUTO UPDATE trekruitmen.rkt_status
 * =====================================================================
 */


// =====================================================================
// HELPER: Log Activity (Audit Trail)
// =====================================================================
async function logActivity(connection, data) {
    const { tpk_nomor, tlp_rkt_nomor, action, status_before, status_after, user_kode, keterangan } = data;
    try {
        await connection.execute(
            `INSERT INTO t_selection_log 
            (log_tlp_tpk_nomor, log_tlp_rkt_nomor, log_action, log_status_before, log_status_after, log_user_kode, log_keterangan)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [tpk_nomor, tlp_rkt_nomor, action, status_before ?? null, status_after ?? null, user_kode || null, keterangan || null]
        );
    } catch (error) {
        console.warn('⚠️ Warning: Failed to log activity:', error.message);
    }
}


// =====================================================================
// HELPER: Generate NIK (CONCURRENCY SAFE)
// =====================================================================
async function generateNIK(connection) {
    const year = new Date().getFullYear();

    // 1. Pastikan row exists (create jika belum ada)
    await connection.execute(
        `INSERT INTO t_sequence_tracker (seq_name, current_val, year)
         VALUES ('NIK', ?, ?)
         ON DUPLICATE KEY UPDATE seq_name = seq_name`,
        [year * 1000, year]
    );

    // 2. Lock row + increment secara atomic
    const [res] = await connection.execute(
        `SELECT current_val 
         FROM t_sequence_tracker 
         WHERE seq_name = 'NIK' AND year = ?
         FOR UPDATE`,
        [year]
    );

    const nextVal = res[0].current_val + 1;

    // 3. Update dengan nilai baru
    await connection.execute(
        `UPDATE t_sequence_tracker 
         SET current_val = ?
         WHERE seq_name = 'NIK' AND year = ?`,
        [nextVal, year]
    );

    return String(nextVal);
}


// =====================================================================
// HELPER: Schedule Evaluasi ke t_evaluasi
// =====================================================================
async function upsertEvaluasiSchedule(connection, tpk_nomor, tlp_rkt_nomor, jenis, tanggal) {
    await connection.execute(
        `INSERT INTO t_evaluasi (eval_tlp_tpk_nomor, eval_tlp_rkt_nomor, eval_jenis, eval_tanggal, eval_status)
         VALUES (?, ?, ?, ?, 'SCHEDULED')
         ON DUPLICATE KEY UPDATE 
            eval_tanggal = VALUES(eval_tanggal),
            eval_status = 'SCHEDULED'`,
        [tpk_nomor, tlp_rkt_nomor, jenis, tanggal]
    );
}


// =====================================================================
// HELPER: Hitung Buffer Days untuk No-Show (FAIR CALCULATION)
// =====================================================================
async function calculateNoShowBuffer(connection, tpk_nomor) {
    const [countResult] = await connection.execute(
        `SELECT COUNT(*) AS no_show_count
         FROM t_selection_log
         WHERE log_tlp_tpk_nomor = ?
           AND log_action = 'NO_SHOW_TRIGGER'`,
        [tpk_nomor]
    );
    const noShowCount = countResult[0].no_show_count;
    if (noShowCount === 1) return 7;
    if (noShowCount === 2) return 5;
    return 3;
}

// =====================================================================
// HELPER: Get No-Show Count (untuk logging & display)
// =====================================================================
async function getNoShowCount(connection, tpk_nomor) {
    const [result] = await connection.execute(
        `SELECT COUNT(*) AS count
         FROM t_selection_log
         WHERE log_tlp_tpk_nomor = ?
           AND log_action = 'NO_SHOW_TRIGGER'`,
        [tpk_nomor]
    );
    return result[0].count;
}


// =====================================================================
// SECTION 1: UNIFIED SHORTLIST (HRD Matching)
// =====================================================================

/**
 * POST /api/selection/shortlist
 * ✅ WITH TRANSACTION & LOGGING
 */
router.post('/shortlist', async (req, res) => {
    const { tpk_nomor, source_type, source_id } = req.body;

    if (!tpk_nomor || !source_type || !source_id) {
        return res.status(400).json({
            success: false,
            message: 'tpk_nomor, source_type, dan source_id wajib diisi'
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let tlp_rkt_nomor;
        let candidateName;
        let candidateData = {};

        // --- Validasi berdasarkan source_type ---
        if (source_type === 'applicant') {
            const [checkApplicant] = await connection.execute(
                'SELECT applicant_id, nik, nama_lengkap, posisi_dilamar FROM t_applicant WHERE applicant_id = ? FOR UPDATE',
                [source_id]
            );

            if (checkApplicant.length === 0) {
                await connection.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Pelamar tidak ditemukan di database'
                });
            }

            tlp_rkt_nomor = `APP-${source_id}`;
            candidateName = checkApplicant[0].nama_lengkap;
            candidateData = checkApplicant[0];

        } else if (source_type === 'rekruitmen') {
            const [checkRekruitmen] = await connection.execute(
                'SELECT rkt_nomor, rkt_nama, rkt_posisi FROM trekruitmen WHERE rkt_nomor = ? AND rkt_status <> 1 FOR UPDATE',
                [source_id]
            );

            if (checkRekruitmen.length === 0) {
                await connection.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Kandidat tidak ditemukan atau sudah hired'
                });
            }

            tlp_rkt_nomor = source_id;
            candidateName = checkRekruitmen[0].rkt_nama;
            candidateData = checkRekruitmen[0];

        } else {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'source_type harus "applicant" atau "rekruitmen"'
            });
        }

        // --- Validasi lowongan ---
        const [checkJob] = await connection.execute(
            'SELECT tpk_approveHRD, tpk_jumlah FROM tpermintaankaryawan WHERE tpk_nomor = ? FOR UPDATE',
            [tpk_nomor]
        );

        if (checkJob.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Lowongan tidak ditemukan'
            });
        }

        if (checkJob[0].tpk_approveHRD !== 1) {
            await connection.rollback();
            return res.status(403).json({
                success: false,
                message: 'Lowongan belum di-approve HRD'
            });
        }

        // --- Cek duplikasi ---
        const [checkExist] = await connection.execute(
            'SELECT tlp_rkt_nomor FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ?',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (checkExist.length > 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Kandidat sudah pernah di-shortlist ke lowongan ini'
            });
        }

        // --- Insert ke tlistpelamar ---
        await connection.execute(
            `INSERT INTO tlistpelamar 
            (tlp_tpk_nomor, tlp_rkt_nomor, tlp_tglinsert, tlp_status, statusterakhir) 
            VALUES (?, ?, CURDATE(), 0, 0)`,
            [tpk_nomor, tlp_rkt_nomor]
        );

        // --- Log activity ---
        await logActivity(connection, {
            tpk_nomor,
            tlp_rkt_nomor,
            action: 'SHORTLIST',
            status_before: null,
            status_after: 0,
            user_kode: req.user?.user_kode,
            keterangan: `Kandidat ${candidateName} di-shortlist ke lowongan ${tpk_nomor}`
        });

        await connection.commit();

        res.json({
            success: true,
            message: 'Kandidat berhasil di-shortlist',
            data: {
                tpk_nomor,
                tlp_rkt_nomor,
                source_type,
                nama: candidateName,
                candidate_info: candidateData
            }
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error shortlist:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal shortlist kandidat',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


// =====================================================================
// SECTION 2: UNIFIED CANDIDATES LIST
// =====================================================================

/**
 * GET /api/selection/candidates
 * List kandidat yang sudah di-shortlist (unified dari 2 sumber)
 */
router.get('/candidates', async (req, res) => {
    const { tpk_nomor, stage, source_filter } = req.query;

    if (!tpk_nomor) {
        return res.status(400).json({
            success: false,
            message: 'Parameter tpk_nomor wajib diisi'
        });
    }

    try {
        let sql = `
            SELECT 
                lp.tlp_rkt_nomor,
                lp.tlp_status,
                lp.statusterakhir,
                DATE_FORMAT(lp.tlp_tglinsert, '%Y-%m-%d')      AS tgl_shortlist,
                DATE_FORMAT(lp.tgl_tes, '%Y-%m-%d')             AS tgl_tes,
                DATE_FORMAT(lp.tgl_interviewuser, '%Y-%m-%d')   AS tgl_interviewuser,
                DATE_FORMAT(lp.tgl_interviewhrd, '%Y-%m-%d')    AS tgl_interviewhrd,
                DATE_FORMAT(lp.tgl_diterima, '%Y-%m-%d')        AS tgl_diterima,
                DATE_FORMAT(lp.tgl_tidakditerima, '%Y-%m-%d')   AS tgl_tidakditerima,

                -- Dynamic source detection
                CASE 
                    WHEN lp.tlp_rkt_nomor LIKE 'APP-%' THEN 'applicant'
                    ELSE 'rekruitmen'
                END AS source_type,

                -- Extract ID berdasarkan source
                CASE 
                    WHEN lp.tlp_rkt_nomor LIKE 'APP-%' THEN SUBSTRING(lp.tlp_rkt_nomor, 5)
                    ELSE lp.tlp_rkt_nomor
                END AS source_id,

                -- Data dari t_applicant
                a.applicant_id,
                a.nik                       AS applicant_nik,
                a.nama_lengkap              AS applicant_nama,
                a.jenis_kelamin             AS applicant_gender,
                a.nomor_telepon             AS applicant_telp,
                a.email                     AS applicant_email,
                a.posisi_dilamar            AS applicant_posisi,
                a.pendidikan_terakhir       AS applicant_pendidikan,
                a.cv_link,
                a.ekspektasi_gaji,

                -- Data dari trekruitmen
                r.rkt_nomor,
                r.rkt_nama,
                IF(r.rkt_jenkel = 1, 'Laki-Laki', 'Perempuan') AS rkt_jenkel_str,
                r.rkt_jenkel,
                r.rkt_telp,
                r.rkt_email,
                r.rkt_posisi,
                r.rkt_pendidikanterakhir,
                r.rkt_identitas,

                -- Unified output fields
                COALESCE(a.nama_lengkap, r.rkt_nama)                         AS nama,
                COALESCE(a.nomor_telepon, r.rkt_telp)                        AS telepon,
                COALESCE(a.email, r.rkt_email)                               AS email,
                COALESCE(a.posisi_dilamar, r.rkt_posisi)                     AS posisi,
                COALESCE(a.pendidikan_terakhir, r.rkt_pendidikanterakhir)    AS pendidikan,

                -- Status labels
                CASE lp.tlp_status
                    WHEN 0 THEN 'Belum Verifikasi'
                    WHEN 1 THEN 'Terverifikasi'
                    ELSE 'Unknown'
                END AS status_verifikasi,

                CASE lp.statusterakhir 
                    WHEN 0 THEN 'Belum diputuskan'
                    WHEN 1 THEN 'Diterima - Sudah Jadi Karyawan'
                    WHEN 2 THEN 'Tidak Diterima'
                    WHEN 3 THEN 'Dipanggil Tidak Datang'
                    WHEN 4 THEN 'Pelatihan'
                    WHEN 5 THEN 'Diterima - Menunggu Onboarding'
                    WHEN 6 THEN 'Diterima - Gagal Onboarding'
                    ELSE 'Unknown'
                END AS status_akhir_text,

                -- Subquery dari tabel baru
                (SELECT COUNT(*) FROM t_evaluasi 
                    WHERE eval_tlp_tpk_nomor = lp.tlp_tpk_nomor 
                      AND eval_tlp_rkt_nomor = lp.tlp_rkt_nomor
                ) AS jml_evaluasi,

                (SELECT pel_status FROM t_pelatihan 
                    WHERE pel_tlp_tpk_nomor = lp.tlp_tpk_nomor 
                      AND pel_tlp_rkt_nomor = lp.tlp_rkt_nomor 
                    ORDER BY pel_id DESC LIMIT 1
                ) AS pelatihan_status,

                (SELECT onb_status FROM t_onboarding 
                    WHERE onb_tlp_tpk_nomor = lp.tlp_tpk_nomor 
                      AND onb_tlp_rkt_nomor = lp.tlp_rkt_nomor 
                    ORDER BY onb_id DESC LIMIT 1
                ) AS onboarding_status

            FROM tlistpelamar lp

            LEFT JOIN t_applicant  a ON CONCAT('APP-', a.applicant_id) = lp.tlp_rkt_nomor
            LEFT JOIN trekruitmen  r ON r.rkt_nomor = lp.tlp_rkt_nomor

            WHERE lp.tlp_tpk_nomor = ?
        `;

        const params = [tpk_nomor];

        // --- Filter by source ---
        if (source_filter === 'applicant') {
            sql += ` AND lp.tlp_rkt_nomor LIKE 'APP-%'`;
        } else if (source_filter === 'rekruitmen') {
            sql += ` AND lp.tlp_rkt_nomor NOT LIKE 'APP-%'`;
        }

        // --- Filter by stage ---
        const stageMap = {
            shortlist:           ` AND 1=1`,
            verified:            ` AND lp.tlp_status = 1`,
            test:                ` AND lp.tgl_tes IS NOT NULL`,
            interview_user:      ` AND lp.tgl_interviewuser IS NOT NULL`,
            interview_hrd:       ` AND lp.tgl_interviewhrd IS NOT NULL`,
            decided:             ` AND lp.statusterakhir <> 0`,
            pending:             ` AND lp.statusterakhir = 0`,
            training:            ` AND lp.statusterakhir = 4`,
            approved_pending:    ` AND lp.statusterakhir = 5`,
            hired:               ` AND lp.statusterakhir = 1`
        };

        if (stage && stageMap[stage]) {
            sql += stageMap[stage];
        }

        sql += ` ORDER BY lp.tlp_tglinsert DESC, nama ASC`;

        const [rows] = await db.execute(sql, params);

        res.json({
            success: true,
            data: rows,
            count: rows.length,
            summary: {
                total:               rows.length,
                from_applicant:      rows.filter(r => r.source_type === 'applicant').length,
                from_rekruitmen:     rows.filter(r => r.source_type === 'rekruitmen').length,
                verified:            rows.filter(r => r.tlp_status === 1).length,
                decided:             rows.filter(r => r.statusterakhir !== 0).length,
                hired:               rows.filter(r => r.statusterakhir === 1).length,
                training:            rows.filter(r => r.statusterakhir === 4).length,
                pending_onboarding:  rows.filter(r => r.statusterakhir === 5).length
            }
        });

    } catch (error) {
        console.error('❌ Error get candidates:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data kandidat',
            error: error.message
        });
    }
});

// CONTINUATION OF selection.js - PART 2 (CRITICAL SECTIONS)

// ... (continuing from part 1)

/**
 * GET /api/selection/candidate-detail
 * Detail kandidat (auto-detect source) + evaluasi, pelatihan, onboarding, log
 */
router.get('/candidate-detail', async (req, res) => {
    const { tpk_nomor, tlp_rkt_nomor } = req.query;

    if (!tpk_nomor || !tlp_rkt_nomor) {
        return res.status(400).json({
            success: false,
            message: 'Parameter tpk_nomor dan tlp_rkt_nomor diperlukan'
        });
    }

    try {
        const [checkShortlist] = await db.execute(
            'SELECT * FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ?',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (checkShortlist.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Data kandidat tidak ditemukan di lowongan ini'
            });
        }

        const shortlistData = checkShortlist[0];
        const isFromApplicant = tlp_rkt_nomor.startsWith('APP-');

        let candidateDetail = {};

        if (isFromApplicant) {
            const applicant_id = tlp_rkt_nomor.replace('APP-', '');
            const [applicantData] = await db.execute(
                'SELECT * FROM t_applicant WHERE applicant_id = ?',
                [applicant_id]
            );

            if (applicantData.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Data applicant tidak ditemukan'
                });
            }

            candidateDetail = { source_type: 'applicant', ...applicantData[0] };

        } else {
            const [rekruitmenData] = await db.execute(
                'SELECT * FROM trekruitmen WHERE rkt_nomor = ?',
                [tlp_rkt_nomor]
            );

            if (rekruitmenData.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Data kandidat tidak ditemukan'
                });
            }

            const [experienceData] = await db.execute(
                'SELECT * FROM trekruitmenpengalaman WHERE rktp_rkt_nomor = ? ORDER BY rktp_tglmasuk DESC',
                [tlp_rkt_nomor]
            );

            candidateDetail = {
                source_type: 'rekruitmen',
                ...rekruitmenData[0],
                pengalaman_kerja: experienceData
            };
        }

        const [evaluasiData] = await db.execute(
            `SELECT * FROM t_evaluasi 
             WHERE eval_tlp_tpk_nomor = ? AND eval_tlp_rkt_nomor = ?
             ORDER BY eval_tanggal DESC, eval_created_at DESC`,
            [tpk_nomor, tlp_rkt_nomor]
        );

        const [pelatihanData] = await db.execute(
            `SELECT * FROM t_pelatihan 
             WHERE pel_tlp_tpk_nomor = ? AND pel_tlp_rkt_nomor = ?
             ORDER BY pel_id DESC`,
            [tpk_nomor, tlp_rkt_nomor]
        );

        const [onboardingData] = await db.execute(
            `SELECT * FROM t_onboarding 
             WHERE onb_tlp_tpk_nomor = ? AND onb_tlp_rkt_nomor = ?
             ORDER BY onb_id DESC`,
            [tpk_nomor, tlp_rkt_nomor]
        );

        const [logData] = await db.execute(
            `SELECT * FROM t_selection_log 
             WHERE log_tlp_tpk_nomor = ? AND log_tlp_rkt_nomor = ?
             ORDER BY log_created_at DESC
             LIMIT 20`,
            [tpk_nomor, tlp_rkt_nomor]
        );

        res.json({
            success: true,
            data: {
                shortlist_info:   shortlistData,
                candidate_detail: candidateDetail,
                evaluasi:         evaluasiData,
                pelatihan:        pelatihanData.length > 0 ? pelatihanData[0] : null,
                onboarding:       onboardingData.length > 0 ? onboardingData[0] : null,
                activity_log:     logData
            }
        });

    } catch (error) {
        console.error('❌ Error get candidate detail:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil detail kandidat',
            error: error.message
        });
    }
});


// =====================================================================
// SECTION 3: VERIFICATION
// =====================================================================

router.put('/verify', async (req, res) => {
    const { tpk_nomor, tlp_rkt_nomor } = req.body;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        
        const [curr] = await connection.execute(
            'SELECT tlp_status FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ? FOR UPDATE',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (curr.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Kandidat tidak ditemukan' });
        }

        if (curr[0].tlp_status === 1) {
            await connection.rollback();
            return res.status(200).json({ success: true, message: 'Sudah terverifikasi' });
        }

        await connection.execute(
            'UPDATE tlistpelamar SET tlp_status = 1 WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ?',
            [tpk_nomor, tlp_rkt_nomor]
        );

        await logActivity(connection, {
            tpk_nomor, tlp_rkt_nomor, action: 'VERIFY',
            status_before: 0, status_after: 1, user_kode: req.user?.user_kode,
            keterangan: 'Kandidat terverifikasi'
        });

        await connection.commit();
        res.json({ success: true, message: 'Berhasil verifikasi' });
    } catch (e) { await connection.rollback(); res.status(500).json({ error: e.message }); }
    finally { connection.release(); }
});


// =====================================================================
// SECTION 4: SCHEDULING (Tes & Interview)
// =====================================================================

router.put('/schedule', async (req, res) => {
    const { tpk_nomor, tlp_rkt_nomor, tgl_tes, tgl_interviewuser, tgl_interviewhrd } = req.body;

    if (!tpk_nomor || !tlp_rkt_nomor) {
        return res.status(400).json({
            success: false,
            message: 'tpk_nomor dan tlp_rkt_nomor wajib diisi'
        });
    }

    if (!tgl_tes && !tgl_interviewuser && !tgl_interviewhrd) {
        return res.status(400).json({
            success: false,
            message: 'Minimal harus ada satu tanggal yang diisi'
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [checkRows] = await connection.execute(
            'SELECT tlp_status FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ? FOR UPDATE',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (checkRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Kandidat belum di-shortlist ke lowongan ini'
            });
        }

        if (checkRows[0].tlp_status === 0) {
            await connection.execute(
                'UPDATE tlistpelamar SET tlp_status = 1 WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ?',
                [tpk_nomor, tlp_rkt_nomor]
            );
        }

        let updateFields = [];
        let params = [];

        if (tgl_tes)            { updateFields.push('tgl_tes = ?');            params.push(tgl_tes); }
        if (tgl_interviewuser)  { updateFields.push('tgl_interviewuser = ?');  params.push(tgl_interviewuser); }
        if (tgl_interviewhrd)   { updateFields.push('tgl_interviewhrd = ?');   params.push(tgl_interviewhrd); }

        params.push(tpk_nomor, tlp_rkt_nomor);

        await connection.execute(
            `UPDATE tlistpelamar SET ${updateFields.join(', ')} WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ?`,
            params
        );

        if (tgl_tes)            await upsertEvaluasiSchedule(connection, tpk_nomor, tlp_rkt_nomor, 'TES',            tgl_tes);
        if (tgl_interviewuser)  await upsertEvaluasiSchedule(connection, tpk_nomor, tlp_rkt_nomor, 'INTERVIEW_USER', tgl_interviewuser);
        if (tgl_interviewhrd)   await upsertEvaluasiSchedule(connection, tpk_nomor, tlp_rkt_nomor, 'INTERVIEW_HRD',  tgl_interviewhrd);

        await logActivity(connection, {
            tpk_nomor,
            tlp_rkt_nomor,
            action: 'SCHEDULE',
            user_kode: req.user?.user_kode,
            keterangan: `Jadwal diset: Tes=${tgl_tes || 'N/A'}, IntUser=${tgl_interviewuser || 'N/A'}, IntHRD=${tgl_interviewhrd || 'N/A'}`
        });

        await connection.commit();

        res.json({
            success: true,
            message: 'Jadwal berhasil disimpan',
            data: {}
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error schedule:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal menyimpan jadwal',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


// =====================================================================
// SECTION 5: EVALUASI (TES & INTERVIEW RESULTS)
// =====================================================================

router.post('/evaluasi', async (req, res) => {
    const { tpk_nomor, tlp_rkt_nomor, jenis, tanggal, nilai, keterangan, evaluator, status } = req.body;

    const validJenis  = ['TES', 'INTERVIEW_USER', 'INTERVIEW_HRD'];
    const validStatus = ['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];

    if (!tpk_nomor || !tlp_rkt_nomor || !jenis) {
        return res.status(400).json({
            success: false,
            message: 'tpk_nomor, tlp_rkt_nomor, dan jenis wajib diisi'
        });
    }

    if (!validJenis.includes(jenis)) {
        return res.status(400).json({
            success: false,
            message: 'Jenis tidak valid',
            valid_jenis: validJenis
        });
    }

    if (status && !validStatus.includes(status)) {
        return res.status(400).json({
            success: false,
            message: 'Status tidak valid',
            valid_status: validStatus
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [checkKandidat] = await connection.execute(
            'SELECT 1 FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ?',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (checkKandidat.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Kandidat tidak ditemukan'
            });
        }

        await connection.execute(
            `INSERT INTO t_evaluasi 
            (eval_tlp_tpk_nomor, eval_tlp_rkt_nomor, eval_jenis, eval_tanggal, eval_nilai, eval_keterangan, eval_evaluator, eval_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [tpk_nomor, tlp_rkt_nomor, jenis, tanggal || null, nilai || null, keterangan || null, evaluator || null, status || 'COMPLETED']
        );

        await logActivity(connection, {
            tpk_nomor,
            tlp_rkt_nomor,
            action: 'EVALUASI',
            user_kode: req.user?.user_kode,
            keterangan: `${jenis} - Nilai: ${nilai || 'N/A'} - Status: ${status || 'COMPLETED'}`
        });

        await connection.commit();

        res.json({
            success: true,
            message: 'Evaluasi berhasil diupdate',
            data: {}
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error evaluasi:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal menyimpan evaluasi',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


router.put('/evaluasi/:eval_id', async (req, res) => {
    const { eval_id }  = req.params;
    const { tanggal, nilai, keterangan, evaluator, status } = req.body;

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let updateFields = [];
        let params = [];

        if (tanggal    !== undefined) { updateFields.push('eval_tanggal   = ?'); params.push(tanggal); }
        if (nilai      !== undefined) { updateFields.push('eval_nilai     = ?'); params.push(nilai); }
        if (keterangan !== undefined) { updateFields.push('eval_keterangan = ?'); params.push(keterangan); }
        if (evaluator  !== undefined) { updateFields.push('eval_evaluator = ?'); params.push(evaluator); }
        if (status     !== undefined) { updateFields.push('eval_status    = ?'); params.push(status); }

        if (updateFields.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Tidak ada data yang diupdate'
            });
        }

        params.push(eval_id);

        const [result] = await connection.execute(
            `UPDATE t_evaluasi SET ${updateFields.join(', ')} WHERE eval_id = ?`,
            params
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Data evaluasi tidak ditemukan'
            });
        }

        await connection.commit();

        res.json({
            success: true,
            message: 'Evaluasi berhasil diupdate',
            data: null
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error update evaluasi:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal update evaluasi',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


// =====================================================================
// SECTION 6: PELATIHAN MANAGEMENT
// =====================================================================

router.post('/pelatihan/start', async (req, res) => {
    const { tpk_nomor, tlp_rkt_nomor, jenis, tgl_mulai, durasi_hari, instruktur, lokasi, keterangan } = req.body;

    if (!tpk_nomor || !tlp_rkt_nomor) {
        return res.status(400).json({
            success: false,
            message: 'tpk_nomor dan tlp_rkt_nomor wajib diisi'
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [checkKandidat] = await connection.execute(
            'SELECT statusterakhir FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ? FOR UPDATE',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (checkKandidat.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Kandidat tidak ditemukan'
            });
        }

        if (checkKandidat[0].statusterakhir !== 4) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Kandidat belum dalam status Pelatihan (4). Set status ke 4 terlebih dahulu via /decision.'
            });
        }

        const mulaiDate   = tgl_mulai ? new Date(tgl_mulai) : new Date();
        const durasi      = parseInt(durasi_hari) || 30;
        const selesaiDate = new Date(mulaiDate);
        selesaiDate.setDate(selesaiDate.getDate() + durasi);

        const tglMulaiStr   = mulaiDate.toISOString().split('T')[0];
        const tglSelesaiStr = selesaiDate.toISOString().split('T')[0];

        const [result] = await connection.execute(
            `INSERT INTO t_pelatihan 
            (pel_tlp_tpk_nomor, pel_tlp_rkt_nomor, pel_jenis, pel_tgl_mulai, pel_tgl_selesai_rencana, 
             pel_durasi_hari, pel_instruktur, pel_lokasi, pel_keterangan, pel_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ONGOING')`,
            [
                tpk_nomor,
                tlp_rkt_nomor,
                jenis || 'Pelatihan Umum',
                tglMulaiStr,
                tglSelesaiStr,
                durasi,
                instruktur || null,
                lokasi     || null,
                keterangan || null
            ]
        );

        await logActivity(connection, {
            tpk_nomor,
            tlp_rkt_nomor,
            action: 'PELATIHAN_START',
            user_kode: req.user?.user_kode,
            keterangan: `Pelatihan dimulai - Durasi: ${durasi} hari`
        });

        await connection.commit();

        res.json({
            success: true,
            message: 'Pelatihan berhasil dimulai',
            data: {
                pel_id:              result.insertId,
                tgl_mulai:           tglMulaiStr,
                tgl_selesai_rencana: tglSelesaiStr,
                durasi_hari:         durasi
            }
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error start pelatihan:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal memulai pelatihan',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


router.put('/pelatihan/:pel_id/complete', async (req, res) => {
    const { pel_id } = req.params;
    const { status, nilai, keterangan, tgl_selesai } = req.body;

    const validStatus = ['COMPLETED', 'FAILED'];

    if (!status || !validStatus.includes(status)) {
        return res.status(400).json({
            success: false,
            message: 'Status tidak valid',
            valid_status: validStatus
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [pelatihanData] = await connection.execute(
            'SELECT * FROM t_pelatihan WHERE pel_id = ? FOR UPDATE',
            [pel_id]
        );

        if (pelatihanData.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Data pelatihan tidak ditemukan'
            });
        }

        const pelatihan     = pelatihanData[0];
        const tpk_nomor     = pelatihan.pel_tlp_tpk_nomor;
        const tlp_rkt_nomor = pelatihan.pel_tlp_rkt_nomor;
        const tglSelesai    = tgl_selesai || new Date().toISOString().split('T')[0];

        await connection.execute(
            `UPDATE t_pelatihan 
             SET pel_status = ?, pel_nilai = ?, pel_keterangan = ?, pel_tgl_selesai_aktual = ?
             WHERE pel_id = ?`,
            [status, nilai || null, keterangan || null, tglSelesai, pel_id]
        );

        const newStatus = status === 'COMPLETED' ? 5 : 2;

        // ================================================================
        // ⚠️ TRIGGER SAFE: Tambahkan WHERE untuk idempotency
        // ================================================================
        const [updateResult] = await connection.execute(
            `UPDATE tlistpelamar 
             SET statusterakhir = ? 
             WHERE tlp_tpk_nomor = ? 
               AND tlp_rkt_nomor = ?
               AND statusterakhir = 4`,
            [newStatus, tpk_nomor, tlp_rkt_nomor]
        );

        if (updateResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Status kandidat sudah berubah atau tidak dalam status Training. Silakan refresh halaman.'
            });
        }

        await logActivity(connection, {
            tpk_nomor,
            tlp_rkt_nomor,
            action: 'PELATIHAN_COMPLETE',
            status_before: 4,
            status_after: newStatus,
            user_kode: req.user?.user_kode,
            keterangan: `Pelatihan ${status} - Nilai: ${nilai || 'N/A'}`
        });

        await connection.commit();

        res.json({
            success: true,
            message: status === 'COMPLETED'
                ? 'Pelatihan selesai — Kandidat lulus dan menunggu onboarding'
                : 'Pelatihan selesai — Kandidat tidak diterima',
            data: {
                new_status:  newStatus,
                status_text: newStatus === 5 ? 'Diterima - Menunggu Onboarding' : 'Tidak Diterima'
            }
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error complete pelatihan:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal menyelesaikan pelatihan',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


// =====================================================================
// SECTION 7: ONBOARDING PROCESS (TRIGGER-ALIGNED)
// =====================================================================

router.post('/onboarding/start', async (req, res) => {
    const { tpk_nomor, tlp_rkt_nomor, tgl_mulai, keterangan } = req.body;

    if (!tpk_nomor || !tlp_rkt_nomor) {
        return res.status(400).json({
            success: false,
            message: 'tpk_nomor dan tlp_rkt_nomor wajib diisi'
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [checkKandidat] = await connection.execute(
            'SELECT statusterakhir FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ? FOR UPDATE',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (checkKandidat.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Kandidat tidak ditemukan'
            });
        }

        if (checkKandidat[0].statusterakhir !== 5) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Kandidat belum dalam status Approved (5). Status harus 5 (Diterima - Menunggu Onboarding).'
            });
        }

        const tglMulaiStr = tgl_mulai || new Date().toISOString().split('T')[0];

        const [result] = await connection.execute(
            `INSERT INTO t_onboarding 
            (onb_tlp_tpk_nomor, onb_tlp_rkt_nomor, onb_tgl_mulai, onb_status, onb_keterangan)
            VALUES (?, ?, ?, 'ONGOING', ?)`,
            [tpk_nomor, tlp_rkt_nomor, tglMulaiStr, keterangan || null]
        );

        await logActivity(connection, {
            tpk_nomor,
            tlp_rkt_nomor,
            action: 'ONBOARDING_START',
            user_kode: req.user?.user_kode,
            keterangan: 'Proses onboarding dimulai'
        });

        await connection.commit();

        res.json({
            success: true,
            message: 'Proses onboarding berhasil dimulai',
            data: {
                onb_id:    result.insertId,
                tgl_mulai: tglMulaiStr
            }
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error start onboarding:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal memulai onboarding',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


router.put('/onboarding/:onb_id/checklist', async (req, res) => {
    const { onb_id } = req.params;
    const {
        dokumen_lengkap,
        medical_checkup,
        kontrak_signed,
        seragam_diterima,
        id_card_diterima,
        training_completed
    } = req.body;

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let updateFields = [];
        let params = [];

        if (dokumen_lengkap    !== undefined) { updateFields.push('onb_dokumen_lengkap    = ?'); params.push(dokumen_lengkap    ? 1 : 0); }
        if (medical_checkup    !== undefined) { updateFields.push('onb_medical_checkup    = ?'); params.push(medical_checkup    ? 1 : 0); }
        if (kontrak_signed     !== undefined) { updateFields.push('onb_kontrak_signed     = ?'); params.push(kontrak_signed     ? 1 : 0); }
        if (seragam_diterima   !== undefined) { updateFields.push('onb_seragam_diterima   = ?'); params.push(seragam_diterima   ? 1 : 0); }
        if (id_card_diterima   !== undefined) { updateFields.push('onb_id_card_diterima   = ?'); params.push(id_card_diterima   ? 1 : 0); }
        if (training_completed !== undefined) { updateFields.push('onb_training_completed = ?'); params.push(training_completed ? 1 : 0); }

        if (updateFields.length === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Tidak ada checklist yang diupdate'
            });
        }

        params.push(onb_id);

        const [result] = await connection.execute(
            `UPDATE t_onboarding SET ${updateFields.join(', ')} WHERE onb_id = ?`,
            params
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Data onboarding tidak ditemukan'
            });
        }

        await connection.commit();

        res.json({
            success: true,
            message: 'Checklist onboarding berhasil diupdate',
            data: {}
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error update checklist:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal update checklist',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


/**
 * PUT /api/selection/onboarding/:onb_id/complete
 * =====================================================================
 * 🔥 CRITICAL: HIRING PROCESS - FULL TRIGGER ALIGNMENT
 * =====================================================================
 */
router.put('/onboarding/:onb_id/complete', async (req, res) => {
    const { onb_id } = req.params;
    const { status, tgl_selesai, keterangan } = req.body;

    const validStatus = ['COMPLETED', 'NO_SHOW', 'CANCELLED'];

    if (!status || !validStatus.includes(status)) {
        return res.status(400).json({
            success: false,
            message: 'Status tidak valid',
            valid_status: validStatus
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [onboardingData] = await connection.execute(
            'SELECT * FROM t_onboarding WHERE onb_id = ? FOR UPDATE',
            [onb_id]
        );

        if (onboardingData.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Data onboarding tidak ditemukan'
            });
        }

        const onboarding    = onboardingData[0];
        const tpk_nomor     = onboarding.onb_tlp_tpk_nomor;
        const tlp_rkt_nomor = onboarding.onb_tlp_rkt_nomor;
        const tglSelesai    = tgl_selesai || new Date().toISOString().split('T')[0];

        // ================================================================
        // BLOCK: ONBOARDING SUKSES → CREATE EMPLOYEE
        // ================================================================
        if (status === 'COMPLETED') {

            // --- Validasi checklist harus lengkap ---
            const missingChecklist = [];
            if (!onboarding.onb_dokumen_lengkap)    missingChecklist.push('Dokumen Lengkap');
            if (!onboarding.onb_medical_checkup)    missingChecklist.push('Medical Checkup');
            if (!onboarding.onb_kontrak_signed)     missingChecklist.push('Kontrak Signed');
            if (!onboarding.onb_seragam_diterima)   missingChecklist.push('Seragam Diterima');
            if (!onboarding.onb_id_card_diterima)   missingChecklist.push('ID Card Diterima');
            if (!onboarding.onb_training_completed) missingChecklist.push('Training Completed');

            if (missingChecklist.length > 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Checklist belum lengkap — tidak bisa selesaikan onboarding',
                    missing: missingChecklist
                });
            }

            // --- Validasi jumlah hired vs target lowongan ---
            const [hiringStats] = await connection.execute(
                `SELECT 
                    tpk.tpk_jumlah AS target,
                    COUNT(lp.tlp_rkt_nomor) AS total_hired
                 FROM tpermintaankaryawan tpk
                 LEFT JOIN tlistpelamar lp 
                     ON lp.tlp_tpk_nomor = tpk.tpk_nomor 
                    AND lp.statusterakhir = 1
                 WHERE tpk.tpk_nomor = ?
                 GROUP BY tpk.tpk_nomor
                 FOR UPDATE`,
                [tpk_nomor]
            );

            if (hiringStats.length > 0 && hiringStats[0].total_hired >= hiringStats[0].target) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Jumlah hired sudah mencapai target (${hiringStats[0].target}). Tidak bisa menambah karyawan baru untuk lowongan ini.`
                });
            }

            // --- Detect source & ambil candidate data ---
            const isFromApplicant = tlp_rkt_nomor.startsWith('APP-');
            let candidateData;
            let candidateName;

            if (isFromApplicant) {
                const applicant_id = tlp_rkt_nomor.replace('APP-', '');
                const [applicantRows] = await connection.execute(
                    'SELECT * FROM t_applicant WHERE applicant_id = ? FOR UPDATE',
                    [applicant_id]
                );

                if (applicantRows.length === 0) {
                    await connection.rollback();
                    return res.status(404).json({
                        success: false,
                        message: 'Data applicant tidak ditemukan'
                    });
                }

                candidateData = applicantRows[0];
                candidateName = candidateData.nama_lengkap;

                // ================================================================
                // 🔥 CRITICAL FIX: SHADOW RECORD FOR TRIGGER COMPATIBILITY
                // ================================================================
                // Problem: Trigger 'tlistpelamar_after_update' mencari nama dari
                // trekruitmen.rkt_nama, tapi kandidat dari t_applicant tidak ada
                // di tabel trekruitmen.
                // 
                // Solution: Buat shadow record minimal (nomor + nama + status)
                // agar trigger bisa menemukan nama saat INSERT triilpermintaankaryawan.
                // INSERT IGNORE = skip jika sudah ada, prevent duplicate key error.
                // ================================================================
                await connection.execute(
                    `INSERT IGNORE INTO trekruitmen (rkt_nomor, rkt_nama, rkt_status, rkt_tgllahir, rkt_jenkel) 
                     VALUES (?, ?, 1, ?, ?)`,
                    [
                        tlp_rkt_nomor, 
                        candidateName,
                        candidateData.tanggal_lahir || null,
                        candidateData.jenis_kelamin?.toLowerCase().includes('laki') ? 1 : 0
                    ]
                );

            } else {
                const [rekruitmenRows] = await connection.execute(
                    'SELECT * FROM trekruitmen WHERE rkt_nomor = ? FOR UPDATE',
                    [tlp_rkt_nomor]
                );

                if (rekruitmenRows.length === 0) {
                    await connection.rollback();
                    return res.status(404).json({
                        success: false,
                        message: 'Data kandidat tidak ditemukan'
                    });
                }

                candidateData = rekruitmenRows[0];
                candidateName = candidateData.rkt_nama;
            }

            // --- Generate NIK ---
            const newNIK = await generateNIK(connection);

            // ================================================================
            // 🔥 CRITICAL: INSERT ke tkaryawan DENGAN CASING kar_Nik YANG BENAR
            // ================================================================
            if (isFromApplicant) {
                await connection.execute(
                    `INSERT INTO tkaryawan (
                        kar_Nik, kar_nama, kar_jenkel, kar_tempatlahir, kar_tgllahir,
                        kar_alamat, kar_status_kawin, kar_warganegara, kar_agama, kar_gol_darah,
                        kar_status_tinggal, kar_notelp, kar_noidentitas, kar_email,
                        kar_jab_kode, kar_bagian, kar_pendidikanterakhir, kar_jurusan,
                        kar_tgl_masuk, kar_status_aktif, kar_status_kerja, kar_size,
                        kar_pab_kode, kar_dep_kode, kar_kode_absensi,
                        kar_golongan, kar_nik_atasan, kar_sistem_gaji, kar_status_bpjs
                    ) VALUES (
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?,
                        '', '', ?, ?,
                        CURDATE(), 1, 1, ?,
                        '', '', '',
                        '', '', '', 0
                    )`,
                    [
                        newNIK,
                        candidateData.nama_lengkap,
                        candidateData.jenis_kelamin?.toLowerCase().includes('laki') ? 1 : 0,
                        candidateData.tempat_lahir        || '',
                        candidateData.tanggal_lahir       || null,
                        candidateData.alamat_ktp          || '',
                        candidateData.status_pernikahan   || '',
                        candidateData.kewarganegaraan     || 'WNI',
                        candidateData.agama               || '',
                        candidateData.golongan_darah      || '',
                        candidateData.status_tinggal      || '',
                        candidateData.nomor_telepon       || '',
                        candidateData.nik,
                        candidateData.email               || '',
                        candidateData.pendidikan_terakhir || '',
                        candidateData.jurusan             || '',
                        candidateData.ukuran_baju         || ''
                    ]
                );

                // Update status di t_applicant
                await connection.execute(
                    'UPDATE t_applicant SET status_applicant = "HIRED", updated_at = NOW() WHERE applicant_id = ?',
                    [tlp_rkt_nomor.replace('APP-', '')]
                );

            } else {
                await connection.execute(
                    `INSERT INTO tkaryawan (
                        kar_Nik, kar_nama, kar_jenkel, kar_tempatlahir, kar_tgllahir,
                        kar_alamat, kar_status_kawin, kar_warganegara, kar_agama, kar_gol_darah,
                        kar_status_tinggal, kar_notelp, kar_noidentitas, kar_email, kar_ibukandung,
                        kar_jab_kode, kar_bagian, kar_pendidikanterakhir, kar_jurusan,
                        kar_tgl_masuk, kar_status_aktif, kar_status_kerja,
                        kar_pab_kode, kar_dep_kode, kar_kode_absensi,
                        kar_golongan, kar_nik_atasan, kar_sistem_gaji, kar_status_bpjs
                    ) VALUES (
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        '', '', ?, ?,
                        CURDATE(), 1, 1,
                        '', '', '',
                        '', '', '', 0
                    )`,
                    [
                        newNIK,
                        candidateData.rkt_nama,
                        candidateData.rkt_jenkel,
                        candidateData.rkt_tempatlahir       || '',
                        candidateData.rkt_tgllahir          || null,
                        candidateData.rkt_alamat            || '',
                        candidateData.rkt_status_kawin      || '',
                        candidateData.rkt_warganegara       || 'WNI',
                        candidateData.rkt_agama             || '',
                        candidateData.rkt_gol_darah         || '',
                        candidateData.rkt_status_tinggal    || '',
                        candidateData.rkt_telp              || '',
                        candidateData.rkt_identitas         || '',
                        candidateData.rkt_email             || '',
                        candidateData.rkt_ibukandung        || '',
                        candidateData.rkt_pendidikanterakhir || '',
                        candidateData.rkt_jurusan           || ''
                    ]
                );

                // ================================================================
                // 🔥 CRITICAL: rkt_status DIUPDATE OTOMATIS OLEH TRIGGER
                // ================================================================
                // Trigger 'tlistpelamar_after_update' akan OTOMATIS update
                // trekruitmen.rkt_status = 1 saat statusterakhir = 1.
                // Backend TIDAK BOLEH update manual untuk mencegah race condition.
                // ================================================================
            }

            // --- Update t_onboarding dengan NIK baru ---
            await connection.execute(
                `UPDATE t_onboarding 
                 SET onb_status = 'COMPLETED', onb_tgl_selesai = ?, onb_kar_nik = ?, onb_keterangan = ?
                 WHERE onb_id = ?`,
                [tglSelesai, newNIK, keterangan || null, onb_id]
            );

            // ================================================================
            // 🔥 CRITICAL: UPDATE statusterakhir - TRIGGER WILL HANDLE THE REST
            // ================================================================
            // Trigger 'tlistpelamar_after_update' akan OTOMATIS:
            // 1. UPDATE tgl_diterima = NOW()
            // 2. INSERT ke triilpermintaankaryawan (RPK)
            // 3. UPDATE trekruitmen.rkt_status = 1 (jika dari rekruitmen)
            // 
            // Backend HANYA update statusterakhir, biarkan trigger handle sisanya.
            // Tambahkan WHERE statusterakhir <> 1 untuk IDEMPOTENCY.
            // ================================================================
            const [updateResult] = await connection.execute(
                `UPDATE tlistpelamar 
                 SET statusterakhir = 1
                 WHERE tlp_tpk_nomor = ? 
                   AND tlp_rkt_nomor = ?
                   AND statusterakhir <> 1`,
                [tpk_nomor, tlp_rkt_nomor]
            );

            // ✅ Guard: Jika UPDATE tidak mengubah apapun (sudah status 1), rollback
            if (updateResult.affectedRows === 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Kandidat sudah dalam status HIRED. Operasi dibatalkan untuk mencegah duplikasi.'
                });
            }

            // --- Update SLA completion ---
            await connection.execute(
                `UPDATE t_recruitment_sla 
                SET 
                    sla_completed_at = CASE
                        WHEN (
                            SELECT COUNT(*) 
                            FROM tlistpelamar 
                            WHERE tlp_tpk_nomor = ?
                            AND statusterakhir = 1
                        ) >= (
                            SELECT tpk_jumlah 
                            FROM tpermintaankaryawan 
                            WHERE tpk_nomor = ?
                        )
                        THEN NOW()
                        ELSE sla_completed_at
                    END,
                    sla_status = CASE
                        WHEN (
                            SELECT COUNT(*) 
                            FROM tlistpelamar 
                            WHERE tlp_tpk_nomor = ?
                            AND statusterakhir = 1
                        ) >= (
                            SELECT tpk_jumlah 
                            FROM tpermintaankaryawan 
                            WHERE tpk_nomor = ?
                        )
                        THEN 'COMPLETED'
                        ELSE 'ONGOING'
                    END
                WHERE sla_tpk_nomor = ?`,
                [tpk_nomor, tpk_nomor, tpk_nomor, tpk_nomor, tpk_nomor]
            );

            // ================================================================
            // ⚠️ REMOVED: Manual INSERT ke triilpermintaankaryawan
            // ================================================================
            // ALASAN: Trigger 'tlistpelamar_after_update' sudah handle INSERT
            // ke triilpermintaankaryawan saat statusterakhir = 1.
            // Kita sudah prepare shadow record di trekruitmen (untuk t_applicant)
            // sehingga trigger bisa menemukan nama kandidat.
            // 
            // Jika tetap di-INSERT manual → ERROR: Duplicate Entry
            // ================================================================

            // --- Log ---
            await logActivity(connection, {
                tpk_nomor,
                tlp_rkt_nomor,
                action: 'ONBOARDING_COMPLETE_HIRED',
                status_before: 5,
                status_after: 1,
                user_kode: req.user?.user_kode,
                keterangan: `Onboarding sukses — Jadi karyawan dengan NIK: ${newNIK}`
            });

            await connection.commit();

            return res.json({
                success: true,
                message: `Onboarding sukses! Kandidat berhasil menjadi karyawan dengan NIK: ${newNIK}`,
                data: { new_nik: newNIK }
            });

        // ================================================================
        // BLOCK: ONBOARDING GAGAL (NO_SHOW / CANCELLED)
        // ================================================================
        } else {

            await connection.execute(
                `UPDATE t_onboarding 
                SET onb_status = ?, onb_tgl_selesai = ?, onb_keterangan = ?
                WHERE onb_id = ?`,
                [status, tglSelesai, keterangan || null, onb_id]
            );

            const newStatus = status === 'NO_SHOW' ? 3 : 6;

            // ================================================================
            // 🔥 CRITICAL: tgl_tidakditerima DIUPDATE OTOMATIS OLEH TRIGGER
            // ================================================================
            // Trigger akan set tgl_tidakditerima = NOW() untuk status 2, 3, 6
            // Backend HANYA update statusterakhir, biarkan trigger handle timestamp
            // ================================================================
            const [updateResult] = await connection.execute(
                `UPDATE tlistpelamar 
                SET statusterakhir = ?
                WHERE tlp_tpk_nomor = ? 
                  AND tlp_rkt_nomor = ?
                  AND statusterakhir = 5`,
                [newStatus, tpk_nomor, tlp_rkt_nomor]
            );

            if (updateResult.affectedRows === 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Kandidat tidak dalam status Approved (5) atau sudah diupdate oleh proses lain.'
                });
            }

            // ============================================================
            // NO-SHOW → SLA BUFFER + UNLOCK EDIT
            // ============================================================
            if (newStatus === 3) {
                const [alreadyNoShow] = await connection.execute(
                    `SELECT 1
                    FROM t_selection_log
                    WHERE log_tlp_tpk_nomor = ?
                    AND log_tlp_rkt_nomor = ?
                    AND log_action = 'NO_SHOW_TRIGGER'
                    AND log_status_before = 5
                    AND log_status_after = 3
                    LIMIT 1`,
                    [tpk_nomor, tlp_rkt_nomor]
                );

                if (alreadyNoShow.length === 0) {
                    const bufferDays = await calculateNoShowBuffer(connection, tpk_nomor);

                    await connection.execute(
                        `UPDATE t_recruitment_sla SET 
                            sla_is_editable = 1,
                            sla_no_show_buffer_days = sla_no_show_buffer_days + ?,
                            sla_final_target_date = DATE_ADD(sla_final_target_date, INTERVAL ? DAY)
                        WHERE sla_tpk_nomor = ?`,
                        [bufferDays, bufferDays, tpk_nomor]
                    );

                    await logActivity(connection, {
                        tpk_nomor,
                        tlp_rkt_nomor,
                        action: 'NO_SHOW_TRIGGER',
                        status_before: 5,
                        status_after: 3,
                        user_kode: req.user?.user_kode,
                        keterangan: `No-Show onboarding → SLA +${bufferDays} hari`
                    });
                }
            }
            
            await connection.commit();

            return res.json({
                success: true,
                message: status === 'NO_SHOW'
                    ? 'Onboarding gagal karena No-Show — SLA diperpanjang'
                    : 'Onboarding dibatalkan',
                data: {}
            });
        }

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error complete onboarding:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal menyelesaikan onboarding',
            error: error.message
        });
    } finally {
        connection.release();
    }
});

// =====================================================================
// SECTION 8: FINAL DECISION (WITH NO-SHOW LOGIC & INSTANT HIRE)
// =====================================================================

/**
 * PUT /api/selection/decision
 * ✅ TRIGGER-ALIGNED VERSION
 * Menangani keputusan akhir, otomatisasi No-Show, dan penyesuaian SLA.
 */
router.put('/decision', async (req, res) => {
    const { tpk_nomor, tlp_rkt_nomor, status_akhir, keterangan_no_show } = req.body;
    const validStatuses = [0, 1, 2, 3, 4, 5, 6];
    const connection = await db.getConnection();

    if (!tpk_nomor || !tlp_rkt_nomor || !validStatuses.includes(parseInt(status_akhir))) {
        return res.status(400).json({ success: false, message: 'Input tidak valid.' });
    }

    try {
        await connection.beginTransaction();

        // 1. Cek data kandidat dan kunci baris (Prevent Race Condition & Multiple Clicks)
        const [currentData] = await connection.execute(
            'SELECT statusterakhir FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ? FOR UPDATE',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (currentData.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Kandidat tidak ditemukan.' });
        }

        const oldStatus = currentData[0].statusterakhir;
        const validTransitions = {
            0: [1, 2, 3, 4, 5],
            4: [5, 2],
            5: [1, 3, 6],
        };
        
        if (validTransitions[oldStatus] && !validTransitions[oldStatus].includes(parseInt(status_akhir))) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: `Transisi status tidak valid: ${oldStatus} → ${status_akhir}`
            });
        }

        // Guard: Jika sudah HIRED (1), REJECT (2), atau NO SHOW (3), kunci tombol
        if ([1, 2, 3].includes(oldStatus)) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Keputusan sudah final dan tidak dapat diubah.' });
        }

        // PRE-DECISION VALIDATION: Kandidat harus punya evaluasi sebelum diterima/training
        if ([4, 5].includes(parseInt(status_akhir))) {
            const [evalCheck] = await connection.execute(
                `SELECT COUNT(*) as eval_count 
                 FROM t_evaluasi 
                 WHERE eval_tlp_tpk_nomor = ? 
                   AND eval_tlp_rkt_nomor = ?
                   AND eval_status = 'COMPLETED'`,
                [tpk_nomor, tlp_rkt_nomor]
            );
            
            if (evalCheck[0].eval_count === 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Kandidat harus melewati minimal satu evaluasi (TES/INTERVIEW) dengan status COMPLETED sebelum bisa diputuskan diterima atau training.'
                });
            }
        }

        // ================================================================
        // 2. Update Status Utama Kandidat (WITH IDEMPOTENCY GUARD)
        // ================================================================
        const [updateResult] = await connection.execute(
            `UPDATE tlistpelamar SET 
                statusterakhir = ?
             WHERE tlp_tpk_nomor = ? 
               AND tlp_rkt_nomor = ?
               AND statusterakhir = ?`,
            [status_akhir, tpk_nomor, tlp_rkt_nomor, oldStatus]
        );

        if (updateResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Status tidak berubah atau sudah diupdate oleh proses lain. Silakan refresh halaman.'
            });
        }

        // ================================================================
        // 3. Initialize Response Data
        // ================================================================
        let responseData = { 
            success: true, 
            message: 'Keputusan berhasil disimpan.',
            data: null
        };

        // ================================================================
        // 4. LOGIKA NO-SHOW (Status 3) & SLA ADJUSTMENT
        // ================================================================
        if (parseInt(status_akhir) === 3) {
            const [alreadyNoShow] = await connection.execute(
                `SELECT 1 FROM t_selection_log
                WHERE log_tlp_tpk_nomor = ? 
                AND log_action = 'NO_SHOW_TRIGGER' 
                LIMIT 1 FOR UPDATE`,
                [tpk_nomor]
            );

            if (alreadyNoShow.length === 0) {
                const bufferDays = await calculateNoShowBuffer(connection, tpk_nomor);
                const nthNoShow = (await getNoShowCount(connection, tpk_nomor)) + 1;

                await connection.execute(
                    `UPDATE t_recruitment_sla SET 
                        sla_is_editable = 1, 
                        sla_no_show_buffer_days = sla_no_show_buffer_days + ?,
                        sla_final_target_date = DATE_ADD(sla_final_target_date, INTERVAL ? DAY),
                        sla_notes = CONCAT(
                            COALESCE(sla_notes, ''), 
                            '\n[', NOW(), '] No-Show ke-', ?, ': ', ?, ' | Buffer +', ?, ' hari.'
                        )
                    WHERE sla_tpk_nomor = ?`,
                    [bufferDays, bufferDays, nthNoShow, keterangan_no_show || 'Tanpa keterangan', bufferDays, tpk_nomor]
                );

                await logActivity(connection, {
                    tpk_nomor, tlp_rkt_nomor, action: 'NO_SHOW_TRIGGER',
                    status_before: oldStatus, status_after: 3, user_kode: req.user?.user_kode,
                    keterangan: `No-Show decision → SLA +${bufferDays} hari`
                });

                responseData.data = {
                    sla_adjustment: {
                        buffer_added: bufferDays,
                        edit_unlocked: true,
                        total_noshow: nthNoShow
                    }
                };
            }
        }

        // ================================================================
        // 5. LOGIKA INSTANT HIRE (Status 1) - TRIGGER-AWARE VERSION
        // ================================================================
        if (parseInt(status_akhir) === 1) {
            // --- Validasi jumlah hired vs target lowongan ---
            const [hiringStats] = await connection.execute(
                `SELECT 
                    tpk.tpk_jumlah AS target,
                    COUNT(lp.tlp_rkt_nomor) AS total_hired
                FROM tpermintaankaryawan tpk
                LEFT JOIN tlistpelamar lp 
                    ON lp.tlp_tpk_nomor = tpk.tpk_nomor 
                    AND lp.statusterakhir = 1
                WHERE tpk.tpk_nomor = ?
                GROUP BY tpk.tpk_nomor
                FOR UPDATE`,
                [tpk_nomor]
            );

            if (hiringStats.length > 0 && hiringStats[0].total_hired >= hiringStats[0].target) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Jumlah hired sudah mencapai target (${hiringStats[0].target}). Tidak bisa menambah karyawan baru.`
                });
            }

            // --- Detect source & ambil candidate data ---
            const isFromApplicant = tlp_rkt_nomor.startsWith('APP-');
            let candidateData;
            let candidateName;

            if (isFromApplicant) {
                const applicant_id = tlp_rkt_nomor.replace('APP-', '');
                const [applicantRows] = await connection.execute(
                    'SELECT * FROM t_applicant WHERE applicant_id = ? FOR UPDATE',
                    [applicant_id]
                );

                if (applicantRows.length === 0) {
                    await connection.rollback();
                    return res.status(404).json({
                        success: false,
                        message: 'Data applicant tidak ditemukan'
                    });
                }

                candidateData = applicantRows[0];
                candidateName = candidateData.nama_lengkap;

                // ================================================================
                // 🔥 CRITICAL FIX: SHADOW RECORD FOR TRIGGER COMPATIBILITY
                // ================================================================
                await connection.execute(
                    `INSERT IGNORE INTO trekruitmen (rkt_nomor, rkt_nama, rkt_status, rkt_tgllahir, rkt_jenkel) 
                    VALUES (?, ?, 1, ?, ?)`,
                    [
                        tlp_rkt_nomor, 
                        candidateName,
                        candidateData.tanggal_lahir || null,
                        candidateData.jenis_kelamin?.toLowerCase().includes('laki') ? 1 : 0
                    ]
                );

            } else {
                const [rekruitmenRows] = await connection.execute(
                    'SELECT * FROM trekruitmen WHERE rkt_nomor = ? FOR UPDATE',
                    [tlp_rkt_nomor]
                );

                if (rekruitmenRows.length === 0) {
                    await connection.rollback();
                    return res.status(404).json({
                        success: false,
                        message: 'Data kandidat tidak ditemukan'
                    });
                }

                candidateData = rekruitmenRows[0];
                candidateName = candidateData.rkt_nama;
            }

            // --- Generate NIK ---
            const newNIK = await generateNIK(connection);

            // ================================================================
            // 🔥 CRITICAL: INSERT ke tkaryawan DENGAN CASING kar_Nik YANG BENAR
            // ================================================================
            if (isFromApplicant) {
                await connection.execute(
                    `INSERT INTO tkaryawan (
                        kar_Nik, kar_nama, kar_jenkel, kar_tempatlahir, kar_tgllahir,
                        kar_alamat, kar_status_kawin, kar_warganegara, kar_agama, kar_gol_darah,
                        kar_status_tinggal, kar_notelp, kar_noidentitas, kar_email,
                        kar_jab_kode, kar_bagian, kar_pendidikanterakhir, kar_jurusan,
                        kar_tgl_masuk, kar_status_aktif, kar_status_kerja, kar_size,
                        kar_pab_kode, kar_dep_kode, kar_kode_absensi,
                        kar_golongan, kar_nik_atasan, kar_sistem_gaji, kar_status_bpjs
                    ) VALUES (
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?,
                        '', '', ?, ?,
                        CURDATE(), 1, 1, ?,
                        '', '', '',
                        '', '', '', 0
                    )`,
                    [
                        newNIK,
                        candidateData.nama_lengkap,
                        candidateData.jenis_kelamin?.toLowerCase().includes('laki') ? 1 : 0,
                        candidateData.tempat_lahir        || '',
                        candidateData.tanggal_lahir       || null,
                        candidateData.alamat_ktp          || '',
                        candidateData.status_pernikahan   || '',
                        candidateData.kewarganegaraan     || 'WNI',
                        candidateData.agama               || '',
                        candidateData.golongan_darah      || '',
                        candidateData.status_tinggal      || '',
                        candidateData.nomor_telepon       || '',
                        candidateData.nik,
                        candidateData.email               || '',
                        candidateData.pendidikan_terakhir || '',
                        candidateData.jurusan             || '',
                        candidateData.ukuran_baju         || ''
                    ]
                );

                await connection.execute(
                    'UPDATE t_applicant SET status_applicant = "HIRED", updated_at = NOW() WHERE applicant_id = ?',
                    [applicant_id]
                );

            } else {
                await connection.execute(
                    `INSERT INTO tkaryawan (
                        kar_Nik, kar_nama, kar_jenkel, kar_tempatlahir, kar_tgllahir,
                        kar_alamat, kar_status_kawin, kar_warganegara, kar_agama, kar_gol_darah,
                        kar_status_tinggal, kar_notelp, kar_noidentitas, kar_email, kar_ibukandung,
                        kar_jab_kode, kar_bagian, kar_pendidikanterakhir, kar_jurusan,
                        kar_tgl_masuk, kar_status_aktif, kar_status_kerja,
                        kar_pab_kode, kar_dep_kode, kar_kode_absensi,
                        kar_golongan, kar_nik_atasan, kar_sistem_gaji, kar_status_bpjs
                    ) VALUES (
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        '', '', ?, ?,
                        CURDATE(), 1, 1,
                        '', '', '',
                        '', '', '', 0
                    )`,
                    [
                        newNIK,
                        candidateData.rkt_nama,
                        candidateData.rkt_jenkel,
                        candidateData.rkt_tempatlahir       || '',
                        candidateData.rkt_tgllahir          || null,
                        candidateData.rkt_alamat            || '',
                        candidateData.rkt_status_kawin      || '',
                        candidateData.rkt_warganegara       || 'WNI',
                        candidateData.rkt_agama             || '',
                        candidateData.rkt_gol_darah         || '',
                        candidateData.rkt_status_tinggal    || '',
                        candidateData.rkt_telp              || '',
                        candidateData.rkt_identitas         || '',
                        candidateData.rkt_email             || '',
                        candidateData.rkt_ibukandung        || '',
                        candidateData.rkt_pendidikanterakhir || '',
                        candidateData.rkt_jurusan           || ''
                    ]
                );
            }

            // --- Update SLA completion ---
            await connection.execute(
                `UPDATE t_recruitment_sla 
                SET 
                    sla_completed_at = CASE
                        WHEN (
                            SELECT COUNT(*) 
                            FROM tlistpelamar 
                            WHERE tlp_tpk_nomor = ?
                            AND statusterakhir = 1
                        ) >= (
                            SELECT tpk_jumlah 
                            FROM tpermintaankaryawan 
                            WHERE tpk_nomor = ?
                        )
                        THEN NOW()
                        ELSE sla_completed_at
                    END,
                    sla_status = CASE
                        WHEN (
                            SELECT COUNT(*) 
                            FROM tlistpelamar 
                            WHERE tlp_tpk_nomor = ?
                            AND statusterakhir = 1
                        ) >= (
                            SELECT tpk_jumlah 
                            FROM tpermintaankaryawan 
                            WHERE tpk_nomor = ?
                        )
                        THEN 'COMPLETED'
                        ELSE 'ONGOING'
                    END
                WHERE sla_tpk_nomor = ?`,
                [tpk_nomor, tpk_nomor, tpk_nomor, tpk_nomor, tpk_nomor]
            );

            // ================================================================
            // ⚠️ REMOVED: Manual INSERT ke triilpermintaankaryawan
            // ================================================================
            // CRITICAL: Trigger 'tlistpelamar_after_update' sudah handle INSERT
            // ke triilpermintaankaryawan saat statusterakhir = 1.
            // 
            // Shadow record sudah dibuat di trekruitmen (untuk t_applicant)
            // sehingga trigger bisa menemukan nama kandidat.
            // 
            // Manual INSERT akan menyebabkan ERROR: Duplicate Entry
            // ================================================================

            // --- Update response message ---
            responseData.message = `Berhasil! Kandidat langsung menjadi karyawan dengan NIK: ${newNIK}`;
            responseData.data = { new_nik: newNIK };
        }

        // ================================================================
        // 6. Catat Audit Log Umum (SATU KALI SAJA)
        // ================================================================
        await logActivity(connection, {
            tpk_nomor, 
            tlp_rkt_nomor, 
            action: 'DECISION',
            status_before: oldStatus, 
            status_after: status_akhir,
            user_kode: req.user?.user_kode, 
            keterangan: keterangan_no_show || 'Update status rekrutmen'
        });

        await connection.commit();
        res.json(responseData);

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error decision:', error.message);
        res.status(500).json({ success: false, message: 'Gagal memproses keputusan', error: error.message });
    } finally {
        connection.release();
    }
});


// =====================================================================
// SECTION 9: STATISTICS & SUMMARY
// =====================================================================

router.get('/summary/:tpk_nomor', async (req, res) => {
    const { tpk_nomor } = req.params;

    try {
        const [rows] = await db.execute(
            `SELECT 
                COUNT(*) AS total_pelamar,
                SUM(CASE WHEN tlp_rkt_nomor LIKE 'APP-%' THEN 1 ELSE 0 END) AS dari_applicant,
                SUM(CASE WHEN tlp_rkt_nomor NOT LIKE 'APP-%' THEN 1 ELSE 0 END) AS dari_rekruitmen,
                SUM(CASE WHEN tlp_status = 1 THEN 1 ELSE 0 END) AS terverifikasi,
                SUM(CASE WHEN tlp_status = 0 THEN 1 ELSE 0 END) AS belum_verifikasi,
                SUM(CASE WHEN tgl_tes IS NOT NULL THEN 1 ELSE 0 END) AS sudah_tes,
                SUM(CASE WHEN tgl_interviewuser IS NOT NULL THEN 1 ELSE 0 END) AS sudah_interview_user,
                SUM(CASE WHEN tgl_interviewhrd IS NOT NULL THEN 1 ELSE 0 END) AS sudah_interview_hrd,
                SUM(CASE WHEN statusterakhir = 0 THEN 1 ELSE 0 END) AS belum_diputuskan,
                SUM(CASE WHEN statusterakhir = 1 THEN 1 ELSE 0 END) AS hired,
                SUM(CASE WHEN statusterakhir = 2 THEN 1 ELSE 0 END) AS ditolak,
                SUM(CASE WHEN statusterakhir = 3 THEN 1 ELSE 0 END) AS tidak_datang,
                SUM(CASE WHEN statusterakhir = 4 THEN 1 ELSE 0 END) AS pelatihan,
                SUM(CASE WHEN statusterakhir = 5 THEN 1 ELSE 0 END) AS approved_pending_onboarding,
                SUM(CASE WHEN statusterakhir = 6 THEN 1 ELSE 0 END) AS failed_onboarding
            FROM tlistpelamar
            WHERE tlp_tpk_nomor = ?`,
            [tpk_nomor]
        );

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error('❌ Error summary:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil summary',
            error: error.message
        });
    }
});


router.delete('/remove', async (req, res) => {
    const { tpk_nomor, tlp_rkt_nomor } = req.body;

    if (!tpk_nomor || !tlp_rkt_nomor) {
        return res.status(400).json({
            success: false,
            message: 'tpk_nomor dan tlp_rkt_nomor wajib diisi'
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [checkRows] = await connection.execute(
            'SELECT statusterakhir FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ? FOR UPDATE',
            [tpk_nomor, tlp_rkt_nomor]
        );

        if (checkRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Data tidak ditemukan'
            });
        }

        if (checkRows[0].statusterakhir !== 0) {
            await connection.rollback();
            return res.status(403).json({
                success: false,
                message: 'Tidak dapat menghapus kandidat yang sudah ada keputusan akhir'
            });
        }

        await connection.execute(
            'DELETE FROM tlistpelamar WHERE tlp_tpk_nomor = ? AND tlp_rkt_nomor = ?',
            [tpk_nomor, tlp_rkt_nomor]
        );

        await logActivity(connection, {
            tpk_nomor,
            tlp_rkt_nomor,
            action: 'REMOVE_SHORTLIST',
            user_kode: req.user?.user_kode,
            keterangan: 'Kandidat dihapus dari shortlist'
        });

        await connection.commit();

        res.json({
            success: true,
            message: 'Kandidat berhasil dihapus dari shortlist',
            data: {}
        });

    } catch (error) {
        await connection.rollback();
        console.error('❌ Error remove:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal menghapus kandidat',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


module.exports = router;