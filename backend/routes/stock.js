const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole, requireFeature, hasFeature, featureLocked } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const INCOME_UNITS = new Set(['pcs', 'g', 'kg', 'ml', 'l']);
const STOCK_CATEGORIES = new Set(['kitchen', 'bar', 'drinks', 'packaging', 'other']);

// На простом тарифе склад только поштучный; граммы и литры — весовой склад («Бизнес»)
function weightLocked(req, unit) {
  return unit !== 'pcs' && !hasFeature(req, 'stock_weight');
}

function toStockDeltaGrams(quantity, unit) {
  const delta = (unit === 'kg' || unit === 'l') ? quantity * 1000 : quantity;
  return Number(delta.toFixed(3));
}

function parseNonNegativeStock(value) {
  const stock = Number(value);
  if (!Number.isFinite(stock) || stock < 0) {
    throw new Error('Остаток не может быть отрицательным');
  }
  return Number(stock.toFixed(3));
}

// GET /stock — список ингредиентов
router.get('/', async (req, res) => {
  const r = await pool.query('SELECT * FROM ingredients WHERE venue_id = $1 ORDER BY name', [req.user.venueId]);
  res.json(r.rows);
});

// GET /stock/incomes — последние приходы товара
router.get('/incomes', requireRole('owner', 'admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT
       si.id,
       si.ingredient_id,
       i.name AS ingredient_name,
       si.staff_id,
       s.name AS staff_name,
       si.quantity,
       si.unit,
       si.purchase_price,
       si.total_amount,
       si.comment,
       si.created_at
     FROM stock_incomes si
     JOIN ingredients i ON i.id = si.ingredient_id
     LEFT JOIN staff s ON s.id = si.staff_id
     WHERE si.venue_id = $1
     ORDER BY si.created_at DESC
     LIMIT 50`,
    [req.user.venueId]
  );
  res.json(r.rows);
});

// ── Заполнение и пересчёт склада (инвентаризация) ──────────
// Остатки в базе: штуки — как есть, кг и литры — в граммах и миллилитрах (×1000).

const INVENTORY_PERIODS = new Set([0, 3, 7, 14, 30]); // дней; 0 — не напоминать

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);
}

// Первое заполнение склада тоже считается пересчётом: от него идёт отсчёт до следующего
async function touchInventory(client, venueId, force) {
  await client.query(
    `UPDATE venues SET last_inventory_at = NOW()
     WHERE id = $1 ${force ? '' : 'AND last_inventory_at IS NULL'}`,
    [venueId]
  );
}

// POST /stock/bulk — добавить сразу несколько товаров с текущим количеством
// body: { items: [{ name, unit: 'pcs'|'kg'|'l', quantity }] }
router.post('/bulk', requireRole('owner', 'admin'), async (req, res) => {
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = [];
  for (const it of raw) {
    const name = cleanName(it.name);
    if (!name) continue;
    const unit = INCOME_UNITS.has(it.unit) ? it.unit : 'pcs';
    const quantity = Number(it.quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity < 0) {
      return res.status(400).json({ error: `Проверьте количество у «${name}»` });
    }
    items.push({ name, unit, stock: toStockDeltaGrams(quantity, unit) });
  }
  if (!items.length) return res.status(400).json({ error: 'Добавьте хотя бы один товар' });
  if (items.length > 200) return res.status(400).json({ error: 'Слишком много товаров за раз' });
  if (items.some(it => weightLocked(req, it.unit))) return featureLocked(res, 'stock_weight');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const it of items) {
      // «Заканчивается» по умолчанию: меньше 5 штук или меньше 1 кг / 1 л
      const min = it.unit === 'pcs' ? 5 : (it.unit === 'kg' || it.unit === 'l') ? 1000 : 300;
      const r = await client.query(
        `INSERT INTO ingredients (venue_id, name, category, unit, stock_grams, min_grams)
         VALUES ($1,$2,'kitchen',$3,$4,$5) RETURNING *`,
        [req.user.venueId, it.name, it.unit, it.stock, min]
      );
      created.push(r.rows[0]);
    }
    await touchInventory(client, req.user.venueId, false);
    await client.query('COMMIT');
    res.json(created);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /stock/inventory — пересчёт склада: новые остатки всех товаров разом
// body: { items: [{ id, stock_grams }] } — остаток в тех же единицах, что хранит база
router.post('/inventory', requireRole('owner', 'admin'), async (req, res) => {
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = [];
  for (const it of raw) {
    const id = Number(it.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    try {
      items.push({ id, stock: parseNonNegativeStock(it.stock_grams) });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      await client.query(
        'UPDATE ingredients SET stock_grams = $1, updated_at = NOW() WHERE id = $2 AND venue_id = $3',
        [it.stock, it.id, req.user.venueId]
      );
    }
    await touchInventory(client, req.user.venueId, true);
    const venue = await client.query(
      'SELECT inventory_every_days, last_inventory_at FROM venues WHERE id = $1',
      [req.user.venueId]
    );
    await client.query('COMMIT');
    res.json({ updated: items.length, ...venue.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// PUT /stock/inventory-settings — как часто напоминать о пересчёте склада
router.put('/inventory-settings', requireRole('owner', 'admin'), async (req, res) => {
  const every = Number(req.body?.every_days);
  if (!INVENTORY_PERIODS.has(every)) return res.status(400).json({ error: 'Выберите, как часто пересчитывать склад' });
  const r = await pool.query(
    `UPDATE venues SET inventory_every_days = $1,
       last_inventory_at = COALESCE(last_inventory_at, NOW())
     WHERE id = $2 RETURNING inventory_every_days, last_inventory_at`,
    [every, req.user.venueId]
  );
  res.json(r.rows[0]);
});

// POST /stock — новый ингредиент (owner, admin)
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const { name, min_grams = 300, category = 'kitchen' } = req.body;
  const unit = req.body.unit || (hasFeature(req, 'stock_weight') ? 'g' : 'pcs');
  if (!name) return res.status(400).json({ error: 'Укажите название' });
  if (weightLocked(req, unit)) return featureLocked(res, 'stock_weight');
  if (!STOCK_CATEGORIES.has(category) || !INCOME_UNITS.has(unit)) {
    return res.status(400).json({ error: 'Проверьте категорию и единицу измерения' });
  }
  let normalizedMinGrams;
  let initialStock = 0; // сколько товара есть прямо сейчас (необязательно)
  try {
    normalizedMinGrams = parseNonNegativeStock(min_grams);
    if (req.body.stock_grams !== undefined && req.body.stock_grams !== null && req.body.stock_grams !== '') {
      initialStock = parseNonNegativeStock(req.body.stock_grams);
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const r = await pool.query(
    'INSERT INTO ingredients (venue_id, name, category, unit, stock_grams, min_grams) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.user.venueId, cleanName(name), category, unit, initialStock, normalizedMinGrams]
  );
  await pool.query(
    'UPDATE venues SET last_inventory_at = NOW() WHERE id = $1 AND last_inventory_at IS NULL',
    [req.user.venueId]
  );
  res.json(r.rows[0]);
});

// PUT /stock/:id — изменить ингредиент
router.put('/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { name, stock_grams, min_grams, category, unit } = req.body;
  if (category && !STOCK_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Неверная категория' });
  }
  if (unit && !INCOME_UNITS.has(unit)) {
    return res.status(400).json({ error: 'Неверная единица измерения' });
  }
  if (unit && weightLocked(req, unit)) return featureLocked(res, 'stock_weight');
  let normalizedStockGrams = null;
  if (stock_grams !== undefined && stock_grams !== null && stock_grams !== '') {
    try {
      normalizedStockGrams = parseNonNegativeStock(stock_grams);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  const r = await pool.query(
    `UPDATE ingredients SET
       name = COALESCE($1, name),
       stock_grams = COALESCE($2, stock_grams),
       min_grams = COALESCE($3, min_grams),
       category = COALESCE($4, category),
       unit = COALESCE($5, unit),
       updated_at = NOW()
     WHERE id = $6 AND venue_id = $7 RETURNING *`,
    [name, normalizedStockGrams, min_grams, category, unit, req.params.id, req.user.venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  res.json(r.rows[0]);
});

// POST /stock/:id/income — приход товара с историей
router.post('/:id/income', requireRole('owner', 'admin'), async (req, res) => {
  const quantity = Number(req.body.quantity ?? req.body.grams);
  const requestedUnit = req.body.unit ? String(req.body.unit) : null;
  const purchasePrice = Math.round(Number(req.body.purchase_price) || 0);
  const comment = String(req.body.comment || '').trim();

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Укажите корректное количество и единицу измерения' });
  }
  if (requestedUnit && !INCOME_UNITS.has(requestedUnit)) {
    return res.status(400).json({ error: 'Неверная единица измерения' });
  }
  if (!Number.isInteger(purchasePrice) || purchasePrice < 0) {
    return res.status(400).json({ error: 'Укажите корректную цену закупки' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ingRes = await client.query(
      `SELECT id, unit FROM ingredients
       WHERE id = $1 AND venue_id = $2
       FOR UPDATE`,
      [req.params.id, req.user.venueId]
    );
    if (!ingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Не найдено' });
    }

    const unit = requestedUnit || ingRes.rows[0].unit || 'g';
    if (weightLocked(req, unit) || weightLocked(req, ingRes.rows[0].unit || 'g')) {
      await client.query('ROLLBACK');
      return featureLocked(res, 'stock_weight');
    }
    if (!INCOME_UNITS.has(unit)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Неверная единица измерения товара' });
    }

    const stockDeltaGrams = toStockDeltaGrams(quantity, unit);
    if (stockDeltaGrams <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Количество слишком маленькое для учёта остатка' });
    }
    const totalAmount = Math.round(quantity * purchasePrice);

    const r = await client.query(
      `UPDATE ingredients SET stock_grams = stock_grams + $1, updated_at = NOW()
       WHERE id = $2 AND venue_id = $3 RETURNING *`,
      [stockDeltaGrams, req.params.id, req.user.venueId]
    );

    await client.query(
      `INSERT INTO stock_incomes
        (venue_id, ingredient_id, staff_id, quantity, unit, stock_delta_grams, purchase_price, total_amount, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        req.user.venueId,
        req.params.id,
        req.user.staffId,
        quantity,
        unit,
        stockDeltaGrams,
        purchasePrice,
        totalAmount,
        comment || null,
      ]
    );

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка при сохранении прихода' });
  } finally {
    client.release();
  }
});

