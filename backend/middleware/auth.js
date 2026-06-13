const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ ОШИБКА: Переменная окружения JWT_SECRET не задана!');
  process.exit(1);
}

// Проверяет JWT токен в заголовке Authorization: Bearer <token>
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Токен не найден. Войдите в систему.' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { accountId, venueId, staffId, role }

    // Проверяем статус подписки аккаунта
    const acc = await pool.query(
      'SELECT status, expires_at FROM accounts WHERE id = $1',
      [payload.accountId]
    );
    if (!acc.rows.length) {
      return res.status(401).json({ error: 'Аккаунт не найден' });
    }
    const account = acc.rows[0];
    const now = new Date();
    const expired = account.expires_at && new Date(account.expires_at) < now;

    if (account.status === 'blocked') {
      return res.status(403).json({ error: 'Аккаунт заблокирован. Свяжитесь с поддержкой.' });
    }
    if (expired || account.status === 'expired') {
      return res.status(402).json({ error: 'Подписка истекла. Продлите тариф для продолжения работы.', code: 'SUBSCRIPTION_EXPIRED' });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Неверный или просроченный токен' });
  }
}

// Проверяет что роль пользователя входит в список разрешённых
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, JWT_SECRET };
