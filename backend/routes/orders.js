const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── СМЕНЫ ────────────────────────────────────────────────────

// GET /orders/shift/current — текущая открытая смена
router.get('/shift/current', async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM shifts WHERE venue_id = $1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
    [req.user.venueId]
  );
  res.json(r.rows[0] || null);
});

// POST /orders/shift/open — открыть смену
router.post('/shift/open', async (req, res) => {
  const existing = await pool.query(
    `SELECT id FROM shifts WHERE venue_id = $1 AND closed_at IS NULL`,
    [req.user.venueId]
  );
  if (existing.rows.length) return res.status(409).json({ error: 'Смена уже открыта' });

  const r = await pool.query(
    `INSERT INTO shifts (venue_id, staff_id) VALUES ($1,$2) RETURNING *`,
    [req.user.venueId, req.user.staffId]
  );
  res.json(r.rows[0]);
});

// POST /orders/shift/close — закрыть текущую смену
router.post('/shift/close', async (req, res) => {
  const r = await pool.query(
    `UPDATE shifts SET closed_at = NOW()
     WHERE venue_id = $1 AND closed_at IS NULL RETURNING *`,
    [req.user.venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Открытой смены нет' });
  res.json(r.rows[0]);
});

// ── ЗАКАЗЫ ───────────────────────────────────────────────────

// GET /orders — история заказов (последние 50)
router.get('/', async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name as client_name FROM orders o
     LEFT JOIN clients c ON c.id = o.client_id
     WHERE o.venue_id = $1 ORDER BY o.created_at DESC LIMIT 50`,
    [req.user.venueId]
  );
  res.json(r.rows);
});

// POST /orders — создать заказ. Списывает склад автоматически по тех.картам.
// body: { items: [{ id: menu_item_id, qty }], pay_method, client_id }
router.post('/', async (req, res) => {
  const { venueId, staffId } = req.user;
  const { items, pay_method, client_id } = req.body;
  if (!items || !items.length || !pay_method) {
    return res.status(400).json({ error: 'Укажите items и pay_method' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Находим открытую смену
    const shiftRes = await client.query(
      `SELECT id FROM shifts WHERE venue_id = $1 AND closed_at IS NULL`,
      [venueId]
    );
    if (!shiftRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Смена не открыта. Откройте смену перед продажей.' });
    }
    const shiftId = shiftRes.rows[0].id;

    let total = 0;
    const itemsSnapshot = [];

    for (const { id, qty } of items) {
      const itemRes = await client.query('SELECT * FROM menu_items WHERE id = $1 AND venue_id = $2', [id, venueId]);
      if (!itemRes.rows.length) throw new Error('Блюдо не найдено: ' + id);
      const item = itemRes.rows[0];
      total += item.price * qty;
      itemsSnapshot.push({ name: item.name, qty, price: item.price });

      // Списываем ингредиенты по тех.карте
      const recipeRes = await client.query('SELECT * FROM recipes WHERE menu_item_id = $1', [id]);
      for (const r of recipeRes.rows) {
        const needed = r.grams * qty;
        const ingRes = await client.query('SELECT stock_grams FROM ingredients WHERE id = $1 FOR UPDATE', [r.ingredient_id]);
        const current = ingRes.rows[0]?.stock_grams ?? 0;
        if (current < needed) {
          throw new Error(`Недостаточно ингредиента для "${item.name}"`);
        }
        await client.query(
          'UPDATE ingredients SET stock_grams = stock_grams - $1, updated_at = NOW() WHERE id = $2',
          [needed, r.ingredient_id]
        );
      }
    }

    // Бонусы клиента
    if (client_id) {
      const venueRes = await client.query('SELECT bonus_pct FROM venues WHERE id = $1', [venueId]);
      const pct = venueRes.rows[0]?.bonus_pct ?? 5;
      const bonusEarned = Math.round(total * pct / 100);
      await client.query(
        `UPDATE clients SET bonus = bonus + $1, visits = visits + 1, total_spent = total_spent + $2
         WHERE id = $3 AND venue_id = $4`,
        [bonusEarned, total, client_id, venueId]
      );
    }

    // Обновляем выручку смены
    await client.query('UPDATE shifts SET revenue = revenue + $1 WHERE id = $2', [total, shiftId]);

    // Сохраняем заказ
    const orderRes = await client.query(
      `INSERT INTO orders (venue_id, shift_id, staff_id, client_id, total, pay_method, items_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [venueId, shiftId, staffId, client_id || null, total, pay_method, JSON.stringify(itemsSnapshot)]
    );

    await client.query('COMMIT');
    res.json(orderRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.message || 'Ошибка при создании заказа' });
  } finally {
    client.release();
  }
});

