// src/modules/dashboard.js
const express = require('express');
const db = require('../config/db');
const { authenticate, isHRD } = require('../middleware/authMiddleware');
const { countWorkdays } = require('../utils/workdayCalculator');
const router = express.Router();


/**
 * Resolver approver aktif berbasis scope untuk dashboard.
 * Urutan prioritas: bagian+dep+pab, bagian+pab, bagian+dep, bagian global,
 * lalu fallback tkaryawan.kar_nik_atasan.
 */
const RESOLVED_APPROVER_SQL_K = `
    COALESCE((
                SELECT TRIM(am2.am_approver_nik)
                FROM rekruitmen2.t_approval_mapping am2
                WHERE am2.am_active = 1
                  AND TRIM(am2.am_bagian) = TRIM(p.tpk_bagian)
                  AND (
                        am2.am_dep_kode IS NULL
                     OR TRIM(am2.am_dep_kode) = ''
                     OR TRIM(am2.am_dep_kode) = TRIM(k.kar_dep_kode)
                  )
                  AND (
                        am2.am_pab_kode IS NULL
                     OR TRIM(am2.am_pab_kode) = ''
                     OR TRIM(am2.am_pab_kode) = TRIM(k.kar_pab_kode)
                  )
                ORDER BY
                    CASE
                        WHEN NULLIF(TRIM(am2.am_dep_kode), '') = NULLIF(TRIM(k.kar_dep_kode), '')
                         AND NULLIF(TRIM(am2.am_pab_kode), '') = NULLIF(TRIM(k.kar_pab_kode), '')
                        THEN 1
                        WHEN (am2.am_dep_kode IS NULL OR TRIM(am2.am_dep_kode) = '')
                         AND NULLIF(TRIM(am2.am_pab_kode), '') = NULLIF(TRIM(k.kar_pab_kode), '')
                        THEN 2
                        WHEN NULLIF(TRIM(am2.am_dep_kode), '') = NULLIF(TRIM(k.kar_dep_kode), '')
                         AND (am2.am_pab_kode IS NULL OR TRIM(am2.am_pab_kode) = '')
                        THEN 3
                        WHEN (am2.am_dep_kode IS NULL OR TRIM(am2.am_dep_kode) = '')
                         AND (am2.am_pab_kode IS NULL OR TRIM(am2.am_pab_kode) = '')
                        THEN 4
                        ELSE 99
                    END,
                    COALESCE(am2.am_priority, 100),
                    am2.am_id
                LIMIT 1
            ), TRIM(k.kar_nik_atasan))
`;

/**
 * HELPER: Build filter SQL untuk shadow table (tpk_index_helper) berdasarkan period.
 *
 * [OPTIMASI] Semua filter tanggal kini menggunakan h.tpk_tanggal (indexed di shadow table)
 * bukan p.tpk_tanggal (non-indexed di hrd2.tpermintaankaryawan).
 *
 * @param {string|null} period
 * @param {string} [dateColumn='h.tpk_tanggal'] — kolom tanggal pada shadow table
 * @returns {{ sql: string, params: any[] }}
 */
const getDateFilter = (period, dateColumn = 'h.tpk_tanggal') => {
    if (!period || period === 'All Time') return { sql: '', params: [] };

    let condition = '';
    let params = [];

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
            condition = `MONTH(${dateColumn}) = MONTH(CURDATE()) AND YEAR(${dateColumn}) = YEAR(CURDATE())`;
            break;
        case 'Last month':
            condition = `MONTH(${dateColumn}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND YEAR(${dateColumn}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))`;
            break;
        case 'This year':
            condition = `YEAR(${dateColumn}) = YEAR(CURDATE())`;
            break;
        case 'Last year':
            condition = `YEAR(${dateColumn}) = YEAR(CURDATE()) - 1`;
            break;
        default:
            if (period.includes(',')) {
                const [start, end] = period.split(',');
                condition = `${dateColumn} BETWEEN ? AND ?`;
                params.push(start.trim(), end.trim());
            }
    }
    return { sql: condition, params };
};

