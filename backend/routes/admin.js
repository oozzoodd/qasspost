// ═══════════════════════════════════════════════════════════
// АДМИН-РОУТЫ — личная панель владельца сервиса vzlyot.post.
// Защищены отдельным секретным ключом ADMIN_KEY (задаётся в Railway).
// Здесь: клиенты и их активность, подписки, оплаты, вход в кассу клиента для просмотра.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { JWT_SECRET } = require('../middleware/auth');
const { normalizePhone } = require('../utils/phone');
const { APP_TIMEZONE } = require('../utils/time');
const { isValidPlan, publicPlans, PLANS } = require('../config/plans');
const { createAccount, AccountError, MIN_PASSWORD_LENGTH } = require('../utils/accounts');
const { sheetRegistration, sheetPayment, sheetPing } = require('../utils/sheets');

const router = express.Router();

// Секретный ключ в заголовке x-admin-key. Сравнение за постоянное время.
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  const given = req.headers['x-admin-key'];
  if (!expected || typeof given !== 'string') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  next();
}
router.use(requireAdmin);

const COMPLETED = "(o.status IS NULL OR o.status = 'completed')";
const CURRENCIES = new Set(['USD', 'UZS']);
const METHODS = new Set(['click', 'payme', 'cash', 'card', 'transfer', 'other']);

// Подписка, у которой вышел срок, считается истёкшей, даже если статус в базе ещё «active»
const EFFECTIVE_STATUS = `CASE
  WHEN a.status IN ('trial','active') AND a.expires_at IS NOT NULL AND a.expires_at < NOW() THEN 'expired'
  ELSE a.status END`;

const ACCOUNT_LIST_SQL = `
  SELECT a.id, a.name, a.email, a.phone, a.plan, a.status, a.expires_at, a.created_at,
         a.note, a.last_login_at, a.last_seen_at,
         ${EFFECTIVE_STATUS} AS effective_status,
         v.id AS venue_id, v.name AS venue_name,
         COALESCE(u.orders_total, 0) AS orders_total,
         COALESCE(u.orders_7d, 0) AS orders_7d,
         COALESCE(u.orders_30d, 0) AS orders_30d,
         COALESCE(u.revenue_30d, 0) AS revenue_30d,
         u.last_order_at,
         (SELECT COUNT(*) FROM staff s WHERE s.venue_id = v.id AND s.active)::int AS staff_count,
         (SELECT COUNT(*) FROM menu_items m WHERE m.venue_id = v.id)::int AS menu_count,
         COALESCE(p.paid_usd, 0) AS paid_usd,
         COALESCE(p.paid_uzs, 0) AS paid_uzs,
         p.last_paid_at
  FROM accounts a
  LEFT JOIN LATERAL (
    SELECT id, name FROM venues WHERE account_id = a.id ORDER BY id LIMIT 1
  ) v ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS orders_total,
           COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '7 days')::int AS orders_7d,
           COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '30 days')::int AS orders_30d,
           COALESCE(SUM(o.total) FILTER (WHERE o.created_at >= NOW() - INTERVAL '30 days'), 0)::float8 AS revenue_30d,
           MAX(o.created_at) AS last_order_at
    FROM orders o WHERE o.venue_id = v.id AND ${COMPLETED}
  ) u ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount) FILTER (WHERE currency = 'USD'), 0)::float8 AS paid_usd,
           COALESCE(SUM(amount) FILTER (WHERE currency = 'UZS'), 0)::float8 AS paid_uzs,
           MAX(paid_at) AS last_paid_at
    FROM subscription_payments sp WHERE sp.account_id = a.id
  ) p ON true`;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function parseMonths(value) {
  const months = Number(value);
  return Number.isInteger(months) && months >= 1 && months <= 60 ? months : null;
}
async function loadAccount(id) {
  const r = await pool.query(`${ACCOUNT_LIST_SQL} WHERE a.id = $1`, [id]);
  return r.rows[0] || null;
}

// POST /admin/sheets/ping — проверить связь с Google Таблицей (ничего не записывает)
router.post('/sheets/ping', async (req, res) => {
  res.json(await sheetPing());
});

// GET /admin/plans — тарифы и цены (из config/plans.js)
router.get('/plans', (req, res) => res.json(publicPlans()));

// GET /admin/accounts — все клиенты с подпиской и активностью
router.get('/accounts', async (req, res) => {
  const r = await pool.query(`${ACCOUNT_LIST_SQL} ORDER BY a.created_at DESC`);
  res.json(r.rows);
});

