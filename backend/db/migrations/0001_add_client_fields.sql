-- Миграция: добавить поля в таблицу clients
-- Использует IF NOT EXISTS, безопасно для многократного выполнения
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'new';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMP;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
-- Индекс по email для быстрого поиска (если нужен)
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients USING btree (email);

-- Пример обновления существующих записей (необязательно):
-- UPDATE clients SET status='new' WHERE status IS NULL;
