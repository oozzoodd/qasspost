// ═══════════════════════════════════════════════════════════
// Скрипт для Google Таблицы vzlyot.post.
// Принимает от сервера новые регистрации и оплаты и дописывает их строками
// на листы «Регистрации» и «Оплаты» (листы создаются сами).
//
// Как подключить:
// 1. Откройте свою Google Таблицу → Расширения → Apps Script.
// 2. Удалите всё в редакторе, вставьте этот файл целиком, вставьте ниже свой SECRET.
// 3. Сохраните → «Начать развёртывание» → «Новое развёртывание» → тип «Веб-приложение».
//    Выполнять как: «Я». Доступ: «Все». Нажмите «Развернуть» и разрешите доступ.
// 4. Скопируйте адрес веб-приложения (заканчивается на /exec) и вставьте в Railway:
//    SHEETS_WEBHOOK_URL = этот адрес, SHEETS_WEBHOOK_SECRET = тот же SECRET.
// ═══════════════════════════════════════════════════════════

const SECRET = 'ВСТАВЬТЕ_СЮДА_СЕКРЕТ';

const SHEETS = {
  registration: {
    name: 'Регистрации',
    header: ['Дата', 'Заведение', 'Имя', 'Телефон', 'Тариф', 'Статус', 'Доступ до', 'Откуда'],
  },
  payment: {
    name: 'Оплаты',
    header: ['Дата', 'Заведение', 'Телефон', 'Сумма', 'Валюта', 'Способ', 'Тариф', 'Месяцев', 'Доступ до', 'Комментарий'],
  },
};

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply('bad json');
  }
  if (!SECRET || data.secret !== SECRET) return reply('forbidden');
  if (data.event === 'ping') return reply('ok'); // проверка связи из админ-панели, ничего не пишет

  const config = SHEETS[data.event];
  if (!config || !Array.isArray(data.row)) return reply('unknown event');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // две регистрации в одну секунду не перепишут друг друга
  try {
    const sheet = getSheet(config);
    sheet.appendRow(data.row);
  } finally {
    lock.releaseLock();
  }
  return reply('ok');
}

function getSheet(config) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(config.name);
  if (!sheet) {
    sheet = ss.insertSheet(config.name);
    sheet.appendRow(config.header);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, config.header.length).setFontWeight('bold').setBackground('#1C2B45').setFontColor('#F7F4EC');
  }
  return sheet;
}

function reply(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}
