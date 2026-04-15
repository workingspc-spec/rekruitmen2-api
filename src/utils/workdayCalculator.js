/**
 * =====================================================================
 * UTILITY: Workday Calculator
 * Menghitung hari kerja (skip Minggu & libur dari tabel hrd2.tharilibur)
 * HRD bekerja Senin-Sabtu (hanya Minggu = weekend)
 *
 * [FIX-INFO] Circular Dependency diperbaiki:
 *   Sebelumnya: require('../config/db') dilakukan secara lazy di dalam fungsi
 *   Sekarang: db di-inject sebagai parameter dari luar (app.js)
 *   Referensi disimpan di _dbRef untuk digunakan oleh setInterval.
 * =====================================================================
 */

// ── Fallback hardcoded (dipakai jika DB belum dimuat / gagal) ─────────────────
const FALLBACK_HOLIDAYS = new Set([
    // 2025
    '2025-01-01','2025-01-27','2025-01-29',
    '2025-03-29','2025-03-31','2025-04-01',
    '2025-04-02','2025-04-03','2025-04-04','2025-04-05',
    '2025-04-18','2025-05-01','2025-05-12','2025-05-29',
    '2025-06-06','2025-06-27','2025-08-17',
    '2025-09-05','2025-12-25',
    // 2026
    '2026-01-01','2026-01-02','2026-01-03','2026-01-16',
    '2026-02-17',
    '2026-03-19','2026-03-20','2026-03-21','2026-03-22',
    '2026-03-23','2026-03-24','2026-03-25',
    '2026-04-03','2026-04-05',
    '2026-05-01','2026-05-14','2026-05-27','2026-05-31',
    '2026-06-01','2026-06-16',
    '2026-08-17','2026-08-25',
    '2026-12-25',
]);

// ── Cache dari DB ──────────────────────────────────────────────────────────────
let _holidaySet = null;   // null = belum dimuat
let _lastLoaded = null;

// [FIX-INFO] Referensi DB disimpan setelah pertama kali di-inject dari app.js
// Digunakan oleh setInterval untuk refresh berkala tanpa memerlukan require() ulang
let _dbRef = null;

/**
 * Format Date ke string 'YYYY-MM-DD' tanpa UTC shift
 */
function toDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Ambil Set holiday yang aktif.
 * Gunakan cache DB jika sudah dimuat, fallback ke hardcoded jika belum.
 */
function getHolidaySet() {
    return _holidaySet || FALLBACK_HOLIDAYS;
}

/**
 * Muat hari libur dari hrd2.tharilibur.
 *
 * [FIX-INFO] db di-inject sebagai parameter untuk menghindari circular dependency.
 * Jika db tidak disuplai, gunakan _dbRef yang sudah tersimpan sebelumnya.
 *
 * @param {Object|null} db - Instance pool mysql2 (dari app.js atau slaCron.js)
 */
async function refreshHolidaysFromDB(db = null) {
    // Simpan referensi jika disuplai (untuk digunakan oleh interval)
    if (db) {
        _dbRef = db;
    }

    const dbToUse = _dbRef;

    if (!dbToUse) {
        console.warn('[workday] DB instance not provided and no stored reference. Using fallback.');
        return;
    }

    try {
        const currentYear = new Date().getFullYear();

        const [rows] = await dbToUse.execute(
            `SELECT DATE_FORMAT(hl_tanggal, '%Y-%m-%d') AS d
             FROM hrd2.tharilibur
             WHERE hl_status = 1
               AND YEAR(hl_tanggal) BETWEEN ? AND ?`,
            [currentYear - 1, currentYear + 1]
        );

        if (rows.length > 0) {
            _holidaySet = new Set(rows.map(r => r.d));
            _lastLoaded = new Date();
            console.log(`✅ [workday] Holidays loaded from DB: ${_holidaySet.size} entries (${currentYear - 1}–${currentYear + 1})`);
        } else {
            console.warn('[workday] No holidays found in DB, using fallback.');
        }
    } catch (err) {
        console.warn('[workday] Holiday DB load failed, using fallback:', err.message);
    }
}

/**
 * Cek apakah tanggal adalah hari libur nasional
 */
function isHoliday(date) {
    return getHolidaySet().has(toDateStr(date));
}

/**
 * Cek apakah tanggal adalah weekend (HANYA MINGGU).
 * HRD kerja Senin–Sabtu.
 */
function isWeekend(date) {
    return date.getDay() === 0; // 0 = Minggu
}

/**
 * Cek apakah tanggal adalah hari kerja
 */
function isWorkday(date) {
    return !isWeekend(date) && !isHoliday(date);
}

/**
 * Hitung tanggal setelah X hari kerja dari startDate
 * @param {Date} startDate
 * @param {number} workdays
 * @returns {Date}
 */
function addWorkdays(startDate, workdays) {
    const d = new Date(startDate);
    let added = 0;
    while (added < workdays) {
        d.setDate(d.getDate() + 1);
        if (isWorkday(d)) added++;
    }
    return d;
}

/**
 * Hitung selisih hari kerja antara dua tanggal (eksklusif startDate).
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @returns {number}
 */
function countWorkdays(startDate, endDate) {
    const start = new Date(startDate);
    const end   = new Date(endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    if (start.getTime() === end.getTime()) return 0;

    let count = 0;
    const cur = new Date(start);
    cur.setDate(cur.getDate() + 1);

    while (cur <= end) {
        if (isWorkday(cur)) count++;
        cur.setDate(cur.getDate() + 1);
    }
    return count;
}

/**
 * Format Date ke 'YYYY-MM-DD' (timezone-safe)
 */
function formatDateSafe(date) {
    if (!date) return null;
    return toDateStr(new Date(date));
}

// ── Refresh otomatis setiap 6 jam ─────────────────────────────────────────────
// [FIX-INFO] Tidak ada lagi require() di dalam interval — gunakan _dbRef yang sudah tersimpan
setInterval(() => {
    if (_dbRef) {
        refreshHolidaysFromDB().catch(() => {}); // silent fail
    }
}, 6 * 60 * 60 * 1000);

module.exports = {
    addWorkdays,
    countWorkdays,
    isHoliday,
    isWeekend,
    isWorkday,
    formatDateSafe,
    refreshHolidaysFromDB,
    getHolidaySet,
    FALLBACK_HOLIDAYS: Array.from(FALLBACK_HOLIDAYS),
};