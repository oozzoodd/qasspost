// Запуск vzlyot.post на своём компьютере: база PostgreSQL + сервер кассы.
// База хранится в local/data и не уходит в git. Остановка — Ctrl+C или закрыть окно.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(here, '..', 'backend');
const dataDir = path.join(here, 'data');
const pgDir = path.join(dataDir, 'postgres');
const secretsFile = path.join(dataDir, 'secrets.json');

const DB_PORT = 5433;
const DB_NAME = 'vzlyot';
const APP_PORT = 3000; // касса на localhost ищет сервер именно на 3000

fs.mkdirSync(dataDir, { recursive: true });

// Секреты создаются один раз и потом переиспользуются, чтобы входы не слетали
let secrets;
if (fs.existsSync(secretsFile)) {
  secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
} else {
  secrets = {
    jwtSecret: crypto.randomBytes(32).toString('hex'),
    adminKey: crypto.randomBytes(9).toString('base64url'),
    dbPassword: crypto.randomBytes(12).toString('hex'),
  };
  fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
}

const firstRun = !fs.existsSync(path.join(pgDir, 'PG_VERSION'));
const db = new EmbeddedPostgres({
  databaseDir: pgDir,
  user: 'postgres',
  password: secrets.dbPassword,
  port: DB_PORT,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
});

const DATABASE_URL = `postgres://postgres:${secrets.dbPassword}@127.0.0.1:${DB_PORT}/${DB_NAME}`;

const ADMIN_URL = `postgres://postgres:${secrets.dbPassword}@127.0.0.1:${DB_PORT}/postgres`;

// База могла остаться запущенной, если окно закрыли без Ctrl+C
async function isDbRunning() {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

// Штатная остановка базы через pg_ctl (работает и для базы, запущенной прошлым окном)
function pgCtlStop() {
  const require = createRequire(import.meta.url);
  try {
    const pkgDir = path.dirname(require.resolve(`@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}/package.json`));
    const pgCtl = path.join(pkgDir, 'native', 'bin', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
    spawnSync(pgCtl, ['-D', pgDir, 'stop', '-m', 'fast', '-w'], { stdio: 'ignore' });
  } catch {}
}

async function ensureDatabase() {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (!exists.rows.length) {
    await client.query(`CREATE DATABASE ${DB_NAME} ENCODING 'UTF8' TEMPLATE template0`);
  }
  await client.end();
  return !exists.rows.length;
}

let server;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\n⏹  Останавливаю...');
  if (server && server.exitCode === null) server.kill();
  pgCtlStop();
  process.exit(code);
}
// SIGHUP / SIGBREAK — закрытие окна консоли в Windows
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => stop(0));
}

try {
  console.log(firstRun ? '📦 Первый запуск: создаю базу данных (около минуты)...' : '📦 Запускаю базу данных...');
  if (firstRun) await db.initialise();
  if (!firstRun && await isDbRunning()) {
    console.log('   База уже была запущена — подключаюсь к ней');
  } else {
    await db.start();
  }
  const created = await ensureDatabase();

  const env = {
    ...process.env,
    DATABASE_URL,
    JWT_SECRET: secrets.jwtSecret,
    ADMIN_KEY: secrets.adminKey,
    PORT: String(APP_PORT),
  };

  // Таблицы + демо-данные (повторный запуск демо не дублирует)
  if (created) {
    const init = spawnSync(process.execPath, ['db/init.js'], { cwd: backendDir, env, stdio: 'inherit' });
    if (init.status !== 0) throw new Error('Не удалось создать демо-данные');
  }

  server = spawn(process.execPath, ['server.js'], { cwd: backendDir, env, stdio: 'inherit' });
  server.on('exit', code => { if (!stopping) { console.log('Сервер остановился'); stop(code || 0); } });

  console.log('');
  console.log(`   Касса:   http://localhost:${APP_PORT}`);
  console.log(`   Админка: http://localhost:${APP_PORT}/admin.html   (ключ: ${secrets.adminKey})`);
  console.log('   Демо:    demo@vzlyot.post / demo1234, PIN 1111');
  console.log('   Остановить: Ctrl+C или закрыть это окно');
  console.log('');

  if (process.platform === 'win32' && !process.env.NO_BROWSER) {
    setTimeout(() => spawn('cmd', ['/c', 'start', '', `http://localhost:${APP_PORT}`], { detached: true, stdio: 'ignore' }), 2500);
  }
} catch (err) {
  console.error('❌ Ошибка запуска:', err.message || err);
  await stop(1);
}
