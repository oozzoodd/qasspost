-- Миграция: вход по номеру телефона, оплаты подписок, активность аккаунтов.
-- Безопасно для многократного выполнения.

-- Телефон — основной логин владельца; email теперь необязателен
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE accounts ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_phone ON accounts(phone) WHERE phone IS NOT NULL;

-- Для админ-панели: заметка о клиенте и когда он последний раз заходил / работал
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;

-- Оплаты подписок (вносятся вручную в админ-панели)
CREATE TABLE IF NOT EXISTS subscription_payments (
  id SERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',   -- USD | UZS
  method VARCHAR(30),                            -- click | payme | cash | card | transfer | other
  plan VARCHAR(50),
  months INTEGER,
  comment TEXT,
  paid_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_account ON subscription_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_paid ON subscription_payments(paid_at);
