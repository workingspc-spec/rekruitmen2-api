const cron = require('node-cron');
const db   = require('../config/db');
const { fullSync: syncIndexHelper } = require('./tpkIndexSync'); // [BARU]

const runSlaSync = async () => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [activeSlas] = await connection.query(
            `SELECT sla_tpk_nomor FROM rekruitmen2.t_recruitment_sla WHERE sla_status IN ('PENDING', 'CALCULATED')`
        );

        if (activeSlas.length > 0) {
            const tpkNomors    = activeSlas.map(s => s.sla_tpk_nomor);
            const placeholders = tpkNomors.map(() => '?').join(',');

            const [hiredData] = await connection.query(`
                SELECT 
                    rpk_tpk_nomor AS tlp_tpk_nomor, 
                    SUM(GREATEST(COALESCE(rpk_jumlah, 1), 1)) as total_hired 
                FROM triilpermintaankaryawan 
                WHERE rpk_tpk_nomor IN (${placeholders})
                GROUP BY rpk_tpk_nomor
            `, tpkNomors);

            const hiredMap = {};
            hiredData.forEach(row => {
                hiredMap[row.tlp_tpk_nomor] = row.total_hired;
            });

            const caseStatements = activeSlas.map(() => `WHEN ? THEN ?`).join(' ');
            const flatValues     = activeSlas.flatMap(sla => [
                sla.sla_tpk_nomor,
                hiredMap[sla.sla_tpk_nomor] || 0
            ]);

            await connection.query(`
                UPDATE rekruitmen2.t_recruitment_sla
                SET sla_hired_count = CASE sla_tpk_nomor ${caseStatements} END
                WHERE sla_tpk_nomor IN (${placeholders})
            `, [...flatValues, ...tpkNomors]);

            const [toComplete] = await connection.query(`
                SELECT sla.sla_tpk_nomor, sla.sla_id
                FROM rekruitmen2.t_recruitment_sla sla
                JOIN hrd2.tpermintaankaryawan tpk ON sla.sla_tpk_nomor = tpk.tpk_nomor
                WHERE sla.sla_hired_count >= tpk.tpk_jumlah 
                  AND sla.sla_status      = 'CALCULATED'
                  AND sla.sla_tpk_nomor  IN (${placeholders})
            `, tpkNomors);

            if (toComplete.length > 0) {
                const tpksToClose       = toComplete.map(row => row.sla_tpk_nomor);
                const placeholdersClose = tpksToClose.map(() => '?').join(',');

                await connection.query(`
                    UPDATE rekruitmen2.t_recruitment_sla 
                    SET 
                        sla_status       = 'COMPLETED',
                        sla_completed_at = NOW(),
                        sla_is_editable  = 0,
                        sla_notes        = CONCAT(
                            COALESCE(sla_notes, ''),
                            '\n[', NOW(), '] System: Target terpenuhi, SLA otomatis ditutup.'
                        )
                    WHERE sla_tpk_nomor IN (${placeholdersClose})
                `, tpksToClose);

                const logValues = toComplete.map(row => [
                    row.sla_tpk_nomor,
                    row.sla_id,
                    'SYSTEM',
                    'status_sla',
                    'CALCULATED',
                    'COMPLETED (Auto-Sync)'
                ]);

                await connection.query(`
                    INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value)
                    VALUES ?
                `, [logValues]);
            }
        }

        await connection.commit();
        console.log(
            `[${new Date().toLocaleString()}] SLA Sync Success.`,
            `Validated ${activeSlas.length} active requests.`
        );

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('SLA Sync Error:', error.message);
    } finally {
        if (connection) connection.release();
    }

    // ── [BARU] Sync shadow index table setelah SLA sync ──────────────────────
    // fullSync menggunakan pool (bukan connection) — tidak konflik dengan transaksi di atas.
    // Tujuan: menangkap perubahan approval_status dari aplikasi desktop legacy
    //         yang tidak melewati backend baru ini.
    try {
        await syncIndexHelper(db);
    } catch (syncErr) {
        // Silent fail — jangan hentikan cron karena shadow sync gagal
        console.warn('[tpkIndexSync] Periodic sync error (non-fatal):', syncErr.message);
    }
};

cron.schedule('*/5 * * * *', runSlaSync);

module.exports = { runSlaSync };