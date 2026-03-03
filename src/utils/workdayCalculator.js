/**
 * =====================================================================
 * UTILITY: Workday Calculator
 * Menghitung hari kerja (skip Minggu & libur nasional Indonesia)
 * HRD bekerja Senin-Sabtu
 * =====================================================================
 */

// Libur Nasional Indonesia 2026 (Update tiap tahun)
const INDONESIAN_HOLIDAYS_2026 = [
    '2026-01-01', // Tahun Baru
    '2026-02-17', // Isra Mi'raj
    '2026-03-11', // Tahun Baru Imlek
    '2026-03-22', // Hari Suci Nyepi
    '2026-03-31', // Idul Fitri
    '2026-04-01', // Idul Fitri
    '2026-04-02', // Cuti Bersama
    '2026-04-03', // Cuti Bersama
    '2026-04-10', // Wafat Yesus Kristus
    '2026-05-01', // Hari Buruh
    '2026-05-06', // Kenaikan Yesus Kristus
    '2026-05-26', // Waisak
    '2026-06-01', // Hari Lahir Pancasila
    '2026-06-07', // Idul Adha
    '2026-06-28', // Tahun Baru Islam
    '2026-08-17', // Hari Kemerdekaan
    '2026-09-06', // Maulid Nabi
    '2026-12-25', // Hari Raya Natal
];

/**
 * ✅ TIMEZONE-SAFE: Selalu kembalikan "hari ini" dalam WIB (Asia/Jakarta)
 * tanpa peduli timezone server PM2/Linux.
 *
 * Cara kerja:
 *  - toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) → "2026-03-03"
 *  - Parse string itu ke Date lokal midnight → tidak ada UTC shift
 *
 * ❌ JANGAN gunakan: const today = new Date(); today.setHours(0,0,0,0);
 *    → Bergantung pada timezone sistem server, tidak reliable di PM2/Linux UTC
 *
 * ✅ GUNAKAN ini di mana pun butuh "tanggal hari ini":
 *    const today = getTodayWIB();
 */
function getTodayWIB() {
    const now = new Date();
    // en-CA menghasilkan format YYYY-MM-DD — mudah di-parse, tidak perlu regex
    const wibDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    const [y, m, d] = wibDateStr.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/**
 * ✅ TIMEZONE-SAFE: Format tanggal tanpa bias UTC
 */
function formatDateSafe(date) {
    if (!date) return null;
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * ✅ FIXED: Check apakah tanggal adalah hari libur (TANPA UTC SHIFT)
 */
function isHoliday(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    return INDONESIAN_HOLIDAYS_2026.includes(dateStr);
}

/**
 * Check apakah tanggal adalah weekend (HANYA MINGGU)
 * Karena HRD kerja Senin-Sabtu
 */
function isWeekend(date) {
    const day = date.getDay();
    return day === 0; // 0 = Minggu
}

/**
 * Hitung tanggal setelah X hari kerja dari startDate
 */
function addWorkdays(startDate, workdays) {
    let currentDate = new Date(startDate);
    let daysAdded = 0;

    while (daysAdded < workdays) {
        currentDate.setDate(currentDate.getDate() + 1);

        if (!isWeekend(currentDate) && !isHoliday(currentDate)) {
            daysAdded++;
        }
    }

    return currentDate;
}

/**
 * Hitung selisih hari kerja antara dua tanggal
 * ✅ FIX: Eksklusif startDate (mulai hitung dari hari berikutnya)
 */
function countWorkdays(startDate, endDate) {
    let count = 0;
    let currentDate = new Date(startDate);
    const end = new Date(endDate);

    currentDate.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    if (currentDate.getTime() === end.getTime()) {
        return 0;
    }

    currentDate.setDate(currentDate.getDate() + 1);

    while (currentDate <= end) {
        if (!isWeekend(currentDate) && !isHoliday(currentDate)) {
            count++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }

    return count;
}

module.exports = {
    addWorkdays,
    countWorkdays,
    isHoliday,
    isWeekend,
    formatDateSafe,
    getTodayWIB,            // ✅ EXPORT BARU — wajib digunakan pengganti new Date()
    INDONESIAN_HOLIDAYS_2026
};