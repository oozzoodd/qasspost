const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const COMPLETED_ORDER_SQL = "(status IS NULL OR status = 'completed')";

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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const shiftRes = await client.query(
      `SELECT * FROM shifts
       WHERE venue_id = $1 AND closed_at IS NULL
       ORDER BY opened_at DESC LIMIT 1
       FOR UPDATE`,
      [req.user.venueId]
    );
    if (!shiftRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Открытой смены нет' });
    }

    const shift = shiftRes.rows[0];
    const closeTimeRes = await client.query('SELECT NOW() AS closed_at');
    const closedAt = closeTimeRes.rows[0].closed_at;

    const summaryRes = await client.query(
      `SELECT
         COALESCE(SUM(total), 0)::int AS total,
         COALESCE(SUM(CASE WHEN pay_method = 'cash' AND COALESCE(cash_amount, 0) = 0 THEN total ELSE COALESCE(cash_amount, 0) END), 0)::int AS cash,
         COALESCE(SUM(CASE WHEN pay_method = 'card' AND COALESCE(card_amount, 0) = 0 THEN total ELSE COALESCE(card_amount, 0) END), 0)::int AS card,
         COUNT(*)::int AS orders_count
       FROM orders
       WHERE venue_id = $1 AND shift_id = $2
         AND ${COMPLETED_ORDER_SQL}`,
      [req.user.venueId, shift.id]
    );
    const summary = summaryRes.rows[0];

    const expensesRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS total
       FROM cash_expenses
       WHERE venue_id = $1 AND shift_id = $2`,
      [req.user.venueId, shift.id]
    );

    const stockIncomeRes = await client.query(
      `SELECT COALESCE(SUM(total_amount), 0)::int AS total
       FROM stock_incomes
       WHERE venue_id = $1
         AND created_at >= $2
         AND created_at <= $3`,
      [req.user.venueId, shift.opened_at, closedAt]
    );

    const expensesTotal = expensesRes.rows[0].total || 0;
    const stockIncomeTotal = stockIncomeRes.rows[0].total || 0;
    const netProfit = summary.total - expensesTotal - stockIncomeTotal;
    const marginPercent = summary.total > 0
      ? Math.round((netProfit / summary.total * 100) * 100) / 100
      : 0;

    const r = await client.query(
      `UPDATE shifts
       SET closed_at = $1,
           revenue = $2,
           cash_total = $3,
           card_total = $4,
           orders_count = $5,
           expenses_total = $6,
           stock_income_total = $7,
           net_profit = $8,
           margin_percent = $9
       WHERE id = $10 AND venue_id = $11
       RETURNING *`,
      [
        closedAt,
        summary.total,
        summary.cash,
        summary.card,
        summary.orders_count,
        expensesTotal,
        stockIncomeTotal,
        netProfit,
        marginPercent,
        shift.id,
        req.user.venueId,
      ]
    );

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка при закрытии смены' });
  } finally {
    client.release();
  }
});

// GET /orders/shift/summary — сводка по текущей открытой смене
router.get('/shift/summary', async (req, res) => {
  const shiftRes = await pool.query(
    `SELECT id FROM shifts
     WHERE venue_id = $1 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [req.user.venueId]
  );

  if (!shiftRes.rows.length) {
    return res.json({ total: 0, cash: 0, card: 0, orders_count: 0 });
  }

  const r = await pool.query(
    `SELECT
       COALESCE(SUM(total), 0)::int AS total,
       COALESCE(SUM(CASE WHEN pay_method = 'cash' AND COALESCE(cash_amount, 0) = 0 THEN total ELSE COALESCE(cash_amount, 0) END), 0)::int AS cash,
       COALESCE(SUM(CASE WHEN pay_method = 'card' AND COALESCE(card_amount, 0) = 0 THEN total ELSE COALESCE(card_amount, 0) END), 0)::int AS card,
       COUNT(*)::int AS orders_count
     FROM orders
     WHERE venue_id = $1 AND shift_id = $2
       AND ${COMPLETED_ORDER_SQL}`,
    [req.user.venueId, shiftRes.rows[0].id]
  );

  res.json(r.rows[0]);
});

