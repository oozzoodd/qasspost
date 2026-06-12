const { Pool } = require('pg');

// Railway автоматически создаёт переменную DATABASE_URL когда ты добавляешь PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

module.exports = pool;
