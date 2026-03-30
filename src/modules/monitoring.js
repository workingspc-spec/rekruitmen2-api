// src/modules/monitoring.js
const express = require('express');
const db = require('../config/db');
const { authenticate, isHRD } = require('../middleware/authMiddleware');
const { countWorkdays } = require('../utils/workdayCalculator');
const router = express.Router();

/**
 * =====================================================================
 * MODULE: RECRUITMENT SLA MONITORING
 * Fokus: SLA tracking, KPI HRD, KPI Approver
 * =====================================================================
 */

// =====================================================================
// ROUTER 1: GET /api/monitoring/sla-status
// PERUBAHAN: days_remaining & CASE WHEN ui_status_tag → pakai sla_max_target_date
// =====================================================================
router.get('/sla-status', authenticate, async (req, res) => {
    const { user_kode, user_hrd } = req.user;

    try {
        let whereClause;
        let params;

        if (user_hrd === 1) {
            whereClause = 'WHERE sla.sla_status IN ("CALCULATED", "COMPLETED")';
            params = [];
        } else {
            whereClause = `WHERE (p.tpk_peminta = ? OR k.kar_nik_atasan = ?) 
                           AND sla.sla_status IN ("CALCULATED", "COMPLETED")`;
            params = [user_kode, user_kode];
        }

        const sql = `
            SELECT 
                p.tpk_nomor,
                p.tpk_tanggal,
                j.jab_nama,
                p.tpk_bagian,
                p.tpk_peminta,
                k.kar_nama as nama_peminta,
                
                sla.sla_calculated_at,
                sla.sla_final_target_date,
                sla.sla_max_target_date,
                sla.sla_min_days as standard_lead_time,
                sla.sla_no_show_buffer_days,
                sla.sla_is_editable,
                sla.sla_source,
                sla.sla_notes,
                sla.sla_approval_delay_days,
                sla.sla_status,
                sla.sla_hired_count,
                
                approver.kar_nama AS approver_name,
                
                DATEDIFF(sla.sla_max_target_date, CURDATE()) as days_remaining, /* [UBAH] Gunakan max_target_date */
                p.tpk_jumlah as target_count,
                
                ROUND((COALESCE(sla.sla_hired_count, 0) / NULLIF(p.tpk_jumlah, 0)) * 100) AS progress_percentage,

                CASE 
                    WHEN sla.sla_status = 'COMPLETED' THEN 'COMPLETED'
                    WHEN sla.sla_is_editable = 1 THEN 'NEED_USER_UPDATE'
                    WHEN CURDATE() > sla.sla_max_target_date THEN 'OVERDUE'          /* [UBAH] Patokan Overdue */
                    WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 3 THEN 'CRITICAL' /* [UBAH] */
                    WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 7 THEN 'WARNING'  /* [UBAH] */
                    ELSE 'ON_PROGRESS'
                END as ui_status_tag,
                
                CASE
                    WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                    ELSE NULL
                END AS approval_flag,
                
                CASE WHEN k.kar_nik_atasan = ? THEN 1 ELSE 0 END as is_bawahan
                
            FROM tpermintaankaryawan p
            JOIN pkar.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            LEFT JOIN tkaryawan approver ON approver.kar_nik = k.kar_nik_atasan
            ${whereClause}
            ORDER BY 
                CASE 
                    WHEN sla.sla_is_editable = 1 THEN 0
                    WHEN CURDATE() > sla.sla_max_target_date THEN 1
                    ELSE 2
                END ASC,
                days_remaining ASC
        `;

        const finalParams = user_hrd === 1 ? [user_kode] : [...params, user_kode];
        const [rows] = await db.execute(sql, finalParams);

        const summary = {
            total_active: rows.filter(r => r.sla_status === 'CALCULATED').length,
            need_update: rows.filter(r => r.sla_is_editable === 1).length,
            overdue: rows.filter(r => r.ui_status_tag === 'OVERDUE').length,
            critical: rows.filter(r => r.ui_status_tag === 'CRITICAL').length,
            warning: rows.filter(r => r.ui_status_tag === 'WARNING').length,
            on_progress: rows.filter(r => r.ui_status_tag === 'ON_PROGRESS').length,
            total_hired: rows.reduce((sum, r) => sum + (Number(r.sla_hired_count) || 0), 0),
            total_target: rows.reduce((sum, r) => sum + (Number(r.target_count) || 0), 0)
        };

        if (user_hrd !== 1) {
            summary.monitoring_bawahan = rows.filter(r => r.is_bawahan === 1).length;
            summary.permintaan_sendiri = rows.filter(r => r.is_bawahan === 0).length;
        }

        res.json({
            success: true,
            data: rows,
            summary,
            ui_hints: {
                COMPLETED: 'Rekrutmen selesai',
                NEED_USER_UPDATE: 'Anda perlu mengubah tanggal target',
                OVERDUE: 'Target sudah terlewat',
                CRITICAL: '≤3 hari tersisa',
                WARNING: '≤7 hari tersisa',
                ON_PROGRESS: 'Berjalan normal'
            }
        });

    } catch (error) {
        console.error('❌ Error monitoring SLA:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data monitoring',
            error: error.message
        });
    }
});

