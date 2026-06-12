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
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Ингредиенты (склад, в граммах)
CREATE TABLE IF NOT EXISTS ingredients (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  stock_grams INTEGER DEFAULT 0,
  min_grams INTEGER DEFAULT 300,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Тех.карты: связь блюдо <-> ингредиент
CREATE TABLE IF NOT EXISTS recipes (
  id SERIAL PRIMARY KEY,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id INTEGER REFERENCES ingredients(id) ON DELETE CASCADE,
  grams INTEGER NOT NULL
);

-- Клиенты заведения (программа лояльности)
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
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
  revenue INTEGER DEFAULT 0
);

-- Заказы
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  shift_id INTEGER REFERENCES shifts(id),
  staff_id INTEGER REFERENCES staff(id),
  client_id INTEGER REFERENCES clients(id),
  total INTEGER NOT NULL,
  pay_method VARCHAR(20),                    -- cash | card
  items_json JSONB,                          -- [{name, qty, price}, ...]
  created_at TIMESTAMP DEFAULT NOW()
);

-- Индексы для быстрых запросов
CREATE INDEX IF NOT EXISTS idx_venues_account ON venues(account_id);
CREATE INDEX IF NOT EXISTS idx_staff_venue ON staff(venue_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_venue ON menu_items(venue_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_venue ON ingredients(venue_id);
CREATE INDEX IF NOT EXISTS idx_orders_venue ON orders(venue_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
