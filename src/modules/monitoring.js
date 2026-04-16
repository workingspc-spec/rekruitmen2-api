// src/modules/monitoring.js
const express = require('express');
const db      = require('../config/db');
const { authenticate, isHRD } = require('../middleware/authMiddleware');
const { countWorkdays }       = require('../utils/workdayCalculator');
const router  = express.Router();

/**
 * =====================================================================
 * HELPER: Build KPI date filter
 * =====================================================================
 */
function buildKpiDateFilter(period, dateColumn) {
    if (!period || period === 'All Time') {
        return { sql: '', params: [] };
    }

    let condition = '';
    const params  = [];

    switch (period) {
        case 'Today':
            condition = `DATE(${dateColumn}) = CURDATE()`;
            break;
        case 'Yesterday':
            condition = `DATE(${dateColumn}) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`;
            break;
        case 'This week':
            condition = `YEARWEEK(${dateColumn}, 1) = YEARWEEK(CURDATE(), 1)`;
            break;
        case 'Last week':
            condition = `YEARWEEK(${dateColumn}, 1) = YEARWEEK(CURDATE(), 1) - 1`;
            break;
        case 'This month':
        case 'month':
            condition = `MONTH(${dateColumn}) = MONTH(CURDATE()) AND YEAR(${dateColumn}) = YEAR(CURDATE())`;
            break;
        case 'Last month':
            condition = `MONTH(${dateColumn}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND YEAR(${dateColumn}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))`;
            break;
        case 'This year':
        case 'year':
            condition = `YEAR(${dateColumn}) = YEAR(CURDATE())`;
            break;
        case 'Last year':
            condition = `YEAR(${dateColumn}) = YEAR(CURDATE()) - 1`;
            break;
        case 'quarter':
            condition = `YEAR(${dateColumn}) = YEAR(CURDATE()) AND QUARTER(${dateColumn}) = QUARTER(CURDATE())`;
            break;
        default: {
            let rangeStr = period;
            if (rangeStr.toLowerCase().startsWith('custom:')) {
                rangeStr = rangeStr.replace(/custom:/i, '').trim();
            }
            const parts = rangeStr.includes(',')
                ? rangeStr.split(',')
                : rangeStr.split(' - ');

            if (parts.length === 2) {
                const start = parts[0].trim();
                const end   = parts[1].trim();
                condition = `DATE(${dateColumn}) BETWEEN ? AND ?`;
                params.push(start, end);
            }
            break;
        }
    }

    return { sql: condition, params };
}

