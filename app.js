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
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

const slaCron             = require('./src/utils/slaCron');
const { refreshHolidaysFromDB } = require('./src/utils/workdayCalculator');

// ================= INIT APP =================
const app = express();

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
app.use(express.json());
app.use(helmet({ crossOriginResourcePolicy: false }));

// ================= AUTH MIDDLEWARE =================
const { authenticate } = require('./src/middleware/authMiddleware');

// ================= ROUTES =================
app.get('/', (_, res) => res.send('Backend Rekruitmen is Running! 🚀'));

app.use('/api/auth',       require('./src/modules/auth'));
app.use('/api/master',     authenticate, require('./src/modules/masterData'));
app.use('/api/recruitment', authenticate, require('./src/modules/recruitment'));
app.use('/api/dashboard',  authenticate, require('./src/modules/dashboard'));
app.use('/api/monitoring', authenticate, require('./src/modules/monitoring'));

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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);

    // ── Init SLA cron ─────────────────────────────────────────────
    try {
        slaCron.runSlaSync();
        console.log('🔄 SLA Synchronization Service started.');
    } catch (err) {
        console.error('⚠️ Failed to start SLA Sync Service:', err.message);
    }

    // ── Load holidays dari DB (non-blocking) ─────────────────────
    // workdayCalculator akan langsung bisa digunakan (fallback hardcoded)
    // sambil menunggu load dari DB selesai di background.
    refreshHolidaysFromDB().catch(err => {
        console.warn('⚠️ Initial holiday load failed, fallback active:', err.message);
    });
});