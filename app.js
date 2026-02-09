// app.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Default NODE_ENV
process.env.NODE_ENV = process.env.NODE_ENV || 'local';

// Load env sesuai environment
const envFile =
  process.env.NODE_ENV === 'production'
    ? '.env.production'
    : process.env.NODE_ENV === 'staging'
    ? '.env.ngrok'
    : '.env.local';

dotenv.config({ path: envFile });

console.log(`📦 Using env file: ${envFile}`);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Middleware auth
const { authenticate, isHRD, optionalAuth } =
  require('./src/middleware/authMiddleware');

// Routes
app.get('/', (_, res) => res.send('Backend Rekruitmen is Running! 🚀'));

app.use('/api/auth', require('./src/modules/auth'));
app.use('/api/master', authenticate, require('./src/modules/masterData'));
app.use('/api/recruitment', authenticate, require('./src/modules/recruitment'));
app.use('/api/applicant', optionalAuth, require('./src/modules/applicant'));
app.use('/api/selection', authenticate, isHRD, require('./src/modules/selection'));
app.use('/api/employee', authenticate, isHRD, require('./src/modules/employee'));
app.use('/api/dashboard', authenticate, require('./src/modules/dashboard'));
app.use('/api/monitoring', authenticate, require('./src/modules/monitoring'));

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    success: false,
    message: 'Terjadi kesalahan server',
    ...(process.env.NODE_ENV !== 'production' && { error: err.message })
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);
});
