const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────
// POST /auth/register
// Регистрация нового владельца (приходит с лендинга, статус "trial")
// ─────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { name, email, password, venueName } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  try {
    const exists = await pool.query('SELECT id FROM accounts WHERE email = $1', [email]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Этот email уже зарегистрирован' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Новый аккаунт: 14 дней триал
    const accRes = await pool.query(
      `INSERT INTO accounts (name, email, password_hash, plan, status, expires_at)
       VALUES ($1,$2,$3,'business','trial', NOW() + INTERVAL '14 days') RETURNING id`,
      [name, email, passwordHash]
    );
    const accountId = accRes.rows[0].id;

    const venueRes = await pool.query(
      `INSERT INTO venues (account_id, name) VALUES ($1,$2) RETURNING id`,
      [accountId, venueName || 'Моя точка']
    );
    const venueId = venueRes.rows[0].id;

    // Создаём владельца как сотрудника с PIN 0000 по умолчанию
    await pool.query(
      `INSERT INTO staff (venue_id, name, role, pin) VALUES ($1,$2,'owner','0000')`,
      [venueId, name]
    );

    res.json({ message: 'Регистрация успешна! У вас 14 дней бесплатного доступа.', accountId, venueId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /auth/login
// Вход владельца по email + пароль -> получает venueId и список сотрудников
// ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Введите email и пароль' });

  try {
    const accRes = await pool.query('SELECT * FROM accounts WHERE email = $1', [email]);
    if (!accRes.rows.length) return res.status(401).json({ error: 'Неверный email или пароль' });

    const account = accRes.rows[0];
    const valid = await bcrypt.compare(password, account.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    const venueRes = await pool.query('SELECT id, name FROM venues WHERE account_id = $1', [account.id]);
    if (!venueRes.rows.length) return res.status(404).json({ error: 'Заведение не найдено' });
    const venue = venueRes.rows[0];

    const staffRes = await pool.query(
      `SELECT id, name, role FROM staff WHERE venue_id = $1 AND role = 'owner' LIMIT 1`,
      [venue.id]
    );
    const ownerStaff = staffRes.rows[0];

    const token = jwt.sign(
      { accountId: account.id, venueId: venue.id, staffId: ownerStaff?.id, role: 'owner' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      account: { id: account.id, name: account.name, email: account.email, plan: account.plan, status: account.status, expires_at: account.expires_at },
      venue: { id: venue.id, name: venue.name },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /auth/pin-login
// Вход сотрудника по PIN-коду на конкретной точке (используется на кассе)
// Требует venueId (берётся из локального сохранённого токена владельца на устройстве)
// ─────────────────────────────────────────────────────────
router.post('/pin-login', async (req, res) => {
  const { venueId, pin } = req.body;
  if (!venueId || !pin) return res.status(400).json({ error: 'Укажите venueId и PIN' });

  try {
    const staffRes = await pool.query(
      `SELECT s.*, v.account_id FROM staff s JOIN venues v ON v.id = s.venue_id
       WHERE s.venue_id = $1 AND s.pin = $2 AND s.active = true`,
      [venueId, pin]
    );
    if (!staffRes.rows.length) return res.status(401).json({ error: 'Неверный PIN-код' });

    const staff = staffRes.rows[0];

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

module.exports = router;