/**
 * GET /api/dashboard/stats
 *
 * [OPTIMASI] Semua query yang filter tpermintaankaryawan kini melalui shadow table
 * tpk_index_helper agar memanfaatkan index pada tpk_peminta, tpk_tanggal,
 * tpk_approveatasan, dan tpk_approveHRD.
 */
router.get('/stats', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;
    const { period = 'All Time' } = req.query;

    try {
        // ── 1. TOTAL PERMINTAAN (GABUNGAN NEW + LEGACY) ──
        const dateFilter = getDateFilter(period, 'h.tpk_tanggal');
        const dateWhere  = dateFilter.sql ? ` AND ${dateFilter.sql}` : '';

        // PKAR Baru: ada record di t_recruitment_sla
        let pkarCount;
        if (is_hrd) {
            const [rows] = await db.execute(
                `SELECT COUNT(*) as total FROM rekruitmen2.tpk_index_helper h
                INNER JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = h.tpk_nomor
                WHERE 1=1 ${dateWhere}`,
                dateFilter.params
            );
            pkarCount = rows[0].total;
        } else {
            const [rows] = await db.execute(
                `SELECT COUNT(*) as total FROM rekruitmen2.tpk_index_helper h
                INNER JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = h.tpk_nomor
                WHERE 1=1 ${dateWhere} AND h.tpk_peminta = ?`,
                [...dateFilter.params, user_kode]
            );
            pkarCount = rows[0].total;
        }

        // Legacy: hrd2 yang TIDAK punya SLA (data dari sistem lama)
        const legacyDateFilter = getDateFilter(period, 'p.tpk_tanggal');
        const legacyDateWhere  = legacyDateFilter.sql ? ` AND ${legacyDateFilter.sql}` : '';

        let legacyCount;
        if (is_hrd) {
            const [rows] = await db.execute(
                `SELECT COUNT(*) as total FROM hrd2.tpermintaankaryawan p
                LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
                WHERE sla.sla_id IS NULL ${legacyDateWhere}`,
                legacyDateFilter.params
            );
            legacyCount = rows[0].total;
        } else {
            const [rows] = await db.execute(
                `SELECT COUNT(*) as total FROM hrd2.tpermintaankaryawan p
                LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
                WHERE sla.sla_id IS NULL AND TRIM(p.tpk_peminta) = ? ${legacyDateWhere}`,
                [user_kode, ...legacyDateFilter.params]
            );
            legacyCount = rows[0].total;
        }


        // ── 2. LOWONGAN AKTIF (FIX: Hanya hitung data dari aplikasi baru) ──
        const lowonganFilter = getDateFilter(period, 'h.tpk_tanggal');
        const lowonganWhere  = lowonganFilter.sql ? ` AND ${lowonganFilter.sql}` : '';
        const [lowongan] = await db.execute(
            `SELECT COUNT(*) as total
             FROM rekruitmen2.tpk_index_helper h
             INNER JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = h.tpk_nomor
             WHERE h.tpk_approveHRD = 1 ${lowonganWhere}`,
            lowonganFilter.params
        );


        // ── 3. PENDING APPROVAL (NEW & LEGACY) ──
        let pendingApproval = 0;
        let pendingLegacy = 0;

        if (is_hrd) {
            // [A] New Pending (Draft / Bisa diproses)
            const approvalFilter = getDateFilter(period, 'p.tpk_tanggal');
            const approvalWhere  = approvalFilter.sql ? ` AND ${approvalFilter.sql}` : '';
            const [hrdApprovals] = await db.execute(
                `SELECT COUNT(*) as total
                 FROM rekruitmen2.tpermintaan_draft p
                 LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
                 WHERE (
                    (p.tpk_approveatasan IN (1, 9) AND p.tpk_approveHRD = 0) 
                    OR 
                    (
                       ${RESOLVED_APPROVER_SQL_K} = ?
                       AND p.tpk_approveatasan = 0
                    )
                 ) ${approvalWhere}`,
                [user_kode, ...approvalFilter.params]
            );
            pendingApproval = hrdApprovals[0].total;

            // [B] Legacy Pending (Hanya read-only)
            const legacyApprovalFilter = getDateFilter(period, 'h.tpk_tanggal');
            const legacyApprovalWhere  = legacyApprovalFilter.sql ? ` AND ${legacyApprovalFilter.sql}` : '';
            const [hrdLegacyApprovals] = await db.execute(
                `SELECT COUNT(*) as total
                 FROM rekruitmen2.tpk_index_helper h
                 LEFT JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = h.tpk_nomor
                 LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = h.tpk_peminta
                 LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = h.tpk_nomor
                 WHERE (
                    (h.tpk_approveatasan IN (1, 9) AND h.tpk_approveHRD = 0)
                    OR
                    (
                       ${RESOLVED_APPROVER_SQL_K} = ?
                       AND h.tpk_approveatasan = 0
                    )
                 ) AND sla.sla_id IS NULL ${legacyApprovalWhere}`,
                [user_kode, ...legacyApprovalFilter.params]
            );
            pendingLegacy = hrdLegacyApprovals[0].total;

        } else {
            // [A] New Pending (Draft / Bisa diproses)
            const approvalFilter = getDateFilter(period, 'p.tpk_tanggal');
            const approvalWhere  = approvalFilter.sql ? ` AND ${approvalFilter.sql}` : '';
            const [approvals] = await db.execute(
                `SELECT COUNT(*) as total
                 FROM rekruitmen2.tpermintaan_draft p
                 LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
                 WHERE ${RESOLVED_APPROVER_SQL_K} = ?
                   AND p.tpk_approveatasan = 0
                   ${approvalWhere}`,
                [user_kode, ...approvalFilter.params]
            );
            pendingApproval = approvals[0].total;

            // [B] Legacy Pending (Hanya read-only)
            const legacyApprovalFilter = getDateFilter(period, 'h.tpk_tanggal');
            const legacyApprovalWhere  = legacyApprovalFilter.sql ? ` AND ${legacyApprovalFilter.sql}` : '';
            const [legacyApprovals] = await db.execute(
                `SELECT COUNT(*) as total
                 FROM rekruitmen2.tpk_index_helper h
                 LEFT JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = h.tpk_nomor
                 LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = h.tpk_peminta
                 LEFT JOIN rekruitmen2.t_recruitment_sla sla ON sla.sla_tpk_nomor = h.tpk_nomor
                 WHERE ${RESOLVED_APPROVER_SQL_K} = ?
                   AND h.tpk_approveatasan = 0
                   AND sla.sla_id IS NULL
                   ${legacyApprovalWhere}`,
                [user_kode, ...legacyApprovalFilter.params]
            );
            pendingLegacy = legacyApprovals[0].total;
        }


        // ── 4. SLA SUMMARY (Tidak ada masalah di sini) ──
        let slaStats = null;
        if (is_hrd) {
            const [sla] = await db.execute(`
                SELECT 
                    COUNT(*) as total_active,
                    SUM(CASE WHEN sla_status = 'CALCULATED' THEN 1 ELSE 0 END) as calculated,
                    SUM(CASE WHEN sla_status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN sla_is_editable = 1 THEN 1 ELSE 0 END) as need_user_update,
                    SUM(CASE WHEN sla_status = 'CALCULATED' AND CURDATE() > sla_max_target_date THEN 1 ELSE 0 END) as overdue
                FROM rekruitmen2.t_recruitment_sla
            `);
            slaStats = sla[0];
        }

        res.json({
            success: true,
            data: {
                totalPermintaan: Number(pkarCount) + Number(legacyCount),
                pkarCount:       Number(pkarCount),
                legacyCount:     Number(legacyCount),
                lowonganAktif:   Number(lowongan[0].total || 0),
                pendingApproval: Number(pendingApproval || 0),
                pendingLegacy:   Number(pendingLegacy || 0),

                ...(is_hrd && {
                    sla: {
                        total_active:     Number(slaStats.total_active   || 0),
                        calculated:       Number(slaStats.calculated      || 0),
                        completed:        Number(slaStats.completed       || 0),
                        need_user_update: Number(slaStats.need_user_update|| 0),
                        overdue:          Number(slaStats.overdue         || 0)
                    }
                }),

                user: { kode: user_kode, is_hrd: Number(is_hrd) }
            }
        });

    } catch (error) {
        console.error('❌ Dashboard stats error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil statistik dashboard', error: error.message });
    }
});

