// Ваши контакты для клиентов. Касса показывает их на экране «Подписка истекла»,
// в окне тарифа «Бизнес», в настройках и в приветствии после регистрации;
// сайт — в подвале и у тарифа «Сеть» («Обсудить цену»).
//
// Пустая строка — этот контакт не показывается.

const SUPPORT = {
  phone: '+998999638438',  // номер для звонка
  telegram: 'tveers',      // имя в Telegram без @
};

// Отдаём только то, что безопасно вставить в ссылку
function publicSupport() {
  const phone = String(SUPPORT.phone || '').replace(/[^\d+]/g, '');
  const telegram = String(SUPPORT.telegram || '').replace(/^@/, '');
  return {
    phone: /^\+?\d{7,15}$/.test(phone) ? phone : '',
    telegram: /^[A-Za-z0-9_]{4,32}$/.test(telegram) ? telegram : '',
  };
}

module.exports = { publicSupport };
