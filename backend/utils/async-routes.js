// Express 4 не ловит ошибки из async-обработчиков: необработанный reject
// роняет весь процесс Node. Этот модуль оборачивает каждый обработчик роутеров
// так, что ошибка уходит в общий обработчик ошибок (server.js), а сервер живёт.
// Подключать до создания роутеров.

const express = require('express');

const routerProto = Object.getPrototypeOf(express.Router());

function wrap(fn) {
  // Обработчики ошибок (4 аргумента) и не-функции не трогаем
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  const wrapped = function (req, res, next) {
    try {
      const result = fn.call(this, req, res, next);
      if (result && typeof result.catch === 'function') result.catch(next);
      return result;
    } catch (err) {
      return next(err);
    }
  };
  // Вложенные роутеры (router.use(subRouter)) сохраняют свои свойства
  return Object.assign(wrapped, fn);
}

for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
  const original = routerProto[method];
  routerProto[method] = function (...args) {
    return original.apply(this, args.map(arg => (Array.isArray(arg) ? arg.map(wrap) : wrap(arg))));
  };
}
