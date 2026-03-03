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
    // Gunakan cara manual agar tidak terpengaruh UTC shift
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
    return day === 0; // 0 = Minggu (Sabtu tidak dianggap weekend)
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
 * Contoh: Request 12 Feb, Approve 12 Feb → delay = 0 hari
 *         Request 12 Feb, Approve 13 Feb → delay = 1 hari (jika 13 Feb hari kerja)
 */
function countWorkdays(startDate, endDate) {
    let count = 0;
    let currentDate = new Date(startDate);
    const end = new Date(endDate);
    
    // ✅ Normalisasi tanggal (set ke pukul 00:00:00 untuk perbandingan yang akurat)
    currentDate.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    // ✅ Jika tanggal sama, return 0
    if (currentDate.getTime() === end.getTime()) {
        return 0;
    }

    // ✅ Mulai dari hari SETELAH startDate
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
    formatDateSafe,  // ✅ EXPORT HELPER BARU
    INDONESIAN_HOLIDAYS_2026
};