const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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
  const { venueId } = req.user;
  const { name, price, category_id } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'Укажите название и цену' });
  const r = await pool.query(
    'INSERT INTO menu_items (venue_id, category_id, name, price) VALUES ($1,$2,$3,$4) RETURNING *',
    [venueId, category_id || null, name, price]
  );
  res.json(r.rows[0]);
});

// PUT /menu/items/:id — редактирование блюда (owner, admin)
router.put('/items/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { venueId } = req.user;
  const { name, price, category_id, active } = req.body;
  const r = await pool.query(
    `UPDATE menu_items SET
       name = COALESCE($1, name),
       price = COALESCE($2, price),
       category_id = COALESCE($3, category_id),
       active = COALESCE($4, active)
     WHERE id = $5 AND venue_id = $6 RETURNING *`,
    [name, price, category_id, active, req.params.id, venueId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Блюдо не найдено' });
  res.json(r.rows[0]);
});

// DELETE /menu/items/:id (owner, admin)
router.delete('/items/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { venueId } = req.user;
  await pool.query('DELETE FROM menu_items WHERE id = $1 AND venue_id = $2', [req.params.id, venueId]);
  res.json({ ok: true });
});

module.exports = router;
