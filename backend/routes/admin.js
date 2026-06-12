// ═══════════════════════════════════════════════════════════
// АДМИН-РОУТЫ — это твоя личная панель управления клиентами.
// Защищены отдельным секретным ключом ADMIN_KEY (задаётся в Railway).
// Сюда заходишь ТОЛЬКО ТЫ, чтобы активировать/продлевать аккаунты клиентов.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// Простая защита — секретный ключ в заголовке x-admin-key
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  next();
}
router.use(requireAdmin);

// GET /admin/accounts — список всех аккаунтов-клиентов
router.get('/accounts', async (req, res) => {
  const r = await pool.query(
    `SELECT a.id, a.name, a.email, a.plan, a.status, a.expires_at, a.created_at,
            v.id as venue_id, v.name as venue_name
     FROM accounts a LEFT JOIN venues v ON v.account_id = a.id
     ORDER BY a.created_at DESC`
  );
  res.json(r.rows);
});

// POST /admin/accounts/:id/activate
// body: { plan: 'start'|'business'|'network', months: 1|3|6|12 }
router.post('/accounts/:id/activate', async (req, res) => {
  const { plan, months } = req.body;
  if (!plan || !months) return res.status(400).json({ error: 'Укажите plan и months' });

  const r = await pool.query(
    `UPDATE accounts SET
       plan = $1,
       status = 'active',
       expires_at = NOW() + ($2 || ' months')::interval
     WHERE id = $3 RETURNING *`,
    [plan, months, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Аккаунт не найден' });
  res.json({ message: `Активирован тариф "${plan}" на ${months} мес.`, account: r.rows[0] });
});

// POST /admin/accounts/:id/extend — продлить на N месяцев от текущей даты окончания
router.post('/accounts/:id/extend', async (req, res) => {
  const { months } = req.body;
  if (!months) return res.status(400).json({ error: 'Укажите months' });

  const r = await pool.query(
    `UPDATE accounts SET
       status = 'active',
       expires_at = GREATEST(expires_at, NOW()) + ($1 || ' months')::interval
     WHERE id = $2 RETURNING *`,
    [months, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Не найден' });
  res.json({ message: `Продлено на ${months} мес.`, account: r.rows[0] });
});

// POST /admin/accounts/:id/block — заблокировать (например, при неуплате)
router.post('/accounts/:id/block', async (req, res) => {
  const r = await pool.query(`UPDATE accounts SET status='blocked' WHERE id=$1 RETURNING *`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найден' });
  res.json({ message: 'Аккаунт заблокирован', account: r.rows[0] });
});

// POST /admin/accounts/:id/unblock
router.post('/accounts/:id/unblock', async (req, res) => {
  const r = await pool.query(`UPDATE accounts SET status='active' WHERE id=$1 RETURNING *`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найден' });
  res.json({ message: 'Аккаунт разблокирован', account: r.rows[0] });
});

// GET /admin/stats — общая статистика по всем клиентам (для тебя)
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
