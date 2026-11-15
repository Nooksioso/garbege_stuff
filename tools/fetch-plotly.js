#!/usr/bin/env node
/*  Garbege stUff — разовый загрузчик plotly.js (CLI)
    Скачивает библиотеку в папку проекта public/vendor/plotly.min.js,
    чтобы «Отчёты» работали без npm и без доступа к CDN в дальнейшем.

    Запуск:   node tools/fetch-plotly.js
    Зависимостей нет — только Node.js 16+. Логика — в tools/plotly-lib.js.  */
'use strict';
const { ensurePlotly, PLOTLY_FILE, SOURCES } = require('./plotly-lib.js');

function log(msg) { process.stdout.write(msg + '\n'); }

ensurePlotly().then(r => {
  if (r.ok) {
    log(r.cached
      ? `[plotly] файл уже на месте: ${PLOTLY_FILE} (${Math.round(r.bytes / 1024)} KB) — ничего не скачиваю.`
      : `[plotly] скачано: ${r.file} (${Math.round(r.bytes / 1024)} KB) из ${r.url}`);
    log('[plotly] теперь «Отчёты» работают без интернета и без npm.');
  } else {
    log('');
    log('[plotly] ✖ Не удалось скачать: ' + r.error);
    log('[plotly]   Варианты:');
    log('[plotly]   1) Повторить позже:  node tools/fetch-plotly.js');
    log('[plotly]   2) Скачать вручную: ' + SOURCES[0]);
    log('[plotly]      и сохранить как: ' + PLOTLY_FILE);
    process.exitCode = 1;
  }
}).catch(e => {
  log('[plotly] ошибка: ' + e.message);
  process.exitCode = 1;
});
