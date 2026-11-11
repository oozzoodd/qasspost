require('dotenv').config();
require('./utils/async-routes'); // до роутеров: ошибки async-обработчиков не роняют сервер
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const stockRoutes = require('./routes/stock');
const ordersRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const migrate = require('./db/migrate');
const { publicPlans, TRIAL_DAYS } = require('./config/plans');
const { publicSupport } = require('./config/support');

const app = express();

// Railway ставит перед сервером один прокси: без этого все посетители выглядят
// как один IP-адрес и ограничение попыток входа срабатывает на всех сразу.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      // Фирменный шрифт Manrope грузится с Google Fonts; без интернета остаётся системный
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      // Фотографии на лендинге — с Unsplash (бесплатная лицензия, раздаются их CDN)
      imgSrc: ["'self'", "data:", "blob:", 'https://images.unsplash.com'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:", 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
}));
app.use(express.json({ limit: '1mb' }));

const limiter = options => rateLimit({
  windowMs: 15 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Подождите немного и попробуйте снова.' },
  ...options,
});
// Вход и PIN: защита от перебора
app.use(['/auth/login', '/auth/pin-login', '/auth/owner-pin'], limiter({ limit: 80 }));
// Регистрация открыта всем с лендинга — не даём создавать аккаунты пачками
app.use('/auth/register', limiter({ windowMs: 60 * 60 * 1000, limit: 10 }));
// Админка: считаем только неудачные запросы (неверный ключ), работе в панели это не мешает
app.use('/admin', limiter({ limit: 30, skipSuccessfulRequests: true }));

// Страницы: «/» — лендинг (index.html), «/app» — касса, «/admin.html» — админ-панель
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
// Иконки Tabler (контурные) — свои, не с чужого сайта: касса не зависит от внешних CDN
app.use('/vendor/tabler', express.static(
  path.join(__dirname, 'node_modules', '@tabler', 'icons-webfont', 'dist'),
  { maxAge: '30d', immutable: true }
));
app.use(express.static(path.join(__dirname, 'public')));

// Проверка что сервер живой (Railway health check)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'vzlyot.post API', version: '1.0.0' });
});

// Тарифы, цены и контакты поддержки для лендинга и кассы (config/plans.js, config/support.js)
app.get('/plans', (req, res) => {
  res.json({ plans: publicPlans(), trialDays: TRIAL_DAYS, support: publicSupport() });
});

app.use('/auth', authRoutes);
app.use('/menu', menuRoutes);
app.use('/stock', stockRoutes);
app.use('/orders', ordersRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));

// Общий обработчик ошибок
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  // 23503 — запись используется в других (продажи, смены, приходы)
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Нельзя удалить: запись уже используется в продажах, сменах или приходах' });
  }
  // 22P02 / 22003 / 23502 — неверный формат или пустое обязательное поле
  if (['22P02', '22003', '23502', '22007', '22008'].includes(err.code)) {
    return res.status(400).json({ error: 'Проверьте введённые данные' });
  }
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Последняя страховка: ошибка вне запроса не должна останавливать кассу
process.on('unhandledRejection', err => console.error('Необработанная ошибка:', err));

const PORT = process.env.PORT || 3000;
migrate()
  .catch(err => console.error('❌ Миграция базы не удалась:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`🚀 vzlyot.post API запущен на порту ${PORT}`);
    });
  });
