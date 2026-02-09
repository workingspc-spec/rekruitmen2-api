const mysql = require('mysql2');
const dotenv = require('dotenv');

// Tentukan env file berdasarkan NODE_ENV
const envFile = `.env.${process.env.NODE_ENV || 'local'}`;
dotenv.config({ path: envFile });

console.log(`📦 Load ENV dari: ${envFile}`);

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

const db = pool.promise();

// Test koneksi awal (SAFE)
(async () => {
    try {
        const conn = await db.getConnection();
        console.log(`✅ Database connected: ${process.env.DB_NAME}`);
        conn.release();
    } catch (err) {
        console.error('❌ Database connection failed!');
        console.error(err.message);
        process.exit(1); // hentikan app kalau DB gagal
    }
})();

module.exports = db;
