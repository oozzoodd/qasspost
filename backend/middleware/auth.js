const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { featuresOf } = require('../config/plans');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ ОШИБКА: Переменная окружения JWT_SECRET не задана!');
  process.exit(1);
}

// «Был в сети»: отмечаем не чаще раза в 5 минут на аккаунт, чтобы не писать
// в базу на каждый запрос. Память процесса — после перезапуска просто отметим снова.
const SEEN_INTERVAL_MS = 5 * 60 * 1000;
const lastSeenTouch = new Map();
function touchLastSeen(accountId) {
  const now = Date.now();
  if (now - (lastSeenTouch.get(accountId) || 0) < SEEN_INTERVAL_MS) return;
  lastSeenTouch.set(accountId, now);
  pool.query('UPDATE accounts SET last_seen_at = NOW() WHERE id = $1', [accountId]).catch(() => {});
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
    req.user = payload; // { accountId, venueId, staffId, role, ro? }

    // Проверяем статус подписки аккаунта
    const acc = await pool.query(
      'SELECT plan, status, expires_at FROM accounts WHERE id = $1',
      [payload.accountId]
    );
    if (!acc.rows.length) {
      return res.status(401).json({ error: 'Аккаунт не найден' });
    }
    const account = acc.rows[0];
    req.account = account;
    req.features = featuresOf(account.plan);

    // Просмотр из админ-панели: только чтение, подписка и «был в сети» не учитываются
    if (payload.ro) {
      if (req.method !== 'GET') {
        return res.status(403).json({ error: 'Режим просмотра: изменения отключены', code: 'READ_ONLY' });
      }
      return next();
    }

    const now = new Date();
    const expired = account.expires_at && new Date(account.expires_at) < now;

    if (account.status === 'blocked') {
      return res.status(403).json({ error: 'Аккаунт заблокирован. Свяжитесь с поддержкой.' });
    }
    if (expired || account.status === 'expired') {
      return res.status(402).json({ error: 'Подписка истекла. Продлите тариф для продолжения работы.', code: 'SUBSCRIPTION_EXPIRED' });
    }

    touchLastSeen(payload.accountId);
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

// Раздел входит в тариф аккаунта? (список — в config/plans.js)
function hasFeature(req, feature) {
  return Boolean(req.features && req.features.has(feature));
}
function featureLocked(res, feature) {
  return res.status(403).json({
    error: 'Этот раздел доступен на тарифе «Бизнес»',
    code: 'FEATURE_LOCKED',
    feature,
  });
}
function requireFeature(feature) {
  return (req, res, next) => (hasFeature(req, feature) ? next() : featureLocked(res, feature));
}

module.exports = { requireAuth, requireRole, requireFeature, hasFeature, featureLocked, JWT_SECRET };
