// Время в отчётах — по Ташкенту, а не по часовому поясу сервера (Railway работает в UTC).
//
// Колонки created_at / closed_at имеют тип TIMESTAMP (без пояса) и заполняются NOW()
// в часовом поясе сессии базы. Поэтому границы периодов считаем в ташкентском
// времени, а потом переводим обратно в пояс сессии — так сравнение остаётся
// прямым и индексы по created_at работают.

const APP_TIMEZONE = 'Asia/Tashkent';

// Текущее ташкентское время и начало ташкентских суток (TIMESTAMP без пояса)
const TZ_NOW = `(NOW() AT TIME ZONE '${APP_TIMEZONE}')`;
const TZ_DAY_START = `date_trunc('day', ${TZ_NOW})`;

// Переводит ташкентское время (SQL-выражение) в формат, в котором хранятся даты в базе
function localToStored(localExpr) {
  return `(((${localExpr}) AT TIME ZONE '${APP_TIMEZONE}') AT TIME ZONE current_setting('TimeZone'))`;
}

module.exports = { APP_TIMEZONE, TZ_NOW, TZ_DAY_START, localToStored };