// GET /orders/shifts/history — последние закрытые смены
router.get('/shifts/history', requireRole('owner', 'admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT
       s.id,
       s.opened_at,
       s.closed_at,
       s.revenue,
       s.cash_total,
       s.card_total,
       s.orders_count,
       s.staff_id,
       st.name AS staff_name
     FROM shifts s
     LEFT JOIN staff st ON st.id = s.staff_id
     WHERE s.venue_id = $1 AND s.closed_at IS NOT NULL
     ORDER BY s.closed_at DESC
     LIMIT 50`,
    [req.user.venueId]
  );
  res.json(r.rows);
});

function isValidDateParam(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function financePeriodSql(query) {
  const period = query.period || 'today';
  const ranges = {
    today: { start: 'CURRENT_DATE', end: "CURRENT_DATE + INTERVAL '1 day'", params: [] },
    yesterday: { start: "CURRENT_DATE - INTERVAL '1 day'", end: 'CURRENT_DATE', params: [] },
    '7d': { start: "NOW() - INTERVAL '7 days'", end: 'NOW()', params: [] },
    '30d': { start: "NOW() - INTERVAL '30 days'", end: 'NOW()', params: [] },
    this_week: { start: "date_trunc('week', CURRENT_DATE)", end: "date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'", params: [] },
    last_week: { start: "date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'", end: "date_trunc('week', CURRENT_DATE)", params: [] },
    this_month: { start: "date_trunc('month', CURRENT_DATE)", end: "date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'", params: [] },
    last_month: { start: "date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'", end: "date_trunc('month', CURRENT_DATE)", params: [] },
    quarter: { start: "date_trunc('quarter', CURRENT_DATE)", end: "date_trunc('quarter', CURRENT_DATE) + INTERVAL '3 months'", params: [] },
    year: { start: "date_trunc('year', CURRENT_DATE)", end: "date_trunc('year', CURRENT_DATE) + INTERVAL '1 year'", params: [] },
  };

  if (period === 'custom') {
    const { start, end } = query;
    if (!isValidDateParam(start) || !isValidDateParam(end) || start > end) return null;
    return { start: '$2::date', end: "($3::date + INTERVAL '1 day')", params: [start, end] };
  }

  return ranges[period] || null;
}

// GET /orders/finance/summary — финансовая сводка за период
router.get('/finance/summary', requireRole('owner', 'admin'), async (req, res) => {
  const period = financePeriodSql(req.query);
  if (!period) return res.status(400).json({ error: 'Неверный период' });
  const params = [req.user.venueId, ...period.params];

  const revenueRes = await pool.query(
    `SELECT
       COALESCE(SUM(total), 0)::int AS revenue,
       COALESCE(SUM(CASE WHEN pay_method = 'cash' AND COALESCE(cash_amount, 0) = 0 THEN total ELSE COALESCE(cash_amount, 0) END), 0)::int AS cash_total,
       COALESCE(SUM(CASE WHEN pay_method = 'card' AND COALESCE(card_amount, 0) = 0 THEN total ELSE COALESCE(card_amount, 0) END), 0)::int AS card_total,
       COUNT(*)::int AS orders_count
     FROM orders
     WHERE venue_id = $1
       AND ${COMPLETED_ORDER_SQL}
       AND created_at >= ${period.start}
       AND created_at < ${period.end}`,
    params
  );

  const expensesRes = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS expenses_total
     FROM cash_expenses
     WHERE venue_id = $1
       AND created_at >= ${period.start}
       AND created_at < ${period.end}`,
    params
  );

  const stockRes = await pool.query(
    `SELECT COALESCE(SUM(total_amount), 0)::int AS stock_income_total
     FROM stock_incomes
     WHERE venue_id = $1
       AND created_at >= ${period.start}
       AND created_at < ${period.end}`,
    params
  );

  const shiftsRes = await pool.query(
    `SELECT COUNT(*)::int AS shifts_count
     FROM shifts
     WHERE venue_id = $1
       AND closed_at IS NOT NULL
       AND closed_at >= ${period.start}
       AND closed_at < ${period.end}`,
    params
  );

  const revenue = revenueRes.rows[0].revenue || 0;
  const expensesTotal = expensesRes.rows[0].expenses_total || 0;
  const stockIncomeTotal = stockRes.rows[0].stock_income_total || 0;
  const netProfit = revenue - expensesTotal - stockIncomeTotal;
  const marginPercent = revenue > 0 ? Math.round((netProfit / revenue * 100) * 100) / 100 : 0;

  res.json({
    ...revenueRes.rows[0],
    expenses_total: expensesTotal,
    stock_income_total: stockIncomeTotal,
    net_profit: netProfit,
    margin_percent: marginPercent,
    shifts_count: shiftsRes.rows[0].shifts_count || 0,
  });
});