// =====================================================================
// ROUTER 2: GET /api/monitoring/sla-detail/:tpk_nomor
// PERUBAHAN: days_remaining → max_target_date, tambah max_target_date di timeline response
// =====================================================================
router.get('/sla-detail/:tpk_nomor', authenticate, async (req, res) => {
    const { tpk_nomor } = req.params;
    const { user_kode, user_hrd } = req.user;

    try {
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

        const [slaRows] = await db.execute(
            `SELECT 
                sla.*,
                j.jab_nama,
                p.tpk_jumlah,
                p.tpk_bagian,
                p.tpk_peminta,
                k.kar_nama AS nama_peminta,
                DATEDIFF(sla.sla_max_target_date, CURDATE()) AS days_remaining, /* [UBAH] Gunakan max_target_date */
                approver.kar_nama AS approver_name,
                CASE
                    WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                    ELSE NULL
                END AS approval_flag
             FROM pkar.t_recruitment_sla sla
             JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
             JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             LEFT JOIN tkaryawan approver ON approver.kar_nik = k.kar_nik_atasan
             WHERE sla.sla_tpk_nomor = ?`,
            [tpk_nomor]
        );

        if (slaRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Data SLA tidak ditemukan' });
        }

        const [editHistory] = await db.execute(
            `SELECT 
                l.log_id,
                l.field_name,
                l.old_value,
                l.new_value,
                l.user_kode,
                k.kar_nama AS user_nama,
                DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
             FROM pkar.t_pkar_log l
             LEFT JOIN tkaryawan k ON k.kar_Nik = l.user_kode
             WHERE l.tpk_nomor = ?
             ORDER BY l.created_at DESC`,
            [tpk_nomor]
        );

        const sla = slaRows[0];

        res.json({
            success: true,
            data: {
                sla_info: sla,
                timeline: {
                    request_created_at: sla.sla_request_created_at,
                    approved_at: sla.sla_approved_at,
                    original_target_date: sla.sla_original_requested_date,
                    system_floor_date: sla.sla_system_floor_date,
                    final_target_date: sla.sla_final_target_date,
                    max_target_date: sla.sla_max_target_date, /* [TAMBAHAN] Kirim ke Frontend */
                    buffer_days_added: sla.sla_no_show_buffer_days,
                    days_remaining: sla.days_remaining
                },
                edit_history: editHistory,
                approval_info: {
                    approver_name: sla.approver_name,
                    approval_delay_days: sla.sla_approval_delay_days,
                    approval_flag: sla.approval_flag
                }
            }
        });

    } catch (error) {
        console.error('❌ SLA DETAIL ERROR:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================
// ROUTER 3: GET /api/monitoring/sla-dashboard/:tpk_nomor
// PERUBAHAN: days_remaining & CASE WHEN ui_status → pakai sla_max_target_date
// =====================================================================
router.get('/sla-dashboard/:tpk_nomor', authenticate, async (req, res) => {
    const { tpk_nomor } = req.params;
    const { user_kode, user_hrd } = req.user;

    try {
        const [authCheck] = await db.execute(
            `SELECT p.tpk_peminta, k.kar_nik_atasan
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             WHERE p.tpk_nomor = ?`,
            [tpk_nomor]
        );

        if (authCheck.length === 0) {
            return res.status(404).json({ success: false, message: 'Permintaan tidak ditemukan' });
        }

        const isAuthorized =
            user_hrd === 1 ||
            authCheck[0].tpk_peminta === user_kode ||
            authCheck[0].kar_nik_atasan === user_kode;

        if (!isAuthorized) {
            return res.status(403).json({ success: false, message: 'Akses ditolak' });
        }

        const [slaRows] = await db.execute(
            `SELECT 
                sla.sla_tpk_nomor,
                sla.sla_final_target_date,
                sla.sla_max_target_date,
                sla.sla_is_editable,
                sla.sla_no_show_buffer_days,
                sla.sla_status,
                sla.sla_hired_count,
                j.jab_nama,
                p.tpk_jumlah,
                DATEDIFF(sla.sla_max_target_date, CURDATE()) AS days_remaining, /* [UBAH] Gunakan max_target_date */
                CASE
                    WHEN sla.sla_status = 'COMPLETED' THEN 'COMPLETED'
                    WHEN sla.sla_is_editable = 1 THEN 'NEED_USER_UPDATE'
                    WHEN CURDATE() > sla.sla_max_target_date THEN 'OVERDUE'          /* [UBAH] Patokan Overdue */
                    WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 3 THEN 'CRITICAL' /* [UBAH] */
                    WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 7 THEN 'WARNING'  /* [UBAH] */
                    ELSE 'ON_PROGRESS'
                END AS ui_status
             FROM pkar.t_recruitment_sla sla
             JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
             JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
             WHERE sla.sla_tpk_nomor = ?`,
            [tpk_nomor]
        );

        if (slaRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Data SLA tidak ditemukan' });
        }

        res.json({
            success: true,
            data: slaRows[0]
        });

    } catch (error) {
        console.error('❌ SLA DASHBOARD ERROR:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/monitoring/kpi-hrd
 * KPI Dashboard khusus HRD
 */
router.get('/kpi-hrd', authenticate, isHRD, async (req, res) => {
    const { period } = req.query;

    try {
        let dateFilter = '';
        if (period === 'month') {
            dateFilter = 'AND YEAR(sla.sla_completed_at) = YEAR(CURDATE()) AND MONTH(sla.sla_completed_at) = MONTH(CURDATE())';
        } else if (period === 'quarter') {
            dateFilter = 'AND YEAR(sla.sla_completed_at) = YEAR(CURDATE()) AND QUARTER(sla.sla_completed_at) = QUARTER(CURDATE())';
        } else if (period === 'year') {
            dateFilter = 'AND YEAR(sla.sla_completed_at) = YEAR(CURDATE())';
        }

        // ✅ SQL KITA SEDERHANAKAN, HAPUS DATEDIFF
        const [rows] = await db.execute(`
            SELECT 
                sla.sla_tpk_nomor,
                p.tpk_tanggal as request_date,
                j.jab_nama as position,
                p.tpk_bagian as department,
                p.tpk_peminta,
                k.kar_nama as requester_name,
                
                sla.sla_min_days as standard_lead_time,
                sla.sla_max_days, /* Tambahan wajib untuk JS */
                sla.sla_calculated_at as start_date,
                sla.sla_completed_at as completion_date,
                sla.sla_no_show_buffer_days as no_show_buffer_days,
                
                sla.sla_hired_count as hired_count,
                p.tpk_jumlah as target_count,
                sla.sla_source
                
            FROM pkar.t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            WHERE sla.sla_status = 'COMPLETED'
            ${dateFilter}
            ORDER BY sla.sla_completed_at DESC
        `);

        // ✅ HITUNG MENGGUNAKAN HARI KERJA (NODE.JS)
        const processedRows = rows.map(row => {
            const grossDays = countWorkdays(row.start_date, row.completion_date);
            const netDays = Math.max(0, grossDays - row.no_show_buffer_days);
            
            let kpiStatus = 'DELAY';
            if (netDays <= row.standard_lead_time) {
                kpiStatus = 'EXCELLENT';
            } else if (netDays <= row.sla_max_days) {
                kpiStatus = 'GOOD';
            } else if (netDays <= (row.sla_max_days + (row.sla_max_days - row.standard_lead_time))) {
                kpiStatus = 'ACCEPTABLE';
            }

            return {
                ...row,
                gross_duration_days: grossDays,
                net_duration_days: netDays,
                performance_label: kpiStatus
            };
        });

        const totalRecords = processedRows.length;
        const avgGross = totalRecords > 0 ? processedRows.reduce((s, r) => s + r.gross_duration_days, 0) / totalRecords : 0;
        const avgNet = totalRecords > 0 ? processedRows.reduce((s, r) => s + r.net_duration_days, 0) / totalRecords : 0;
        const totalBuffer = processedRows.reduce((s, r) => s + r.no_show_buffer_days, 0);

        const excellentCount  = processedRows.filter(r => r.performance_label === 'EXCELLENT').length;
        const goodCount       = processedRows.filter(r => r.performance_label === 'GOOD').length;
        const acceptableCount = processedRows.filter(r => r.performance_label === 'ACCEPTABLE').length;
        const delayCount      = processedRows.filter(r => r.performance_label === 'DELAY').length;

        res.json({
            success: true,
            data: processedRows, // Kembalikan array yang sudah diproses
            summary: {
                period: period || 'all_time',
                total_completed: totalRecords,
                avg_gross_duration: Math.round(avgGross * 10) / 10,
                avg_net_duration: Math.round(avgNet * 10) / 10,
                total_buffer_granted: totalBuffer,
                performance_distribution: { excellent: excellentCount, good: goodCount, acceptable: acceptableCount, delay: delayCount },
                success_rate: totalRecords > 0
                    ? Math.round(((excellentCount + goodCount) / totalRecords) * 100)
                    : 0
            },
            insights: {
                fairness_note: 'Net Duration = Gross Duration - No-Show Buffer',
                explanation: 'Perhitungan menggunakan Hari Kerja (Workdays), mengabaikan hari libur.'
            }
        });

    } catch (error) {
        console.error('❌ Error KPI HRD:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/monitoring/kpi-approver
 * KPI Dashboard untuk Atasan/Manager
 */
router.get('/kpi-approver', authenticate, async (req, res) => {
    const { period } = req.query;
    const user = req.user;

    try {
        let dateFilter = '';
        if (period === 'month') {
            dateFilter = 'AND YEAR(sla.sla_approved_at) = YEAR(CURDATE()) AND MONTH(sla.sla_approved_at) = MONTH(CURDATE())';
        } else if (period === 'quarter') {
            dateFilter = 'AND YEAR(sla.sla_approved_at) = YEAR(CURDATE()) AND QUARTER(sla.sla_approved_at) = QUARTER(CURDATE())';
        } else if (period === 'year') {
            dateFilter = 'AND YEAR(sla.sla_approved_at) = YEAR(CURDATE())';
        }

        // Non-HRD hanya lihat data di mana dia adalah approver
        const roleFilter = user.user_hrd !== 1
            ? `AND approver.kar_nik = '${user.user_kode}'`
            : '';

        const [rows] = await db.execute(`
            SELECT
                p.tpk_nomor,
                DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') AS request_date,
                DATE_FORMAT(sla.sla_approved_at, '%Y-%m-%d') AS approved_date,
                approver.kar_nik AS approver_nik,
                COALESCE(approver.kar_nama, 'TANPA ATASAN') AS approver_name,
                peminta.kar_nama AS requester_name,
                p.tpk_bagian,
                j.jab_nama,
                DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) AS sla_approval_delay_days,
                CASE
                    WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 2 THEN 'FAST_TRACK'
                    WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 5 THEN 'STANDARD_REVIEW'
                    ELSE 'EXTENDED_REVIEW'
                END AS approval_performance
            FROM pkar.t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan peminta ON peminta.kar_nik = p.tpk_peminta
            LEFT JOIN tkaryawan approver ON approver.kar_nik = peminta.kar_nik_atasan
            WHERE sla.sla_status IN ('CALCULATED', 'COMPLETED')
              AND sla.sla_approved_at IS NOT NULL
              ${dateFilter}
              ${roleFilter}
            ORDER BY sla_approval_delay_days DESC
        `);

        const [approverStats] = await db.execute(`
            SELECT
                approver.kar_nik AS approver_nik,
                COALESCE(approver.kar_nama, 'TANPA ATASAN') AS approver_name,
                COUNT(*) AS total_approvals,
                ROUND(AVG(DATEDIFF(sla.sla_approved_at, p.tpk_tanggal)), 1) AS avg_delay_days,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 2 THEN 1 ELSE 0 END) AS fast_track_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) BETWEEN 3 AND 5 THEN 1 ELSE 0 END) AS standard_review_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) > 5 THEN 1 ELSE 0 END) AS extended_review_count
            FROM pkar.t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            LEFT JOIN tkaryawan peminta ON peminta.kar_nik = p.tpk_peminta
            LEFT JOIN tkaryawan approver ON approver.kar_nik = peminta.kar_nik_atasan
            WHERE sla.sla_status IN ('CALCULATED', 'COMPLETED')
              AND sla.sla_approved_at IS NOT NULL
              ${dateFilter}
              ${roleFilter}
            GROUP BY approver.kar_nik, approver.kar_nama
            HAVING total_approvals > 0
            ORDER BY avg_delay_days ASC
        `);

        const totalRecords = rows.length;
        const fastTrackCount      = rows.filter(r => r.approval_performance === 'FAST_TRACK').length;
        const standardReviewCount = rows.filter(r => r.approval_performance === 'STANDARD_REVIEW').length;
        const extendedReviewCount = rows.filter(r => r.approval_performance === 'EXTENDED_REVIEW').length;
        const avgDelay = totalRecords > 0
            ? rows.reduce((s, r) => s + r.sla_approval_delay_days, 0) / totalRecords
            : 0;

        res.json({
            success: true,
            data: rows,
            approver_stats: approverStats,
            summary: {
                period: period || 'all_time',
                total_approvals: totalRecords,
                avg_approval_delay_days: Math.round(avgDelay * 10) / 10,
                
                // ✅ UBAH BAGIAN INI SESUAI DENGAN FIELD BARU
                performance_distribution: { 
                    fast_track_count: fastTrackCount, 
                    standard_review_count: standardReviewCount, 
                    extended_review_count: extendedReviewCount 
                },
                
                // ✅ UBAH JUGA RUMUS RATE-NYA (Gabungan Fast Track + Standard)
                fast_approval_rate: totalRecords > 0
                    ? Math.round(((fastTrackCount + standardReviewCount) / totalRecords) * 100)
                    : 0
            },
            insights: {
                note: 'KPI ini mengukur kecepatan atasan dalam approve permintaan karyawan',
                target: 'Target ideal: approval dalam ≤3 hari kerja',
                fastest_approver: approverStats.length > 0 ? approverStats[0].approver_name : 'N/A',
                slowest_approver: approverStats.length > 0 ? approverStats[approverStats.length - 1].approver_name : 'N/A'
            }
        });

    } catch (error) {
        console.error('❌ Error KPI Approver:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/monitoring/dashboard-summary
 * Summary dashboard untuk semua role
 */
router.get('/dashboard-summary', authenticate, async (req, res) => {
    const { user_kode, user_hrd } = req.user;

    try {
        const whereClause = user_hrd === 1 ? '' : 'WHERE (p.tpk_peminta = ? OR k.kar_nik_atasan = ?)';
        const params = user_hrd === 1 ? [] : [user_kode, user_kode];
        const andOrWhere = whereClause ? 'AND' : 'WHERE';

        const [activeRequests] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN pkar.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause} ${andOrWhere} sla.sla_status = 'CALCULATED'`,
            params
        );

        const [overdueRequests] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN pkar.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause} ${andOrWhere} sla.sla_status = 'CALCULATED'
             AND CURDATE() > sla.sla_max_target_date`, 
            params
        );

        const [needUpdate] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN pkar.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause} ${andOrWhere} sla.sla_status = 'CALCULATED'
             AND sla.sla_is_editable = 1`,
            params
        );

        const [completedThisMonth] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN pkar.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause} ${andOrWhere} sla.sla_status = 'COMPLETED'
             AND sla.sla_completed_at IS NOT NULL
             AND YEAR(sla.sla_completed_at) = YEAR(CURDATE())
             AND MONTH(sla.sla_completed_at) = MONTH(CURDATE())`,
            params
        );

        res.json({
            success: true,
            data: {
                activeRequests: activeRequests[0].count,
                overdueRequests: overdueRequests[0].count,
                needUserUpdate: needUpdate[0].count,
                completedThisMonth: completedThisMonth[0].count
            },
            period: {
                year: new Date().getFullYear(),
                month: new Date().getMonth() + 1
            }
        });

    } catch (error) {
        console.error('❌ Error dashboard summary:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================
// ROUTER 4: GET /api/monitoring/check-deadline
// PERUBAHAN: days_remaining & filter BETWEEN → pakai sla_max_target_date
// =====================================================================
router.get('/check-deadline', authenticate, isHRD, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT 
                sla.sla_tpk_nomor,
                p.tpk_bagian,
                j.jab_nama,
                p.tpk_peminta,
                k.kar_nama AS nama_peminta,
                sla.sla_final_target_date,
                sla.sla_max_target_date,
                DATEDIFF(sla.sla_max_target_date, CURDATE()) AS days_remaining /* [UBAH] Gunakan max_target_date */
            FROM pkar.t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            WHERE sla.sla_status = 'CALCULATED'
              AND sla.sla_is_editable = 0
              AND DATEDIFF(sla.sla_max_target_date, CURDATE()) BETWEEN 0 AND 3 /* [UBAH] Gunakan max_target_date */
            ORDER BY days_remaining ASC
        `);

        res.json({
            success: true,
            alerted_count: rows.length,
            threshold_days: 3,
            data: rows
        });

    } catch (error) {
        console.error('❌ Error SLA deadline check:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;