/**
 * GET /api/dashboard/recent-activities
 *
 * [OPTIMASI] Non-HRD: filter tpk_peminta via shadow table (idx_helper_peminta).
 */
router.get('/recent-activities', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;
    const limit = parseInt(req.query.limit) || 10;

    try {
        let activities = [];

        // Buat sub-query gabungan (Draft + Live) agar mudah di-join
        const combinedTpkQuery = `
            SELECT tpk_nomor, tpk_peminta, tpk_tanggal, tpk_approveHRD, tpk_approveatasan 
            FROM rekruitmen2.tpermintaan_draft
            UNION ALL
            SELECT tpk_nomor, tpk_peminta, tpk_tanggal, tpk_approveHRD, tpk_approveatasan 
            FROM hrd2.tpermintaankaryawan
        `;

        if (is_hrd) {
            const [recentRequests] = await db.execute(`
                SELECT 
                    'request' as type,
                    p.tpk_nomor as id,
                    p.tpk_peminta as actor,
                    k.kar_nama as actor_name,
                    DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d %H:%i:%s') as timestamp,
                    CASE 
                        WHEN p.tpk_approveHRD = 1 THEN 'approved_hrd'
                        WHEN p.tpk_approveatasan IN (1, 9) THEN 'approved_manager'
                        WHEN p.tpk_approveatasan = 2 THEN 'rejected_manager'
                        ELSE 'created'
                    END as action
                FROM (${combinedTpkQuery}) p
                LEFT JOIN hrd2.tkaryawan k ON k.kar_nik = p.tpk_peminta
                ORDER BY p.tpk_tanggal DESC
                LIMIT ?
            `, [limit]);
            activities = recentRequests;
        } else {
            const [myActivities] = await db.execute(`
                SELECT 
                    'my_request' as type,
                    h.tpk_nomor as id,
                    h.tpk_peminta as actor,
                    DATE_FORMAT(p.tpk_tanggal, '%Y-%m-%d %H:%i:%s') as timestamp,
                    CASE 
                        WHEN h.tpk_approveHRD = 1 THEN 'approved_hrd'
                        WHEN h.tpk_approveatasan IN (1, 9) THEN 'approved_manager'
                        WHEN h.tpk_approveatasan = 2 THEN 'rejected_manager'
                        ELSE 'pending'
                    END as action
                FROM rekruitmen2.tpk_index_helper h
                INNER JOIN (${combinedTpkQuery}) p ON p.tpk_nomor = h.tpk_nomor
                WHERE h.tpk_peminta = ?
                ORDER BY h.tpk_tanggal DESC
                LIMIT ?
            `, [user_kode, limit]);
            activities = myActivities;
        }

        res.json({ success: true, data: activities, count: activities.length });

    } catch (error) {
        console.error('❌ Recent activities error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil aktivitas terbaru', error: error.message });
    }
});

