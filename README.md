# vzlyot.post — Инструкция по запуску

Полная пошаговая инструкция, как развернуть систему с нуля.
Идём по порядку, ничего не пропускаем.

---

## Шаг 1. GitHub — создаём репозиторий

1. Заходишь на github.com → New repository
2. Название: `vzlyot.post`
3. Private (чтобы код был скрыт от посторонних)
4. Создаёшь

Затем у себя на компьютере (или прямо здесь, в Claude):

```bash
cd vzlyot.post
git init
git add .
git commit -m "Первый коммит: backend + frontend"
git branch -M main
git remote add origin https://github.com/ТВОЙ_АККАУНТ/vzlyot.post.git
git push -u origin main
```

---

## Шаг 2. Railway — создаём проект

1. Заходишь на railway.app, входишь через GitHub
2. New Project → Deploy from GitHub repo → выбираешь `vzlyot.post`
3. Railway найдёт папку `backend` — укажи Root Directory: `backend`

---

## Шаг 3. Добавляем базу данных PostgreSQL

1. В проекте Railway: New → Database → Add PostgreSQL
2. Railway автоматически создаст переменную `DATABASE_URL` и подключит её к твоему сервису

---

## Шаг 4. Переменные окружения

В настройках сервиса (Variables) добавь:

| Переменная | Значение |
|---|---|
| `JWT_SECRET` | любая длинная случайная строка, например `kj3h4kjh5b34kjhb5kj34hb` |
| `ADMIN_KEY` | свой секретный пароль для админки, например `MySecretAdmin2025!` |
| `PORT` | `3000` (Railway может переопределить сама) |

`DATABASE_URL` уже будет добавлена автоматически шагом выше.

---

## Шаг 5. Инициализация базы данных

Таблицы и обновления базы применяются **сами при каждом запуске сервера**
(`db/migrate.js`: `schema.sql` + файлы из `db/migrations/`, затем шифрование PIN).

Demo-данные нужно создать один раз вручную. В Railway: открой вкладку сервиса → Settings → найди "Run command" или используй Railway CLI:

```bash
railway run npm run init-db
```

Это создаст demo-аккаунт:
- Email: `demo@vzlyot.post`
- Пароль: `demo1234`
- PIN: `1111` (владелец), `2222` (админ), `3333` (кассир)

---

## PIN-коды сотрудников

- PIN хранится в базе только в зашифрованном виде (bcrypt), в ответах API его нет.
- PIN — ровно 4 цифры и не может совпадать с PIN другого сотрудника той же точки.
- При регистрации владелец получает свой PIN (поле `pin`) или случайный — он приходит в ответе как `ownerPin`. Общего «0000» больше нет.
- Забыл PIN или первый вход — на экране PIN ссылка **«Владелец: задать или сбросить PIN»** (нужны email и пароль владельца, `POST /auth/owner-pin`).

## Время в отчётах

«Сегодня», «вчера», неделя, месяц и т.д. считаются по Ташкенту (`utils/time.js`), а не по UTC сервера.

---

## Шаг 6. Проверяем что сервер работает

Railway даст тебе публичный URL вида:
```
https://vzlyot-post-production.up.railway.app
```

Открой его в браузере — должен ответить:
```json
{"status":"ok","service":"vzlyot.post API","version":"1.0.0"}
```

Если видишь это — сервер работает! 🎉

---

## Шаг 7. Frontend

Frontend уже подключён к серверу.
Express раздаёт статические файлы из `backend/public/`.

Рабочие файлы frontend:
- `backend/public/index.html` — касса
- `backend/public/admin.html` — админ-панель

---

## Как активировать клиента (твоя ежедневная задача)

Когда новый клиент регистрируется через лендинг — он попадает в таблицу `accounts` со статусом `trial` (14 дней бесплатно).

Чтобы перевести его на платный тариф, отправь запрос (можно через Postman, или просто curl):

```bash
curl -X POST https://твой-сервер.up.railway.app/admin/accounts/5/activate \
  -H "x-admin-key: ТВОЙ_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"plan":"business","months":1}'
```

Где `5` — это ID аккаунта клиента (узнать через `/admin/accounts`).

**Посмотреть всех клиентов:**
```bash
curl https://твой-сервер.up.railway.app/admin/accounts \
  -H "x-admin-key: ТВОЙ_ADMIN_KEY"
```

**Продлить подписку:**
```bash
curl -X POST https://твой-сервер.up.railway.app/admin/accounts/5/extend \
  -H "x-admin-key: ТВОЙ_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"months":1}'
```

**Заблокировать (если не оплатил):**
```bash
curl -X POST https://твой-сервер.up.railway.app/admin/accounts/5/block \
  -H "x-admin-key: ТВОЙ_ADMIN_KEY"
```

---

## Структура проекта

```
vzlyot.post/
├── backend/
│   ├── server.js          ← главный файл, запускает сервер
│   ├── package.json       ← зависимости
│   ├── .env.example        ← пример переменных окружения
│   ├── db/
│   │   ├── schema.sql      ← структура базы данных
│   │   ├── pool.js          ← подключение к PostgreSQL
│   │   └── init.js          ← создаёт таблицы + demo данные
│   ├── middleware/
│   │   └── auth.js          ← проверка токена и подписки
│   └── routes/
│       ├── auth.js          ← регистрация, вход, PIN
│       ├── menu.js           ← меню и категории
│       ├── stock.js          ← склад и тех.карты
│       ├── orders.js         ← заказы, смены, клиенты, сотрудники
│       └── admin.js          ← твоя панель управления клиентами
│   └── public/
│       ├── index.html       ← рабочий frontend кассы
│       └── admin.html       ← рабочая админ-панель
```

---

## Как работает подписка клиента — логика

1. Клиент регистрируется → `status = 'trial'`, `expires_at = +14 дней`
2. Все запросы к API проходят через `middleware/auth.js`
3. Если `expires_at` в прошлом → сервер возвращает `402 SUBSCRIPTION_EXPIRED`
4. Фронтенд показывает экран "Подписка истекла, продлите тариф"
5. Ты получаешь оплату (вручную, через Click/Payme/наличные)
6. Вызываешь `/admin/accounts/:id/activate` — клиент снова работает

Всё просто: одна таблица `accounts`, одно поле `expires_at`, одна проверка в middleware.