// GET /admin/overview — сводка: клиенты по статусам и деньги по месяцам
router.get('/overview', async (req, res) => {
  const totals = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE s = 'active')::int AS active,
           COUNT(*) FILTER (WHERE s = 'trial')::int AS trial,
           COUNT(*) FILTER (WHERE s = 'expired')::int AS expired,
           COUNT(*) FILTER (WHERE s = 'blocked')::int AS blocked,
           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_7d,
           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_30d,
           COUNT(*) FILTER (WHERE s IN ('active','trial') AND expires_at < NOW() + INTERVAL '7 days')::int AS expiring_7d
    FROM (SELECT a.created_at, a.expires_at, ${EFFECTIVE_STATUS} AS s FROM accounts a) x`);

  // «Работают» — были продажи за 7 дней; «спят» — доступ есть, а продаж за 7 дней нет
  const usage = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE sold)::int AS working_7d,
           COUNT(*) FILTER (WHERE NOT sold AND s IN ('active','trial'))::int AS sleeping
    FROM (
      SELECT ${EFFECTIVE_STATUS} AS s,
             EXISTS (
               SELECT 1 FROM orders o JOIN venues v ON v.id = o.venue_id
               WHERE v.account_id = a.id AND ${COMPLETED} AND o.created_at >= NOW() - INTERVAL '7 days'
             ) AS sold
      FROM accounts a
    ) x`);

  const months = await pool.query(`
    SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month,
           currency,
           SUM(amount)::float8 AS total,
           COUNT(*)::int AS count
    FROM subscription_payments
    WHERE paid_at >= date_trunc('month', NOW()) - INTERVAL '5 months'
    GROUP BY 1, 2 ORDER BY 1 DESC, 2`);

  res.json({ ...totals.rows[0], ...usage.rows[0], payments_by_month: months.rows });
});

