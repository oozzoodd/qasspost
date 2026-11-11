const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole, hasFeature } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MENU_ITEM_TYPES = new Set(['dish', 'stock_item']);
const MAX_NAME = 120;
const DEFAULT_MIN_PCS = 5; // «заканчивается», когда штук меньше

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

async function assertStockIngredientBelongsToVenue(db, venueId, ingredientId, req) {
  if (!ingredientId) return;
  const r = await db.query(
    'SELECT id, unit FROM ingredients WHERE id = $1 AND venue_id = $2',
    [ingredientId, venueId]
  );
  if (!r.rows.length) {
    throw new Error('Складской товар не найден');
  }
  // На простом тарифе к позиции меню привязывается только поштучный товар
  if (req && r.rows[0].unit !== 'pcs' && !hasFeature(req, 'stock_weight')) {
    throw new Error('На вашем тарифе можно привязать только поштучный товар');
  }
}

function cleanName(value, what = 'название') {
  const name = String(value ?? '').trim();
  if (!name) throw new Error(`Укажите ${what}`);
  if (name.length > MAX_NAME) throw new Error('Слишком длинное название');
  return name;
}
function cleanPrice(value) {
  const price = Number(value);
  if (!Number.isInteger(price) || price < 0 || price > 1000000000) throw new Error('Укажите цену целым числом');
  return price;
}
function cleanCount(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10000000) throw new Error('Проверьте количество в наличии');
  return Math.round(n);
}
function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// Поштучный товар на складе под позицию меню (одна галочка «Считать остаток»)
async function createStockFor(db, venueId, name, count) {
  const r = await db.query(
    `INSERT INTO ingredients (venue_id, name, category, unit, stock_grams, min_grams)
     VALUES ($1,$2,'other','pcs',$3,$4) RETURNING id`,
    [venueId, name, count, DEFAULT_MIN_PCS]
  );
  return r.rows[0].id;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function assertCategory(db, venueId, categoryId) {
  if (!categoryId) return null;
  const r = await db.query('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [categoryId, venueId]);
  if (!r.rows.length) throw new Error('Категория не найдена');
  return Number(categoryId);
}

// GET /menu — категории + блюда для текущего venue
router.get('/', async (req, res) => {
  const { venueId } = req.user;
  const cats = await pool.query('SELECT * FROM menu_categories WHERE venue_id = $1 ORDER BY sort_order, id', [venueId]);
  // recipe_count — сколько ингредиентов в техкарте: без техкарты блюдо продаётся без списания со склада
  const items = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM recipes r WHERE r.menu_item_id = m.id)::int AS recipe_count
     FROM menu_items m WHERE m.venue_id = $1 ORDER BY m.id`,
    [venueId]
  );
  res.json({ categories: cats.rows, items: items.rows });
});

// ── КАТЕГОРИИ ────────────────────────────────────────────────

// POST /menu/categories — новая категория (owner, admin)
router.post('/categories', requireRole('owner', 'admin'), async (req, res) => {
  let name;
  try { name = cleanName(req.body.name, 'название категории'); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const r = await pool.query('INSERT INTO menu_categories (venue_id, name) VALUES ($1,$2) RETURNING *', [req.user.venueId, name]);
  res.json(r.rows[0]);
});

// PUT /menu/categories/:id — переименовать категорию
router.put('/categories/:id', requireRole('owner', 'admin'), async (req, res) => {
  let name;
  try { name = cleanName(req.body.name, 'название категории'); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const r = await pool.query(
    'UPDATE menu_categories SET name = $1 WHERE id = $2 AND venue_id = $3 RETURNING *',
    [name, req.params.id, req.user.venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Категория не найдена' });
  res.json(r.rows[0]);
});

// DELETE /menu/categories/:id — удалить категорию; её блюда остаются «без категории»
router.delete('/categories/:id', requireRole('owner', 'admin'), async (req, res) => {
  const r = await pool.query('DELETE FROM menu_categories WHERE id = $1 AND venue_id = $2 RETURNING id', [req.params.id, req.user.venueId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Категория не найдена' });
  res.json({ ok: true });
});

// ── БЛЮДА ────────────────────────────────────────────────────

// POST /menu/items — новое блюдо (owner, admin)
// Простой вариант: { name, price, category_id, track_stock: true, stock_count: 24 } —
// поштучный товар на складе создаётся сам. Старый вариант с item_type/stock_ingredient_id тоже работает.
router.post('/items', requireRole('owner', 'admin'), async (req, res) => {
  const { venueId } = req.user;
  try {
    const name = cleanName(req.body.name);
    const price = cleanPrice(req.body.price);
    const item = await withTransaction(async db => {
      const categoryId = await assertCategory(db, venueId, req.body.category_id);
      let itemType = 'dish';
      let stockIngredientId = null;
      let stockQty = 1;
      if (req.body.track_stock === true && req.body.item_type === undefined) {
        itemType = 'stock_item';
        stockIngredientId = await createStockFor(db, venueId, name, cleanCount(req.body.stock_count));
      } else if (req.body.item_type !== undefined) {
        ({ itemType, stockIngredientId, stockQty } = normalizeMenuItemStockFields(req.body));
        await assertStockIngredientBelongsToVenue(db, venueId, stockIngredientId, req);
      }
      const r = await db.query(
        `INSERT INTO menu_items
          (venue_id, category_id, name, price, item_type, stock_ingredient_id, stock_qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [venueId, categoryId, name, price, itemType, stockIngredientId, stockQty]
      );
      return r.rows[0];
    });
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Ошибка сохранения товара' });
  }
});

