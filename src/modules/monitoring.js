// src/modules/monitoring.js
const express = require('express');
const db = require('../config/db');
const { authenticate, isHRD } = require('../middleware/authMiddleware');
const router = express.Router();

/**
 * =====================================================================
 * MODULE: RECRUITMENT SLA MONITORING (AUDITED VERSION)
 * =====================================================================
 * LATEST UPDATES (2026-02-05):
 * ✅ Visibilitas untuk 3 Role: HRD, Peminta, dan ATASAN
 * ✅ Transparansi No-Show Count untuk User
 * ✅ UI Status Tag untuk Mobile App
 * ✅ Fair KPI Calculation (Net Duration = Gross - Buffer)
 * ✅ Edit Permission Flag (sla_is_editable)
 * =====================================================================
 */


/**
 * GET /api/monitoring/sla-status
 * =====================================================================
 * ROLE ACCESS:
 * - HRD: Melihat SEMUA permintaan yang sedang berjalan
 * - Peminta: Melihat permintaan yang DIA ajukan
 * - Atasan: Melihat permintaan yang DIA ajukan + permintaan BAWAHAN
 * =====================================================================
 */
router.get('/sla-status', authenticate, async (req, res) => {
    const { user_kode, user_hrd } = req.user;

    try {
        // Build WHERE clause berdasarkan role
        let whereClause;
        let params;

        if (user_hrd === 1) {
            // HRD: Lihat semua
            whereClause = 'WHERE sla.sla_status = "CALCULATED"';
            params = [];
        } else {
            // Peminta/Atasan: Lihat miliknya ATAU milik bawahannya
            whereClause = `WHERE (p.tpk_peminta = ? OR k.kar_nik_atasan = ?) AND sla.sla_status = "CALCULATED"`;
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
                
                -- SLA Information
                sla.sla_calculated_at,
                sla.sla_final_target_date,
                sla.sla_min_days as standard_lead_time,
                sla.sla_no_show_buffer_days,
                sla.sla_is_editable,
                sla.sla_source,
                sla.sla_notes,
                sla.sla_approval_delay_days,
                
                -- ✅ PRIORITY 2: TAMBAHKAN APPROVER NAME
                approver.kar_nama AS approver_name,
                
                -- Time Calculation
                DATEDIFF(sla.sla_final_target_date, CURDATE()) as days_remaining,
                
                -- UI Status Tag untuk Mobile App
                CASE 
                    WHEN sla.sla_is_editable = 1 THEN 'NEED_USER_UPDATE'
                    WHEN CURDATE() > sla.sla_final_target_date THEN 'OVERDUE'
                    WHEN DATEDIFF(sla.sla_final_target_date, CURDATE()) <= 3 THEN 'CRITICAL'
                    WHEN DATEDIFF(sla.sla_final_target_date, CURDATE()) <= 7 THEN 'WARNING'
                    ELSE 'ON_PROGRESS'
                END as ui_status_tag,
                
                -- ✅ Approval Flag untuk UI
                CASE
                    WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                    ELSE NULL
                END AS approval_flag,
                
                -- Progress Tracking
                (SELECT COUNT(*) 
                 FROM tlistpelamar 
                 WHERE tlp_tpk_nomor = p.tpk_nomor AND statusterakhir = 1
                ) as hired_count,
                
                (SELECT COUNT(*) 
                 FROM tlistpelamar 
                 WHERE tlp_tpk_nomor = p.tpk_nomor AND statusterakhir = 3
                ) as total_noshow,
                
                (SELECT COUNT(*) 
                 FROM tlistpelamar 
                 WHERE tlp_tpk_nomor = p.tpk_nomor AND statusterakhir IN (4, 5)
                ) as in_process_count,
                
                p.tpk_jumlah as target_count,
                
                -- Progress Percentage
                ROUND(
                    (SELECT COUNT(*) FROM tlistpelamar WHERE tlp_tpk_nomor = p.tpk_nomor AND statusterakhir = 1) 
                    / p.tpk_jumlah * 100, 
                    0
                ) as progress_percentage,
                
                -- Atasan Check (untuk badge di UI)
                CASE WHEN k.kar_nik_atasan = ? THEN 1 ELSE 0 END as is_bawahan
                
            FROM tpermintaankaryawan p
            JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            LEFT JOIN tkaryawan approver ON approver.kar_nik = k.kar_nik_atasan  -- ✅ TAMBAH JOIN
            ${whereClause}
            ORDER BY 
                CASE 
                    WHEN sla.sla_is_editable = 1 THEN 0
                    WHEN CURDATE() > sla.sla_final_target_date THEN 1
                    ELSE 2
                END ASC,
                days_remaining ASC
        `;

        // Tambahkan user_kode di akhir params untuk checking is_bawahan
        const finalParams = user_hrd === 1 ? [user_kode] : [...params, user_kode];

        const [rows] = await db.execute(sql, finalParams);

        // Build response dengan summary yang informatif
        const summary = {
            total_active: rows.length,
            need_update: rows.filter(r => r.sla_is_editable === 1).length,
            overdue: rows.filter(r => r.ui_status_tag === 'OVERDUE').length,
            critical: rows.filter(r => r.ui_status_tag === 'CRITICAL').length,
            warning: rows.filter(r => r.ui_status_tag === 'WARNING').length,
            on_progress: rows.filter(r => r.ui_status_tag === 'ON_PROGRESS').length,
            total_hired: rows.reduce((sum, r) => sum + r.hired_count, 0),
            total_target: rows.reduce((sum, r) => sum + r.target_count, 0),
            total_noshow: rows.reduce((sum, r) => sum + r.total_noshow, 0)
        };

        // Jika user adalah Atasan, tambahkan info bawahan
        if (user_hrd !== 1) {
            summary.monitoring_bawahan = rows.filter(r => r.is_bawahan === 1).length;
            summary.permintaan_sendiri = rows.filter(r => r.is_bawahan === 0).length;
        }

        res.json({
            success: true,
            data: rows,
            summary: summary,
            ui_hints: {
                NEED_USER_UPDATE: 'Anda perlu mengubah tanggal karena ada No-Show',
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
 * =====================================================================
 * Detail SLA untuk satu permintaan tertentu
 * Menampilkan timeline, No-Show events, dan adjustment history
 * =====================================================================
 */
// src/modules/monitoring.js

/**
 * GET /api/monitoring/sla-detail/:tpk_nomor
 * =====================================================================
 * Detail SLA untuk satu permintaan tertentu
 * Menampilkan timeline, No-Show events, dan adjustment history
 * ✅ UPDATED: Tambahkan approval info
 * =====================================================================
 */
router.get('/sla-detail/:tpk_nomor', authenticate, async (req, res) => {
    const { tpk_nomor } = req.params;
    const { user_kode, user_hrd } = req.user;

    try {
        // ================= AUTH =================
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

        // ================= SLA CORE DATA =================
        const [slaRows] = await db.execute(
            `SELECT 
                sla.*,
                j.jab_nama,
                p.tpk_jumlah,
                p.tpk_bagian,
                p.tpk_peminta,
                k.kar_nama AS nama_peminta,
                DATEDIFF(sla.sla_final_target_date, CURDATE()) AS days_remaining,
                
                -- ✅ TAMBAHKAN APPROVAL INFO
                sla.sla_approval_delay_days,
                approver.kar_nama AS approver_name,
                CASE
                    WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                    ELSE NULL
                END AS approval_flag
                
             FROM t_recruitment_sla sla
             JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
             JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             LEFT JOIN tkaryawan approver ON approver.kar_nik = k.kar_nik_atasan  -- ✅ JOIN APPROVER
             WHERE sla.sla_tpk_nomor = ?`,
            [tpk_nomor]
        );

        if (slaRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Data SLA tidak ditemukan' });
        }

        // ================= NO SHOW HISTORY =================
        const [noShowHistory] = await db.execute(
            `SELECT 
                lp.tlp_rkt_nomor,
                lp.tgl_tidakditerima,
                COALESCE(a.nama_lengkap, r.rkt_nama) AS kandidat_nama,
                log.log_keterangan,
                log.log_created_at
             FROM tlistpelamar lp
             LEFT JOIN t_applicant a ON CONCAT('APP-', a.applicant_id) = lp.tlp_rkt_nomor
             LEFT JOIN trekruitmen r ON r.rkt_nomor = lp.tlp_rkt_nomor
             LEFT JOIN t_selection_log log 
                ON log.log_tlp_tpk_nomor = lp.tlp_tpk_nomor
               AND log.log_tlp_rkt_nomor = lp.tlp_rkt_nomor
               AND log.log_action = 'NO_SHOW_TRIGGER'
             WHERE lp.tlp_tpk_nomor = ? AND lp.statusterakhir = 3
             ORDER BY lp.tgl_tidakditerima DESC`,
            [tpk_nomor]
        );

        // ================= RESPONSE =================
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
                no_show_history: noShowHistory,
                
                // ✅ TAMBAHKAN APPROVAL INFO di root level
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

router.get('/sla-dashboard/:tpk_nomor', authenticate, async (req, res) => {
    const { tpk_nomor } = req.params;
    const { user_kode, user_hrd } = req.user;

    try {
        // ================= AUTH =================
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

        // ================= SLA + UI STATUS =================
        const [slaRows] = await db.execute(
            `SELECT 
                sla.sla_tpk_nomor,
                sla.sla_final_target_date,
                sla.sla_is_editable,
                sla.sla_no_show_buffer_days,
                j.jab_nama,
                p.tpk_jumlah,
                DATEDIFF(sla.sla_final_target_date, CURDATE()) AS days_remaining,
                CASE
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

        // ================= PROGRESS =================
        const [progress] = await db.execute(
            `SELECT 
                COUNT(*) AS total_candidates,
                SUM(statusterakhir = 1) AS hired,
                SUM(statusterakhir = 2) AS rejected,
                SUM(statusterakhir = 3) AS no_show,
                SUM(statusterakhir = 4) AS training,
                SUM(statusterakhir = 5) AS pending_onboarding,
                SUM(statusterakhir = 6) AS failed_onboarding
             FROM tlistpelamar
             WHERE tlp_tpk_nomor = ?`,
            [tpk_nomor]
        );

        res.json({
            success: true,
            data: {
                sla: slaRows[0],
                progress: progress[0]
            }
        });

    } catch (error) {
        console.error('❌ SLA DASHBOARD ERROR:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});


/**
 * GET /api/monitoring/kpi-hrd
 * =====================================================================
 * KPI Dashboard khusus HRD
 * Menampilkan performa rekrutmen dengan fair calculation (Net Duration)
 * Net Duration = Gross Duration - No-Show Buffer
 * =====================================================================
 */
router.get('/kpi-hrd', authenticate, isHRD, async (req, res) => {
    const { period } = req.query; // 'month', 'quarter', 'year'

    try {
        // Build date filter
        let dateFilter = '';
        if (period === 'month') {
            dateFilter = 'AND YEAR(sla.sla_completed_at) = YEAR(CURDATE()) AND MONTH(sla.sla_completed_at) = MONTH(CURDATE())';
        } else if (period === 'quarter') {
            dateFilter = 'AND YEAR(sla.sla_completed_at) = YEAR(CURDATE()) AND QUARTER(sla.sla_completed_at) = QUARTER(CURDATE())';
        } else if (period === 'year') {
            dateFilter = 'AND YEAR(sla.sla_completed_at) = YEAR(CURDATE())';
        }

        const sql = `
            SELECT 
                sla.sla_tpk_nomor,
                p.tpk_tanggal as request_date,
                j.jab_nama as position,
                p.tpk_bagian as department,
                p.tpk_peminta,
                k.kar_nama as requester_name,
                
                -- SLA Metrics
                sla.sla_min_days as standard_lead_time,
                sla.sla_calculated_at as start_date,
                sla.sla_completed_at as completion_date,
                
                -- Duration Calculation
                DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) as gross_duration_days,
                sla.sla_no_show_buffer_days as no_show_buffer_days,
                (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) as net_duration_days,
                
                -- Performance Label
                CASE 
                    WHEN (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) <= sla.sla_min_days 
                    THEN '🏆 EXCELLENT'
                    WHEN (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) <= (sla.sla_min_days * 1.2)
                    THEN '✅ GOOD'
                    WHEN (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) <= (sla.sla_min_days * 1.5)
                    THEN '⚠️ ACCEPTABLE'
                    ELSE '❌ DELAY'
                END as performance_label,
                
                -- No-Show Impact
                (SELECT COUNT(*) FROM tlistpelamar 
                 WHERE tlp_tpk_nomor = sla.sla_tpk_nomor AND statusterakhir = 3
                ) as total_no_shows,
                
                -- Hiring Result
                (SELECT COUNT(*) FROM tlistpelamar 
                 WHERE tlp_tpk_nomor = sla.sla_tpk_nomor AND statusterakhir = 1
                ) as hired_count,
                
                p.tpk_jumlah as target_count,
                
                -- Source Info
                sla.sla_source
                
            FROM t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
            WHERE sla.sla_status = 'COMPLETED'
            ${dateFilter}
            ORDER BY sla.sla_completed_at DESC
        `;

        const [rows] = await db.execute(sql);

        // Calculate aggregated metrics
        const totalRecords = rows.length;
        const avgGrossDuration = totalRecords > 0 
            ? rows.reduce((sum, r) => sum + r.gross_duration_days, 0) / totalRecords 
            : 0;
        const avgNetDuration = totalRecords > 0 
            ? rows.reduce((sum, r) => sum + r.net_duration_days, 0) / totalRecords 
            : 0;
        const totalBufferDays = rows.reduce((sum, r) => sum + r.no_show_buffer_days, 0);
        
        const excellentCount = rows.filter(r => r.performance_label.includes('EXCELLENT')).length;
        const goodCount = rows.filter(r => r.performance_label.includes('GOOD')).length;
        const acceptableCount = rows.filter(r => r.performance_label.includes('ACCEPTABLE')).length;
        const delayCount = rows.filter(r => r.performance_label.includes('DELAY')).length;

        res.json({
            success: true,
            data: rows,
            summary: {
                period: period || 'all_time',
                total_completed: totalRecords,
                avg_gross_duration: Math.round(avgGrossDuration * 10) / 10,
                avg_net_duration: Math.round(avgNetDuration * 10) / 10,
                total_buffer_granted: totalBufferDays,
                performance_distribution: {
                    excellent: excellentCount,
                    good: goodCount,
                    acceptable: acceptableCount,
                    delay: delayCount
                },
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
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil KPI HRD',
            error: error.message
        });
    }
});

/**
 * GET /api/monitoring/kpi-approver
 * =====================================================================
 * KPI Dashboard untuk Atasan/Manager
 * Menampilkan performa approval atasan (apakah cepat atau lambat approve)
 * =====================================================================
 */
// ✅ PERBAIKAN: Hapus middleware 'isHRD' agar user non-HRD (Manager) bisa mengakses
router.get('/kpi-approver', authenticate, async (req, res) => {
    const { period } = req.query; // 'month', 'quarter', 'year'
    const user = req.user; // Diambil dari middleware authenticate (user_kode, is_hrd)

    try {
        // 1. Build date filter (Logika Periode Waktu)
        let dateFilter = '';
        if (period === 'month') {
            dateFilter = 'AND YEAR(sla.sla_approved_at) = YEAR(CURDATE()) AND MONTH(sla.sla_approved_at) = MONTH(CURDATE())';
        } else if (period === 'quarter') {
            dateFilter = 'AND YEAR(sla.sla_approved_at) = YEAR(CURDATE()) AND QUARTER(sla.sla_approved_at) = QUARTER(CURDATE())';
        } else if (period === 'year') {
            dateFilter = 'AND YEAR(sla.sla_approved_at) = YEAR(CURDATE())';
        }

        // 2. ✅ LOGIKA ROLE FILTER
        // Jika bukan HRD (user_hrd === 0), filter data agar hanya menampilkan record di mana user login adalah approver-nya.
        let roleFilter = '';
        if (user.user_hrd !== 1) {
            roleFilter = `AND approver.kar_nik = '${user.user_kode}'`;
        }

        // ===== QUERY 1: Detail Records =====
        const sql = `
            SELECT
                p.tpk_nomor,
                DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d') AS request_date,
                DATE_FORMAT(sla.sla_approved_at, '%Y-%m-%d') AS approved_date,

                -- Approver info
                approver.kar_nik AS approver_nik,
                COALESCE(approver.kar_nama, 'TANPA ATASAN') AS approver_name,

                -- Requester info
                peminta.kar_nama AS requester_name,
                p.tpk_bagian,
                j.jab_nama,

                -- KPI Metric
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
              ${roleFilter} -- ✅ Masukkan filter role di sini
            ORDER BY sla_approval_delay_days DESC
        `;

        const [rows] = await db.execute(sql);

        // ===== QUERY 2: Summary Per Approver =====
        const approverSql = `
            SELECT
                approver.kar_nik AS approver_nik,
                COALESCE(approver.kar_nama, 'TANPA ATASAN') AS approver_name,
                COUNT(*) AS total_approvals,
                ROUND(AVG(DATEDIFF(sla.sla_approved_at, p.tpk_tanggal)), 1) AS avg_delay_days,
                
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 1 THEN 1 ELSE 0 END) AS excellent_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 3 THEN 1 ELSE 0 END) AS good_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 5 THEN 1 ELSE 0 END) AS slow_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) > 5 THEN 1 ELSE 0 END) AS very_slow_count

            FROM t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            LEFT JOIN tkaryawan peminta ON peminta.kar_nik = p.tpk_peminta
            LEFT JOIN tkaryawan approver ON approver.kar_nik = peminta.kar_nik_atasan

            WHERE sla.sla_status IN ('CALCULATED', 'COMPLETED')
              AND sla.sla_approved_at IS NOT NULL
              ${dateFilter}
              ${roleFilter} -- ✅ Masukkan filter role juga di sini
            
            GROUP BY approver.kar_nik, approver.kar_nama
            HAVING total_approvals > 0
            ORDER BY avg_delay_days ASC
        `;

        const [approverStats] = await db.execute(approverSql);

        // Perhitungan Summary Akhir (Sesuai ekspektasi Frontend)
        const totalRecords = rows.length;
        const excellentCount = rows.filter(r => r.approval_performance === 'EXCELLENT').length;
        const goodCount = rows.filter(r => r.approval_performance === 'GOOD').length;
        const slowCount = rows.filter(r => r.approval_performance === 'SLOW').length;
        const verySlowCount = rows.filter(r => r.approval_performance === 'VERY_SLOW').length;

        const avgApprovalDelay = totalRecords > 0
            ? rows.reduce((sum, r) => sum + r.sla_approval_delay_days, 0) / totalRecords
            : 0;

        res.json({
            success: true,
            data: rows,
            approver_stats: approverStats,
            summary: {
                period: period || 'all_time',
                total_approvals: totalRecords,
                avg_approval_delay_days: Math.round(avgApprovalDelay * 10) / 10,
                performance_distribution: {
                    excellent: excellentCount,
                    good: goodCount,
                    slow: slowCount,
                    very_slow: verySlowCount
                },
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
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil KPI Approver',
            error: error.message
        });
    }
});


/**
 * GET /api/monitoring/dashboard-summary
 * =====================================================================
 * Summary dashboard untuk semua role
 * Memberikan overview high-level dari sistem rekrutmen
 * =====================================================================
 */
router.get('/dashboard-summary', authenticate, async (req, res) => {
    const { user_kode, user_hrd } = req.user;

    try {
        // Build WHERE clause berdasarkan role (sama seperti sla-status)
        let whereClause;
        let params;

        if (user_hrd === 1) {
            whereClause = '';
            params = [];
        } else {
            whereClause = 'WHERE (p.tpk_peminta = ? OR k.kar_nik_atasan = ?)';
            params = [user_kode, user_kode];
        }

        // Active Requests
        const [activeRequests] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause}
             AND sla.sla_status = 'CALCULATED'`,
            params
        );

        // Overdue Requests
        const [overdueRequests] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause}
             AND sla.sla_status = 'CALCULATED'
             AND CURDATE() > sla.sla_final_target_date`,
            params
        );

        // Need Update (sla_is_editable)
        const [needUpdate] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tpermintaankaryawan p
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
             ${whereClause}
             AND sla.sla_status = 'CALCULATED'
             AND sla.sla_is_editable = 1`,
            params
        );

        // Total Hired (completed this month)
        const [totalHired] = await db.execute(
            `SELECT COUNT(DISTINCT lp.tlp_rkt_nomor) as count
             FROM tlistpelamar lp
             JOIN tpermintaankaryawan p ON p.tpk_nomor = lp.tlp_tpk_nomor
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             ${whereClause}
             AND lp.statusterakhir = 1
             AND YEAR(lp.tgl_diterima) = YEAR(CURDATE())
             AND MONTH(lp.tgl_diterima) = MONTH(CURDATE())`,
            params
        );

        // Total No-Shows (this month)
        const [totalNoShows] = await db.execute(
            `SELECT COUNT(*) as count
             FROM tlistpelamar lp
             JOIN tpermintaankaryawan p ON p.tpk_nomor = lp.tlp_tpk_nomor
             LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
             ${whereClause}
             AND lp.statusterakhir = 3
             AND YEAR(lp.tgl_tidakditerima) = YEAR(CURDATE())
             AND MONTH(lp.tgl_tidakditerima) = MONTH(CURDATE())`,
            params
        );

        res.json({
            success: true,
            data: {
                active_requests: activeRequests[0].count,
                overdue_requests: overdueRequests[0].count,
                need_user_update: needUpdate[0].count,
                hired_this_month: totalHired[0].count,
                no_shows_this_month: totalNoShows[0].count
            },
            period: {
                year: new Date().getFullYear(),
                month: new Date().getMonth() + 1
            }
        });

    } catch (error) {
        console.error('❌ Error dashboard summary:', error.message);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil dashboard summary',
            error: error.message
        });
    }
});


/**
 * GET /api/monitoring/check-deadline
 * =====================================================================
 * SYSTEM ENDPOINT — SLA CRITICAL ALERT (≤ 3 DAYS)
 * Dipakai oleh:
 * - Scheduler / Cron
 * - Notification Service (WA / Email / Push)
 * =====================================================================
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
        res.status(500).json({
            success: false,
            message: 'Gagal mengecek SLA critical deadline',
            error: error.message
        });
    }
});

module.exports = router;