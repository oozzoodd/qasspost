// Отправка событий в вашу Google Таблицу: новые регистрации и оплаты.
//
// Таблица принимает данные через Google Apps Script (код — docs/google-sheets-script.gs).
// На сервере нужны две переменные (Railway → Variables):
//   SHEETS_WEBHOOK_URL    — адрес веб-приложения Apps Script (…/exec)
//   SHEETS_WEBHOOK_SECRET — тот же секрет, что вписан в скрипт
// Без них ничего не отправляется. Ошибка таблицы никогда не мешает регистрации или оплате.

const { PLANS } = require('../config/plans');
const { APP_TIMEZONE } = require('./time');

const TIMEOUT_MS = 8000;

function tashkentDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', {
    timeZone: APP_TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function tashkentDay(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('ru-RU', { timeZone: APP_TIMEZONE });
}

// +998999638438 → +998 99 963 84 38 (с пробелами таблица не превращает номер в число)
function prettyPhone(phone) {
  const m = String(phone || '').match(/^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(phone || '');
}

// Текст, начинающийся с = + - @, таблица считает формулой — экранируем
function cell(value) {
  const s = String(value ?? '');
  return /^[=+\-@]/.test(s) && !/^\+998 /.test(s) ? "'" + s : s;
}

const PLAN_NAMES = Object.fromEntries(Object.values(PLANS).map(p => [p.id, p.name]));
const STATUS_NAMES = { trial: 'Пробный период', active: 'Оплачена', expired: 'Истекла', blocked: 'Заблокирован' };
const METHOD_NAMES = { click: 'Click', payme: 'Payme', cash: 'Наличные', card: 'Карта', transfer: 'Перевод', other: 'Другое' };

// Проверка связи: таблица отвечает «ok» и ничего не записывает
async function sheetPing() {
  if (!process.env.SHEETS_WEBHOOK_URL) return { ok: false, error: 'В Railway не задан SHEETS_WEBHOOK_URL' };
  return send({ event: 'ping' });
}

async function send(payload) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // text/plain — Apps Script принимает такой запрос без лишних проверок браузера
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: process.env.SHEETS_WEBHOOK_SECRET || '', ...payload }),
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = (await res.text()).trim();
    if (!res.ok || text !== 'ok') {
      console.warn('⚠️  Таблица не приняла запись:', res.status, text.slice(0, 120));
      return { ok: false, error: text === 'forbidden' ? 'Секрет в скрипте и в Railway не совпадает' : `Таблица ответила: ${res.status} ${text.slice(0, 80)}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn('⚠️  Не удалось отправить в таблицу:', err.message);
    return { ok: false, error: 'Таблица не отвечает: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Новый клиент. source: «Сайт» или «Админка»
function sheetRegistration({ account, venue, source }) {
  send({
    event: 'registration',
    row: [
      tashkentDate(account.created_at || new Date()),
      cell(venue?.name),
      cell(account.name),
      cell(prettyPhone(account.phone) || account.email || ''),
      PLAN_NAMES[account.plan] || account.plan,
      STATUS_NAMES[account.status] || account.status,
      tashkentDay(account.expires_at),
      source,
    ],
  });
}

// Оплата, записанная в админ-панели
function sheetPayment({ payment, account }) {
  send({
    event: 'payment',
    row: [
      tashkentDate(payment.paid_at),
      cell(account.venue_name),
      cell(prettyPhone(account.phone) || account.email || ''),
      Number(payment.amount),
      payment.currency === 'USD' ? '$' : 'сум',
      METHOD_NAMES[payment.method] || payment.method || '',
      payment.plan ? (PLAN_NAMES[payment.plan] || payment.plan) : '',
      payment.months || '',
      tashkentDay(account.expires_at),
      cell(payment.comment || ''),
    ],
  });
}

module.exports = { sheetRegistration, sheetPayment, sheetPing };
