// src/modules/dashboard.js
const express = require('express');
const db = require('../config/db');
const { authenticate, isHRD } = require('../middleware/authMiddleware'); // ✅ TAMBAHKAN INI
const router = express.Router();

// Helper untuk menghasilkan filter tanggal SQL berdasarkan periode
const getDateFilter = (period, dateColumn) => {
    if (!period || period === 'All Time') return '';
    
    let condition = '';
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
            // Jika range kustom (format: YYYY-MM-DD,YYYY-MM-DD)
            if (period.includes(',')) {
                const [start, end] = period.split(',');
                condition = `${dateColumn} BETWEEN '${start}' AND '${end}'`;
            } else {
                return '';
            }
    }
    return condition;
};
/**
 * =====================================================================
 * MODULE: DASHBOARD
 * Statistik dan ringkasan untuk dashboard aplikasi
 * =====================================================================
 */

/**
 * GET /api/dashboard/stats
 * Statistik utama dashboard
 * - HRD: Lihat semua data global
 * - Manager/User: Lihat data personal
 */
router.get('/stats', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;
    const { period = 'All Time' } = req.query; // Ambil parameter period
    
    const dateFilter = getDateFilter(period, 'tpk_tanggal');
    const wherePrefix = dateFilter ? ` WHERE ${dateFilter}` : '';

    try {
        // 1. TOTAL PERMINTAAN (dengan filter tanggal)
        let permintaanQuery = `SELECT COUNT(*) as total FROM tpermintaankaryawan${wherePrefix}`;
        const permintaanParams = [];
        
        if (!is_hrd) {
            permintaanQuery += dateFilter ? ' AND tpk_peminta = ?' : ' WHERE tpk_peminta = ?';
            permintaanParams.push(user_kode);
        }
        const [permintaan] = await db.execute(permintaanQuery, permintaanParams);

        // 2. TOTAL PELAMAR (Tanpa filter tanggal karena Bank Data biasanya bersifat akumulatif)
        const [applicants] = await db.execute('SELECT COUNT(*) as total FROM t_applicant WHERE status_applicant != "HIRED"');
        const [rekruitmen] = await db.execute('SELECT COUNT(*) as total FROM trekruitmen WHERE rkt_status <> 1');
        const totalPelamar = applicants[0].total + rekruitmen[0].total;

        // 3. LOWONGAN AKTIF (Filter tanggal berdasarkan kapan permintaan disetujui HRD)
        const lowonganFilter = getDateFilter(period, 'tpk_tanggal');
        const lowonganQuery = `SELECT COUNT(*) as total FROM tpermintaankaryawan WHERE tpk_approveHRD = 1${lowonganFilter ? ` AND ${lowonganFilter}` : ''}`;
        const [lowongan] = await db.execute(lowonganQuery);

        // 4. KARYAWAN (Hanya HRD)
        const [employees] = await db.execute(`SELECT COUNT(*) as total, SUM(CASE WHEN kar_status_aktif = 1 THEN 1 ELSE 0 END) as aktif FROM tkaryawan`);

        // 5. APPROVAL STATUS
        let pendingApproval = 0;
        if (!is_hrd) {
            const approvalFilter = getDateFilter(period, 'tpk_tanggal');
            const [approvals] = await db.execute(`
                SELECT COUNT(*) as total FROM tpermintaankaryawan p
                LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
                WHERE k.kar_nik_atasan = ? AND p.tpk_approveatasan = 0${approvalFilter ? ` AND ${approvalFilter}` : ''}
            `, [user_kode]);
            pendingApproval = approvals[0].total;
        }

        // ========== 6. HRD SPECIFIC STATS (Shortlist, Evaluasi, Pelatihan, Onboarding) ==========
        let shortlistStats = null;
        let evaluasiStats = null;
        let pelatihanStats = null;
        let onboardingStats = null;

        if (is_hrd) {
            // A. Shortlist Progress
            const [shortlist] = await db.execute(`
                SELECT 
                    COUNT(*) as total_shortlist,
                    SUM(CASE WHEN tlp_status = 1 THEN 1 ELSE 0 END) as verified,
                    SUM(CASE WHEN statusterakhir = 0 THEN 1 ELSE 0 END) as pending_decision,
                    SUM(CASE WHEN statusterakhir = 1 THEN 1 ELSE 0 END) as hired
                FROM tlistpelamar
            `);
            shortlistStats = shortlist[0];

            // B. Stats Evaluasi (NEW)
            const [evaluasi] = await db.execute(`
                SELECT 
                    COUNT(*) as total_evaluasi,
                    SUM(CASE WHEN eval_jenis = 'TES' THEN 1 ELSE 0 END) as tes,
                    SUM(CASE WHEN eval_jenis = 'INTERVIEW_USER' THEN 1 ELSE 0 END) as interview_user,
                    SUM(CASE WHEN eval_jenis = 'INTERVIEW_HRD' THEN 1 ELSE 0 END) as interview_hrd,
                    SUM(CASE WHEN eval_status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN eval_status = 'NO_SHOW' THEN 1 ELSE 0 END) as no_show
                FROM t_evaluasi
            `);
            evaluasiStats = evaluasi[0];

            // C. Stats Pelatihan (NEW)
            const [pelatihan] = await db.execute(`
                SELECT 
                    COUNT(*) as total_pelatihan,
                    SUM(CASE WHEN pel_status = 'ONGOING' THEN 1 ELSE 0 END) as ongoing,
                    SUM(CASE WHEN pel_status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN pel_status = 'FAILED' THEN 1 ELSE 0 END) as failed
                FROM t_pelatihan
            `);
            pelatihanStats = pelatihan[0];

            // D. Stats Onboarding (NEW)
            const [onboarding] = await db.execute(`
                SELECT 
                    COUNT(*) as total_onboarding,
                    SUM(CASE WHEN onb_status = 'ONGOING' THEN 1 ELSE 0 END) as ongoing,
                    SUM(CASE WHEN onb_status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN onb_status = 'NO_SHOW' THEN 1 ELSE 0 END) as no_show
                FROM t_onboarding
            `);
            onboardingStats = onboarding[0];
        }

        // ========== RESPONSE ==========
        res.json({
            success: true,
            data: {
                // Stats untuk semua role
                totalPermintaan: permintaan[0].total,
                totalPelamar: totalPelamar,
                lowonganAktif: lowongan[0].total,
                totalKaryawan: employees[0].total,
                pendingApproval: pendingApproval,
                user: { kode: user_kode, is_hrd: is_hrd },
                karyawanAktif: employees[0].aktif,
                karyawanTidakAktif: employees[0].tidak_aktif,
                
                // Stats khusus Manager
                ...((!is_hrd && pendingApproval > 0) && {
                    pendingApproval: pendingApproval
                }),
                
                // Stats khusus HRD
                ...(is_hrd && {
                    shortlist: shortlistStats,
                    evaluasi: evaluasiStats,
                    pelatihan: pelatihanStats,
                    onboarding: onboardingStats
                }),
                
                // User info
                user: {
                    kode: user_kode,
                    is_hrd: is_hrd
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
 * Aktivitas terbaru (opsional - untuk fitur timeline)
 */
router.get('/recent-activities', async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;
    const { limit = 10 } = req.query;

    try {
        let activities = [];

        if (is_hrd) {
            // HRD: Lihat semua aktivitas terbaru
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
                        ELSE 'created'
                    END as action
                FROM tpermintaankaryawan p
                LEFT JOIN tkaryawan k ON k.kar_nik = p.tpk_peminta
                ORDER BY tpk_tanggal DESC
                LIMIT ?
            `, [parseInt(limit)]);

            activities = recentRequests;

        } else {
            // Manager: Lihat permintaan sendiri & approval requests
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
            `, [user_kode, parseInt(limit)]);

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
 * Data untuk charts (opsional - untuk visualisasi)
 */
router.get('/charts-data', async (req, res) => {
    const is_hrd = req.user.user_hrd;

    try {
        let chartsData = {};

        if (is_hrd) {
            // ========== CHART 1: Permintaan per Bulan (6 bulan terakhir) ==========
            const [monthlyRequests] = await db.execute(`
                SELECT 
                    DATE_FORMAT(tpk_tanggal, '%Y-%m') as month,
                    COUNT(*) as total
                FROM tpermintaankaryawan
                WHERE tpk_tanggal >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
                GROUP BY DATE_FORMAT(tpk_tanggal, '%Y-%m')
                ORDER BY month ASC
            `);

            // ========== CHART 2: Status Approval ==========
            const [approvalStats] = await db.execute(`
                SELECT 
                    SUM(CASE WHEN tpk_approveatasan = 0 THEN 1 ELSE 0 END) as pending_manager,
                    SUM(CASE WHEN tpk_approveatasan = 1 AND tpk_approveHRD = 0 THEN 1 ELSE 0 END) as pending_hrd,
                    SUM(CASE WHEN tpk_approveHRD = 1 THEN 1 ELSE 0 END) as approved,
                    SUM(CASE WHEN tpk_approveatasan = 2 THEN 1 ELSE 0 END) as rejected
                FROM tpermintaankaryawan
            `);

            // ========== CHART 3: Karyawan per Status Kerja ==========
            const [employeeStatus] = await db.execute(`
                SELECT 
                    SUM(CASE WHEN kar_status_kerja = 0 THEN 1 ELSE 0 END) as harian,
                    SUM(CASE WHEN kar_status_kerja = 1 THEN 1 ELSE 0 END) as pkwt,
                    SUM(CASE WHEN kar_status_kerja = 2 THEN 1 ELSE 0 END) as pkwtt
                FROM tkaryawan
                WHERE kar_status_aktif = 1
            `);

            chartsData = {
                monthlyRequests: monthlyRequests,
                approvalStats: approvalStats[0],
                employeeStatus: employeeStatus[0]
            };
        }

        res.json({
            success: true,
            data: chartsData
        });

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
router.get('/sla-analysis', isHRD, async (req, res) => {
    const { year = new Date().getFullYear(), month } = req.query;

    try {
        let whereClause = 'WHERE YEAR(sla_request_created_at) = ? AND sla_status = "CALCULATED"';
        const params = [year];

        if (month) {
            whereClause += ' AND MONTH(sla_request_created_at) = ?';
            params.push(month);
        }

        const sql = `
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
        `;

        const [rows] = await db.execute(sql, params);
        const data = rows[0];

        res.json({
            success: true,
            period: month ? `${year}-${String(month).padStart(2, '0')}` : year,
            data: data,
            analysis: {
                system_adjusted_percentage: ((data.system_adjusted / data.total_requests) * 100).toFixed(2) + '%',
                user_met_percentage: ((data.user_met / data.total_requests) * 100).toFixed(2) + '%',
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
router.get('/sla-by-job', isHRD, async (req, res) => {
    const { year = new Date().getFullYear() } = req.query;

    try {
        const sql = `
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
        `;

        const [rows] = await db.execute(sql, [year]);

        res.json({
            success: true,
            year: year,
            data: rows
        });

    } catch (error) {
        console.error('❌ Error SLA by job:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});
/**
 * GET /api/dashboard/sla-performance
 * Mengukur kecepatan HRD dalam menyelesaikan rekrutmen
 */
router.get('/sla-performance', isHRD, async (req, res) => {
    const { year = new Date().getFullYear(), month } = req.query;

    try {
        let whereClause = 'WHERE YEAR(sla_request_created_at) = ? AND sla_status = "COMPLETED"';
        const params = [year];

        if (month) {
            whereClause += ' AND MONTH(sla_request_created_at) = ?';
            params.push(month);
        }

        const sql = `
            SELECT 
                COUNT(*) as total_completed,
                
                -- Waktu dari request ke approval
                AVG(DATEDIFF(sla_calculated_at, sla_request_created_at)) as avg_days_to_approval,
                
                -- Waktu dari approval ke hire
                AVG(DATEDIFF(sla_completed_at, sla_calculated_at)) as avg_days_to_hire,
                
                -- Total waktu end-to-end
                AVG(DATEDIFF(sla_completed_at, sla_request_created_at)) as avg_total_days,
                
                -- Perbandingan dengan target
                AVG(DATEDIFF(sla_final_target_date, sla_completed_at)) as avg_vs_target,
                
                -- Persentase on-time
                SUM(CASE WHEN sla_completed_at <= sla_final_target_date THEN 1 ELSE 0 END) as ontime_count,
                SUM(CASE WHEN sla_completed_at > sla_final_target_date THEN 1 ELSE 0 END) as late_count
                
            FROM t_recruitment_sla
            ${whereClause}
        `;

        const [rows] = await db.execute(sql, params);
        const data = rows[0];

        const ontimePercentage = ((data.ontime_count / data.total_completed) * 100).toFixed(2);

        res.json({
            success: true,
            period: month ? `${year}-${String(month).padStart(2, '0')}` : year,
            data: data,
            kpi: {
                ontime_percentage: ontimePercentage + '%',
                performance_rating: ontimePercentage >= 90 ? '🏆 Excellent' :
                                   ontimePercentage >= 75 ? '✅ Good' :
                                   ontimePercentage >= 60 ? '⚠️ Needs Improvement' :
                                   '❌ Poor',
                avg_days_breakdown: {
                    approval_phase: Math.round(data.avg_days_to_approval) + ' hari',
                    hiring_phase: Math.round(data.avg_days_to_hire) + ' hari',
                    total: Math.round(data.avg_total_days) + ' hari'
                },
                vs_target: data.avg_vs_target > 0 
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
 * Laporan detail performa HRD (Khusus HRD)
 */
router.get('/hrd-kpi-report', authenticate, isHRD, async (req, res) => {
    try {
        const sql = `
            SELECT 
                sla.sla_tpk_nomor,
                j.jab_nama,
                sla.sla_min_days,
                DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) as duration_calendar,
                sla.sla_no_show_buffer_days as buffer_noshow,
                (DATEDIFF(sla.sla_completed_at, sla.sla_calculated_at) - sla.sla_no_show_buffer_days) as net_hrd_duration,
                CONCAT(
                    (SELECT COUNT(*) FROM tlistpelamar WHERE tlp_tpk_nomor = sla.sla_tpk_nomor AND statusterakhir = 1),
                    '/',
                    p.tpk_jumlah
                ) as fulfillment
            FROM t_recruitment_sla sla
            JOIN tpermintaankaryawan p ON p.tpk_nomor = sla.sla_tpk_nomor
            JOIN tjabatan j ON j.jab_kode = sla.sla_job_code
            WHERE sla.sla_status = 'COMPLETED'
        `;

        const [rows] = await db.execute(sql);

        // Menambah logika klasifikasi di tingkat aplikasi
        const processedData = rows.map(row => ({
            ...row,
            kpi_status: row.net_hrd_duration <= row.sla_min_days ? 'EXCELLENT' : 'DELAY',
            score: row.net_hrd_duration <= row.sla_min_days ? 100 : Math.max(0, 100 - (row.net_hrd_duration - row.sla_min_days) * 5)
        }));

        res.json({
            success: true,
            data: processedData,
            summary: {
                total_cases: processedData.length,
                on_time_rate: (processedData.filter(d => d.kpi_status === 'EXCELLENT').length / processedData.length * 100).toFixed(2) + '%'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/dashboard/sla-summary
 * SLA summary untuk dashboard (semua role)
 */
router.get('/sla-summary', authenticate, async (req, res) => {
    const user_kode = req.user.user_kode;
    const is_hrd = req.user.user_hrd;

    try {
        const whereClause = is_hrd ? '' : 'WHERE p.tpk_peminta = ?';
        const params = is_hrd ? [] : [user_kode];

        const sql = `
            SELECT 
                COUNT(*) as total_active,
                SUM(CASE WHEN sla.sla_source = 'SYSTEM' THEN 1 ELSE 0 END) as system_adjusted,
                SUM(CASE WHEN sla.sla_source = 'USER' THEN 1 ELSE 0 END) as user_met,
                SUM(CASE WHEN sla.sla_is_editable = 1 THEN 1 ELSE 0 END) as pending_user_edit,
                AVG(DATEDIFF(sla.sla_final_target_date, CURDATE())) as avg_days_remaining
            FROM tpermintaankaryawan p
            JOIN t_recruitment_sla sla ON sla.sla_tpk_nomor = p.tpk_nomor
            ${whereClause}
            AND sla.sla_status = 'CALCULATED'
        `;

        const [rows] = await db.execute(sql, params);

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error('❌ Error SLA summary:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
