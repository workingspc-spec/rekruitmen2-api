// src/modules/dashboard.js
const express = require('express');
const db = require('../config/db');
const { authenticate, isHRD } = require('../middleware/authMiddleware');
const { countWorkdays } = require('../utils/workdayCalculator');
const router = express.Router();

/**
 * HELPER: Filter tanggal SQL (Parameterized)
 */
const getDateFilter = (period, dateColumn) => {
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
 * Statistik utama dashboard
 * - HRD: Lihat semua data global
 * - Manager/User: Lihat data personal
 */
router.get('/stats', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;
    const { period = 'All Time' } = req.query;

    const dateFilter = getDateFilter(period, 'tpk_tanggal');
    const wherePrefix = dateFilter.sql ? ` WHERE ${dateFilter.sql}` : '';

    try {
        // 1. TOTAL PERMINTAAN
        let permintaanQuery = `SELECT COUNT(*) as total FROM tpermintaankaryawan${wherePrefix}`;
        const permintaanParams = [...dateFilter.params];

        if (!is_hrd) {
            permintaanQuery += dateFilter.sql ? ' AND tpk_peminta = ?' : ' WHERE tpk_peminta = ?';
            permintaanParams.push(user_kode);
        }
        const [permintaan] = await db.execute(permintaanQuery, permintaanParams);

        // 2. LOWONGAN AKTIF (approved HRD)
        const lowonganFilter = getDateFilter(period, 'tpk_tanggal');
        let lowonganQuery = `SELECT COUNT(*) as total FROM tpermintaankaryawan WHERE tpk_approveHRD = 1`;
        if (lowonganFilter.sql) lowonganQuery += ` AND ${lowonganFilter.sql}`;
        const [lowongan] = await db.execute(lowonganQuery, lowonganFilter.params);

        // 3. PENDING APPROVAL
        let pendingApproval = 0;
        if (is_hrd) {
            const approvalFilter = getDateFilter(period, 'tpk_tanggal');
            let hrdApprovalQuery = `
                SELECT COUNT(*) as total FROM tpermintaankaryawan 
                WHERE tpk_approveatasan = 1 AND tpk_approveHRD = 0
            `;
            if (approvalFilter.sql) hrdApprovalQuery += ` AND ${approvalFilter.sql}`;
            const [hrdApprovals] = await db.execute(hrdApprovalQuery, approvalFilter.params);
            pendingApproval = hrdApprovals[0].total;
        } else {
            const approvalFilter = getDateFilter(period, 'tpk_tanggal');
            let appQuery = `
                SELECT COUNT(*) as total FROM tpermintaankaryawan p
                LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
                WHERE k.kar_nik_atasan = ? AND p.tpk_approveatasan = 0`;
            if (approvalFilter.sql) appQuery += ` AND ${approvalFilter.sql}`;
            const [approvals] = await db.execute(appQuery, [user_kode, ...approvalFilter.params]);
            pendingApproval = approvals[0].total;
        }

        // 4. SLA SUMMARY (khusus HRD)
        let slaStats = null;
        if (is_hrd) {
            const [sla] = await db.execute(`
                SELECT 
                    COUNT(*) as total_active,
                    SUM(CASE WHEN sla_status = 'CALCULATED' THEN 1 ELSE 0 END) as calculated,
                    SUM(CASE WHEN sla_status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN sla_is_editable = 1 THEN 1 ELSE 0 END) as need_user_update,
                    SUM(CASE WHEN sla_status = 'CALCULATED' AND CURDATE() > sla_max_target_date THEN 1 ELSE 0 END) as overdue /* DIPERBAIKI */
                FROM t_recruitment_sla
            `);
            slaStats = sla[0];
        }

        res.json({
            success: true,
            data: {
                totalPermintaan: Number(permintaan[0].total || 0),
                lowonganAktif: Number(lowongan[0].total || 0),
                pendingApproval: Number(pendingApproval || 0),

                ...(is_hrd && {
                    sla: {
                        total_active: Number(slaStats.total_active || 0),
                        calculated: Number(slaStats.calculated || 0),
                        completed: Number(slaStats.completed || 0),
                        need_user_update: Number(slaStats.need_user_update || 0),
                        overdue: Number(slaStats.overdue || 0)
                    }
                }),

                user: {
                    kode: user_kode,
                    is_hrd: Number(is_hrd)
                }
            }
        });

    } catch (error) {
        console.error('❌ Dashboard stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil statistik dashboard',
            error: error.message
        });
    }
});

/**
 * GET /api/dashboard/recent-activities
 * Aktivitas terbaru berdasarkan permintaan karyawan
 */
router.get('/recent-activities', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;
    const limit = parseInt(req.query.limit) || 10;

    try {
        let activities = [];

        if (is_hrd) {
            const [recentRequests] = await db.execute(`
                SELECT 
                    'request' as type,
                    tpk_nomor as id,
                    tpk_peminta as actor,
                    k.kar_nama as actor_name,
                    DATE_FORMAT(tpk_tanggal, '%Y-%m-%d %H:%i:%s') as timestamp,
                    CASE 
                        WHEN tpk_approveHRD = 1 THEN 'approved_hrd'
                        WHEN tpk_approveatasan = 1 THEN 'approved_manager'
                        WHEN tpk_approveatasan = 2 THEN 'rejected_manager'
                        ELSE 'created'
                    END as action
                FROM tpermintaankaryawan p
                LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
                ORDER BY tpk_tanggal DESC
                LIMIT ?
            `, [limit]);
            activities = recentRequests;
        } else {
            const [myActivities] = await db.execute(`
                SELECT 
                    'my_request' as type,
                    tpk_nomor as id,
                    tpk_peminta as actor,
                    DATE_FORMAT(tpk_tanggal, '%Y-%m-%d %H:%i:%s') as timestamp,
                    CASE 
                        WHEN tpk_approveHRD = 1 THEN 'approved_hrd'
                        WHEN tpk_approveatasan = 1 THEN 'approved_manager'
                        WHEN tpk_approveatasan = 2 THEN 'rejected_manager'
                        ELSE 'pending'
                    END as action
                FROM tpermintaankaryawan
                WHERE tpk_peminta = ?
                ORDER BY tpk_tanggal DESC
                LIMIT ?
            `, [user_kode, limit]);
            activities = myActivities;
        }

        res.json({
            success: true,
            data: activities,
            count: activities.length
        });

    } catch (error) {
        console.error('❌ Recent activities error:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil aktivitas terbaru',
            error: error.message
        });
    }
});