// GET /admin/accounts/:id — карточка клиента: активность по дням, сотрудники, оплаты
router.get('/accounts/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const account = id && await loadAccount(id);
  if (!account) return res.status(404).json({ error: 'Аккаунт не найден' });

  const venueId = account.venue_id;
  const [daily, staff, payments, counts] = await Promise.all([
    pool.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              COALESCE(x.orders, 0)::int AS orders,
              COALESCE(x.revenue, 0)::float8 AS revenue
       FROM generate_series(
              (NOW() AT TIME ZONE '${APP_TIMEZONE}')::date - 13,
              (NOW() AT TIME ZONE '${APP_TIMEZONE}')::date,
              INTERVAL '1 day') d
       LEFT JOIN (
         SELECT ((o.created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${APP_TIMEZONE}')::date AS day,
                COUNT(*) AS orders, SUM(o.total) AS revenue
         FROM orders o
         WHERE o.venue_id = $1 AND ${COMPLETED} AND o.created_at >= NOW() - INTERVAL '15 days'
         GROUP BY 1
       ) x ON x.day = d::date
       ORDER BY d`,
      [venueId]
    ),
    pool.query('SELECT id, name, phone, role, active FROM staff WHERE venue_id = $1 ORDER BY id', [venueId]),
    pool.query('SELECT * FROM subscription_payments WHERE account_id = $1 ORDER BY paid_at DESC, id DESC', [id]),
    pool.query(
      `SELECT (SELECT COUNT(*) FROM ingredients WHERE venue_id = $1)::int AS stock_count,
              (SELECT COUNT(*) FROM recipes r JOIN menu_items m ON m.id = r.menu_item_id WHERE m.venue_id = $1)::int AS recipes_count,
              (SELECT COUNT(*) FROM clients WHERE venue_id = $1)::int AS clients_count,
              (SELECT COUNT(*) FROM shifts WHERE venue_id = $1)::int AS shifts_count,
              (SELECT COUNT(*) FROM cash_expenses WHERE venue_id = $1)::int AS expenses_count,
              (SELECT MAX(opened_at) FROM shifts WHERE venue_id = $1) AS last_shift_at`,
      [venueId]
    ),
  ]);

  res.json({ account, daily: daily.rows, staff: staff.rows, payments: payments.rows, counts: counts.rows[0] });
});

// POST /admin/accounts — создать клиента вручную (например, по звонку)
// body: { name, venueName, phone, password?, plan?, days? }
router.post('/accounts', async (req, res) => {
  const generated = !req.body.password;
  const password = generated ? crypto.randomBytes(6).toString('base64url') : String(req.body.password);
  try {
    const { account, venue, ownerPin } = await createAccount({
      name: req.body.name,
      venueName: req.body.venueName,
      phone: req.body.phone,
      email: req.body.email,
      password,
      plan: req.body.plan,
      days: req.body.days === undefined || req.body.days === '' ? undefined : Number(req.body.days),
    });
    sheetRegistration({ account, venue, source: 'Админка' });
    res.json({ account: await loadAccount(account.id), ownerPin, password: generated ? password : undefined });
  } catch (err) {
    if (err instanceof AccountError) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
});

// PUT /admin/accounts/:id — правка данных клиента
// body: любые из { name, phone, email, plan, expires_at, note }
router.put('/accounts/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Аккаунт не найден' });

  const sets = [];
  const params = [];
  const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
  const has = key => Object.prototype.hasOwnProperty.call(req.body, key);

  if (has('name')) {
    const name = String(req.body.name ?? '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'Проверьте имя' });
    set('name', name);
  }
  if (has('phone')) {
    const raw = String(req.body.phone ?? '').trim();
    const phone = raw ? normalizePhone(raw) : null;
    if (raw && !phone) return res.status(400).json({ error: 'Проверьте номер телефона' });
    set('phone', phone);
  }
  if (has('email')) {
    const email = String(req.body.email ?? '').trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Проверьте email' });
    set('email', email);
  }
  if (has('plan')) {
    if (!isValidPlan(req.body.plan)) return res.status(400).json({ error: 'Неизвестный тариф' });
    set('plan', req.body.plan);
  }
  if (has('expires_at')) {
    const date = new Date(req.body.expires_at);
    if (!req.body.expires_at || Number.isNaN(date.getTime())) return res.status(400).json({ error: 'Проверьте дату' });
    set('expires_at', date);
  }
  if (has('note')) {
    set('note', String(req.body.note ?? '').trim().slice(0, 2000) || null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Нечего менять' });

  params.push(id);
  try {
    const r = await pool.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Аккаунт не найден' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такой номер или email уже есть у другого клиента' });
    throw err;
  }
  res.json({ account: await loadAccount(id) });
});

// POST /admin/accounts/:id/activate — включить тариф на N месяцев с сегодняшнего дня
// body: { plan: 'start'|'business'|'network', months }
router.post('/accounts/:id/activate', async (req, res) => {
  const id = parseId(req.params.id);
  const months = parseMonths(req.body.months);
  const { plan } = req.body;
  if (!isValidPlan(plan) || !months) return res.status(400).json({ error: 'Укажите тариф и срок' });

  const r = await pool.query(
    `UPDATE accounts SET
       plan = $1,
       status = 'active',
       expires_at = NOW() + ($2 || ' months')::interval
     WHERE id = $3 RETURNING id`,
    [plan, String(months), id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Аккаунт не найден' });
  res.json({ message: `Активирован тариф «${PLANS[plan].name}» на ${months} мес.`, account: await loadAccount(id) });
});

// POST /admin/accounts/:id/extend — продлить на N месяцев от текущей даты окончания
router.post('/accounts/:id/extend', async (req, res) => {
  const id = parseId(req.params.id);
  const months = parseMonths(req.body.months);
  if (!months) return res.status(400).json({ error: 'Укажите срок' });

  const r = await pool.query(
    `UPDATE accounts SET
       status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'active' END,
       expires_at = GREATEST(COALESCE(expires_at, NOW()), NOW()) + ($1 || ' months')::interval
     WHERE id = $2 RETURNING id`,
    [String(months), id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Аккаунт не найден' });
  res.json({ message: `Продлено на ${months} мес.`, account: await loadAccount(id) });
});

// POST /admin/accounts/:id/block — заблокировать (например, при неуплате)
router.post('/accounts/:id/block', async (req, res) => {
  const id = parseId(req.params.id);
  const r = await pool.query(`UPDATE accounts SET status = 'blocked' WHERE id = $1 RETURNING id`, [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Аккаунт не найден' });
  res.json({ message: 'Аккаунт заблокирован', account: await loadAccount(id) });
});

// POST /admin/accounts/:id/unblock
router.post('/accounts/:id/unblock', async (req, res) => {
  const id = parseId(req.params.id);
  const r = await pool.query(`UPDATE accounts SET status = 'active' WHERE id = $1 AND status = 'blocked' RETURNING id`, [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Аккаунт не найден или не заблокирован' });
  res.json({ message: 'Аккаунт разблокирован', account: await loadAccount(id) });
});

// POST /admin/accounts/:id/password — задать владельцу новый пароль (если забыл).
// Без body.password пароль придумывается сам и возвращается один раз.
router.post('/accounts/:id/password', async (req, res) => {
  const id = parseId(req.params.id);
  const generated = !req.body.password;
  const password = generated ? crypto.randomBytes(6).toString('base64url') : String(req.body.password);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Пароль — минимум ${MIN_PASSWORD_LENGTH} символов` });
  }
  const r = await pool.query(
    'UPDATE accounts SET password_hash = $1 WHERE id = $2 RETURNING id',
    [await bcrypt.hash(password, 10), id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Аккаунт не найден' });
  res.json({ message: 'Пароль изменён', password });
});

// POST /admin/accounts/:id/impersonate — войти в кассу клиента посмотреть.
// Токен на 1 час и только для чтения: изменить что-либо в чужой кассе нельзя.
router.post('/accounts/:id/impersonate', async (req, res) => {
  const id = parseId(req.params.id);
  const r = await pool.query(
    `SELECT v.id AS venue_id,
            (SELECT s.id FROM staff s WHERE s.venue_id = v.id AND s.role = 'owner' ORDER BY s.id LIMIT 1) AS staff_id
     FROM venues v WHERE v.account_id = $1 ORDER BY v.id LIMIT 1`,
    [id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'У аккаунта нет заведения' });
  const token = jwt.sign(
    { accountId: id, venueId: r.rows[0].venue_id, staffId: r.rows[0].staff_id, role: 'owner', ro: true },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  res.json({ token });
});

// ── ОПЛАТЫ ───────────────────────────────────────────────────

// GET /admin/payments — последние оплаты по всем клиентам
router.get('/payments', async (req, res) => {
  const r = await pool.query(
    `SELECT sp.*, a.name AS account_name, a.phone AS account_phone,
            (SELECT name FROM venues WHERE account_id = a.id ORDER BY id LIMIT 1) AS venue_name
     FROM subscription_payments sp
     JOIN accounts a ON a.id = sp.account_id
     ORDER BY sp.paid_at DESC, sp.id DESC
     LIMIT 300`
  );
  res.json(r.rows);
});

// POST /admin/accounts/:id/payments — записать оплату и (по желанию) сразу продлить доступ
// body: { amount, currency: 'USD'|'UZS', method, months?, plan?, comment?, paid_at?, extend? }
router.post('/accounts/:id/payments', async (req, res) => {
  const id = parseId(req.params.id);
  const amount = Number(req.body.amount);
  const currency = String(req.body.currency || 'USD').toUpperCase();
  const method = String(req.body.method || 'other');
  const comment = String(req.body.comment || '').trim().slice(0, 500) || null;
  const extend = req.body.extend !== false;
  const months = req.body.months === undefined || req.body.months === null || req.body.months === ''
    ? null : parseMonths(req.body.months);
  const plan = req.body.plan || null;
  const paidAt = req.body.paid_at ? new Date(req.body.paid_at) : new Date();

  if (!id) return res.status(404).json({ error: 'Аккаунт не найден' });
  if (!Number.isInteger(amount) || amount <= 0 || amount > 2000000000) {
    return res.status(400).json({ error: 'Укажите сумму целым числом' });
  }
  if (!CURRENCIES.has(currency) || !METHODS.has(method)) {
    return res.status(400).json({ error: 'Проверьте валюту и способ оплаты' });
  }
  if (plan && !isValidPlan(plan)) return res.status(400).json({ error: 'Неизвестный тариф' });
  if (Number.isNaN(paidAt.getTime())) return res.status(400).json({ error: 'Проверьте дату оплаты' });
  if (extend && !months) return res.status(400).json({ error: 'Укажите, на сколько месяцев продлить' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const acc = await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    if (!acc.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Аккаунт не найден' });
    }

    const payment = await client.query(
      `INSERT INTO subscription_payments (account_id, amount, currency, method, plan, months, comment, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, amount, currency, method, plan, months, comment, paidAt]
    );

    if (extend) {
      // Пробный период не «докупается»: оплаченный срок идёт с сегодняшнего дня.
      // Действующая оплаченная подписка продлевается от своей даты окончания.
      await client.query(
        `UPDATE accounts SET
           plan = COALESCE($1, plan),
           expires_at = CASE
             WHEN status = 'active' THEN GREATEST(COALESCE(expires_at, NOW()), NOW())
             ELSE NOW() END + ($2 || ' months')::interval,
           status = 'active'
         WHERE id = $3`,
        [plan, String(months), id]
      );
    }

    await client.query('COMMIT');
    const account = await loadAccount(id);
    sheetPayment({ payment: payment.rows[0], account }); // в вашу Google Таблицу, не ждём ответа
    res.json({ payment: payment.rows[0], account });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /admin/payments/:id — убрать ошибочную запись (срок доступа при этом не меняется)
router.delete('/payments/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const r = await pool.query('DELETE FROM subscription_payments WHERE id = $1 RETURNING id', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Оплата не найдена' });
  res.json({ ok: true });
});

// GET /admin/stats — общая статистика (оставлено для совместимости со старыми запросами)
router.get('/stats', async (req, res) => {
  const totals = await pool.query(`
    SELECT
      COUNT(*) as total_accounts,
      COUNT(*) FILTER (WHERE status='active') as active,
      COUNT(*) FILTER (WHERE status='trial') as trial,
      COUNT(*) FILTER (WHERE status='expired') as expired,
      COUNT(*) FILTER (WHERE status='blocked') as blocked
    FROM accounts
  `);
  res.json(totals.rows[0]);
});

module.exports = router;
