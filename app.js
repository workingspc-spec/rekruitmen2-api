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
    credentials: true, // Diperlukan untuk httpOnly cookie
}));

// ================= SECURITY =================
// [FIX-MEDIUM] Body size limit — cegah DoS via payload besar
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// [FIX-MEDIUM] Cookie parser — untuk mendukung httpOnly cookie auth
app.use(cookieParser());

// [FIX-MEDIUM] Helmet dengan konfigurasi eksplisit
app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: process.env.NODE_ENV === 'production'
        ? undefined   // Gunakan default CSP di production
        : false,      // Matikan CSP di local/dev agar tidak mengganggu debugging
    hsts: process.env.NODE_ENV === 'production'
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,      // Hanya aktifkan HSTS di production (HTTPS)
}));

// ================= GLOBAL RATE LIMITER =================
// [FIX-KRITIS] Semua endpoint /api dilindungi rate limiter global
const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 menit
    max: 300,                   // Maks 300 request per IP per 15 menit
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Terlalu banyak permintaan. Coba lagi dalam 15 menit.'
    },
    // trust proxy sudah di-set di app, IP real dari X-Forwarded-For digunakan
    skip: (req) => {
        // Jangan rate-limit request dari localhost saat development
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
        // [FIX-MEDIUM] Hanya tampilkan detail error di non-production
        ...(process.env.NODE_ENV !== 'production' && { error: err.message }),
    });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ Server running on port ${PORT}`);

    // ── Init SLA cron ─────────────────────────────────────────────
    try {
        slaCron.runSlaSync();
        console.log('🔄 SLA Synchronization Service started.');
    } catch (err) {
        console.error('⚠️ Failed to start SLA Sync Service:', err.message);
    }

    // ── Load holidays dari DB (non-blocking) ─────────────────────
    // [FIX-INFO] Inject db secara eksplisit untuk menghindari circular dependency
    const db = require('./src/config/db');
    refreshHolidaysFromDB(db).catch(err => {
        console.warn('⚠️ Initial holiday load failed, fallback active:', err.message);
    });
});