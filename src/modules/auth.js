// src/modules/auth.js
const rateLimit = require('express-rate-limit');
const express   = require('express');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const db        = require('../config/db');
const { authenticate } = require('../middleware/authMiddleware');
const router    = express.Router();

// ── Konstanta ────────────────────────────────────────────────────────────────
const BCRYPT_SALT_ROUNDS = 12;
const isProduction = process.env.NODE_ENV === 'production';

// ── Rate limiter login (lebih ketat sesuai rekomendasi audit) ────────────────
// [FIX-KRITIS] Turunkan dari 50 → 10 request per 15 menit per IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 10,                   // Maks 10 percobaan login per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.'
    }
});

/**
 * Helper: hitung cookie maxAge dari tokenExpiry string
 */
function getTokenExpiryMs(tokenExpiry) {
    const map = {
        '24h': 24 * 60 * 60 * 1000,
        '3d':  3 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
    };
    return map[tokenExpiry] ?? (24 * 60 * 60 * 1000);
}

/**
 * Helper: set httpOnly cookie dengan konfigurasi aman
 * [FIX-KRITIS] Token disimpan di httpOnly cookie, tidak accessible dari JS
 */
function setAuthCookie(res, token, tokenExpiry) {
    res.cookie('token', token, {
        httpOnly: true,                              // Tidak bisa diakses JS → cegah XSS
        secure:   isProduction,                      // Hanya via HTTPS di production
        sameSite: isProduction ? 'strict' : 'lax',  // CSRF protection
        maxAge:   getTokenExpiryMs(tokenExpiry),
        path:     '/',
    });
}

/**
 * =====================================================================
 * MODULE: AUTHENTICATION
 * =====================================================================
 */

/**
 * POST /api/auth/login
 * PUBLIC — Login endpoint
 *
 * [FIX-KRITIS] Perubahan keamanan:
 *   1. bcrypt.compare() untuk verifikasi password (dengan migrasi gradual)
 *   2. httpOnly cookie untuk menyimpan token (web client)
 *   3. Token tetap dikembalikan di response body (untuk Android/API client)
 */
router.post('/login', loginLimiter, async (req, res) => {
    const { username, password, expiredDays } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Username dan Password wajib diisi'
        });
    }

    try {
        const [rows] = await db.execute(
            `SELECT u.user_kode, u.user_nama, u.user_hrd, u.user_password, k.kar_bagian
             FROM rekruitmen2.tuser u
             LEFT JOIN tkaryawan k ON u.user_kode = k.kar_nik
             WHERE u.user_kode = ?`,
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Username atau password salah'
            });
        }

        const user = rows[0];

        // ── [FIX-KRITIS] Verifikasi password dengan bcrypt ──────────────────
        // Migrasi gradual: deteksi apakah password sudah di-hash (bcrypt hash
        // selalu dimulai dengan "$2a$" atau "$2b$").
        // Jika belum di-hash (password lama plain-text):
        //   → bandingkan langsung, lalu auto-hash dan simpan ke DB.
        // Jika sudah di-hash: gunakan bcrypt.compare().
        let passwordMatch = false;
        const isAlreadyHashed = user.user_password &&
            (user.user_password.startsWith('$2a$') ||
             user.user_password.startsWith('$2b$'));

        if (isAlreadyHashed) {
            // Password sudah di-hash — gunakan bcrypt compare
            passwordMatch = await bcrypt.compare(password, user.user_password);
        } else {
            // Password masih plain-text (legacy) — bandingkan langsung
            passwordMatch = (password === user.user_password);

            if (passwordMatch) {
                // Auto-migrasi: hash password dan simpan ke DB
                console.log(`🔐 [Auth] Auto-migrating password for user: ${user.user_kode}`);
                const hashed = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
                await db.execute(
                    'UPDATE rekruitmen2.tuser SET user_password = ? WHERE user_kode = ?',
                    [hashed, user.user_kode]
                );
            }
        }

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: 'Username atau password salah'
            });
        }

        // Tentukan durasi token
        const tokenExpiry = expiredDays ? `${expiredDays}d` : '24h';

        const token = jwt.sign(
            {
                user_kode: user.user_kode,
                user_nama: user.user_nama,
                user_hrd:  user.user_hrd
            },
            process.env.JWT_SECRET,
            { expiresIn: tokenExpiry }
        );

        // [FIX-KRITIS] Set httpOnly cookie (untuk web browser)
        setAuthCookie(res, token, tokenExpiry);

        // Token juga dikembalikan di response body (untuk Android/API client)
        res.json({
            success: true,
            message: 'Login Berhasil',
            data: {
                token: token, // Dibutuhkan oleh Android (Bearer token)
                user: {
                    kode:   user.user_kode,
                    nama:   user.user_nama,
                    is_hrd: user.user_hrd,
                    bagian: user.kar_bagian || (user.user_hrd === 1 ? 'HR Department' : 'General')
                }
            }
        });

    } catch (error) {
        console.error('❌ Login Error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server'
        });
    }
});