/**
 * GET /api/dashboard/charts-data
 *
 * [OPTIMASI] Filter via shadow table untuk approval stats.
 */
router.get('/charts-data', authenticate, async (req, res) => {
    const is_hrd = req.user.user_hrd;

    try {
        let chartsData = {};

        if (is_hrd) {
            // Monthly requests: perlu tpk_tanggal dari tpermintaankaryawan (shadow table juga punya)
            const [monthlyRequests] = await db.execute(`
                SELECT 
                    DATE_FORMAT(h.tpk_tanggal, '%Y-%m') as month,
                    COUNT(*) as total
                FROM rekruitmen2.tpk_index_helper h
                WHERE h.tpk_tanggal >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
                GROUP BY DATE_FORMAT(h.tpk_tanggal, '%Y-%m')
                ORDER BY month ASC
            `);

            // [OPTIMASI] Approval stats: filter via shadow table (idx_helper_approval)
            const [approvalStats] = await db.execute(`
                SELECT 
                    SUM(CASE WHEN h.tpk_approveatasan = 0 THEN 1 ELSE 0 END) as pending_manager,
                    SUM(CASE WHEN h.tpk_approveatasan = 9 AND h.tpk_approveHRD = 0 THEN 1 ELSE 0 END) as pending_hrd,
                    SUM(CASE WHEN h.tpk_approveHRD = 1 THEN 1 ELSE 0 END) as approved,
                    SUM(CASE WHEN h.tpk_approveatasan = 2 THEN 1 ELSE 0 END) as rejected
                FROM rekruitmen2.tpk_index_helper h
            `);

            const [slaSource] = await db.execute(`
                SELECT 
                    SUM(CASE WHEN sla_source = 'SYSTEM' THEN 1 ELSE 0 END) as system_adjusted,
                    SUM(CASE WHEN sla_source = 'USER' THEN 1 ELSE 0 END) as user_met,
                    SUM(CASE WHEN sla_source = 'FLEXIBLE' THEN 1 ELSE 0 END) as flexible
                FROM rekruitmen2.t_recruitment_sla
                WHERE sla_status IN ('CALCULATED', 'COMPLETED')
            `);

            chartsData = { monthlyRequests, approvalStats: approvalStats[0], slaSource: slaSource[0] };
        }

        res.json({ success: true, data: chartsData });

    } catch (error) {
        console.error('❌ Charts data error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data chart', error: error.message });
    }
});