// =====================================================================
// GET /api/monitoring/sla-status
//
// [OPTIMASI] Query ini join tpermintaankaryawan melalui PK (tpk_nomor)
// via t_recruitment_sla — PK lookup sudah cepat. Filter tpk_peminta untuk
// non-HRD menggunakan shadow table (idx_helper_peminta).
// [FIX] Tambahkan prefix eksplisit hrd2. untuk semua tabel legacy.
// =====================================================================
router.get('/sla-status', authenticate, async (req, res) => {
    const { user_kode, user_hrd } = req.user;

    try {
        let whereClause;
        let params;

        if (user_hrd === 1) {
            // HRD: semua SLA aktif/completed
            whereClause = 'WHERE sla.sla_status IN ("CALCULATED", "COMPLETED")';
            params = [user_kode]; // untuk CASE is_bawahan
        } else {
            // [OPTIMASI] Non-HRD: gunakan shadow table untuk filter tpk_peminta (indexed)
            // dan akses bawahan via tkaryawan join
            whereClause = `
                WHERE (h.tpk_peminta = ? OR k.kar_nik_atasan = ?)
                  AND sla.sla_status IN ("CALCULATED", "COMPLETED")
            `;
            params = [user_kode, user_kode, user_kode]; // 2 untuk WHERE + 1 untuk CASE is_bawahan
        }

        // [FIX] Gunakan eksplisit hrd2. prefix dan rekruitmen2.tpk_index_helper
        // untuk non-HRD agar tidak bergantung pada DEFAULT DB
        const sql = user_hrd === 1
            ? `
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
                    sla.sla_completed_at,

                    approver.kar_nama AS approver_name,

                    DATEDIFF(sla.sla_max_target_date, CURDATE()) as days_remaining,
                    p.tpk_jumlah as target_count,

                    ROUND((COALESCE(sla.sla_hired_count, 0) / NULLIF(p.tpk_jumlah, 0)) * 100) AS progress_percentage,

                    CASE
                        WHEN sla.sla_status = 'COMPLETED' THEN 'COMPLETED'
                        WHEN sla.sla_is_editable = 1 THEN 'NEED_USER_UPDATE'
                        WHEN CURDATE() > sla.sla_max_target_date THEN 'OVERDUE'
                        WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 3 THEN 'CRITICAL'
                        WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 7 THEN 'WARNING'
                        ELSE 'ON_PROGRESS'
                    END as ui_status_tag,

                    CASE
                        WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                        ELSE NULL
                    END AS approval_flag,

                    CASE WHEN k.kar_nik_atasan = ? THEN 1 ELSE 0 END as is_bawahan

                FROM hrd2.tpermintaankaryawan p
                JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
                JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
                LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
                LEFT JOIN hrd2.tkaryawan approver ON approver.kar_nik = k.kar_nik_atasan
                WHERE sla.sla_status IN ("CALCULATED", "COMPLETED")
                ORDER BY
                    CASE WHEN sla.sla_is_editable = 1 THEN 0
                         WHEN CURDATE() > sla.sla_max_target_date THEN 1
                         ELSE 2 END ASC,
                    days_remaining ASC
            `
            : `
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
                    sla.sla_completed_at,

                    approver.kar_nama AS approver_name,

                    DATEDIFF(sla.sla_max_target_date, CURDATE()) as days_remaining,
                    p.tpk_jumlah as target_count,

                    ROUND((COALESCE(sla.sla_hired_count, 0) / NULLIF(p.tpk_jumlah, 0)) * 100) AS progress_percentage,

                    CASE
                        WHEN sla.sla_status = 'COMPLETED' THEN 'COMPLETED'
                        WHEN sla.sla_is_editable = 1 THEN 'NEED_USER_UPDATE'
                        WHEN CURDATE() > sla.sla_max_target_date THEN 'OVERDUE'
                        WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 3 THEN 'CRITICAL'
                        WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 7 THEN 'WARNING'
                        ELSE 'ON_PROGRESS'
                    END as ui_status_tag,

                    CASE
                        WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                        ELSE NULL
                    END AS approval_flag,

                    CASE WHEN k.kar_nik_atasan = ? THEN 1 ELSE 0 END as is_bawahan

                FROM rekruitmen2.tpk_index_helper h
                JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = h.tpk_nomor
                JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
                JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
                LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
                LEFT JOIN hrd2.tkaryawan approver ON approver.kar_nik = k.kar_nik_atasan
                WHERE (h.tpk_peminta = ? OR k.kar_nik_atasan = ?)
                  AND sla.sla_status IN ("CALCULATED", "COMPLETED")
                ORDER BY
                    CASE WHEN sla.sla_is_editable = 1 THEN 0
                         WHEN CURDATE() > sla.sla_max_target_date THEN 1
                         ELSE 2 END ASC,
                    days_remaining ASC
            `;

        const [rows] = await db.execute(sql, params);

        const summary = {
            total_active: rows.filter(r => r.sla_status === 'CALCULATED').length,
            need_update:  rows.filter(r => r.sla_is_editable === 1).length,
            overdue:      rows.filter(r => r.ui_status_tag === 'OVERDUE').length,
            critical:     rows.filter(r => r.ui_status_tag === 'CRITICAL').length,
            warning:      rows.filter(r => r.ui_status_tag === 'WARNING').length,
            on_progress:  rows.filter(r => r.ui_status_tag === 'ON_PROGRESS').length,
            total_hired:  rows.reduce((sum, r) => sum + (Number(r.sla_hired_count) || 0), 0),
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
                COMPLETED:        'Rekrutmen selesai',
                NEED_USER_UPDATE: 'Anda perlu mengubah tanggal target',
                OVERDUE:          'Target sudah terlewat',
                CRITICAL:         '≤3 hari tersisa',
                WARNING:          '≤7 hari tersisa',
                ON_PROGRESS:      'Berjalan normal'
            }
        });

    } catch (error) {
        console.error('❌ Error monitoring SLA:', error.message);
        res.status(500).json({ success: false, message: 'Gagal mengambil data monitoring', error: error.message });
    }
});

