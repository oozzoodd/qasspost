-- ═══════════════════════════════════════════════════════════
-- QassaPos Database Schema
-- ═══════════════════════════════════════════════════════════

-- Аккаунты владельцев (тех кто покупает подписку у тебя)
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  plan VARCHAR(50) DEFAULT 'start',         -- start | business | network
  status VARCHAR(20) DEFAULT 'trial',       -- trial | active | expired | blocked
  expires_at TIMESTAMP,                     -- дата окончания подписки
  created_at TIMESTAMP DEFAULT NOW()
);

-- Заведения (точки) - один аккаунт может иметь несколько точек (тариф "Сеть")
CREATE TABLE IF NOT EXISTS venues (
  id SERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL DEFAULT 'Моя точка',
  currency VARCHAR(10) DEFAULT 'сум',
  bonus_pct INTEGER DEFAULT 5,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Сотрудники (вход по PIN на кассе)
CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  role VARCHAR(20) DEFAULT 'cashier',       -- owner | admin | cashier
  pin VARCHAR(4) NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Категории меню
CREATE TABLE IF NOT EXISTS menu_categories (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- Блюда
CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES menu_categories(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  price INTEGER NOT NULL,                    -- цена в минимальных единицах валюты
  item_type VARCHAR(20) DEFAULT 'dish' CHECK (item_type IN ('dish','stock_item')),
  stock_ingredient_id INTEGER,
  stock_qty NUMERIC(12,3) DEFAULT 1 CHECK (stock_qty > 0),
  CHECK (item_type <> 'stock_item' OR stock_ingredient_id IS NOT NULL),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Ингредиенты (склад, в граммах)
CREATE TABLE IF NOT EXISTS ingredients (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(50) DEFAULT 'kitchen',
  unit VARCHAR(10) DEFAULT 'g',
  stock_grams INTEGER DEFAULT 0,
  min_grams INTEGER DEFAULT 300,
  updated_at TIMESTAMP DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'menu_items' AND column_name = 'stock_ingredient_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_stock_ingredient_fk'
  ) THEN
    ALTER TABLE menu_items
    ADD CONSTRAINT menu_items_stock_ingredient_fk
    FOREIGN KEY (stock_ingredient_id) REFERENCES ingredients(id);
  END IF;
END $$;

-- Тех.карты: связь блюдо <-> ингредиент
CREATE TABLE IF NOT EXISTS recipes (
  id SERIAL PRIMARY KEY,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id INTEGER REFERENCES ingredients(id) ON DELETE CASCADE,
  grams INTEGER NOT NULL
);

-- История приходов товара
CREATE TABLE IF NOT EXISTS stock_incomes (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  ingredient_id INTEGER REFERENCES ingredients(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(10) NOT NULL CHECK (unit IN ('pcs','g','kg','ml','l')),
  stock_delta_grams INTEGER NOT NULL CHECK (stock_delta_grams > 0),
  purchase_price INTEGER DEFAULT 0 CHECK (purchase_price >= 0),
  total_amount INTEGER DEFAULT 0 CHECK (total_amount >= 0),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Клиенты заведения (программа лояльности)
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  status VARCHAR(20) DEFAULT 'new',
  last_payment_at TIMESTAMP,
  expires_at TIMESTAMP,
  bonus INTEGER DEFAULT 0,
  visits INTEGER DEFAULT 0,
  total_spent INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Смены
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id),
  opened_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  revenue INTEGER DEFAULT 0,
  cash_total INTEGER DEFAULT 0,
  card_total INTEGER DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  expenses_total INTEGER DEFAULT 0,
  stock_income_total INTEGER DEFAULT 0,
  net_profit INTEGER DEFAULT 0,
  margin_percent NUMERIC(7,2) DEFAULT 0
);

-- Расходы кассы
CREATE TABLE IF NOT EXISTS cash_expenses (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id),
  shift_id INTEGER REFERENCES shifts(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  category VARCHAR(100),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Заказы
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  shift_id INTEGER REFERENCES shifts(id),
  staff_id INTEGER REFERENCES staff(id),
  client_id INTEGER REFERENCES clients(id),
  total INTEGER NOT NULL,
  pay_method VARCHAR(20),                    -- cash | card | mixed
  cash_amount INTEGER DEFAULT 0,
  card_amount INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'completed',    -- completed | cancelled
  bonus_earned INTEGER DEFAULT 0,
  cancelled_at TIMESTAMP,
  cancelled_by INTEGER REFERENCES staff(id),
  cancel_reason TEXT,
  cancel_food_prepared BOOLEAN DEFAULT false,
  items_json JSONB,                          -- [{name, qty, price}, ...]
  created_at TIMESTAMP DEFAULT NOW()
);

-- Индексы для быстрых запросов
CREATE INDEX IF NOT EXISTS idx_venues_account ON venues(account_id);
CREATE INDEX IF NOT EXISTS idx_staff_venue ON staff(venue_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_venue ON menu_items(venue_id);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'menu_items' AND column_name = 'stock_ingredient_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_menu_items_stock_ingredient ON menu_items(stock_ingredient_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_ingredients_venue ON ingredients(venue_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_venue_category ON ingredients(venue_id, category);
CREATE INDEX IF NOT EXISTS idx_stock_incomes_venue ON stock_incomes(venue_id);
CREATE INDEX IF NOT EXISTS idx_stock_incomes_ingredient ON stock_incomes(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_stock_incomes_created ON stock_incomes(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_venue ON orders(venue_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_venue_status ON orders(venue_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_shift_status ON orders(shift_id, status);
CREATE INDEX IF NOT EXISTS idx_cash_expenses_venue ON cash_expenses(venue_id);
CREATE INDEX IF NOT EXISTS idx_cash_expenses_shift ON cash_expenses(shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_expenses_created ON cash_expenses(created_at);
