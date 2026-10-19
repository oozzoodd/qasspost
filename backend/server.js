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

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 80,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/auth/login', '/auth/pin-login', '/auth/owner-pin', '/auth/register', '/admin'], authLimiter);

// Раздача статических файлов фронтенда (касса и админка)
app.use(express.static(path.join(__dirname, 'public')));

// Проверка что сервер живой (Railway health check)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'vzlyot.post API', version: '1.0.0' });
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
