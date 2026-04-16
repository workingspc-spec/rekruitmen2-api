/**
 * src/utils/tpkIndexSync.js
 *
 * Utilitas sinkronisasi shadow table rekruitmen2.tpk_index_helper.
 *
 * Shadow table ini menyimpan kolom-kolom yang paling sering digunakan sebagai
 * WHERE / ORDER-BY dari hrd2.tpermintaankaryawan, agar aplikasi baru dapat
 * melakukan indexed lookup tanpa menyentuh skema legacy hrd2.
 *
 * Pola penggunaan:
 *   - upsertRow()  → dipanggil di dalam transaksi saat INSERT/UPDATE baru
 *   - updateApproval() → dipanggil saat status approval berubah
 *   - deleteRow()  → dipanggil saat batch delete
 *   - deleteRows() → dipanggil saat batch delete banyak nomor
 *   - fullSync()   → dipanggil saat startup dan oleh slaCron setiap 5 menit
 */

// ── SQL Templates ─────────────────────────────────────────────────────────────

const UPSERT_SQL = `
    INSERT INTO rekruitmen2.tpk_index_helper
        (tpk_nomor, tpk_peminta, tpk_approveatasan, tpk_approveHRD, tpk_tanggal)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        tpk_peminta       = VALUES(tpk_peminta),
        tpk_approveatasan = VALUES(tpk_approveatasan),
        tpk_approveHRD    = VALUES(tpk_approveHRD),
        tpk_tanggal       = VALUES(tpk_tanggal),
        synced_at         = NOW()
`;

const UPDATE_APPROVAL_SQL = `
    UPDATE rekruitmen2.tpk_index_helper
    SET   tpk_approveatasan = ?,
          tpk_approveHRD    = ?,
          synced_at         = NOW()
    WHERE tpk_nomor = ?
`;

const DELETE_ONE_SQL = `
    DELETE FROM rekruitmen2.tpk_index_helper WHERE tpk_nomor = ?
`;

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Upsert satu shadow row (dipakai saat INSERT permintaan baru).
 *
 * @param {import('mysql2/promise').Connection|import('mysql2/promise').Pool} conn
 * @param {{ tpk_nomor: string, tpk_peminta: string,
 *            tpk_approveatasan?: number, tpk_approveHRD?: number,
 *            tpk_tanggal?: string|null }} row
 */
async function upsertRow(conn, {
    tpk_nomor,
    tpk_peminta,
    tpk_approveatasan = 0,
    tpk_approveHRD    = 0,
    tpk_tanggal       = null,
}) {
    await conn.execute(UPSERT_SQL, [
        tpk_nomor,
        tpk_peminta ?? null,
        tpk_approveatasan,
        tpk_approveHRD,
        tpk_tanggal ?? null,
    ]);
}

/**
 * Update kolom approval saja — tanpa mengubah tpk_peminta & tpk_tanggal.
 * Dipakai saat atasan atau HRD melakukan APPROVE/REJECT.
 *
 * @param {import('mysql2/promise').Connection} conn
 * @param {string} tpk_nomor
 * @param {number} tpk_approveatasan
 * @param {number} tpk_approveHRD
 */
async function updateApproval(conn, tpk_nomor, tpk_approveatasan, tpk_approveHRD) {
    await conn.execute(UPDATE_APPROVAL_SQL, [
        tpk_approveatasan,
        tpk_approveHRD,
        tpk_nomor,
    ]);
}

/**
 * Hapus satu shadow row (jarang dipakai; ada deleteRows untuk batch).
 *
 * @param {import('mysql2/promise').Connection} conn
 * @param {string} tpk_nomor
 */
async function deleteRow(conn, tpk_nomor) {
    await conn.execute(DELETE_ONE_SQL, [tpk_nomor]);
}

/**
 * Hapus banyak shadow row sekaligus (dipakai saat batch delete permintaan).
 *
 * @param {import('mysql2/promise').Connection} conn
 * @param {string[]} tpkNomors
 */
async function deleteRows(conn, tpkNomors) {
    if (!tpkNomors?.length) return;
    const placeholders = tpkNomors.map(() => '?').join(',');
    await conn.execute(
        `DELETE FROM rekruitmen2.tpk_index_helper WHERE tpk_nomor IN (${placeholders})`,
        tpkNomors
    );
}

/**
 * Full resync: tarik semua baris dari hrd2.tpermintaankaryawan lalu bulk-upsert
 * ke shadow table dalam chunk 500 baris.
 *
 * Dipanggil saat:
 *   - Server start (app.js)
 *   - Setiap 5 menit oleh slaCron (untuk menangkap perubahan dari aplikasi legacy)
 *
 * @param {import('mysql2/promise').Pool} db – pool dari config/db.js
 */
async function fullSync(db) {
    const start = Date.now();

    const [rows] = await db.execute(`
        SELECT
            tpk_nomor,
            TRIM(tpk_peminta)                AS tpk_peminta,
            COALESCE(tpk_approveatasan, 0)   AS tpk_approveatasan,
            COALESCE(tpk_approveHRD,   0)    AS tpk_approveHRD,
            DATE(tpk_tanggal)                AS tpk_tanggal
        FROM hrd2.tpermintaankaryawan
    `);

    if (!rows.length) {
        console.log('[tpkIndexSync] fullSync: tidak ada data untuk di-sync.');
        return;
    }

    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk       = rows.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?,?,?,?,?)').join(',');
        const values = chunk.flatMap(r => [
            r.tpk_nomor,
            r.tpk_peminta,
            r.tpk_approveatasan,
            r.tpk_approveHRD,
            r.tpk_tanggal,
        ]);

        await db.execute(`
            INSERT INTO rekruitmen2.tpk_index_helper
                (tpk_nomor, tpk_peminta, tpk_approveatasan, tpk_approveHRD, tpk_tanggal)
            VALUES ${placeholders}
            ON DUPLICATE KEY UPDATE
                tpk_peminta       = VALUES(tpk_peminta),
                tpk_approveatasan = VALUES(tpk_approveatasan),
                tpk_approveHRD    = VALUES(tpk_approveHRD),
                tpk_tanggal       = VALUES(tpk_tanggal),
                synced_at         = NOW()
        `, values);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[tpkIndexSync] fullSync selesai: ${rows.length} baris dalam ${elapsed}s`);
}

module.exports = {
    upsertRow,
    updateApproval,
    deleteRow,
    deleteRows,
    fullSync,
};