// GET /orders/finance/shifts — закрытые смены за период
router.get('/finance/shifts', requireRole('owner', 'admin'), async (req, res) => {
  const period = financePeriodSql(req.query);
  if (!period) return res.status(400).json({ error: 'Неверный период' });
  const params = [req.user.venueId, ...period.params];

  const r = await pool.query(
    `SELECT
       id,
       opened_at,
       closed_at,
       COALESCE(revenue, 0)::int AS revenue,
       COALESCE(cash_total, 0)::int AS cash_total,
       COALESCE(card_total, 0)::int AS card_total,
       COALESCE(expenses_total, 0)::int AS expenses_total,
       COALESCE(stock_income_total, 0)::int AS stock_income_total,
       COALESCE(net_profit, 0)::int AS net_profit,
       COALESCE(margin_percent, 0) AS margin_percent,
       COALESCE(orders_count, 0)::int AS orders_count
     FROM shifts
     WHERE venue_id = $1
       AND closed_at IS NOT NULL
       AND closed_at >= ${period.start}
       AND closed_at < ${period.end}
     ORDER BY closed_at DESC
     LIMIT 50`,
    params
  );
  res.json(r.rows);
});

// POST /orders/expenses — добавить расход в текущую открытую смену
router.post('/expenses', async (req, res) => {
  const amount = Number(req.body.amount);
  const category = String(req.body.category || '').trim();
  const comment = String(req.body.comment || '').trim();

  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Укажите корректную сумму расхода' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const shiftRes = await client.query(
      `SELECT id FROM shifts
       WHERE venue_id = $1 AND closed_at IS NULL
       ORDER BY opened_at DESC LIMIT 1
       FOR UPDATE`,
      [req.user.venueId]
    );
    if (!shiftRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Смена не открыта. Откройте смену перед добавлением расхода.' });
    }

    const r = await client.query(
      `INSERT INTO cash_expenses (venue_id, staff_id, shift_id, amount, category, comment)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        req.user.venueId,
        req.user.staffId,
        shiftRes.rows[0].id,
        amount,
        category || null,
        comment || null,
      ]
    );

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка при сохранении расхода' });
  } finally {
    client.release();
  }
});

// GET /orders/expenses — последние расходы заведения
router.get('/expenses', async (req, res) => {
  const r = await pool.query(
    `SELECT e.*, s.name AS staff_name
     FROM cash_expenses e
     LEFT JOIN staff s ON s.id = e.staff_id
     WHERE e.venue_id = $1
     ORDER BY e.created_at DESC
     LIMIT 50`,
    [req.user.venueId]
  );
  res.json(r.rows);
});

// GET /orders/expenses/summary — расходы текущей открытой смены
router.get('/expenses/summary', async (req, res) => {
  const shiftRes = await pool.query(
    `SELECT id FROM shifts
     WHERE venue_id = $1 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [req.user.venueId]
  );

  if (!shiftRes.rows.length) {
    return res.json({ total_expenses: 0 });
  }

  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS total_expenses
     FROM cash_expenses
     WHERE venue_id = $1 AND shift_id = $2`,
    [req.user.venueId, shiftRes.rows[0].id]
  );
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

router.get('/today-summary', async (req, res) => {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(total), 0)::int AS total,
       COALESCE(SUM(CASE WHEN pay_method = 'cash' AND COALESCE(cash_amount, 0) = 0 THEN total ELSE COALESCE(cash_amount, 0) END), 0)::int AS cash,
       COALESCE(SUM(CASE WHEN pay_method = 'card' AND COALESCE(card_amount, 0) = 0 THEN total ELSE COALESCE(card_amount, 0) END), 0)::int AS card,
       COUNT(*)::int AS orders_count
     FROM orders
     WHERE venue_id = $1
       AND ${COMPLETED_ORDER_SQL}
       AND created_at >= CURRENT_DATE
       AND created_at < CURRENT_DATE + INTERVAL '1 day'`,
    [req.user.venueId]
  );
  res.json(r.rows[0]);
});

