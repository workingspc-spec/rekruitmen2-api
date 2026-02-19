// src/utils/dateParser.js

const parseTempatTanggal = (input) => {
    if (!input) return { tempat: null, tanggal: null };

    try {
        const raw = String(input).trim();

        // Cari tanggal dd/mm/yyyy atau dd-mm-yyyy
        const match = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);

        if (!match) {
            return { tempat: raw || null, tanggal: null };
        }

        const [, d, m, y] = match;

        // Ambil tempat = semua sebelum tanggal
        const tempat = raw
            .replace(match[0], '')
            .replace(',', '')
            .trim() || null;

        return {
            tempat,
            tanggal: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
        };

    } catch (error) {
        console.error('❌ parseTempatTanggal error:', error.message);
        return { tempat: null, tanggal: null };
    }
};

const parseSheetTimestamp = (value) => {
    if (!value) return null;

    try {
        const raw = String(value).trim();

        // Format umum Google Form: 24/01/2026 11:16:19
        const match = raw.match(
            /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/
        );

        if (!match) return null;

        const [, d, m, y, hh, mm, ss] = match;

        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${hh}:${mm}:${ss}`;

    } catch (error) {
        console.error('❌ parseSheetTimestamp error:', error.message);
        return null;
    }
};

const mapStatusNikah = (status) => {
    if (!status) return 'Belum Menikah';

    try {
        const s = String(status).toLowerCase();

        // URUTAN KRUSIAL → hindari false match
        if (s.includes('belum')) return 'Belum Menikah';
        if (s.includes('cerai hidup')) return 'Cerai Hidup';
        if (s.includes('cerai mati')) return 'Cerai Mati';
        if (s.includes('menikah')) return 'Menikah';

        return 'Belum Menikah';

    } catch (error) {
        console.error('❌ mapStatusNikah error:', error.message);
        return 'Belum Menikah';
    }
};

module.exports = {
    parseTempatTanggal,
    parseSheetTimestamp,
    mapStatusNikah
};
