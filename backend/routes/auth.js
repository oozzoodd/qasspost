const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { isValidPin, isPinHash, hashPin, findByPin } = require('../utils/pin');
const { normalizePhone } = require('../utils/phone');
const { TRIAL_DAYS, featuresOf } = require('../config/plans');
const { createAccount, AccountError } = require('../utils/accounts');

const router = express.Router();

// Что об аккаунте можно отдавать в кассу
function accountPublic(a) {
  return { id: a.id, name: a.name, email: a.email, phone: a.phone, plan: a.plan, status: a.status, expires_at: a.expires_at };
}

// Логин — номер телефона или email (у старых аккаунтов телефона может не быть)
async function findAccountByLogin(login) {
  const value = String(login ?? '').trim();
  if (!value) return null;
  if (value.includes('@')) {
    const r = await pool.query('SELECT * FROM accounts WHERE LOWER(email) = LOWER($1)', [value]);
    return r.rows[0] || null;
  }
  const phone = normalizePhone(value);
  if (!phone) return null;
  const r = await pool.query('SELECT * FROM accounts WHERE phone = $1', [phone]);
  return r.rows[0] || null;
}

function loginOf(body) {
  return body.login ?? body.phone ?? body.email;
}

// ─────────────────────────────────────────────────────────
// POST /auth/register
// Регистрация владельца с лендинга: имя, номер телефона, пароль.
// Сразу создаёт точку и пробный период, возвращает токены — человек попадает в кассу.
// ─────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { account, venue, staff, ownerPin } = await createAccount({
      name: req.body.name,
      venueName: req.body.venueName,
      phone: req.body.phone,
      email: req.body.email,
      password: req.body.password,
      pin: req.body.pin,
    });
    await pool.query('UPDATE accounts SET last_login_at = NOW() WHERE id = $1', [account.id]);

    const claims = { accountId: account.id, venueId: venue.id, staffId: staff.id, role: 'owner' };
    res.json({
      message: `Регистрация успешна! У вас ${TRIAL_DAYS} дней бесплатного доступа.`,
      accountId: account.id,
      venueId: venue.id,
      ownerPin,
      token: jwt.sign(claims, JWT_SECRET, { expiresIn: '30d' }),
      staffToken: jwt.sign(claims, JWT_SECRET, { expiresIn: '12h' }),
      account: accountPublic(account),
      venue,
      staff,
      features: [...featuresOf(account.plan)],
    });
  } catch (err) {
    if (err instanceof AccountError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /auth/login
// Вход владельца: номер телефона (или email) + пароль
// ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const login = loginOf(req.body);
  const { password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Введите номер телефона и пароль' });

  try {
    const account = await findAccountByLogin(login);
    if (!account) return res.status(401).json({ error: 'Неверный номер или пароль' });

    const valid = await bcrypt.compare(String(password), account.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный номер или пароль' });

    const venueRes = await pool.query('SELECT id, name FROM venues WHERE account_id = $1 ORDER BY id LIMIT 1', [account.id]);
    if (!venueRes.rows.length) return res.status(404).json({ error: 'Заведение не найдено' });
    const venue = venueRes.rows[0];

    const staffRes = await pool.query(
      `SELECT id, name, role FROM staff WHERE venue_id = $1 AND role = 'owner' LIMIT 1`,
      [venue.id]
    );
    const ownerStaff = staffRes.rows[0];

    await pool.query('UPDATE accounts SET last_login_at = NOW() WHERE id = $1', [account.id]);

    const token = jwt.sign(
      { accountId: account.id, venueId: venue.id, staffId: ownerStaff?.id, role: 'owner' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      account: accountPublic(account),
      venue: { id: venue.id, name: venue.name },
      features: [...featuresOf(account.plan)],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /auth/me
// Свежие данные аккаунта и доступные разделы — касса спрашивает при каждом запуске,
// чтобы смена тарифа в админке подхватывалась без повторного входа.
// ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  const { accountId, venueId, staffId } = req.user;
  const accRes = await pool.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
  const venueRes = await pool.query('SELECT id, name FROM venues WHERE id = $1 AND account_id = $2', [venueId, accountId]);
  const staffRes = staffId
    ? await pool.query('SELECT id, name, role FROM staff WHERE id = $1 AND venue_id = $2', [staffId, venueId])
    : { rows: [] };
  if (!accRes.rows.length || !venueRes.rows.length) return res.status(401).json({ error: 'Аккаунт не найден' });

  res.json({
    account: accountPublic(accRes.rows[0]),
    venue: venueRes.rows[0],
    staff: staffRes.rows[0] || null,
    features: [...req.features],
    readOnly: Boolean(req.user.ro),
  });
});

// ─────────────────────────────────────────────────────────
// POST /auth/pin-login
// Вход сотрудника по PIN-коду на конкретной точке (используется на кассе)
// Требует venueId (берётся из локального сохранённого токена владельца на устройстве)
// ─────────────────────────────────────────────────────────
router.post('/pin-login', async (req, res) => {
  const { venueId, pin } = req.body;
  if (!venueId || !pin) return res.status(400).json({ error: 'Укажите venueId и PIN' });

  if (!isValidPin(pin)) return res.status(401).json({ error: 'Неверный PIN-код' });

  try {
    const staffRes = await pool.query(
      `SELECT s.*, v.account_id FROM staff s JOIN venues v ON v.id = s.venue_id
       WHERE s.venue_id = $1 AND s.active = true ORDER BY s.id`,
      [venueId]
    );
    const staff = await findByPin(staffRes.rows, pin);
    if (!staff) return res.status(401).json({ error: 'Неверный PIN-код' });

    // PIN ещё открытым текстом (база до миграции) — сразу шифруем
    if (!isPinHash(staff.pin)) {
      await pool.query('UPDATE staff SET pin = $1 WHERE id = $2', [await hashPin(pin), staff.id]);
    }

    const token = jwt.sign(
      { accountId: staff.account_id, venueId, staffId: staff.id, role: staff.role },
      JWT_SECRET,
      { expiresIn: '12h' } // сессия кассира короче — на одну рабочую смену
    );

    res.json({ token, staff: { id: staff.id, name: staff.name, role: staff.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /auth/owner-pin
// Владелец задаёт свой PIN, подтверждая номером телефона (или email) + паролем.
// Нужен, если PIN забыт.
// ─────────────────────────────────────────────────────────
router.post('/owner-pin', async (req, res) => {
  const login = loginOf(req.body);
  const { password, pin } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Введите номер телефона и пароль' });
  if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN должен состоять из 4 цифр' });

  try {
    const account = await findAccountByLogin(login);
    if (!account || !(await bcrypt.compare(String(password), account.password_hash))) {
      return res.status(401).json({ error: 'Неверный номер или пароль' });
    }

    const venueRes = await pool.query('SELECT id FROM venues WHERE account_id = $1 ORDER BY id LIMIT 1', [account.id]);
    if (!venueRes.rows.length) return res.status(404).json({ error: 'Заведение не найдено' });
    const venueId = venueRes.rows[0].id;

    const staffRes = await pool.query('SELECT id, role, pin FROM staff WHERE venue_id = $1 ORDER BY id', [venueId]);
    const owner = staffRes.rows.find(s => s.role === 'owner');
    if (!owner) return res.status(404).json({ error: 'Владелец не найден среди сотрудников' });

    const others = staffRes.rows.filter(s => s.id !== owner.id);
    if (await findByPin(others, pin)) {
      return res.status(409).json({ error: 'Этот PIN уже занят другим сотрудником' });
    }

    await pool.query('UPDATE staff SET pin = $1, active = true WHERE id = $2', [await hashPin(pin), owner.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
