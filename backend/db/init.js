// Запуск: node db/init.js
// Создаёт все таблицы + одного demo владельца со стартовыми данными.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function init() {
  console.log('📦 Создаю таблицы...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('✅ Таблицы созданы');

  // Проверяем — может demo уже есть
  const existing = await pool.query('SELECT id FROM accounts WHERE email = $1', ['demo@qassapos.uz']);
  if (existing.rows.length) {
    console.log('ℹ️  Demo аккаунт уже существует, пропускаю');
    process.exit(0);
  }

  console.log('👤 Создаю demo аккаунт...');
  const passwordHash = await bcrypt.hash('demo1234', 10);

  const accRes = await pool.query(
    `INSERT INTO accounts (name, email, password_hash, plan, status, expires_at)
     VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '30 days') RETURNING id`,
    ['Демо Бургерная', 'demo@qassapos.uz', passwordHash, 'business', 'trial']
  );
  const accountId = accRes.rows[0].id;

  const venueRes = await pool.query(
    `INSERT INTO venues (account_id, name, currency, bonus_pct) VALUES ($1,$2,$3,$4) RETURNING id`,
    [accountId, 'Быстрый вкус', 'сум', 5]
  );
  const venueId = venueRes.rows[0].id;

  // Сотрудники
  await pool.query(
    `INSERT INTO staff (venue_id, name, phone, role, pin) VALUES
     ($1,'Владелец','+998901111111','owner','1111'),
     ($1,'Санжар Холиков','+998902222222','admin','2222'),
     ($1,'Нилуфар Тошева','+998903333333','cashier','3333')`,
    [venueId]
  );

  // Категории
  const cats = ['Бургеры', 'Шаурма', 'Хот-доги', 'Напитки'];
  const catIds = {};
  for (const c of cats) {
    const r = await pool.query(
      `INSERT INTO menu_categories (venue_id, name) VALUES ($1,$2) RETURNING id`,
      [venueId, c]
    );
    catIds[c] = r.rows[0].id;
  }

  // Ингредиенты
  const ingredients = [
    ['Булочка', 4800, 500],
    ['Котлета', 3600, 600],
    ['Помидор', 2800, 300],
    ['Лист салата', 1200, 200],
    ['Сыр', 900, 300],
    ['Лаваш', 5000, 500],
    ['Куриное мясо', 4200, 600],
    ['Сосиска', 2400, 400],
    ['Хлеб хот-дог', 3000, 400],
  ];
  const ingIds = {};
  for (const [name, stock, min] of ingredients) {
    const r = await pool.query(
      `INSERT INTO ingredients (venue_id, name, stock_grams, min_grams) VALUES ($1,$2,$3,$4) RETURNING id`,
      [venueId, name, stock, min]
    );
    ingIds[name] = r.rows[0].id;
  }

  // Блюда
  const items = [
    ['Классик бургер', 18000, 'Бургеры'],
    ['Двойной бургер', 26000, 'Бургеры'],
    ['Чизбургер', 22000, 'Бургеры'],
    ['Шаурма классик', 20000, 'Шаурма'],
    ['Шаурма с сыром', 24000, 'Шаурма'],
    ['Хот-дог классик', 12000, 'Хот-доги'],
    ['Кола 0.5л', 8000, 'Напитки'],
    ['Чай', 5000, 'Напитки'],
    ['Вода', 4000, 'Напитки'],
  ];
  const itemIds = {};
  for (const [name, price, cat] of items) {
    const r = await pool.query(
      `INSERT INTO menu_items (venue_id, category_id, name, price) VALUES ($1,$2,$3,$4) RETURNING id`,
      [venueId, catIds[cat], name, price]
    );
    itemIds[name] = r.rows[0].id;
  }

  // Тех.карты
  const recipes = {
    'Классик бургер': [['Булочка',80],['Котлета',120],['Помидор',40],['Лист салата',20]],
    'Двойной бургер': [['Булочка',80],['Котлета',200],['Помидор',40]],
    'Чизбургер': [['Булочка',80],['Котлета',120],['Сыр',30],['Помидор',40]],
    'Шаурма классик': [['Лаваш',120],['Куриное мясо',150],['Помидор',50],['Лист салата',30]],
    'Шаурма с сыром': [['Лаваш',120],['Куриное мясо',150],['Сыр',40]],
    'Хот-дог классик': [['Хлеб хот-дог',90],['Сосиска',80]],
  };
  for (const [itemName, ings] of Object.entries(recipes)) {
    for (const [ingName, grams] of ings) {
      await pool.query(
        `INSERT INTO recipes (menu_item_id, ingredient_id, grams) VALUES ($1,$2,$3)`,
        [itemIds[itemName], ingIds[ingName], grams]
      );
    }
  }

  // Клиенты
  await pool.query(
    `INSERT INTO clients (venue_id, name, email, phone, status, last_payment_at, expires_at, visits, bonus, total_spent) VALUES
     ($1,'Алишер Каримов','alisher@example.com','+998901234567','active', NOW() - INTERVAL '3 days', NOW() + INTERVAL '30 days',12,3200,240000),
     ($1,'Малика Юсупова','malika@example.com','+998901234568','active', NOW() - INTERVAL '10 days', NOW() + INTERVAL '20 days',7,1800,140000),
     ($1,'Бобур Рашидов','bobur@example.com','+998901234569','new', NULL, NULL,3,600,60000)`,
    [venueId]
  );

  console.log('✅ Demo данные созданы!');
  console.log('');
  console.log('   Логин:  demo@qassapos.uz');
  console.log('   Пароль: demo1234');
  console.log('');
  process.exit(0);
}

init().catch(err => {
  console.error('❌ Ошибка:', err);
  process.exit(1);
});
