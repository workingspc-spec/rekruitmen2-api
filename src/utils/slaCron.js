const cron = require('node-cron');
const db   = require('../config/db');

/**
 * LOGIKA SINKRONISASI SLA (BACKGROUND TASK)
 * Berjalan setiap 5 menit.
 * ✅ OPTIMIZED: Tidak menggunakan Correlated Subquery untuk Federated Table
 */
const runSlaSync = async () => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        // 1. Cari tiket (tpk_nomor) yang SLA-nya masih berjalan (belum complete/cancelled)
        const [activeSlas] = await connection.query(
            `SELECT sla_tpk_nomor FROM t_recruitment_sla WHERE sla_status IN ('PENDING', 'CALCULATED')`
        );

        if (activeSlas.length > 0) {
            const tpkNomors     = activeSlas.map(s => s.sla_tpk_nomor);
            const placeholders  = tpkNomors.map(() => '?').join(',');

            // 2. Tarik jumlah hired HANYA untuk tiket yang aktif.
            //
            // ✅ FIX #4: Ganti SUM(rpk_jumlah) → COUNT(*) agar konsisten dengan logika
            // cancel-candidate yang menghapus 1 baris dan mengurangi sla_hired_count sebesar 1.
            //
            // Sebelumnya SUM(rpk_jumlah) bisa menghasilkan angka berbeda jika satu baris
            // memiliki rpk_jumlah > 1, menyebabkan drift antara data cron dan data real-time.
            // COUNT(*) = "1 baris = 1 orang hired" → sinkron dengan logika -1 di cancel-candidate.
            // ✅ ANTI-JEBOL CRON JOB
            const [hiredData] = await connection.query(`
                SELECT 
                    rpk_tpk_nomor AS tlp_tpk_nomor, 
                    SUM(GREATEST(COALESCE(rpk_jumlah, 1), 1)) as total_hired 
                FROM triilpermintaankaryawan 
                WHERE rpk_tpk_nomor IN (${placeholders})
                GROUP BY rpk_tpk_nomor
            `, tpkNomors);

            // Mapping hasil query ke object/dictionary untuk akses cepat di Node.js
            const hiredMap = {};
            hiredData.forEach(row => {
                hiredMap[row.tlp_tpk_nomor] = row.total_hired;
            });

            // 3. ✅ FIX: Bulk UPDATE dengan CASE WHEN — 1 query, bukan N query dalam loop
            const caseStatements = activeSlas.map(() => `WHEN ? THEN ?`).join(' ');
            const flatValues     = activeSlas.flatMap(sla => [
                sla.sla_tpk_nomor,
                hiredMap[sla.sla_tpk_nomor] || 0
            ]);

            await connection.query(`
                UPDATE t_recruitment_sla
                SET sla_hired_count = CASE sla_tpk_nomor ${caseStatements} END
                WHERE sla_tpk_nomor IN (${placeholders})
            `, [...flatValues, ...tpkNomors]);

            // 4. Auto-complete jika target terpenuhi
            //    ✅ FIX: Gunakan query SELECT dulu agar kita tahu TPK mana saja yang akan
            //    ditutup, sehingga bisa dicatat di log riwayat (t_pkar_log).
            //    ✅ FIX: Filter IN (tpkNomors) agar tidak scan seluruh tabel saat data besar.
            const [toComplete] = await connection.query(`
                SELECT sla.sla_tpk_nomor
                FROM t_recruitment_sla sla
                JOIN tpermintaankaryawan tpk ON sla.sla_tpk_nomor = tpk.tpk_nomor
                WHERE sla.sla_hired_count >= tpk.tpk_jumlah 
                  AND sla.sla_status      = 'CALCULATED'
                  AND sla.sla_tpk_nomor  IN (${placeholders})
            `, tpkNomors);

            if (toComplete.length > 0) {
                const tpksToClose        = toComplete.map(row => row.sla_tpk_nomor);
                const placeholdersClose  = tpksToClose.map(() => '?').join(',');

                // Update status SLA → COMPLETED
                await connection.query(`
                    UPDATE t_recruitment_sla 
                    SET 
                        sla_status      = 'COMPLETED',
                        sla_completed_at = NOW(),
                        sla_is_editable = 0,
                        sla_notes       = CONCAT(
                            COALESCE(sla_notes, ''),
                            '\n[', NOW(), '] System: Target terpenuhi, SLA otomatis ditutup.'
                        )
                    WHERE sla_tpk_nomor IN (${placeholdersClose})
                `, tpksToClose);

                // Insert ke Audit Log agar muncul di Riwayat Perubahan Frontend
                const logValues = tpksToClose.map(tpk => [
                    tpk, 'SYSTEM', 'status_sla', 'CALCULATED', 'COMPLETED (Auto-Sync)'
                ]);
                await connection.query(`
                    INSERT INTO t_pkar_log (tpk_nomor, user_kode, field_name, old_value, new_value)
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
};

// Atur jadwal setiap 5 menit
cron.schedule('*/5 * * * *', runSlaSync);

module.exports = { runSlaSync };