// POST /orders — создать заказ. Списывает склад автоматически по тех.картам.
// body: { items: [{ id: menu_item_id, qty }], pay_method, client_id, cash_amount, card_amount }
router.post('/', async (req, res) => {
  const { venueId, staffId } = req.user;
  const { items, pay_method, client_id, cash_amount, card_amount } = req.body;
  if (!items || !items.length || !pay_method) {
    return res.status(400).json({ error: 'Укажите items и pay_method' });
  }
  if (!['cash', 'card', 'mixed'].includes(pay_method)) {
    return res.status(400).json({ error: 'Неверный способ оплаты' });
  }
  if (!Array.isArray(items) || items.some(item => !Number.isInteger(+item.id) || !Number.isInteger(+item.qty) || +item.qty <= 0 || +item.qty > 99)) {
    return res.status(400).json({ error: 'Проверьте позиции заказа' });
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

    for (const rawItem of items) {
      const id = +rawItem.id;
      const qty = +rawItem.qty;
      const itemRes = await client.query('SELECT * FROM menu_items WHERE id = $1 AND venue_id = $2', [id, venueId]);
      if (!itemRes.rows.length) throw new Error('Блюдо не найдено: ' + id);
      const item = itemRes.rows[0];
      total += item.price * qty;
      itemsSnapshot.push({ id, name: item.name, qty, price: item.price });

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

    let cashAmount = 0;
    let cardAmount = 0;
    if (pay_method === 'cash') {
      cashAmount = total;
    } else if (pay_method === 'card') {
      cardAmount = total;
    } else {
      const rawCashAmount = Number(cash_amount);
      const rawCardAmount = Number(card_amount);
      if (!Number.isInteger(rawCashAmount) || !Number.isInteger(rawCardAmount) || rawCashAmount < 0 || rawCardAmount < 0) {
        throw new Error('Укажите корректные суммы оплаты');
      }
      cashAmount = rawCashAmount;
      cardAmount = rawCardAmount;
      if (cashAmount + cardAmount !== total) {
        throw new Error('Сумма оплаты не совпадает с итогом заказа');
      }
    }

    // Бонусы клиента
    let bonusEarned = 0;
    if (client_id) {
      const venueRes = await client.query('SELECT bonus_pct FROM venues WHERE id = $1', [venueId]);
      const pct = venueRes.rows[0]?.bonus_pct ?? 5;
      bonusEarned = Math.round(total * pct / 100);
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
      `INSERT INTO orders (venue_id, shift_id, staff_id, client_id, total, pay_method, cash_amount, card_amount, status, bonus_earned, items_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10) RETURNING *`,
      [venueId, shiftId, staffId, client_id || null, total, pay_method, cashAmount, cardAmount, bonusEarned, JSON.stringify(itemsSnapshot)]
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

// POST /orders/:id/cancel — мягкая отмена чека без удаления заказа
router.post('/:id/cancel', requireRole('owner', 'admin'), async (req, res) => {
  const orderId = +req.params.id;
  const foodPrepared = req.body.food_prepared === true;
  const reason = String(req.body.reason || '').trim();

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'Некорректный заказ' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `SELECT o.*, sh.closed_at AS shift_closed_at
       FROM orders o
       JOIN shifts sh ON sh.id = o.shift_id AND sh.venue_id = o.venue_id
       WHERE o.id = $1 AND o.venue_id = $2
       FOR UPDATE OF o, sh`,
      [orderId, req.user.venueId]
    );

    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Заказ не найден' });
    }

    const order = orderRes.rows[0];
    if (order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Чек уже отменён' });
    }
    if (order.shift_closed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Отмена недоступна: смена закрыта' });
    }

    if (!foodPrepared) {
      const items = Array.isArray(order.items_json)
        ? order.items_json
        : JSON.parse(order.items_json || '[]');

      for (const item of items) {
        const menuItemId = +item.id;
        const qty = +item.qty;
        if (!Number.isInteger(menuItemId) || menuItemId <= 0) {
          throw new Error('Невозможно вернуть склад: в чеке нет id блюда');
        }
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error('Невозможно вернуть склад: некорректное количество');
        }

        const recipeRes = await client.query(
          `SELECT r.ingredient_id, r.grams
           FROM recipes r
           JOIN menu_items m ON m.id = r.menu_item_id
           WHERE r.menu_item_id = $1 AND m.venue_id = $2`,
          [menuItemId, req.user.venueId]
        );

        for (const recipe of recipeRes.rows) {
          const restoreAmount = recipe.grams * qty;
          await client.query(
            `UPDATE ingredients
             SET stock_grams = stock_grams + $1, updated_at = NOW()
             WHERE id = $2 AND venue_id = $3`,
            [restoreAmount, recipe.ingredient_id, req.user.venueId]
          );
        }
      }
    }

    if (order.client_id) {
      await client.query(
        `UPDATE clients
         SET visits = GREATEST(COALESCE(visits, 0) - 1, 0),
             total_spent = GREATEST(COALESCE(total_spent, 0) - $1, 0),
             bonus = GREATEST(COALESCE(bonus, 0) - $2, 0)
         WHERE id = $3 AND venue_id = $4`,
        [order.total || 0, order.bonus_earned || 0, order.client_id, req.user.venueId]
      );
    }

    const cancelledRes = await client.query(
      `UPDATE orders
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancelled_by = $1,
           cancel_reason = $2,
           cancel_food_prepared = $3
       WHERE id = $4 AND venue_id = $5
       RETURNING *`,
      [req.user.staffId, reason || null, foodPrepared, orderId, req.user.venueId]
    );

    await client.query('COMMIT');
    res.json(cancelledRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.message || 'Ошибка при отмене чека' });
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
  const r = await pool.query('SELECT id,name,phone,role,active FROM staff WHERE venue_id=$1 ORDER BY id', [req.user.venueId]);
  res.json(r.rows);
});

router.post('/staff', requireRole('owner'), async (req, res) => {
  const { name, phone, role, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Укажите имя и PIN' });
  const r = await pool.query(
    'INSERT INTO staff (venue_id,name,phone,role,pin) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,phone,role,active',
    [req.user.venueId, name, phone || null, role || 'cashier', pin]
  );
  res.json(r.rows[0]);
});

router.put('/staff/:id', requireRole('owner'), async (req, res) => {
  const { name, phone, role, pin, active } = req.body;
  const r = await pool.query(
    `UPDATE staff SET name=COALESCE($1,name), phone=COALESCE($2,phone), role=COALESCE($3,role),
       pin=COALESCE($4,pin), active=COALESCE($5,active)
     WHERE id=$6 AND venue_id=$7 RETURNING id,name,phone,role,active`,
    [name, phone, role, pin || null, active, req.params.id, req.user.venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  res.json(r.rows[0]);
});

router.delete('/staff/:id', requireRole('owner'), async (req, res) => {
  await pool.query('DELETE FROM staff WHERE id=$1 AND venue_id=$2', [req.params.id, req.user.venueId]);
  res.json({ ok: true });
});

module.exports = router;
