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

// ================= [FIX B-03] VALIDASI JWT_SECRET =================
// Harus dilakukan SETELAH dotenv.config() agar variabel env sudah terbaca.
// Jika JWT_SECRET tidak di-set atau terlalu pendek, server menolak start
// daripada menjalankan dengan secret undefined/lemah yang membuat semua
// token menjadi identik secara kriptografis antar deployment.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('');
    console.error('❌ FATAL: JWT_SECRET tidak valid!');
    console.error('   Pastikan JWT_SECRET sudah di-set di env file dan panjangnya minimal 32 karakter.');
    console.error(`   Env file aktif: ${envFile}`);
    console.error('   Contoh: JWT_SECRET=your-very-long-and-secure-secret-key-here');
    console.error('');
    process.exit(1);
}

// ================= IMPORT MODULE =================
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const slaCron                   = require('./src/utils/slaCron');
const { refreshHolidaysFromDB } = require('./src/utils/workdayCalculator');
const { fullSync: syncIndexHelper } = require('./src/utils/tpkIndexSync');

// ================= INIT APP =================
const app = express();

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

// ================= CSRF PROTECTION (tambahkan setelah blok CORS) =================
// Melindungi endpoint cookie-based (web) dari cross-site request forgery.
// Android menggunakan Bearer token → tidak terdampak, dilewati otomatis.
app.use((req, res, next) => {
    // Metode safe (tidak mengubah state) → lewati
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    // Bearer token (Android/API client) → bukan serangan CSRF, lewati
    if (req.headers.authorization?.startsWith('Bearer ')) return next();

    // Untuk cookie-based auth (web), verifikasi dua lapis:

    // Lapis 1: Origin header harus cocok dengan CORS_ORIGINS
    const origin = req.headers.origin;
    if (origin) {
        const isAllowed = allowedOrigins.some(o => origin === o || origin.startsWith(o));
        if (!isAllowed) {
            console.warn(`⛔ CSRF blocked (origin): ${origin}`);
            return res.status(403).json({ success: false, message: 'Forbidden: invalid origin' });
        }
    }

    // Lapis 2: Header kustom yang tidak bisa di-set oleh cross-site script
    // (CORS pre-flight memblokir custom header dari origin tidak terdaftar)
    const xrw = req.headers['x-requested-with'];
    if (!xrw && req.cookies?.token) {
        // Ada cookie tapi tidak ada header custom → kemungkinan CSRF attempt
        console.warn(`⛔ CSRF blocked (missing X-Requested-With): path=${req.path}`);
        return res.status(403).json({ success: false, message: 'Forbidden: missing request header' });
    }

    next();
});

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

app.use('/api/app-version', require('./src/modules/appVersion'));
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

// [FIX H2] Callback dibuat async agar holidays di-load SEBELUM SLA cron berjalan.
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ Server running on port ${PORT}`);

    const db = require('./src/config/db');

    // ── [FIX H2] Load holidays DULU, tunggu selesai ──────────────────────────
    try {
        await refreshHolidaysFromDB(db);
        console.log('✅ Holiday data loaded from DB.');
    } catch (err) {
        console.warn('⚠️ Initial holiday load failed, fallback active:', err.message);
    }

    // ── Sync shadow index table (non-blocking — cron akan retry) ─────────────
    syncIndexHelper(db).catch(err => {
        console.warn('⚠️ Initial tpk_index_helper sync failed (akan dicoba ulang oleh cron):', err.message);
    });

    // ── Init SLA cron (SETELAH holidays di-load) ──────────────────────────────
    try {
        slaCron.runSlaSync();
        console.log('🔄 SLA Synchronization Service started.');
    } catch (err) {
        console.error('⚠️ Failed to start SLA Sync Service:', err.message);
    }
});