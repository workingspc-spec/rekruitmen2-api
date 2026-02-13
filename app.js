// app.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// ✅ Set timezone SEBELUM apa pun
process.env.TZ = 'Asia/Jakarta';

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

// ✅ INIT EXPRESS HARUS DI SINI
const app = express();


// ================= MIDDLEWARE =================

// ✅ Database timezone helper (AMAN POSISINYA)
app.use((req, res, next) => {
  req.dbTimezone = '+07:00';
  next();
});

// ✅ CORS
app.use(cors());

// ✅ Body parser
app.use(express.json());


// ================= AUTH MIDDLEWARE =================

const {
  authenticate,
  isHRD,
  optionalAuth
} = require('./src/middleware/authMiddleware');


// ================= ROUTES =================

app.get('/', (_, res) =>
  res.send('Backend Rekruitmen is Running! 🚀')
);

app.use('/api/auth', require('./src/modules/auth'));
app.use('/api/master', authenticate, require('./src/modules/masterData'));
app.use('/api/recruitment', authenticate, require('./src/modules/recruitment'));
app.use('/api/applicant', optionalAuth, require('./src/modules/applicant'));
app.use('/api/selection', authenticate, isHRD, require('./src/modules/selection'));
app.use('/api/employee', authenticate, isHRD, require('./src/modules/employee'));
app.use('/api/dashboard', authenticate, require('./src/modules/dashboard'));
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
    ...(process.env.NODE_ENV !== 'production' && {
      error: err.message
    })
  });
});


// ================= START SERVER =================

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);
});