// ── КЛИЕНТЫ ──────────────────────────────────────────────────

router.get('/clients/all', async (req, res) => {
  const search = (req.query.search || '').trim();
  const params = [req.user.venueId];
  let sql = 'SELECT * FROM clients WHERE venue_id = $1';
  if (search) {
    params.push(`%${search}%`);
    sql += ' AND (name ILIKE $2 OR phone ILIKE $2 OR email ILIKE $2)';
  }
  sql += ' ORDER BY id DESC';
  const r = await pool.query(sql, params);
  res.json(r.rows);
});

router.post('/clients', requireRole('owner', 'admin'), async (req, res) => {
  const { name, phone, email, status, last_payment_at, expires_at } = req.body;
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  const r = await pool.query(
    `INSERT INTO clients (venue_id, name, phone, email, status, last_payment_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.venueId, name, phone || null, email || null, status || 'new', last_payment_at || null, expires_at || null]
  );
  res.json(r.rows[0]);
});

router.put('/clients/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { name, phone, email, status, last_payment_at, expires_at, bonus } = req.body;
  const r = await pool.query(
    `UPDATE clients SET name=COALESCE($1,name), phone=COALESCE($2,phone), email=COALESCE($3,email),
       status=COALESCE($4,status), last_payment_at=COALESCE($5,last_payment_at), expires_at=COALESCE($6,expires_at), bonus=COALESCE($7,bonus)
     WHERE id=$8 AND venue_id=$9 RETURNING *`,
    [name, phone, email, status, last_payment_at, expires_at, bonus, req.params.id, req.user.venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  res.json(r.rows[0]);
});

router.delete('/clients/:id', requireRole('owner', 'admin'), async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id=$1 AND venue_id=$2', [req.params.id, req.user.venueId]);
  res.json({ ok: true });
});

// ── СОТРУДНИКИ ───────────────────────────────────────────────

router.get('/staff/all', requireRole('owner', 'admin'), async (req, res) => {
  const r = await pool.query('SELECT id,name,phone,role,pin,active FROM staff WHERE venue_id=$1 ORDER BY id', [req.user.venueId]);
  res.json(r.rows);
});

router.post('/staff', requireRole('owner'), async (req, res) => {
  const { name, phone, role, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Укажите имя и PIN' });
  const r = await pool.query(
    'INSERT INTO staff (venue_id,name,phone,role,pin) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,phone,role,pin,active',
    [req.user.venueId, name, phone || null, role || 'cashier', pin]
  );
  res.json(r.rows[0]);
});

router.put('/staff/:id', requireRole('owner'), async (req, res) => {
  const { name, phone, role, pin, active } = req.body;
  const r = await pool.query(
    `UPDATE staff SET name=COALESCE($1,name), phone=COALESCE($2,phone), role=COALESCE($3,role),
       pin=COALESCE($4,pin), active=COALESCE($5,active)
     WHERE id=$6 AND venue_id=$7 RETURNING id,name,phone,role,pin,active`,
    [name, phone, role, pin, active, req.params.id, req.user.venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  res.json(r.rows[0]);
});

router.delete('/staff/:id', requireRole('owner'), async (req, res) => {
  await pool.query('DELETE FROM staff WHERE id=$1 AND venue_id=$2', [req.params.id, req.user.venueId]);
  res.json({ ok: true });
});

module.exports = router;