// PUT /menu/items/:id — редактирование блюда (owner, admin)
// track_stock: true — считать остаток (stock_count — сколько сейчас штук), false — перестать.
router.put('/items/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { venueId } = req.user;
  try {
    const item = await withTransaction(async db => {
      const existingRes = await db.query(
        'SELECT * FROM menu_items WHERE id = $1 AND venue_id = $2 FOR UPDATE',
        [req.params.id, venueId]
      );
      if (!existingRes.rows.length) {
        const err = new Error('Товар не найден');
        err.status = 404;
        throw err;
      }
      const existing = existingRes.rows[0];

      const name = has(req.body, 'name') ? cleanName(req.body.name) : existing.name;
      const price = has(req.body, 'price') ? cleanPrice(req.body.price) : existing.price;
      const categoryId = has(req.body, 'category_id')
        ? await assertCategory(db, venueId, req.body.category_id)
        : existing.category_id;
      const active = typeof req.body.active === 'boolean' ? req.body.active : existing.active;

      let itemType = existing.item_type || 'dish';
      let stockIngredientId = existing.stock_ingredient_id;
      let stockQty = existing.stock_qty ?? 1;

      if (has(req.body, 'track_stock') && !has(req.body, 'item_type')) {
        if (req.body.track_stock === true) {
          if (itemType === 'stock_item' && stockIngredientId) {
            const ingRes = await db.query('SELECT id, name, unit FROM ingredients WHERE id = $1 AND venue_id = $2', [stockIngredientId, venueId]);
            const ing = ingRes.rows[0];
            // Остаток правим только у поштучного товара; весовой — в «Остатках»
            if (ing && ing.unit === 'pcs' && has(req.body, 'stock_count')) {
              await db.query('UPDATE ingredients SET stock_grams = $1, updated_at = NOW() WHERE id = $2', [cleanCount(req.body.stock_count), ing.id]);
            }
            // Товар на складе назывался так же, как блюдо — переименуем вместе
            if (ing && ing.name === existing.name && name !== existing.name) {
              await db.query('UPDATE ingredients SET name = $1, updated_at = NOW() WHERE id = $2', [name, ing.id]);
            }
          } else {
            itemType = 'stock_item';
            stockIngredientId = await createStockFor(db, venueId, name, cleanCount(req.body.stock_count));
            stockQty = 1;
          }
        } else if (req.body.track_stock === false) {
          itemType = 'dish';
          stockIngredientId = null; // товар на складе остаётся, просто не списывается
          stockQty = 1;
        }
      } else if (has(req.body, 'item_type') || has(req.body, 'stock_ingredient_id') || has(req.body, 'stock_qty')) {
        ({ itemType, stockIngredientId, stockQty } = normalizeMenuItemStockFields(req.body, existing));
        await assertStockIngredientBelongsToVenue(db, venueId, stockIngredientId, req);
      }

      const r = await db.query(
        `UPDATE menu_items SET name = $1, price = $2, category_id = $3, active = $4,
           item_type = $5, stock_ingredient_id = $6, stock_qty = $7
         WHERE id = $8 AND venue_id = $9 RETURNING *`,
        [name, price, categoryId, active, itemType, stockIngredientId, stockQty, req.params.id, venueId]
      );
      return r.rows[0];
    });
    res.json(item);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Ошибка сохранения товара' });
  }
});

// DELETE /menu/items/:id (owner, admin)
router.delete('/items/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { venueId } = req.user;
  await pool.query('DELETE FROM menu_items WHERE id = $1 AND venue_id = $2', [req.params.id, venueId]);
  res.json({ ok: true });
});

// ── МАСТЕР ПЕРВОГО ЗАПУСКА ───────────────────────────────────

// POST /menu/setup — сохранить всё меню из мастера одним разом
// body: { categories: [{ name, items: [{ name, price }] }] }
router.post('/setup', requireRole('owner', 'admin'), async (req, res) => {
  const { venueId } = req.user;
  const input = Array.isArray(req.body.categories) ? req.body.categories : [];
  try {
    const cats = input.map(c => ({
      name: cleanName(c && c.name, 'название категории'),
      items: (Array.isArray(c && c.items) ? c.items : [])
        .filter(i => i && String(i.name ?? '').trim())
        .map(i => ({ name: cleanName(i.name), price: cleanPrice(i.price) })),
    }));
    if (!cats.length) throw new Error('Добавьте хотя бы одну категорию');
    if (cats.length > 30) throw new Error('Слишком много категорий за раз');
    const total = cats.reduce((n, c) => n + c.items.length, 0);
    if (!total) throw new Error('Добавьте хотя бы одно блюдо');
    if (total > 300) throw new Error('Слишком много блюд за раз');

    const result = await withTransaction(async db => {
      for (const cat of cats) {
        // Категория с таким названием уже есть — дополняем её, а не создаём вторую
        const found = await db.query('SELECT id FROM menu_categories WHERE venue_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1', [venueId, cat.name]);
        const categoryId = found.rows.length
          ? found.rows[0].id
          : (await db.query('INSERT INTO menu_categories (venue_id, name) VALUES ($1,$2) RETURNING id', [venueId, cat.name])).rows[0].id;
        for (const item of cat.items) {
          await db.query(
            `INSERT INTO menu_items (venue_id, category_id, name, price, item_type, stock_qty) VALUES ($1,$2,$3,$4,'dish',1)`,
            [venueId, categoryId, item.name, item.price]
          );
        }
      }
      // Пустая стартовая категория «Основное» после мастера не нужна
      await db.query(
        `DELETE FROM menu_categories c WHERE c.venue_id = $1 AND c.name = 'Основное'
           AND NOT EXISTS (SELECT 1 FROM menu_items m WHERE m.category_id = c.id)`,
        [venueId]
      );
      return { categories: cats.length, items: total };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Не удалось сохранить меню' });
  }
});

module.exports = router;
