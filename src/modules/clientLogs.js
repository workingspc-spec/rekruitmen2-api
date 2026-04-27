// src/modules/clientLogs.js
const express = require('express');
const router = express.Router();

/**
 * POST /api/logs/client
 * Endpoint publik untuk menerima error dari frontend (React) dan mobile (Android).
 * Dilindungi oleh global rate limiter di app.js agar tidak di-spam.
 */
router.post('/client', (req, res) => {
    const { source, message, stack, url, context, userAgent } = req.body;

    // Format log agar mudah dibaca di log PM2
    const logHeader = `\n[CLIENT ERROR | ${source ? source.toUpperCase() : 'UNKNOWN'}] ==================`;
    
    console.error(logHeader);
    console.error(`Time   : ${new Date().toISOString()}`);
    console.error(`Message: ${message}`);
    if (url) console.error(`URL    : ${url}`);
    if (userAgent) console.error(`Device : ${userAgent}`);
    if (context && Object.keys(context).length > 0) {
        console.error(`Context: ${JSON.stringify(context)}`);
    }
    if (stack) {
        console.error(`Stack  :\n${stack}`);
    }
    console.error('==================================================\n');

    // Kembalikan 200 OK secara senyap
    res.status(200).json({ success: true });
});

module.exports = router;