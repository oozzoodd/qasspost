require('dotenv').config();
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

const app = express();
app.use(helmet({
  contentSecurityPolicy: false,
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
app.use(['/auth/login', '/auth/pin-login', '/auth/register', '/admin'], authLimiter);

// Раздача статических файлов фронтенда (касса и админка)
app.use(express.static(path.join(__dirname, 'public')));

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
