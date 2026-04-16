// ================= SET TIMEZONE =================
process.env.TZ = 'Asia/Jakarta';

// ================= LOAD ENV (WAJIB DI ATAS) =================
const dotenv = require('dotenv');

process.env.NODE_ENV = process.env.NODE_ENV || 'local';

const envFile =
    process.env.NODE_ENV === 'production' ? '.env.production' :
    process.env.NODE_ENV === 'staging'    ? '.env.ngrok'     :
                                            '.env.local';

dotenv.config({ path: envFile });

console.log(`📦 Using env file: ${envFile}`);
console.log(`📍 Environment: ${process.env.NODE_ENV}`);

// ================= IMPORT MODULE =================
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const slaCron                   = require('./src/utils/slaCron');
const { refreshHolidaysFromDB } = require('./src/utils/workdayCalculator');
const { fullSync: syncIndexHelper } = require('./src/utils/tpkIndexSync'); // [BARU] Shadow table sync

// ================= INIT APP =================
const app = express();

// Beri tahu Express untuk mempercayai 1 lapis proxy (yaitu Nginx)
app.set('trust proxy', 1);

// ================= MIDDLEWARE =================
app.use((req, res, next) => {
    req.dbTimezone = '+07:00';
    next();
});

// ================= CORS CONFIG =================
const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`⛔ CORS blocked: ${origin}`);
            callback(new Error(`CORS blocked: ${origin}`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// ================= SECURITY =================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
    hsts: process.env.NODE_ENV === 'production'
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,
}));

// ================= GLOBAL RATE LIMITER =================
const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Terlalu banyak permintaan. Coba lagi dalam 15 menit.'
    },
    skip: (req) => {
        const ip = req.ip || req.connection.remoteAddress;
        return process.env.NODE_ENV === 'local' && (ip === '127.0.0.1' || ip === '::1');
    }
});
app.use('/api/', globalApiLimiter);

// ================= AUTH MIDDLEWARE =================
const { authenticate } = require('./src/middleware/authMiddleware');

// ================= ROUTES =================
app.get('/', (_, res) => res.send('Backend Rekruitmen is Running! 🚀'));

app.use('/api/auth',        require('./src/modules/auth'));
app.use('/api/master',      authenticate, require('./src/modules/masterData'));
app.use('/api/recruitment', authenticate, require('./src/modules/recruitment'));
app.use('/api/dashboard',   authenticate, require('./src/modules/dashboard'));
app.use('/api/monitoring',  authenticate, require('./src/modules/monitoring'));

// ================= 404 HANDLER =================
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan' });
});

// ================= GLOBAL ERROR HANDLER =================
app.use((err, req, res, next) => {
    console.error('❌ GLOBAL ERROR:', err);
    res.status(500).json({
        success: false,
        message: 'Terjadi kesalahan server',
        ...(process.env.NODE_ENV !== 'production' && { error: err.message }),
    });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ Server running on port ${PORT}`);

    const db = require('./src/config/db');

    // ── Load holidays dari DB (non-blocking) ─────────────────────────────────
    refreshHolidaysFromDB(db).catch(err => {
        console.warn('⚠️ Initial holiday load failed, fallback active:', err.message);
    });

    // ── [BARU] Sync shadow index table (tpk_index_helper) ───────────────────
    // Ini memastikan shadow table terisi penuh saat server start sehingga
    // query pertama langsung menggunakan index tanpa menunggu cron pertama.
    syncIndexHelper(db).catch(err => {
        console.warn('⚠️ Initial tpk_index_helper sync failed (akan dicoba ulang oleh cron):', err.message);
    });

    // ── Init SLA cron ─────────────────────────────────────────────────────────
    try {
        slaCron.runSlaSync();
        console.log('🔄 SLA Synchronization Service started.');
    } catch (err) {
        console.error('⚠️ Failed to start SLA Sync Service:', err.message);
    }
});