const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// PIN — всего 4 цифры, поэтому хеш с умеренной стоимостью: вход по PIN
// проверяет всех сотрудников точки по очереди и должен оставаться быстрым.
const PIN_HASH_ROUNDS = 8;

function isValidPin(pin) {
  return /^\d{4}$/.test(String(pin ?? ''));
}

function isPinHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ''));
}

function hashPin(pin) {
  return bcrypt.hash(String(pin), PIN_HASH_ROUNDS);
}

// Сравнивает введённый PIN с сохранённым. Старые записи могут хранить PIN
// открытым текстом (до миграции) — такие сравниваем напрямую.
async function pinMatches(pin, stored) {
  if (!stored) return false;
  if (isPinHash(stored)) return bcrypt.compare(String(pin), stored);
  return String(pin) === String(stored);
}

// Ищет сотрудника с таким PIN среди строк staff (нужны поля id и pin)
async function findByPin(rows, pin) {
  for (const row of rows) {
    if (await pinMatches(pin, row.pin)) return row;
  }
  return null;
}

// Случайный PIN для нового владельца вместо общего «0000»
function randomPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

module.exports = { isValidPin, isPinHash, hashPin, pinMatches, findByPin, randomPin };
