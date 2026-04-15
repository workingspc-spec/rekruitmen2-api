// src/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');

/**
 * =====================================================================
 * MIDDLEWARE: JWT AUTHENTICATION & AUTHORIZATION
 *
 * [FIX-KRITIS] Mendukung dua metode autentikasi:
 *   1. httpOnly Cookie (web browser) — token tidak bisa diakses JS
 *   2. Bearer Token via Authorization header (Android/API client)
 *
 * Urutan pemeriksaan: Bearer Token → Cookie
 * =====================================================================
 */

/**
 * Middleware untuk verifikasi JWT Token
 * Mengisi req.user dengan data dari token
 */
const authenticate = (req, res, next) => {
    try {
        let token = null;

        // 1. Coba ambil dari Authorization header (untuk Android/API client)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        }

        // 2. Fallback ke httpOnly cookie (untuk web browser)
        //    Cookie di-set oleh server saat login, tidak bisa diakses JS
        if (!token && req.cookies && req.cookies.token) {
            token = req.cookies.token;
        }

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token tidak ditemukan. Silakan login terlebih dahulu.'
            });
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Simpan data user ke request object
        req.user = {
            user_kode: decoded.user_kode,
            user_nama: decoded.user_nama,
            user_hrd:  decoded.user_hrd
        };

        next();

    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            // Hapus cookie yang sudah expired (jika ada)
            res.clearCookie('token', { httpOnly: true, path: '/' });
            return res.status(401).json({
                success: false,
                message: 'Token sudah kadaluarsa. Silakan login kembali.'
            });
        }

        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: 'Token tidak valid'
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Kesalahan server saat memverifikasi token'
        });
    }
};

/**
 * Middleware untuk memeriksa apakah user adalah HRD
 */
const isHRD = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized: Token tidak valid'
        });
    }

    if (req.user.user_hrd !== 1) {
        return res.status(403).json({
            success: false,
            message: 'Akses ditolak: Hanya HRD yang dapat mengakses endpoint ini'
        });
    }

    next();
};

/**
 * Middleware untuk memeriksa apakah user adalah Manager/Atasan
 * (user yang bukan HRD)
 */
const isManager = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized: Token tidak valid'
        });
    }

    if (req.user.user_hrd === 1) {
        return res.status(403).json({
            success: false,
            message: 'Akses ditolak: Endpoint ini hanya untuk Manager/Atasan'
        });
    }

    next();
};

/**
 * Optional middleware: bisa login atau tidak
 * Jika ada token (Bearer atau Cookie), decode. Jika tidak, lanjut tanpa req.user
 */
const optionalAuth = (req, res, next) => {
    try {
        let token = null;

        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        }

        if (!token && req.cookies && req.cookies.token) {
            token = req.cookies.token;
        }

        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = {
                user_kode: decoded.user_kode,
                user_nama: decoded.user_nama,
                user_hrd:  decoded.user_hrd
            };
        }

        next();

    } catch (error) {
        // Jika token invalid, lanjut tanpa req.user (optional)
        next();
    }
};

module.exports = {
    authenticate,
    isHRD,
    isManager,
    optionalAuth
};