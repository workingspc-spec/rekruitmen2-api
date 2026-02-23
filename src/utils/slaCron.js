const cron = require('node-cron');
const db = require('../config/db');

/**
 * LOGIKA SINKRONISASI SLA (BACKGROUND TASK)
 * Berjalan setiap 5 menit.
 * Mengambil data dari tlistpelamar (Federated) dan update ke t_recruitment_sla (Lokal)
 */
const runSlaSync = async () => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Sinkronisasi hired_count
        await connection.execute(`
            UPDATE t_recruitment_sla sla
            SET sla.sla_hired_count = (
                SELECT COUNT(*) 
                FROM tlistpelamar tlp 
                WHERE tlp.tlp_tpk_nomor = sla.sla_tpk_nomor 
                AND tlp.statusterakhir = 1
            )
            WHERE sla.sla_status IN ('PENDING', 'CALCULATED')
        `);

        // 2. Auto-complete jika target terpenuhi
        await connection.execute(`
            UPDATE t_recruitment_sla sla
            JOIN tpermintaankaryawan tpk ON sla.sla_tpk_nomor = tpk.tpk_nomor
            SET 
                sla.sla_status = 'COMPLETED',
                sla.sla_completed_at = NOW(),
                sla.sla_notes = CONCAT(COALESCE(sla_notes,''), '\n[', NOW(), '] System: Sync completed.')
            WHERE sla.sla_hired_count >= tpk.tpk_jumlah 
            AND sla.sla_status = 'CALCULATED'
        `);

        await connection.commit();
        console.log(`[${new Date().toLocaleString()}] SLA Sync Success`);
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('SLA Sync Error:', error.message);
    } finally {
        if (connection) connection.release();
    }
};

// Atur jadwal setiap 5 menit
cron.schedule('*/5 * * * *', runSlaSync);

module.exports = { runSlaSync };