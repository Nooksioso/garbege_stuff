'use strict';
/*  Garbege stUff — общий модуль: plotly.js как файл проекта (public/vendor/plotly.min.js).
    Используется CLI-тулом (tools/fetch-plotly.js) и сервером (server.js).
    Зависимостей нет — только встроенный модуль https из Node.js 16+.               */
const https = require('https');
const fs = require('fs');
const path = require('path');

const VERSION = process.env.PLOTLY_VERSION || '4.3.0';
/* официальные зеркала: CDN plotly, затем jsDelivr (npm). Пробуем по очереди. */
const SOURCES = [
  `https://cdn.plot.ly/plotly-${VERSION}.min.js`,
  `https://cdn.jsdelivr.net/npm/plotly.js-dist-min@${VERSION}/plotly.min.js`,
];
const PLOTLY_DIR = path.join(__dirname, '..', 'public', 'vendor');
const PLOTLY_FILE = path.join(PLOTLY_DIR, 'plotly.min.js');
const MIN_BYTES = 200 * 1024; /* plotly.min.js — несколько мегабайт; меньше — скачано не то */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'garbage-stuff-plotly-fetcher/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpGet(next).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' для ' + url)); }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('тайм-аут соединения (60 с)')));
  });
}

function downloadTo(url, dest) {
  return httpGet(url).then(res => new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let bytes = 0;
    res.on('data', c => { bytes += c.length; });
    res.on('error', e => { out.destroy(); fs.unlink(tmp, () => {}); reject(e); });
    out.on('error', e => { fs.unlink(tmp, () => {}); reject(e); });
    res.pipe(out);
    out.on('finish', () => out.close(() => {
      if (bytes < MIN_BYTES) {
        fs.unlink(tmp, () => {});
        return reject(new Error('файл подозрительно мал (' + bytes + ' байт) — вероятно, скачана не библиотека'));
      }
      /* простая проверка, что это именно plotly.js (в бандле есть характерные маркеры) */
      const head = fs.readFileSync(tmp, { start: 0, end: 4096 }).toString('utf8');
      if (!/plotly/i.test(head)) {
        fs.unlink(tmp, () => {});
        return reject(new Error('скачанный файл не похож на plotly.js'));
      }
      fs.renameSync(tmp, dest);
      resolve(bytes);
    }));
  }));
}

/* Если библиотека уже лежит в проекте и валидна — не скачиваем. Иначе — пробуем зеркала. */
async function ensurePlotly(log) {
  log = log || (() => {});
  try {
    if (fs.existsSync(PLOTLY_FILE) && fs.statSync(PLOTLY_FILE).size >= MIN_BYTES) {
      return { ok: true, cached: true, file: PLOTLY_FILE, bytes: fs.statSync(PLOTLY_FILE).size };
    }
  } catch { /* файла нет или не читается — скачаем заново */ }

  let lastErr = null;
  for (const url of SOURCES) {
    try {
      const bytes = await downloadTo(url, PLOTLY_FILE);
      return { ok: true, cached: false, file: PLOTLY_FILE, bytes, url };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'неизвестная ошибка', file: PLOTLY_FILE };
}

module.exports = { VERSION, SOURCES, PLOTLY_DIR, PLOTLY_FILE, MIN_BYTES, ensurePlotly, downloadTo };
