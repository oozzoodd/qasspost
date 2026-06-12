require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const stockRoutes = require('./routes/stock');
const ordersRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(cors());
app.use(express.json());

// Проверка что сервер живой (Railway health check)
app.get('/', (req, res) => {
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
