const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /stock — список ингредиентов
router.get('/', async (req, res) => {
  const r = await pool.query('SELECT * FROM ingredients WHERE venue_id = $1 ORDER BY name', [req.user.venueId]);
  res.json(r.rows);
});

// POST /stock — новый ингредиент (owner, admin)
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const { name, stock_grams = 0, min_grams = 300 } = req.body;
  if (!name) return res.status(400).json({ error: 'Укажите название' });
  const r = await pool.query(
    'INSERT INTO ingredients (venue_id, name, stock_grams, min_grams) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.user.venueId, name, stock_grams, min_grams]
  );
  res.json(r.rows[0]);
});

// PUT /stock/:id — изменить ингредиент
router.put('/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { name, stock_grams, min_grams } = req.body;
  const r = await pool.query(
    `UPDATE ingredients SET
       name = COALESCE($1, name),
       stock_grams = COALESCE($2, stock_grams),
       min_grams = COALESCE($3, min_grams),
       updated_at = NOW()
     WHERE id = $4 AND venue_id = $5 RETURNING *`,
    [name, stock_grams, min_grams, req.params.id, req.user.venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  res.json(r.rows[0]);
});

// POST /stock/:id/income — приход товара (+grams к остатку)
router.post('/:id/income', requireRole('owner', 'admin'), async (req, res) => {
  const { grams } = req.body;
  if (!grams || grams <= 0) return res.status(400).json({ error: 'Укажите положительное количество' });
  const r = await pool.query(
    `UPDATE ingredients SET stock_grams = stock_grams + $1, updated_at = NOW()
     WHERE id = $2 AND venue_id = $3 RETURNING *`,
    [grams, req.params.id, req.user.venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  res.json(r.rows[0]);
});

// DELETE /stock/:id
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  await pool.query('DELETE FROM ingredients WHERE id = $1 AND venue_id = $2', [req.params.id, req.user.venueId]);
  res.json({ ok: true });
});

// ── Тех.карты ──────────────────────────────────────────────

// GET /stock/recipes/:menuItemId — состав блюда (проверяем venue_id)
router.get('/recipes/:menuItemId', async (req, res) => {
  try {
    const itemCheck = await pool.query('SELECT id FROM menu_items WHERE id = $1 AND venue_id = $2', [req.params.menuItemId, req.user.venueId]);
    if (!itemCheck.rows.length) return res.status(403).json({ error: 'Доступ запрещён' });

    const r = await pool.query(
      `SELECT r.id, r.ingredient_id, r.grams, i.name as ingredient_name, i.stock_grams
       FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
       WHERE r.menu_item_id = $1`,
      [req.params.menuItemId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /stock/recipes — добавить ингредиент в тех.карту
router.post('/recipes', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { menu_item_id, ingredient_id, grams } = req.body;
    if (!menu_item_id || !ingredient_id || !grams) return res.status(400).json({ error: 'Заполните все поля' });

    // Проверяем что блюдо и ингредиент принадлежат нашему заведению
    const itemCheck = await pool.query('SELECT id FROM menu_items WHERE id = $1 AND venue_id = $2', [menu_item_id, req.user.venueId]);
    const ingCheck = await pool.query('SELECT id FROM ingredients WHERE id = $1 AND venue_id = $2', [ingredient_id, req.user.venueId]);

    if (!itemCheck.rows.length || !ingCheck.rows.length) {
      return res.status(403).json({ error: 'Доступ запрещён. Неверное блюдо или ингредиент.' });
    }

    const r = await pool.query(
      'INSERT INTO recipes (menu_item_id, ingredient_id, grams) VALUES ($1,$2,$3) RETURNING *',
      [menu_item_id, ingredient_id, grams]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PUT /stock/recipes/:id — изменить граммовку
router.put('/recipes/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { grams } = req.body;

    // Проверяем, что рецепт относится к нашему заведению
    const check = await pool.query(
      `SELECT r.id FROM recipes r 
       JOIN menu_items m ON m.id = r.menu_item_id 
       WHERE r.id = $1 AND m.venue_id = $2`,
      [req.params.id, req.user.venueId]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Доступ запрещён' });

    const r = await pool.query('UPDATE recipes SET grams = $1 WHERE id = $2 RETURNING *', [grams, req.params.id]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /stock/recipes/:id
router.delete('/recipes/:id', requireRole('owner', 'admin'), async (req, res) => {
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
