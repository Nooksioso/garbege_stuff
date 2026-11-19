#!/usr/bin/env node
/* Вспомогательная проверка: извлекает inline-скрипты из index.html и проверяет их синтаксис */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stx-'));
let i = 0, fail = 0;
let m;
while ((m = re.exec(html)) !== null) {
  i += 1;
  const f = path.join(tmpDir, `inline${i}.js`);
  fs.writeFileSync(f, m[1]);
  try {
    new Function(m[1]); /* синтаксический разбор (без выполнения) */
    console.log(`inline #${i}: OK (${m[1].length} chars)`);
  } catch (e) {
    fail = 1;
    console.error(`inline #${i}: SYNTAX ERROR: ${e.message}`);
  }
}
if (i === 0) { console.error('inline-скрипты не найдены'); fail = 1; }
process.exit(fail);