/**
 * GET /api/dashboard/sla-analysis
 */
router.get('/sla-analysis', authenticate, isHRD, async (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = req.query.month ? parseInt(req.query.month) : null;

    try {
        let whereClause = 'WHERE YEAR(sla_request_created_at) = ? AND sla_status = "CALCULATED"';
        const params = [year];

        if (month) {
            whereClause += ' AND MONTH(sla_request_created_at) = ?';
            params.push(month);
        }

        const [rows] = await db.execute(`
            SELECT 
                COUNT(*) as total_requests,
                AVG(sla_approval_delay_days) as avg_approval_delay,
                SUM(CASE WHEN sla_source = 'SYSTEM' THEN 1 ELSE 0 END) as system_adjusted,
                SUM(CASE WHEN sla_source = 'USER' THEN 1 ELSE 0 END) as user_met,
                SUM(CASE WHEN sla_source = 'FLEXIBLE' THEN 1 ELSE 0 END) as flexible,
                AVG(sla_user_vs_system_diff_days) as avg_extension_days,
                MAX(sla_user_vs_system_diff_days) as max_extension_days
            FROM rekruitmen2.t_recruitment_sla
            ${whereClause}
        `, params);

        const data = rows[0];

        res.json({
            success: true,
            period: month ? `${year}-${String(month).padStart(2, '0')}` : year,
            data,
            analysis: {
                system_adjusted_percentage: data.total_requests > 0
                    ? ((data.system_adjusted / data.total_requests) * 100).toFixed(2) + '%'
                    : '0%',
                user_met_percentage: data.total_requests > 0
                    ? ((data.user_met / data.total_requests) * 100).toFixed(2) + '%'
                    : '0%',
                recommendation: data.system_adjusted > data.user_met
                    ? '⚠️ Banyak permintaan tidak realistis. Perlu edukasi user tentang lead time rekrutmen.'
                    : '✅ Mayoritas permintaan sudah realistis. User planning baik.',
                avg_approval_delay_interpretation: data.avg_approval_delay > 3
                    ? `⚠️ Atasan rata-rata delay ${Math.round(data.avg_approval_delay)} hari. Perlu percepatan approval.`
                    : '✅ Approval atasan cukup cepat.'
            }
        });

    } catch (error) {
        console.error('❌ Error SLA analysis:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/dashboard/sla-by-job
 */
router.get('/sla-by-job', authenticate, isHRD, async (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    try {
        const [rows] = await db.execute(`
            SELECT 
                sla_job_code,
                j.jab_nama,
                COUNT(*) as total_requests,
                AVG(sla_approval_delay_days) as avg_approval_delay,
                AVG(sla_user_vs_system_diff_days) as avg_extension,
                SUM(CASE WHEN sla_source = 'SYSTEM' THEN 1 ELSE 0 END) as system_count,
                SUM(CASE WHEN sla_source = 'USER' THEN 1 ELSE 0 END) as user_count
            FROM rekruitmen2.t_recruitment_sla sla
            LEFT JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
            WHERE YEAR(sla_request_created_at) = ? AND sla_status = 'CALCULATED'
            GROUP BY sla_job_code, j.jab_nama
            ORDER BY total_requests DESC
        `, [year]);

        res.json({ success: true, year, data: rows });

    } catch (error) {
        console.error('❌ Error SLA by job:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/dashboard/sla-performance
 */
router.get('/sla-performance', authenticate, isHRD, async (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = req.query.month ? parseInt(req.query.month) : null;

    try {
        let whereClause = 'WHERE YEAR(sla_request_created_at) = ? AND sla_status = "COMPLETED"';
        const params = [year];

        if (month) {
            whereClause += ' AND MONTH(sla_request_created_at) = ?';
            params.push(month);
        }

        const [rows] = await db.execute(`
            SELECT 
                COUNT(*) as total_completed,
                AVG(DATEDIFF(sla_calculated_at, sla_request_created_at)) as avg_days_to_approval,
                AVG(DATEDIFF(sla_completed_at, sla_calculated_at)) as avg_days_to_hire,
                AVG(DATEDIFF(sla_completed_at, sla_request_created_at)) as avg_total_days,
                AVG(DATEDIFF(sla_max_target_date, sla_completed_at)) as avg_vs_target,
                SUM(CASE WHEN sla_completed_at <= sla_max_target_date THEN 1 ELSE 0 END) as ontime_count,
                SUM(CASE WHEN sla_completed_at > sla_max_target_date THEN 1 ELSE 0 END) as late_count
            FROM rekruitmen2.t_recruitment_sla
            ${whereClause}
        `, params);

        const data = rows[0];
        const ontimePercentage = data.total_completed > 0
            ? ((data.ontime_count / data.total_completed) * 100).toFixed(2)
            : '0.00';

        res.json({
            success: true,
            period: month ? `${year}-${String(month).padStart(2, '0')}` : year,
            data,
            kpi: {
                ontime_percentage: ontimePercentage + '%',
                performance_rating:
                    ontimePercentage >= 90 ? '🏆 Excellent' :
                    ontimePercentage >= 75 ? '✅ Good' :
                    ontimePercentage >= 60 ? '⚠️ Needs Improvement' : '❌ Poor',
                avg_days_breakdown: {
                    approval_phase: Math.round(data.avg_days_to_approval) + ' hari',
                    hiring_phase: Math.round(data.avg_days_to_hire) + ' hari',
                    total: Math.round(data.avg_total_days) + ' hari'
                },
                vs_target: data.avg_vs_target >= 0
                    ? `✅ Lebih cepat ${Math.abs(Math.round(data.avg_vs_target))} hari dari target`
                    : `⚠️ Lebih lambat ${Math.abs(Math.round(data.avg_vs_target))} hari dari target`
            }
        });

    } catch (error) {
        console.error('❌ Error SLA performance:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/dashboard/hrd-kpi-report
 */
router.get('/hrd-kpi-report', authenticate, isHRD, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT 
                sla.sla_tpk_nomor,
                j.jab_nama,
                sla.sla_min_days,
                sla.sla_max_days,
                sla.sla_calculated_at,
                sla.sla_completed_at,
                sla.sla_no_show_buffer_days as buffer_noshow,
                p.tpk_jumlah as target_count,
                sla.sla_hired_count as hired_count
            FROM rekruitmen2.t_recruitment_sla sla
            JOIN hrd2.tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN hrd2.tjabatan j ON j.jab_kode = sla.sla_job_code
            WHERE sla.sla_status = 'COMPLETED'
        `);

        const processedData = rows.map(row => {
            const grossDays = countWorkdays(row.sla_calculated_at, row.sla_completed_at);
            const netDuration = Math.max(0, grossDays - row.buffer_noshow);
            
            let kpiStatus = 'DELAY';
            if (netDuration <= row.sla_min_days) kpiStatus = 'EXCELLENT';
            else if (netDuration <= row.sla_max_days) kpiStatus = 'GOOD';
            else if (netDuration <= (row.sla_max_days + (row.sla_max_days - row.sla_min_days))) kpiStatus = 'ACCEPTABLE';

            const score = netDuration <= row.sla_min_days 
                ? 100 
                : Math.max(0, 100 - (netDuration - row.sla_min_days) * 5);

            return { ...row, duration_calendar: grossDays, net_hrd_duration: netDuration, kpi_status: kpiStatus, score };
        });

        res.json({
            success: true,
            data: processedData,
            summary: {
                total_cases: processedData.length,
                on_time_rate: processedData.length > 0
                    ? ((processedData.filter(d => d.kpi_status === 'EXCELLENT' || d.kpi_status === 'GOOD').length / processedData.length) * 100).toFixed(2) + '%'
                    : '0%'
            }
        });

    } catch (error) {
        console.error('❌ HRD KPI Report error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/dashboard/sla-summary
 *
 * [OPTIMASI] Filter tpk_peminta via shadow table untuk non-HRD.
 */
router.get('/sla-summary', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;

    try {
        let whereClause, params;

        if (is_hrd) {
            whereClause = `WHERE sla.sla_status = 'CALCULATED'`;
            params = [];
        } else {
            // [OPTIMASI] Join shadow table untuk filter tpk_peminta (indexed)
            whereClause = `
                JOIN rekruitmen2.tpk_index_helper h ON h.tpk_nomor = sla.sla_tpk_nomor
                WHERE sla.sla_status = 'CALCULATED'
                  AND h.tpk_peminta = ?
            `;
            params = [user_kode];
        }

        const [rows] = await db.execute(`
            SELECT 
                COUNT(*) as total_active,
                SUM(CASE WHEN sla.sla_source = 'SYSTEM' THEN 1 ELSE 0 END) as system_adjusted,
                SUM(CASE WHEN sla.sla_source = 'USER' THEN 1 ELSE 0 END) as user_met,
                SUM(CASE WHEN sla.sla_is_editable = 1 THEN 1 ELSE 0 END) as pending_user_edit,
                AVG(DATEDIFF(sla.sla_max_target_date, CURDATE())) as avg_days_remaining
            FROM rekruitmen2.t_recruitment_sla sla
            ${whereClause}
        `, params);

        res.json({ success: true, data: rows[0] });

    } catch (error) {
        console.error('❌ Error SLA summary:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;