// =====================================================================
// GET /api/monitoring/sla-detail/:tpk_nomor
// [FIX] Tambahkan prefix hrd2. eksplisit
// =====================================================================
router.get('/sla-detail/:tpk_nomor', authenticate, async (req, res) => {
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

        const [slaRows] = await db.execute(
            `SELECT
                sla.*,
                j.jab_nama,
                p.tpk_jumlah,
                p.tpk_bagian,
                p.tpk_peminta,
                k.kar_nama AS nama_peminta,
                DATEDIFF(sla.sla_max_target_date, CURDATE()) AS days_remaining,
                approver.kar_nama AS approver_name,
                CASE
                    WHEN sla.sla_approval_delay_days > 5 THEN 'APPROVAL_DELAYED'
                    ELSE NULL
                END AS approval_flag
             FROM rekruitmen2.t_recruitment_sla sla
             JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
             JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
             LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
             LEFT JOIN hrd2.tkaryawan approver ON approver.kar_nik = k.kar_nik_atasan
             WHERE sla.sla_tpk_nomor = ?`,
            [tpk_nomor]
        );

        if (slaRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Data SLA tidak ditemukan' });
        }

        const sla = slaRows[0];

        const [editHistory] = await db.execute(
            `SELECT
                l.log_id,
                l.field_name,
                l.old_value,
                l.new_value,
                l.user_kode,
                k.kar_nama AS user_nama,
                DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
            FROM rekruitmen2.t_pkar_log l
            LEFT JOIN hrd2.tkaryawan k ON k.kar_Nik = l.user_kode
            WHERE (l.sla_id = ? OR (l.sla_id IS NULL AND l.tpk_nomor = ?))
            ORDER BY l.created_at DESC`,
            [sla.sla_id, tpk_nomor]
        );

        res.json({
            success: true,
            data: {
                sla_info: sla,
                timeline: {
                    request_created_at:   sla.sla_request_created_at,
                    approved_at:          sla.sla_approved_at,
                    original_target_date: sla.sla_original_requested_date,
                    system_floor_date:    sla.sla_system_floor_date,
                    final_target_date:    sla.sla_final_target_date,
                    max_target_date:      sla.sla_max_target_date,
                    buffer_days_added:    sla.sla_no_show_buffer_days,
                    days_remaining:       sla.days_remaining
                },
                edit_history: editHistory,
                approval_info: {
                    approver_name:       sla.approver_name,
                    approval_delay_days: sla.sla_approval_delay_days,
                    approval_flag:       sla.approval_flag
                }
            }
        });

    } catch (error) {
        console.error('❌ SLA DETAIL ERROR:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================
// GET /api/monitoring/sla-dashboard/:tpk_nomor
// =====================================================================
router.get('/sla-dashboard/:tpk_nomor', authenticate, async (req, res) => {
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
                DATEDIFF(sla.sla_max_target_date, CURDATE()) AS days_remaining,
                CASE
                    WHEN sla.sla_status = 'COMPLETED' THEN 'COMPLETED'
                    WHEN sla.sla_is_editable = 1 THEN 'NEED_USER_UPDATE'
                    WHEN CURDATE() > sla.sla_max_target_date THEN 'OVERDUE'
                    WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 3 THEN 'CRITICAL'
                    WHEN DATEDIFF(sla.sla_max_target_date, CURDATE()) <= 7 THEN 'WARNING'
                    ELSE 'ON_PROGRESS'
                END AS ui_status
             FROM rekruitmen2.t_recruitment_sla sla
             JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
             JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
             WHERE sla.sla_tpk_nomor = ?`,
            [tpk_nomor]
        );

        if (slaRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Data SLA tidak ditemukan' });
        }

        res.json({ success: true, data: slaRows[0] });

    } catch (error) {
        console.error('❌ SLA DASHBOARD ERROR:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/monitoring/kpi-hrd
 */
router.get('/kpi-hrd', authenticate, isHRD, async (req, res) => {
    const { period } = req.query;

    try {
        const dateFilter = buildKpiDateFilter(period, 'sla.sla_completed_at');
        const dateCondition = dateFilter.sql ? `AND ${dateFilter.sql}` : '';

        const [rows] = await db.execute(`
            SELECT
                sla.sla_tpk_nomor,
                p.tpk_tanggal as request_date,
                j.jab_nama as position,
                p.tpk_bagian as department,
                p.tpk_peminta,
                k.kar_nama as requester_name,

                sla.sla_min_days as standard_lead_time,
                sla.sla_max_days,
                sla.sla_calculated_at as start_date,
                sla.sla_completed_at as completion_date,
                sla.sla_no_show_buffer_days as no_show_buffer_days,

                sla.sla_hired_count as hired_count,
                p.tpk_jumlah as target_count,
                sla.sla_source

            FROM rekruitmen2.t_recruitment_sla sla
            JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
            WHERE sla.sla_status = 'COMPLETED'
            ${dateCondition}
            ORDER BY sla.sla_completed_at DESC
        `, dateFilter.params);

        const processedRows = rows.map(row => {
            const grossDays = countWorkdays(row.start_date, row.completion_date);
            const netDays   = Math.max(0, grossDays - row.no_show_buffer_days);

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
                net_duration_days:   netDays,
                performance_label:   kpiStatus
            };
        });

        const totalRecords   = processedRows.length;
        const avgGross       = totalRecords > 0 ? processedRows.reduce((s, r) => s + r.gross_duration_days, 0) / totalRecords : 0;
        const avgNet         = totalRecords > 0 ? processedRows.reduce((s, r) => s + r.net_duration_days, 0) / totalRecords : 0;

        const excellentCount  = processedRows.filter(r => r.performance_label === 'EXCELLENT').length;
        const goodCount       = processedRows.filter(r => r.performance_label === 'GOOD').length;
        const acceptableCount = processedRows.filter(r => r.performance_label === 'ACCEPTABLE').length;
        const delayCount      = processedRows.filter(r => r.performance_label === 'DELAY').length;

        const periodLabel = !period || period === 'All Time' ? 'all_time' : period;

        res.json({
            success: true,
            data: processedRows,
            summary: {
                period:                periodLabel,
                total_completed:       totalRecords,
                avg_gross_duration:    Math.round(avgGross * 10) / 10,
                avg_net_duration:      Math.round(avgNet * 10) / 10,
                performance_distribution: {
                    excellent:  excellentCount,
                    good:       goodCount,
                    acceptable: acceptableCount,
                    delay:      delayCount
                },
                success_rate: totalRecords > 0
                    ? Math.round(((excellentCount + goodCount) / totalRecords) * 100)
                    : 0
            },
            insights: {
                fairness_note: 'Net Duration = Gross Duration - No-Show Buffer',
                explanation:   'Perhitungan menggunakan Hari Kerja (Workdays), mengabaikan hari libur.'
            }
        });

    } catch (error) {
        console.error('❌ Error KPI HRD:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/monitoring/kpi-approver
 * [FIX-KRITIS] SQL Injection diperbaiki dengan parameterized query.
 */
router.get('/kpi-approver', authenticate, async (req, res) => {
    const { period } = req.query;
    const user = req.user;

    try {
        const dateFilter    = buildKpiDateFilter(period, 'sla.sla_approved_at');
        const dateCondition = dateFilter.sql ? `AND ${dateFilter.sql}` : '';

        const roleFilter = user.user_hrd !== 1 ? `AND approver.kar_nik = ?` : '';
        const roleParams = user.user_hrd !== 1 ? [user.user_kode] : [];

        const queryParams      = [...dateFilter.params, ...roleParams];
        const statsQueryParams = [...dateFilter.params, ...roleParams];

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
            FROM rekruitmen2.t_recruitment_sla sla
            JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN hrd2.tkaryawan peminta ON peminta.kar_nik = p.tpk_peminta
            LEFT JOIN hrd2.tkaryawan approver ON approver.kar_nik = peminta.kar_nik_atasan
            WHERE sla.sla_status IN ('CALCULATED', 'COMPLETED')
              AND sla.sla_approved_at IS NOT NULL
              ${dateCondition}
              ${roleFilter}
            ORDER BY sla_approval_delay_days DESC
        `, queryParams);

        const [approverStats] = await db.execute(`
            SELECT
                approver.kar_nik AS approver_nik,
                COALESCE(approver.kar_nama, 'TANPA ATASAN') AS approver_name,
                COUNT(*) AS total_approvals,
                ROUND(AVG(DATEDIFF(sla.sla_approved_at, p.tpk_tanggal)), 1) AS avg_delay_days,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) <= 2 THEN 1 ELSE 0 END) AS fast_track_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) BETWEEN 3 AND 5 THEN 1 ELSE 0 END) AS standard_review_count,
                SUM(CASE WHEN DATEDIFF(sla.sla_approved_at, p.tpk_tanggal) > 5 THEN 1 ELSE 0 END) AS extended_review_count
            FROM rekruitmen2.t_recruitment_sla sla
            JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            LEFT JOIN hrd2.tkaryawan peminta ON peminta.kar_nik = p.tpk_peminta
            LEFT JOIN hrd2.tkaryawan approver ON approver.kar_nik = peminta.kar_nik_atasan
            WHERE sla.sla_status IN ('CALCULATED', 'COMPLETED')
              AND sla.sla_approved_at IS NOT NULL
              ${dateCondition}
              ${roleFilter}
            GROUP BY approver.kar_nik, approver.kar_nama
            HAVING total_approvals > 0
            ORDER BY avg_delay_days ASC
        `, statsQueryParams);

        const totalRecords        = rows.length;
        const fastTrackCount      = rows.filter(r => r.approval_performance === 'FAST_TRACK').length;
        const standardReviewCount = rows.filter(r => r.approval_performance === 'STANDARD_REVIEW').length;
        const extendedReviewCount = rows.filter(r => r.approval_performance === 'EXTENDED_REVIEW').length;
        const avgDelay            = totalRecords > 0
            ? rows.reduce((s, r) => s + r.sla_approval_delay_days, 0) / totalRecords
            : 0;

        const periodLabel = !period || period === 'All Time' ? 'all_time' : period;

        res.json({
            success: true,
            data: rows,
            approver_stats: approverStats,
            summary: {
                period:                  periodLabel,
                total_approvals:         totalRecords,
                avg_approval_delay_days: Math.round(avgDelay * 10) / 10,
                performance_distribution: {
                    fast_track_count:      fastTrackCount,
                    standard_review_count: standardReviewCount,
                    extended_review_count: extendedReviewCount
                },
                fast_approval_rate: totalRecords > 0
                    ? Math.round(((fastTrackCount + standardReviewCount) / totalRecords) * 100)
                    : 0
            },
            insights: {
                note:             'KPI ini mengukur kecepatan atasan dalam approve permintaan karyawan',
                target:           'Target ideal: approval dalam ≤3 hari kerja',
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
 * [OPTIMASI] Filter tpk_peminta via shadow table untuk non-HRD.
 */
router.get('/dashboard-summary', authenticate, async (req, res) => {
    const { user_kode, user_hrd } = req.user;

    try {
        // [OPTIMASI] Non-HRD: gunakan shadow table untuk filter tpk_peminta
        const shadowJoin  = user_hrd === 1 ? '' : 'JOIN rekruitmen2.tpk_index_helper h ON h.tpk_nomor = sla.sla_tpk_nomor';
        const userFilter  = user_hrd === 1 ? '' : 'AND (h.tpk_peminta = ? OR k.kar_nik_atasan = ?)';
        const userParams  = user_hrd === 1 ? [] : [user_kode, user_kode];

        const baseFrom = `
            FROM rekruitmen2.t_recruitment_sla sla
            ${shadowJoin}
            LEFT JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
        `;
        const baseWhere = `WHERE 1=1 ${userFilter}`;

        const [activeRequests] = await db.execute(
            `SELECT COUNT(*) as count ${baseFrom} ${baseWhere} AND sla.sla_status = 'CALCULATED'`,
            userParams
        );

        const [overdueRequests] = await db.execute(
            `SELECT COUNT(*) as count ${baseFrom} ${baseWhere} AND sla.sla_status = 'CALCULATED' AND CURDATE() > sla.sla_max_target_date`,
            userParams
        );

        const [needUpdate] = await db.execute(
            `SELECT COUNT(*) as count ${baseFrom} ${baseWhere} AND sla.sla_status = 'CALCULATED' AND sla.sla_is_editable = 1`,
            userParams
        );

        const [completedThisMonth] = await db.execute(
            `SELECT COUNT(*) as count ${baseFrom} ${baseWhere} AND sla.sla_status = 'COMPLETED'
             AND sla.sla_completed_at IS NOT NULL
             AND YEAR(sla.sla_completed_at) = YEAR(CURDATE())
             AND MONTH(sla.sla_completed_at) = MONTH(CURDATE())`,
            userParams
        );

        res.json({
            success: true,
            data: {
                activeRequests:     activeRequests[0].count,
                overdueRequests:    overdueRequests[0].count,
                needUserUpdate:     needUpdate[0].count,
                completedThisMonth: completedThisMonth[0].count
            },
            period: {
                year:  new Date().getFullYear(),
                month: new Date().getMonth() + 1
            }
        });

    } catch (error) {
        console.error('❌ Error dashboard summary:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================================================
// GET /api/monitoring/check-deadline
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
                DATEDIFF(sla.sla_max_target_date, CURDATE()) AS days_remaining
            FROM rekruitmen2.t_recruitment_sla sla
            JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
            LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
            WHERE sla.sla_status = 'CALCULATED'
              AND sla.sla_is_editable = 0
              AND DATEDIFF(sla.sla_max_target_date, CURDATE()) BETWEEN 0 AND 3
            ORDER BY days_remaining ASC
        `);

        res.json({
            success:       true,
            alerted_count: rows.length,
            threshold_days: 3,
            data:          rows
        });

    } catch (error) {
        console.error('❌ Error SLA deadline check:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;