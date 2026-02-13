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
    keepAliveInitialDelay: 0,
    timezone: '+07:00',  // ✅ CRITICAL: Set timezone ke WIB
    dateStrings: true    // ✅ PENTING: Kembalikan DATE/DATETIME sebagai string
});

const db = pool.promise();

// Test koneksi awal dengan explicit timezone setting
(async () => {
    try {
        const conn = await db.getConnection();
        console.log(`✅ Database connected: ${process.env.DB_NAME}`);
        
        // ✅ Set timezone untuk setiap connection
        await conn.execute("SET time_zone = '+07:00'");
        
        conn.release();
    } catch (err) {
        console.error('❌ Database connection failed!');
        console.error(err.message);
        process.exit(1); // hentikan app kalau DB gagal
    }
})();

module.exports = db;