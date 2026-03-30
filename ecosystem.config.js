module.exports = {
  apps: [
    {
      name: 'backend-pkar',
      script: 'app.js',

      exec_mode: 'fork',
      // 🔹 Mode cluster TIDAK perlu dulu (karena DB remote)
      instances: 1,

      // 🔹 Restart otomatis kalau crash
      autorestart: true,

      // 🔹 Jangan watch (rawan restart loop)
      watch: false,

      // 🔹 Delay restart (hindari crash loop)
      restart_delay: 5000,

      // 🔹 Memory limit (optional tapi aman)
      max_memory_restart: '300M',

      // =========================
      // ENVIRONMENTS
      // =========================

      env: {
        NODE_ENV: 'local',
        PORT: 3000
      },

      env_staging: {
        NODE_ENV: 'staging',
        PORT: 3000
      },

      env_production: {
        NODE_ENV: 'production',
        PORT: 3006
      },

      // =========================
      // LOGGING
      // =========================
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
