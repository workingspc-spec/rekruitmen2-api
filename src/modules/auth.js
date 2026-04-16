// src/modules/auth.js
const rateLimit = require('express-rate-limit');
const express   = require('express');
const jwt       = require('jsonwebtoken');
const db        = require('../config/db');
const { authenticate } = require('../middleware/authMiddleware');
const router    = express.Router();

// ── Konstanta ────────────────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';

// ── Rate limiter login ────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
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
 */
function setAuthCookie(res, token, tokenExpiry) {
    res.cookie('token', token, {
        httpOnly: true,
        secure:   isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
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

        if (password !== user.user_password) {
            return res.status(401).json({
                success: false,
                message: 'Username atau password salah'
            });
        }

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

        setAuthCookie(res, token, tokenExpiry);

        res.json({
            success: true,
            message: 'Login Berhasil',
            data: {
                token: token,
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

        if (rows[0].user_password !== oldPassword) {
            return res.status(400).json({
                success: false,
                message: 'Password lama anda salah'
            });
        }

        await db.execute(
            'UPDATE rekruitmen2.tuser SET user_password = ? WHERE user_kode = ?',
            [newPassword, userKode]
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