// src/modules/monitoring.js
const express = require('express');
const db = require('../config/db');
const { authenticate, isHRD } = require('../middleware/authMiddleware');
const router = express.Router();

/**
 * =====================================================================
 * MODULE: RECRUITMENT SLA MONITORING
 * Fokus: SLA tracking, KPI HRD, KPI Approver
 * =====================================================================
 */

/**
 * GET /api/monitoring/sla-status
 * - HRD: Melihat SEMUA permintaan yang sedang berjalan
 * - Peminta: Melihat permintaan yang dia ajukan
 * - Atasan: Melihat permintaan miliknya + bawahan
 */
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
                sla.sla_min_days as standard_lead_time,
                sla.sla_no_show_buffer_days,
                sla.sla_is_editable,
                sla.sla_source,
                sla.sla_notes,
                sla.sla_approval_delay_days,
                sla.sla_status,
                sla.sla_hired_count,
                
                approver.kar_nama AS approver_name,
                
                DATEDIFF(sla.sla_final_target_date, CURDATE()) as days_remaining,
                p.tpk_jumlah as target_count,
                
                CASE 
                    WHEN sla.sla_status = 'COMPLETED' THEN 'COMPLETED'
                    WHEN sla.sla_is_editable = 1 THEN 'NEED_USER_UPDATE'
                    WHEN CURDATE() > sla.sla_final_target_date THEN 'OVERDUE'
                    WHEN DATEDIFF(sla.sla_final_target_date, CURDATE()) <= 3 THEN 'CRITICAL'
                    WHEN DATEDIFF(sla.sla_final_target_date, CURDATE()) <= 7 THEN 'WARNING'
                    ELSE 'ON_PROGRESS'
                END as ui_status_tag,
                
                CASE
                    WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                    ELSE NULL
                END AS approval_flag,
                
                CASE WHEN k.kar_nik_atasan = ? THEN 1 ELSE 0 END as is_bawahan
                
            FROM tpermintaankaryawan p
            JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            LEFT JOIN tkaryawan approver ON approver.kar_nik = k.kar_nik_atasan
            ${whereClause}
            ORDER BY 
                CASE 
                    WHEN sla.sla_is_editable = 1 THEN 0
                    WHEN CURDATE() > sla.sla_final_target_date THEN 1
                    ELSE 2
                END ASC,
                days_remaining ASC
        `;

        const finalParams = user_hrd === 1 ? [user_kode] : [...params, user_kode];
        const [rows] = await db.execute(sql, finalParams);

        const summary = {
            total_active: rows.length,
            need_update: rows.filter(r => r.sla_is_editable === 1).length,
            overdue: rows.filter(r => r.ui_status_tag === 'OVERDUE').length,
            critical: rows.filter(r => r.ui_status_tag === 'CRITICAL').length,
            warning: rows.filter(r => r.ui_status_tag === 'WARNING').length,
            on_progress: rows.filter(r => r.ui_status_tag === 'ON_PROGRESS').length
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

/**
 * GET /api/monitoring/sla-detail/:tpk_nomor
 * Detail SLA untuk satu permintaan
 */
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
                DATEDIFF(sla.sla_final_target_date, CURDATE()) AS days_remaining,
                approver.kar_nama AS approver_name,
                CASE
                    WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                    ELSE NULL
                END AS approval_flag
             FROM t_recruitment_sla sla
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

        // Edit history dari audit log
        const [editHistory] = await db.execute(
            `SELECT field_name, old_value, new_value, user_kode, created_at
             FROM t_pkar_log
             WHERE tpk_nomor = ?
             ORDER BY created_at DESC`,
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

/**
 * GET /api/monitoring/sla-dashboard/:tpk_nomor
 * Summary cepat SLA untuk satu permintaan
 */
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
                sla.sla_is_editable,
                sla.sla_no_show_buffer_days,
                sla.sla_status,
                sla.sla_hired_count,
                j.jab_nama,
                p.tpk_jumlah,
                DATEDIFF(sla.sla_final_target_date, CURDATE()) AS days_remaining,
                CASE
                    WHEN sla.sla_status = 'COMPLETED' THEN 'COMPLETED'
                    WHEN sla.sla_is_editable = 1 THEN 'NEED_USER_UPDATE'
                    WHEN CURDATE() > sla.sla_final_target_date THEN 'OVERDUE'
                    WHEN DATEDIFF(sla.sla_final_target_date, CURDATE()) <= 3 THEN 'CRITICAL'
                    WHEN DATEDIFF(sla.sla_final_target_date, CURDATE()) <= 7 THEN 'WARNING'
                    ELSE 'ON_PROGRESS'
                END AS ui_status
             FROM t_recruitment_sla sla
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

        const [rows] = await db.execute(`
            SELECT 
                sla.sla_tpk_nomor,
                p.tpk_tanggal as request_date,
                j.jab_nama as position,
                p.tpk_bagian as department,
                p.tpk_peminta,
                k.kar_nama as requester_name,
                
                sla.sla_min_days as standard_lead_time,
                sla.sla_calculated_at as start_date,
                sla.sla_completed_at as completion_date,
                
                DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) as gross_duration_days,
                sla.sla_no_show_buffer_days as no_show_buffer_days,
                (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) as net_duration_days,
                
                CASE 
                    WHEN (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) <= sla.sla_min_days 
                        THEN 'EXCELLENT'
                    WHEN (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) <= (sla.sla_min_days * 1.2)
                        THEN 'GOOD'
                    WHEN (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) <= (sla.sla_min_days * 1.5)
                        THEN 'ACCEPTABLE'
                    ELSE 'DELAY'
                END as performance_label,
                
                sla.sla_hired_count as hired_count,
                p.tpk_jumlah as target_count,
                sla.sla_source
                
            FROM t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            WHERE sla.sla_status = 'COMPLETED'
            ${dateFilter}
            ORDER BY sla.sla_completed_at DESC
        `);

        const totalRecords = rows.length;
        const avgGross = totalRecords > 0 ? rows.reduce((s, r) => s + r.gross_duration_days, 0) / totalRecords : 0;
        const avgNet = totalRecords > 0 ? rows.reduce((s, r) => s + r.net_duration_days, 0) / totalRecords : 0;
        const totalBuffer = rows.reduce((s, r) => s + r.no_show_buffer_days, 0);

        const excellentCount  = rows.filter(r => r.performance_label === 'EXCELLENT').length;
        const goodCount       = rows.filter(r => r.performance_label === 'GOOD').length;
        const acceptableCount = rows.filter(r => r.performance_label === 'ACCEPTABLE').length;
        const delayCount      = rows.filter(r => r.performance_label === 'DELAY').length;

        res.json({
            success: true,
            data: rows,
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
                explanation: 'HRD tidak dipenalti untuk waktu yang hilang karena kandidat No-Show'
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
                    WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 1 THEN 'EXCELLENT'
                    WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 3 THEN 'GOOD'
                    WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 5 THEN 'SLOW'
                    ELSE 'VERY_SLOW'
                END AS approval_performance
            FROM t_recruitment_sla sla
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
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 1 THEN 1 ELSE 0 END) AS excellent_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) BETWEEN 2 AND 3 THEN 1 ELSE 0 END) AS good_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) BETWEEN 4 AND 5 THEN 1 ELSE 0 END) AS slow_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) > 5 THEN 1 ELSE 0 END) AS very_slow_count
            FROM t_recruitment_sla sla
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
        const excellentCount = rows.filter(r => r.approval_performance === 'EXCELLENT').length;
        const goodCount      = rows.filter(r => r.approval_performance === 'GOOD').length;
        const slowCount      = rows.filter(r => r.approval_performance === 'SLOW').length;
        const verySlowCount  = rows.filter(r => r.approval_performance === 'VERY_SLOW').length;
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
                performance_distribution: { excellent: excellentCount, good: goodCount, slow: slowCount, very_slow: verySlowCount },
                fast_approval_rate: totalRecords > 0
                    ? Math.round(((excellentCount + goodCount) / totalRecords) * 100)
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
             JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause} ${andOrWhere} sla.sla_status = 'CALCULATED'`,
            params
        );

        const [overdueRequests] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause} ${andOrWhere} sla.sla_status = 'CALCULATED'
             AND CURDATE() > sla.sla_final_target_date`,
            params
        );

        const [needUpdate] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause} ${andOrWhere} sla.sla_status = 'CALCULATED'
             AND sla.sla_is_editable = 1`,
            params
        );

        const [completedThisMonth] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
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

/**
 * GET /api/monitoring/check-deadline
 * SLA Critical Alert (≤ 3 hari)
 */
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
                DATEDIFF(sla.sla_final_target_date, CURDATE()) AS days_remaining
            FROM t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            WHERE sla.sla_status = 'CALCULATED'
              AND sla.sla_is_editable = 0
              AND DATEDIFF(sla.sla_final_target_date, CURDATE()) BETWEEN 0 AND 3
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