/**
 * POST /api/auth/logout
 * PUBLIC — Logout endpoint, hapus httpOnly cookie
 *
 * [FIX-KRITIS] Endpoint baru untuk invalidasi sesi web
 * Android tidak perlu memanggil ini (cukup hapus token dari DataStore)
 */
router.post('/logout', (req, res) => {
    res.clearCookie('token', {
        httpOnly: true,
        secure:   isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
        path:     '/',
    });
    res.json({ success: true, message: 'Logout berhasil' });
});

/**
 * POST /api/auth/change-password
 * PROTECTED — Ganti password (butuh login)
 *
 * [FIX-KRITIS] Password baru selalu di-hash dengan bcrypt
 */
router.post('/change-password', authenticate, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const userKode = req.user.user_kode;

    if (!oldPassword || !newPassword) {
        return res.status(400).json({
            success: false,
            message: 'Password lama dan baru wajib diisi'
        });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({
            success: false,
            message: 'Password baru minimal 6 karakter'
        });
    }

    try {
        const [rows] = await db.execute(
            'SELECT user_password FROM rekruitmen2.tuser WHERE user_kode = ?',
            [userKode]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User tidak ditemukan'
            });
        }

        const storedPassword  = rows[0].user_password;
        const isAlreadyHashed = storedPassword &&
            (storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$'));

        // Verifikasi password lama
        let oldPasswordMatch = false;
        if (isAlreadyHashed) {
            oldPasswordMatch = await bcrypt.compare(oldPassword, storedPassword);
        } else {
            oldPasswordMatch = (oldPassword === storedPassword);
        }

        if (!oldPasswordMatch) {
            return res.status(400).json({
                success: false,
                message: 'Password lama anda salah'
            });
        }

        // Hash password baru sebelum disimpan
        const hashedNewPassword = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);

        await db.execute(
            'UPDATE rekruitmen2.tuser SET user_password = ? WHERE user_kode = ?',
            [hashedNewPassword, userKode]
        );

        res.json({
            success: true,
            message: 'Password Berhasil diubah'
        });

    } catch (error) {
        console.error('❌ Change Password Error:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengubah password'
        });
    }
});

/**
 * GET /api/auth/me
 * PROTECTED — Get current user info
 */
router.get('/me', authenticate, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT u.user_kode, u.user_nama, u.user_hrd, k.kar_bagian
             FROM rekruitmen2.tuser u
             LEFT JOIN tkaryawan k ON u.user_kode = k.kar_nik
             WHERE u.user_kode = ?`,
            [req.user.user_kode]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User tidak ditemukan'
            });
        }

        res.json({
            success: true,
            data: {
                kode:   rows[0].user_kode,
                nama:   rows[0].user_nama,
                is_hrd: rows[0].user_hrd,
                bagian: rows[0].kar_bagian || (rows[0].user_hrd === 1 ? 'HR Department' : 'General')
            }
        });

    } catch (error) {
        console.error('❌ Get Me Error:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil data user'
        });
    }
});

module.exports = router;