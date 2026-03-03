// ✅ Set timezone SEBELUM apa pun
process.env.TZ = 'Asia/Jakarta';
// app.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const slaCron = require('./src/utils/slaCron');

// ✅ Default NODE_ENV
process.env.NODE_ENV = process.env.NODE_ENV || 'local';

// ✅ Load env sesuai environment
const envFile =
  process.env.NODE_ENV === 'production'
    ? '.env.production'
    : process.env.NODE_ENV === 'staging'
    ? '.env.ngrok'
    : '.env.local';

dotenv.config({ path: envFile });

console.log(`📦 Using env file: ${envFile}`);

const app = express();

// ================= MIDDLEWARE =================

app.use((req, res, next) => {
  req.dbTimezone = '+07:00';
  next();
});

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(helmet());

// ================= AUTH MIDDLEWARE =================
const { authenticate, isHRD } = require('./src/middleware/authMiddleware');

// ================= ROUTES =================
app.get('/', (_, res) =>
  res.send('Backend Rekruitmen is Running! 🚀')
);

app.use('/api/auth',       require('./src/modules/auth'));
app.use('/api/master',     authenticate, require('./src/modules/masterData'));
app.use('/api/recruitment',authenticate, require('./src/modules/recruitment'));
app.use('/api/dashboard',  authenticate, require('./src/modules/dashboard'));
app.use('/api/monitoring', authenticate, require('./src/modules/monitoring'));

// ================= 404 HANDLER =================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint tidak ditemukan'
  });
});

// ================= GLOBAL ERROR HANDLER =================
app.use((err, req, res, next) => {
  console.error('❌ GLOBAL ERROR:', err);
  res.status(500).json({
    success: false,
    message: 'Terjadi kesalahan server',
    ...(process.env.NODE_ENV !== 'production' && { error: err.message })
  });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);

    // ✅ Jalankan sinkronisasi SLA otomatis saat server startup
  try {
    slaCron.runSlaSync();
    console.log('🔄 SLA Synchronization Service started successfully.');
  } catch (err) {
    console.error('⚠️ Failed to start SLA Sync Service:', err.message);
  }
});