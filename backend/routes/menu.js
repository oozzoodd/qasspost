const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MENU_ITEM_TYPES = new Set(['dish', 'stock_item']);

function normalizeMenuItemStockFields(body, existing = {}) {
  const itemType = body.item_type !== undefined
    ? String(body.item_type || 'dish')
    : (existing.item_type || 'dish');
  if (!MENU_ITEM_TYPES.has(itemType)) {
    throw new Error('Неверный тип товара');
  }

  const rawStockQty = body.stock_qty !== undefined ? body.stock_qty : (existing.stock_qty ?? 1);
  const stockQty = Number(rawStockQty);
  if (!Number.isFinite(stockQty) || stockQty <= 0) {
    throw new Error('Количество списания должно быть больше 0');
  }

  if (itemType === 'stock_item') {
    const rawIngredientId = body.stock_ingredient_id !== undefined
      ? body.stock_ingredient_id
      : existing.stock_ingredient_id;
    const stockIngredientId = Number(rawIngredientId);
    if (!Number.isInteger(stockIngredientId) || stockIngredientId <= 0) {
      throw new Error('Выберите складской товар');
    }
    return { itemType, stockIngredientId, stockQty };
  }

  return { itemType, stockIngredientId: null, stockQty: 1 };
}

async function assertStockIngredientBelongsToVenue(venueId, ingredientId) {
  if (!ingredientId) return;
  const r = await pool.query(
    'SELECT id FROM ingredients WHERE id = $1 AND venue_id = $2',
    [ingredientId, venueId]
  );
  if (!r.rows.length) {
    throw new Error('Складской товар не найден');
  }
}

// GET /menu — категории + блюда для текущего venue
router.get('/', async (req, res) => {
  const { venueId } = req.user;
  const cats = await pool.query('SELECT * FROM menu_categories WHERE venue_id = $1 ORDER BY sort_order, id', [venueId]);
  const items = await pool.query('SELECT * FROM menu_items WHERE venue_id = $1 ORDER BY id', [venueId]);
  res.json({ categories: cats.rows, items: items.rows });
});

// POST /menu/categories — новая категория (owner, admin)
router.post('/categories', requireRole('owner', 'admin'), async (req, res) => {
  const { venueId } = req.user;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Укажите название категории' });
  const r = await pool.query('INSERT INTO menu_categories (venue_id, name) VALUES ($1,$2) RETURNING *', [venueId, name]);
  res.json(r.rows[0]);
});

// POST /menu/items — новое блюдо (owner, admin)
router.post('/items', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { venueId } = req.user;
    const { name, price, category_id } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'Укажите название и цену' });

    const { itemType, stockIngredientId, stockQty } = normalizeMenuItemStockFields(req.body);
    await assertStockIngredientBelongsToVenue(venueId, stockIngredientId);

    const r = await pool.query(
      `INSERT INTO menu_items
        (venue_id, category_id, name, price, item_type, stock_ingredient_id, stock_qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [venueId, category_id || null, name, price, itemType, stockIngredientId, stockQty]
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Ошибка сохранения товара' });
  }
});

// PUT /menu/items/:id — редактирование блюда (owner, admin)
router.put('/items/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { venueId } = req.user;
    const { name, price, category_id, active } = req.body;
    const existingRes = await pool.query(
      'SELECT * FROM menu_items WHERE id = $1 AND venue_id = $2',
      [req.params.id, venueId]
    );
    if (!existingRes.rows.length) return res.status(404).json({ error: 'Товар не найден' });

    const touchesStockFields = Object.prototype.hasOwnProperty.call(req.body, 'item_type')
      || Object.prototype.hasOwnProperty.call(req.body, 'stock_ingredient_id')
      || Object.prototype.hasOwnProperty.call(req.body, 'stock_qty');
    const stockFields = touchesStockFields
      ? normalizeMenuItemStockFields(req.body, existingRes.rows[0])
      : normalizeMenuItemStockFields({}, existingRes.rows[0]);
    await assertStockIngredientBelongsToVenue(venueId, stockFields.stockIngredientId);

    const r = await pool.query(
      `UPDATE menu_items SET
         name = COALESCE($1, name),
         price = COALESCE($2, price),
         category_id = COALESCE($3, category_id),
         active = COALESCE($4, active),
         item_type = $5,
         stock_ingredient_id = $6,
         stock_qty = $7
       WHERE id = $8 AND venue_id = $9 RETURNING *`,
      [
        name,
        price,
        category_id,
        active,
        stockFields.itemType,
        stockFields.stockIngredientId,
        stockFields.stockQty,
        req.params.id,
        venueId,
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Ошибка сохранения товара' });
  }
});

// DELETE /menu/items/:id (owner, admin)
router.delete('/items/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { venueId } = req.user;
  await pool.query('DELETE FROM menu_items WHERE id = $1 AND venue_id = $2', [req.params.id, venueId]);
  res.json({ ok: true });
});

module.exports = router;