/**
 * GET /api/dashboard/charts-data
 * Data untuk charts
 */
router.get('/charts-data', authenticate, async (req, res) => {
    const is_hrd = req.user.user_hrd;

    try {
        let chartsData = {};

        if (is_hrd) {
            // CHART 1: Permintaan per Bulan (6 bulan terakhir)
            const [monthlyRequests] = await db.execute(`
                SELECT 
                    DATE_FORMAT(tpk_tanggal, '%Y-%m') as month,
                    COUNT(*) as total
                FROM tpermintaankaryawan
                WHERE tpk_tanggal >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
                GROUP BY DATE_FORMAT(tpk_tanggal, '%Y-%m')
                ORDER BY month ASC
            `);

            // CHART 2: Status Approval
            const [approvalStats] = await db.execute(`
                SELECT 
                    SUM(CASE WHEN tpk_approveatasan = 0 THEN 1 ELSE 0 END) as pending_manager,
                    SUM(CASE WHEN tpk_approveatasan = 1 AND tpk_approveHRD = 0 THEN 1 ELSE 0 END) as pending_hrd,
                    SUM(CASE WHEN tpk_approveHRD = 1 THEN 1 ELSE 0 END) as approved,
                    SUM(CASE WHEN tpk_approveatasan = 2 THEN 1 ELSE 0 END) as rejected
                FROM tpermintaankaryawan
            `);

            // CHART 3: SLA Source Distribution
            const [slaSource] = await db.execute(`
                SELECT 
                    SUM(CASE WHEN sla_source = 'SYSTEM' THEN 1 ELSE 0 END) as system_adjusted,
                    SUM(CASE WHEN sla_source = 'USER' THEN 1 ELSE 0 END) as user_met,
                    SUM(CASE WHEN sla_source = 'FLEXIBLE' THEN 1 ELSE 0 END) as flexible
                FROM t_recruitment_sla
                WHERE sla_status IN ('CALCULATED', 'COMPLETED')
            `);

            chartsData = {
                monthlyRequests,
                approvalStats: approvalStats[0],
                slaSource: slaSource[0]
            };
        }

        res.json({ success: true, data: chartsData });

    } catch (error) {
        console.error('❌ Charts data error:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data chart',
            error: error.message
        });
    }
});

/**
 * GET /api/dashboard/sla-analysis
 * Analisis SLA untuk evaluasi proses HRD vs User Planning
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
            FROM t_recruitment_sla
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
 * Breakdown SLA per jabatan
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
            FROM t_recruitment_sla sla
            LEFT JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
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
 * Mengukur kecepatan HRD menyelesaikan rekrutmen
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
            FROM t_recruitment_sla
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
 * Laporan detail performa HRD
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
            FROM t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            WHERE sla.sla_status = 'COMPLETED'
        `);

        // ✅ HITUNG MENGGUNAKAN HARI KERJA
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

            return {
                ...row,
                duration_calendar: grossDays, // Diganti jadi Workdays
                net_hrd_duration: netDuration,
                kpi_status: kpiStatus,
                score: score
            };
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
 * SLA summary untuk semua role
 *
 * ✅ FIX #6: Refactor whereClause agar tidak rapuh.
 * Sebelumnya: whereClause = '' (string kosong) saat is_hrd = true.
 * String kosong adalah falsy di JS, sehingga kondisi ternary
 * `${whereClause ? 'AND' : 'WHERE'}` kebetulan benar, tapi membingungkan dan rawan salah.
 * Sekarang menggunakan array conditions yang di-join secara eksplisit,
 * konsisten dengan pola di monitoring.js.
 */
router.get('/sla-summary', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;

    try {
        // ✅ FIX #6: Bangun conditions sebagai array, lalu join dengan AND.
        // Hasilnya selalu valid SQL tanpa bergantung pada kebetulan falsy/truthy string kosong.
        const conditions = [`sla.sla_status = 'CALCULATED'`];
        const params = [];

        if (!is_hrd) {
            conditions.push(`p.tpk_peminta = ?`);
            params.push(user_kode);
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        const [rows] = await db.execute(`
            SELECT 
                COUNT(*) as total_active,
                SUM(CASE WHEN sla.sla_source = 'SYSTEM' THEN 1 ELSE 0 END) as system_adjusted,
                SUM(CASE WHEN sla.sla_source = 'USER' THEN 1 ELSE 0 END) as user_met,
                SUM(CASE WHEN sla.sla_is_editable = 1 THEN 1 ELSE 0 END) as pending_user_edit,
                AVG(DATEDIFF(sla.sla_max_target_date, CURDATE())) as avg_days_remaining
            FROM tpermintaankaryawan p
            JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            ${whereClause}
        `, params);

        res.json({ success: true, data: rows[0] });

    } catch (error) {
        console.error('❌ Error SLA summary:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;