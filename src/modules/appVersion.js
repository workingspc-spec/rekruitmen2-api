// src/modules/appVersion.js
const express = require('express');
const db      = require('../config/db');
const router  = express.Router();

/**
 * GET /api/app-version/latest?app_id=pkar_android
 * 
 * Endpoint OTA yang fleksibel — bisa dipakai semua aplikasi.
 * Parameter app_id membedakan aplikasi mana yang bertanya.
 * 
 * Cara pakai untuk aplikasi lain:
 *   GET /api/app-version/latest?app_id=nama_app_lain
 * Lalu insert baris baru di tabel t_app_version dengan app_id berbeda.
 */
router.get('/latest', async (req, res) => {
    const { app_id } = req.query;

    if (!app_id) {
        return res.status(400).json({
            success: false,
            message: 'Parameter app_id diperlukan. Contoh: ?app_id=pkar_android'
        });
    }

    try {
        const [rows] = await db.execute(
            `SELECT version_code, version_name, is_mandatory, download_url, release_notes
             FROM rekruitmen2.t_app_version
             WHERE app_id = ?
             ORDER BY version_code DESC
             LIMIT 1`,
            [app_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Tidak ada data versi untuk app_id: ${app_id}`
            });
        }

        const latest = rows[0];

        res.json({
            success: true,
            data: {
                versionCode:  latest.version_code,
                versionName:  latest.version_name,
                isMandatory:  latest.is_mandatory === 1,
                downloadUrl:  latest.download_url,
                releaseNotes: latest.release_notes
            }
        });

    } catch (error) {
        console.error('❌ Error app-version:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;