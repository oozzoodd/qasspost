// Создание аккаунта владельца: используется и регистрацией с лендинга,
// и ручным созданием клиента в админ-панели.

const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { isValidPin, hashPin, randomPin } = require('./pin');
const { normalizePhone } = require('./phone');
const { DEFAULT_PLAN, TRIAL_DAYS, isValidPlan } = require('../config/plans');

const MIN_PASSWORD_LENGTH = 6;

// Ошибка, которую можно показать человеку как есть
class AccountError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ALREADY = 'ALREADY_REGISTERED';

async function createAccount(input) {
  const name = String(input.name ?? '').trim();
  const venueName = String(input.venueName ?? '').trim();
  const password = String(input.password ?? '');
  const email = String(input.email ?? '').trim() || null;
  const phoneRaw = String(input.phone ?? '').trim();
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  const plan = input.plan || DEFAULT_PLAN;
  const days = input.days === undefined ? TRIAL_DAYS : Number(input.days);
  const pin = input.pin;

  if (!name || !password || (!phoneRaw && !email)) {
    throw new AccountError(400, 'Заполните имя, номер телефона и пароль');
  }
  if (phoneRaw && !phone) throw new AccountError(400, 'Проверьте номер телефона');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError(400, 'Проверьте email');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AccountError(400, `Пароль — минимум ${MIN_PASSWORD_LENGTH} символов`);
  }
  if (name.length > 120 || venueName.length > 120) throw new AccountError(400, 'Слишком длинное название');
  if (pin !== undefined && pin !== '' && !isValidPin(pin)) throw new AccountError(400, 'PIN должен состоять из 4 цифр');
  if (!isValidPlan(plan)) throw new AccountError(400, 'Неизвестный тариф');
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new AccountError(400, 'Проверьте срок доступа');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (phone) {
      const exists = await client.query('SELECT id FROM accounts WHERE phone = $1', [phone]);
      if (exists.rows.length) throw new AccountError(409, 'Этот номер уже зарегистрирован. Войдите в кассу.', ALREADY);
    }
    if (email) {
      const exists = await client.query('SELECT id FROM accounts WHERE LOWER(email) = LOWER($1)', [email]);
      if (exists.rows.length) throw new AccountError(409, 'Этот email уже зарегистрирован', ALREADY);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const accRes = await client.query(
      `INSERT INTO accounts (name, email, phone, password_hash, plan, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,'trial', NOW() + ($6 || ' days')::interval) RETURNING *`,
      [name, email, phone, passwordHash, plan, String(days)]
    );
    const account = accRes.rows[0];

    const venueRes = await client.query(
      'INSERT INTO venues (account_id, name) VALUES ($1,$2) RETURNING id, name',
      [account.id, venueName || 'Моя точка']
    );
    const venue = venueRes.rows[0];

    // Владелец как сотрудник: свой PIN или случайный (общий «0000» небезопасен).
    // Сменить PIN владелец может через /auth/owner-pin по своему паролю.
    const ownerPin = isValidPin(pin) ? String(pin) : randomPin();
    const staffRes = await client.query(
      `INSERT INTO staff (venue_id, name, phone, role, pin) VALUES ($1,$2,$3,'owner',$4) RETURNING id, name, role`,
      [venue.id, name, phone, await hashPin(ownerPin)]
    );

    // Стартовая категория, чтобы первое блюдо можно было добавить сразу
    await client.query(`INSERT INTO menu_categories (venue_id, name) VALUES ($1,'Основное')`, [venue.id]);

    await client.query('COMMIT');
    return { account, venue, staff: staffRes.rows[0], ownerPin };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Гонка двух одинаковых регистраций упирается в уникальный индекс
    if (err.code === '23505') throw new AccountError(409, 'Этот номер уже зарегистрирован. Войдите в кассу.', ALREADY);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createAccount, AccountError, MIN_PASSWORD_LENGTH };
