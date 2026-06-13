require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const stockRoutes = require('./routes/stock');
const ordersRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');

const app = express();

// Безопасность
app.use(helmet({
  contentSecurityPolicy: false // Разрешаем встроенные стили и скрипты фронтенда
}));

// Ограничение запросов
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 300, // Лимит 300 запросов с одного IP
  message: { error: 'Слишком много запросов. Попробуйте позже.' }
});
app.use(limiter);

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*';
app.use(cors({
  origin: allowedOrigins
}));

app.use(express.json());

// Раздача фронтенда
app.use(express.static(path.join(__dirname, '../frontend')));

// Проверка что сервер живой (Railway health check)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'QassaPos API', version: '1.0.0' });
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
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 QassaPos API запущен на порту ${PORT}`);
});
