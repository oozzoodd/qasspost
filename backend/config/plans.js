// Тарифы vzlyot.post и что в них входит. Единственное место, где это задаётся:
// сервер проверяет доступ по этому списку, касса и лендинг получают его через API.
//
// «Старт» — простая касса: продажи, меню, смены, сотрудники, выручка,
// поштучный склад. Всё остальное открывается на «Бизнесе»:
//   recipes       — техкарты (списание ингредиентов по граммам при продаже)
//   stock_weight  — весовой склад (граммы, килограммы, миллилитры, литры)
//   finance       — расходы кассы, прибыль, финансовые отчёты
//   clients       — база клиентов и бонусы
//
// ЦЕНЫ: поменяйте числа ниже — лендинг и админка подхватят их сами.

const PAID_FEATURES = ['recipes', 'stock_weight', 'finance', 'clients'];

const PLANS = {
  start: {
    id: 'start',
    name: 'Старт',
    price: 29,
    currency: '$',
    features: [],
  },
  business: {
    id: 'business',
    name: 'Бизнес',
    price: 49,
    currency: '$',
    features: [...PAID_FEATURES],
  },
  network: {
    id: 'network',
    name: 'Сеть',
    price: 89,
    currency: '$',
    features: [...PAID_FEATURES],
  },
};

const DEFAULT_PLAN = 'start';
const TRIAL_DAYS = 14;

function isValidPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLANS, plan);
}

// Неизвестный тариф (старая запись в базе) считаем «Стартом»
function featuresOf(plan) {
  return new Set((PLANS[plan] || PLANS[DEFAULT_PLAN]).features);
}

function publicPlans() {
  return Object.values(PLANS).map(({ id, name, price, currency, features }) => ({ id, name, price, currency, features }));
}

module.exports = { PLANS, PAID_FEATURES, DEFAULT_PLAN, TRIAL_DAYS, isValidPlan, featuresOf, publicPlans };
