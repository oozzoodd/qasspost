-- Миграция: пересчёт склада (инвентаризация) по графику.
-- inventory_every_days — как часто напоминать: 3, 7, 14, 30; 0 — не напоминать; NULL — ещё не выбрано.
-- last_inventory_at — когда склад последний раз пересчитывали (или заполнили впервые).
-- Безопасно для многократного выполнения.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS inventory_every_days INTEGER;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS last_inventory_at TIMESTAMP;
