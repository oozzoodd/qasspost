-- Миграция: номер заказа для выдачи и сдача.
-- order_no — номер по порядку внутри смены (1, 2, 3…), его называют гостю и печатают на чеке.
-- cash_received — сколько наличных дал гость (для сдачи на чеке); NULL — без сдачи или картой.
-- Безопасно для многократного выполнения.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_no INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_received INTEGER;
CREATE INDEX IF NOT EXISTS idx_orders_shift_no ON orders(shift_id, order_no);
