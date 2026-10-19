// Приводит базу к актуальной структуре. Запускается при старте сервера и из init.js.
// Все шаги безопасны для повторного выполнения.

const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const { isPinHash, hashPin } = require('../utils/pin');

async function migrate() {
  // 1. Таблицы (CREATE TABLE IF NOT EXISTS — существующие не трогаются).
  // В старой базе отдельные индексы могут не создаться — это не мешает шагам ниже.
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(schema);
  } catch (err) {
    console.warn('⚠️  schema.sql применён не полностью:', err.message);
  }

  // 2. Миграции по порядку имён файлов
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }

  // 3. Хешируем PIN, оставшиеся открытым текстом
  const staff = await pool.query('SELECT id, pin FROM staff');
  let hashed = 0;
  for (const row of staff.rows) {
    if (isPinHash(row.pin)) continue;
    await pool.query('UPDATE staff SET pin = $1 WHERE id = $2', [await hashPin(row.pin), row.id]);
    hashed++;
  }
  if (hashed) console.log(`🔒 Зашифровано PIN-кодов: ${hashed}`);
}

module.exports = migrate;
