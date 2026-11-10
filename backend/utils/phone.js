// Номер телефона — логин владельца. Храним в одном виде: +998901234567.
// Пользователь может ввести «90 123 45 67», «998901234567», «+998 (90) 123-45-67».

function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  // 9 цифр — узбекский номер без кода страны
  if (digits.length === 9) return '+998' + digits;
  if (digits.length >= 11 && digits.length <= 15) return '+' + digits;
  return null;
}

module.exports = { normalizePhone };
