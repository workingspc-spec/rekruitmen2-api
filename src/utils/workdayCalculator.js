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
 * Check apakah tanggal adalah hari libur
 */
function isHoliday(date) {
    const dateStr = date.toISOString().split('T')[0];
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
 */
function countWorkdays(startDate, endDate) {
    let count = 0;
    let currentDate = new Date(startDate);
    const end = new Date(endDate);

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
    INDONESIAN_HOLIDAYS_2026
};