// DELETE /stock/:id
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  await pool.query('DELETE FROM ingredients WHERE id = $1 AND venue_id = $2', [req.params.id, req.user.venueId]);
  res.json({ ok: true });
});

// ── Тех.карты ──────────────────────────────────────────────

// GET /stock/recipes/:menuItemId — состав блюда (проверяем venue_id)
router.get('/recipes/:menuItemId', async (req, res) => {
  // Без техкарт в тарифе состава нет: блюдо продаётся без списания
  if (!hasFeature(req, 'recipes')) return res.json([]);
  try {
    const itemCheck = await pool.query('SELECT id FROM menu_items WHERE id = $1 AND venue_id = $2', [req.params.menuItemId, req.user.venueId]);
    if (!itemCheck.rows.length) return res.status(403).json({ error: 'Доступ запрещён' });

    const r = await pool.query(
      `SELECT r.id, r.ingredient_id, r.grams, i.name as ingredient_name, i.stock_grams, i.unit
       FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id AND i.venue_id = $2
       WHERE r.menu_item_id = $1`,
      [req.params.menuItemId, req.user.venueId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /stock/recipes — добавить ингредиент в тех.карту
router.post('/recipes', requireFeature('recipes'), requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { menu_item_id, ingredient_id, grams } = req.body;
    const amount = Number(grams);
    if (!menu_item_id || !ingredient_id || !grams) return res.status(400).json({ error: 'Заполните все поля' });

    // Проверяем что блюдо и ингредиент принадлежат нашему заведению
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Укажите корректное количество' });

    const itemCheck = await pool.query('SELECT id, item_type FROM menu_items WHERE id = $1 AND venue_id = $2', [menu_item_id, req.user.venueId]);
    const ingCheck = await pool.query('SELECT id FROM ingredients WHERE id = $1 AND venue_id = $2', [ingredient_id, req.user.venueId]);

    if (!itemCheck.rows.length || !ingCheck.rows.length) {
      return res.status(403).json({ error: 'Доступ запрещён. Неверное блюдо или ингредиент.' });
    }
    if (itemCheck.rows[0].item_type === 'stock_item') {
      return res.status(400).json({ error: 'Для поштучного товара техкарта не нужна' });
    }

    const r = await pool.query(
      'INSERT INTO recipes (menu_item_id, ingredient_id, grams) VALUES ($1,$2,$3) RETURNING *',
      [menu_item_id, ingredient_id, Number(amount.toFixed(3))]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PUT /stock/recipes/:id — изменить граммовку
router.put('/recipes/:id', requireFeature('recipes'), requireRole('owner', 'admin'), async (req, res) => {
  try {
    const amount = Number(req.body.grams);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Укажите корректное количество' });

    // Проверяем, что рецепт относится к нашему заведению
    const check = await pool.query(
      `SELECT r.id FROM recipes r 
       JOIN menu_items m ON m.id = r.menu_item_id 
       WHERE r.id = $1 AND m.venue_id = $2`,
      [req.params.id, req.user.venueId]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Доступ запрещён' });

    const r = await pool.query('UPDATE recipes SET grams = $1 WHERE id = $2 RETURNING *', [Number(amount.toFixed(3)), req.params.id]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /stock/recipes/:id
router.delete('/recipes/:id', requireFeature('recipes'), requireRole('owner', 'admin'), async (req, res) => {
  try {
    // Проверяем, что рецепт относится к нашему заведению
    const check = await pool.query(
      `SELECT r.id FROM recipes r 
       JOIN menu_items m ON m.id = r.menu_item_id 
       WHERE r.id = $1 AND m.venue_id = $2`,
      [req.params.id, req.user.venueId]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Доступ запрещён' });

    await pool.query('DELETE FROM recipes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
