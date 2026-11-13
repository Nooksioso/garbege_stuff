#!/usr/bin/env node
/*  STUFFTIME — сервер учёта рабочего времени сотрудников
    Запуск:   node server.js   →   http://localhost:8080
    Данные:   data/stufftime.json  — журнал записей и сессии
              data/employees.json  — справочник сотрудников (отдельный JSON)
              data/projects.json   — справочник проектов (задач): номер, наименование, комментарий
    Аватарки: public/avatars       — готовый набор картинок (6 шт.)
    Зависимостей нет — только Node.js 16+                                */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const AVATARS_DIR = path.join(PUBLIC_DIR, 'avatars');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'stufftime.json');
const EMPS_FILE = path.join(DATA_DIR, 'employees.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const startedAt = Date.now();

/* Проверяем, что интерфейс на месте, — иначе браузеру нечего показать */
if (!fs.existsSync(INDEX_FILE)) {
  console.error('');
  console.error('  ✖ Не найден файл интерфейса:');
  console.error('      ' + INDEX_FILE);
  console.error('');
  console.error('  Папка stufftime должна содержать:  server.js  и  public/index.html');
  console.error('  Запускайте сервер из папки stufftime:');
  console.error('      cd stufftime && node server.js');
  process.exit(1);
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex'));

/* ---- пароли: хеш (scrypt + соль), в базе и в API наружу не отдаём ---- */
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(password, salt) { return crypto.scryptSync(String(password), salt, 32).toString('hex'); }
function setEmployeePassword(emp, password) {
  const salt = newSalt();
  emp.passwordSalt = salt;
  emp.passwordHash = hashPassword(password, salt);
}
/* нормализуем роль доступа (admin | executor) */
function normAccess(e) { return (e && e.accessRole === 'admin') ? 'admin' : 'executor'; }
function publicEmp(e) {
  return {
    id: e.id, name: e.name, role: e.role,
    accessRole: normAccess(e),
    avatar: validAvatar(e.avatar) || '',
    hasPassword: Boolean(e.passwordHash),
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

/* ---- готовые аватарки: картинки лежат в папке public/avatars ---- */
const AVATAR_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
function listAvatars() {
  try {
    return fs.readdirSync(AVATARS_DIR)
      .filter(f => AVATAR_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'ru'));
  } catch { return []; }
}
/* имя файла аватарки: пусто — «без аватара» (покажутся инициалы),
   иначе файл обязан существовать в public/avatars */
function validAvatar(name) {
  const a = String(name || '').trim();
  if (!a) return '';
  if (!AVATAR_EXT.has(path.extname(a).toLowerCase())) return null;
  const full = path.normalize(path.join(AVATARS_DIR, a));
  if (!full.startsWith(AVATARS_DIR + path.sep)) return null;
  try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
  return a;
}

/* ---- ограничение перебора паролей (в памяти) ---- */
const loginFails = new Map(); // employeeId -> { n, resetAt }
function loginLimited(id) {
  const a = loginFails.get(id);
  return Boolean(a && a.n >= 5 && a.resetAt > Date.now());
}
function recordLoginFail(id) {
  const now = Date.now();
  const a = loginFails.get(id);
  if (!a || a.resetAt < now) loginFails.set(id, { n: 1, resetAt: now + 5 * 60000 });
  else a.n += 1;
}
function clearLoginFails(id) { loginFails.delete(id); }

function isoLocal(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- хранилище ----------
   журнал + сессии — data/stufftime.json
   справочник      — data/employees.json (отдельный файл)               */
let db = { entries: [], sessions: [] };
let emps = [];
let projects = [];
let saveTimer = null, empsTimer = null, projectsTimer = null;

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw === 'object') db = raw;
    }
  } catch (e) { console.warn('[db] чтение журнала пропущено:', e.message); }
  if (!Array.isArray(db.entries)) db.entries = [];
  if (!Array.isArray(db.sessions)) db.sessions = [];

  /* справочник сотрудников — свой JSON-файл */
  try {
    if (fs.existsSync(EMPS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(EMPS_FILE, 'utf8'));
      if (Array.isArray(raw)) emps = raw;
    }
  } catch (e) { console.warn('[db] чтение справочника пропущено:', e.message); }
  if (!Array.isArray(emps)) emps = [];

  /* проекты — свой JSON-файл (справочник задач) */
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
      if (Array.isArray(raw)) projects = raw;
    }
  } catch (e) { console.warn('[db] чтение проектов пропущено:', e.message); }
  if (!Array.isArray(projects)) projects = [];

  /* разовая миграция: у каждого проекта — уникальный номер (автоматический, первый свободный) */
  {
    const usedNums = new Set();
    let numChanged = false;
    for (const pr of projects) {
      const n = Number(pr.num);
      if (!Number.isInteger(n) || n < 1 || usedNums.has(n)) {
        let k = 1; while (usedNums.has(k)) k += 1;
        pr.num = k;
        numChanged = true;
      }
      usedNums.add(pr.num);
    }
    if (numChanged) flushProjects();
  }

  /* разовая миграция: раньше справочник лежал внутри stufftime.json —
     переносим его в employees.json, выдаём аватары из готового набора */
  if (Array.isArray(db.employees) && db.employees.length) {
    if (!emps.length) {
      emps = db.employees;
      const avs = listAvatars();
      if (avs.length) emps.forEach((e, i) => { if (!e.avatar) e.avatar = avs[i % avs.length]; });
      flushEmps();
    }
    delete db.employees;
    flush();
  }

  /* разовая миграция: роли доступа (администратор / исполнитель) */
  if (!db.migratedRoles) {
    for (const e of emps) if (normAccess(e) !== 'admin') e.accessRole = 'executor';
    /* Иванов Сергей — администратор, все остальные — исполнители */
    let admin = emps.find(e => String(e.name || '').trim().toLowerCase() === 'иванов сергей');
    if (admin) {
      admin.accessRole = 'admin';
    } else {
      /* такого сотрудника ещё нет — создаём администратором (пароль задастся при первом входе) */
      admin = { id: uid(), name: 'Иванов Сергей', role: '', accessRole: 'admin', createdAt: Date.now() };
      emps.push(admin);
    }
    db.migratedRoles = true;
    flush(); flushEmps();
  }
}
function flush() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function flushEmps() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(EMPS_FILE, JSON.stringify(emps, null, 2));
}
function flushProjects() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 150); }
function saveEmps() { clearTimeout(empsTimer); empsTimer = setTimeout(flushEmps, 150); }
function saveProjects() { clearTimeout(projectsTimer); projectsTimer = setTimeout(flushProjects, 150); }
process.on('SIGINT', () => { flush(); flushEmps(); flushProjects(); console.log('\n[db] сохранено. Пока!'); process.exit(0); });

/* Демо-данные при первом запуске (чтобы сбросить — удалите оба файла data/*.json) */
function seed() {
  const now = Date.now();
  const avs = listAvatars();
  const mk = (name, role, accessRole, avatar) => {
    const e = { id: uid(), name, role, accessRole: accessRole || 'executor', avatar: avatar || '', createdAt: now };
    setEmployeePassword(e, '1234');
    return e;
  };
  const e1 = mk('Иванов Иван', 'инженер', 'executor', avs[0]);
  const e2 = mk('Петрова Анна', 'дизайнер', 'executor', avs[1]);
  const e3 = mk('Сидоров Пётр', 'техник', 'executor', avs[2]);
  const e4 = mk('Иванов Сергей', 'инженер-технолог', 'admin', avs[3]);
  emps = [e1, e2, e3, e4];
  /* справочник проектов (задач) — названия совпадают с демо-записями ниже */
  projects = [
    { id: uid(), num: 1, name: 'Настройка конвейера №2', description: 'плановые работы', createdAt: now, updatedAt: now },
    { id: uid(), num: 2, name: 'Макет упаковки', description: 'дизайн, согласование', createdAt: now, updatedAt: now },
    { id: uid(), num: 3, name: 'Аудит процессов', description: 'проверка журналов', createdAt: now, updatedAt: now },
    { id: uid(), num: 4, name: 'Ремонт станка №3', description: 'замена датчика', createdAt: now, updatedAt: now },
    { id: uid(), num: 5, name: 'Сопровождение клиента', description: 'выезды, консультации', createdAt: now, updatedAt: now },
    { id: uid(), num: 6, name: 'Печатная форма', description: 'предпечатная подготовка', createdAt: now, updatedAt: now },
  ];
  flushProjects();
  const mkE = (emp, offset, task, hours, comment) => ({
    id: uid(), employeeId: emp.id, employeeName: emp.name,
    date: isoLocal(offset), task, hours, comment,
    createdAt: now - offset * 86400000, updatedAt: now - offset * 86400000,
  });
  db.entries = [
    mkE(e1, 0, 'Настройка конвейера №2', 4.5, 'плановые работы'),
    mkE(e2, 0, 'Макет упаковки', 3, 'итог согласован'),
    mkE(e4, 0, 'Аудит процессов', 2.5, 'проверка журналов'),
    mkE(e3, -1, 'Ремонт станка №3', 6, 'замена датчика'),
    mkE(e1, -3, 'Сопровождение клиента', 8, 'выезд'),
    mkE(e2, -5, 'Печатная форма', 5.5, ''),
  ];
  db.migratedRoles = true;
  flush();
  flushEmps();
}

/* ---------- помощники ---------- */
function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1e5) { reject(new Error('слишком большой запрос')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

/* текущий пользователь — администратор? */
function actorIsAdmin(req) {
  return Boolean(req.auth && req.auth.employee && req.auth.employee.accessRole === 'admin');
}

/* ---- проекты (справочник задач): наименование — уникальное, номер — первый свободный ---- */
function findProjectByName(name, skipId) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return projects.find(x => x.id !== skipId && String(x.name || '').trim().toLowerCase() === n) || null;
}
function nextProjectNum(list) {
  const used = new Set(list.map(x => Number(x.num)).filter(n => Number.isInteger(n) && n > 0));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}
function sortedProjects() {
  return [...projects].sort((a, b) =>
    (Number(a.num) || 0) - (Number(b.num) || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
}

function validateEntryPayload(body) {
  const errors = [];
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('дата в формате ГГГГ-ММ-ДД');
  const task = String(body.task || '').trim();
  if (!task) errors.push('заполните задачу');
  else if (task.length > 300) errors.push('задача слишком длинная (до 300 знаков)');
  else if (!findProjectByName(task)) errors.push(projects.length
    ? 'задачу можно выбрать только из справочника «Проекты» (ручной ввод отключён)'
    : 'в справочнике «Проекты» нет ни одного проекта — сначала внесите проект');
  const hours = Number(body.hours);
  if (!Number.isFinite(hours) || hours <= 0) errors.push('часы — число больше 0');
  if (hours > 24) errors.push('не более 24 часов за день');
  const comment = String(body.comment || '').trim();
  if (comment.length > 300) errors.push('комментарий слишком длинный (до 300 знаков)');
  if (errors.length) return { error: errors.join('; ') };
  return { value: { date, task, hours: Math.round(hours * 100) / 100, comment } };
}

function sortedEntries() {
  return [...db.entries].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt);
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  try {
    /* ================= API ================= */

    if (m === 'GET' && p === '/api/health')
      return json(res, 200, { ok: true, now: Date.now(), uptime: Math.round((Date.now() - startedAt) / 1000) });

    /* ---- публичные: аватарки, список для экрана входа и сам вход ---- */
    if (m === 'GET' && p === '/api/avatars')
      return json(res, 200, { avatars: listAvatars() });

    if (m === 'GET' && p === '/api/login/employees')
      return json(res, 200, emps.map(e => ({
        id: e.id, name: e.name, role: e.role,
        avatar: validAvatar(e.avatar) || '',
        hasPassword: Boolean(e.passwordHash), accessRole: normAccess(e),
      })));

    if (m === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      const emp = emps.find(e => e.id === body.employeeId);
      const password = String(body.password || '');
      if (!emp) return json(res, 401, { error: 'Неверный логин или пароль' });

      if (body.setup === true) {
        /* первичная установка: доступна, пока у сотрудника нет пароля */
        if (emp.passwordHash) return json(res, 400, { error: 'Пароль уже задан — войдите с ним' });
        if (password.length < 4) return json(res, 400, { error: 'Пароль должен быть не короче 4 символов' });
        setEmployeePassword(emp, password);
        saveEmps();
      } else {
        if (!emp.passwordHash) { recordLoginFail(emp.id); return json(res, 401, { error: 'Неверный логин или пароль' }); }
        if (loginLimited(emp.id)) return json(res, 429, { error: 'Слишком много попыток — попробуйте через минуту' });
        const given = Buffer.from(hashPassword(password, emp.passwordSalt), 'hex');
        const stored = Buffer.from(emp.passwordHash, 'hex');
        const ok = given.length === stored.length && crypto.timingSafeEqual(given, stored);
        if (!ok) { recordLoginFail(emp.id); return json(res, 401, { error: 'Неверный логин или пароль' }); }
        clearLoginFails(emp.id);
      }

      const now = Date.now();
      db.sessions = db.sessions.filter(s => s.expiresAt > now);
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions.push({ token, employeeId: emp.id, createdAt: now, expiresAt: now + 8 * 3600000 });
      save();
      return json(res, 200, {
        token, name: emp.name, role: emp.role, accessRole: normAccess(emp),
        avatar: validAvatar(emp.avatar) || '',
      });
    }

    /* ---- защита: всё остальное API — только с активной сессией ---- */
    if (p.startsWith('/api/')) {
      const h = String(req.headers['authorization'] || '');
      const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
      const now = Date.now();
      const sess = token ? db.sessions.find(s => s.token === token && s.expiresAt > now) : null;
      const emp = sess ? emps.find(e => e.id === sess.employeeId) : null;
      if (!sess || !emp) return json(res, 401, { error: 'Требуется вход в систему' });
      req.auth = { session: sess, employee: emp };
    }

    const isAdmin = actorIsAdmin(req);
    const actor = (req.auth && req.auth.employee) || null;

    if (m === 'POST' && p === '/api/logout') {
      db.sessions = db.sessions.filter(s => s.token !== req.auth.session.token);
      save();
      return json(res, 200, { ok: true });
    }

    if (m === 'GET' && p === '/api/whoami') {
      const e = actor;
      return json(res, 200, {
        employeeId: e.id, name: e.name, role: e.role,
        accessRole: normAccess(e), avatar: validAvatar(e.avatar) || '',
        expiresAt: req.auth.session.expiresAt,
      });
    }

    /* ---- справочник сотрудников (data/employees.json) ---- */
    if (m === 'GET' && p === '/api/employees') {
      /* администратор видит всех, исполнитель — только себя (для списка при вводе) */
      const list = isAdmin ? emps : emps.filter(e => e.id === actor.id);
      return json(res, 200, list.map(publicEmp));
    }

    if (m === 'POST' && p === '/api/employees') {
      if (!isAdmin) return json(res, 403, { error: 'Вносить сотрудников может только администратор' });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: 'Укажите фамилию и имя' });
      if (name.length > 60) return json(res, 400, { error: 'Имя слишком длинное (до 60 знаков)' });
      if (emps.some(e => e.name.toLowerCase() === name.toLowerCase()))
        return json(res, 409, { error: 'Такой сотрудник уже есть в справочнике' });
      const password = String(body.password || '').trim();
      if (password && password.length < 4) return json(res, 400, { error: 'Пароль должен быть не короче 4 символов' });
      const accessRole = body.accessRole === 'admin' ? 'admin' : 'executor';
      const avatarRaw = String(body.avatar || '').trim();
      const avatar = validAvatar(avatarRaw);
      if (avatarRaw && !avatar) return json(res, 400, { error: 'Аватар не найден: выберите картинку из папки public/avatars' });
      const emp = {
        id: uid(), name,
        role: String(body.role || '').trim().slice(0, 40),
        accessRole, avatar: avatar || '', createdAt: Date.now(),
      };
      if (password) setEmployeePassword(emp, password);
      emps.push(emp); saveEmps();
      return json(res, 201, publicEmp(emp));
    }

    let em = p.match(/^\/api\/employees\/([\w-]+)$/);
    if (em) {
      const emp = emps.find(e => e.id === em[1]);
      if (!emp) return json(res, 404, { error: 'Сотрудник не найден' });
      if (!isAdmin) return json(res, 403, { error: 'Управлять справочником может только администратор' });
      if (m === 'PUT') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name) return json(res, 400, { error: 'Укажите фамилию и имя' });
        if (emps.some(e => e.id !== emp.id && e.name.toLowerCase() === name.toLowerCase()))
          return json(res, 409, { error: 'Такой сотрудник уже есть в справочнике' });
        emp.name = name.slice(0, 60);
        emp.role = String(body.role || '').trim().slice(0, 40);
        if (body.accessRole === 'admin' || body.accessRole === 'executor') emp.accessRole = body.accessRole;
        if (body.avatar !== undefined) {
          const avatarRaw = String(body.avatar || '').trim();
          const avatar = validAvatar(avatarRaw);
          if (avatarRaw && !avatar) return json(res, 400, { error: 'Аватар не найден: выберите картинку из папки public/avatars' });
          emp.avatar = avatar || '';
        }
        if (body.clearPassword === true) {
          emp.passwordSalt = undefined;
          emp.passwordHash = undefined;
        } else if (body.password) {
          const password = String(body.password);
          if (password.length < 4) return json(res, 400, { error: 'Пароль должен быть не короче 4 символов' });
          setEmployeePassword(emp, password);
        }
        emp.updatedAt = Date.now();
        saveEmps();
        return json(res, 200, publicEmp(emp));
      }
      if (m === 'DELETE') {
        emps = emps.filter(e => e.id !== emp.id);
        saveEmps();
        return json(res, 200, { ok: true });
      }
    }

    /* ---- проекты (data/projects.json) — справочник задач ---- */
    if (m === 'GET' && p === '/api/projects') {
      /* список нужен для выбора задач — доступен всем авторизованным;
         внесение, изменение и удаление — только администратору */
      return json(res, 200, { projects: sortedProjects() });
    }

    if (m === 'POST' && p === '/api/projects') {
      if (!isAdmin) return json(res, 403, { error: 'Вносить проекты может только администратор' });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: 'Укажите наименование проекта' });
      if (name.length > 80) return json(res, 400, { error: 'Наименование слишком длинное (до 80 знаков)' });
      if (findProjectByName(name))
        return json(res, 409, { error: 'Наименование должно быть уникальным: такой проект уже есть в справочнике' });
      const description = String(body.description || '').trim().slice(0, 300);
      /* номер — автоматический, первый свободный */
      const proj = { id: uid(), num: nextProjectNum(projects), name, description, createdAt: Date.now(), updatedAt: Date.now() };
      projects.push(proj); saveProjects();
      return json(res, 201, proj);
    }

    let pm = p.match(/^\/api\/projects\/([\w-]+)$/);
    if (pm) {
      const proj = projects.find(x => x.id === pm[1]);
      if (!proj) return json(res, 404, { error: 'Проект не найден' });
      if (!isAdmin) return json(res, 403, { error: 'Управлять проектами может только администратор' });
      if (m === 'PUT') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name) return json(res, 400, { error: 'Укажите наименование проекта' });
        if (name.length > 80) return json(res, 400, { error: 'Наименование слишком длинное (до 80 знаков)' });
        if (findProjectByName(name, proj.id))
          return json(res, 409, { error: 'Наименование должно быть уникальным: такой проект уже есть в справочнике' });
        proj.name = name;
        if (body.description !== undefined) proj.description = String(body.description || '').trim().slice(0, 300);
        /* номер (num) присваивается автоматически и не изменяется */
        proj.updatedAt = Date.now();
        saveProjects();
        return json(res, 200, proj);
      }
      if (m === 'DELETE') {
        projects = projects.filter(x => x.id !== proj.id);
        saveProjects();
        return json(res, 200, { ok: true });
      }
    }

    /* ---- записи журнала ---- */
    if (m === 'GET' && p === '/api/entries') {
      const all = sortedEntries();
      const list = isAdmin ? all : all.filter(e => e.employeeId === actor.id);
      return json(res, 200, { entries: list });
    }

    if (m === 'POST' && p === '/api/entries') {
      const body = await readBody(req);
      const v = validateEntryPayload(body);
      if (v.error) return json(res, 400, { error: v.error });
      let target;
      if (isAdmin) {
        target = emps.find(e => e.id === body.employeeId);
        if (!target) return json(res, 400, { error: 'выберите сотрудника из справочника' });
      } else {
        /* исполнитель вносит запись только за себя */
        if (body.employeeId && body.employeeId !== actor.id)
          return json(res, 403, { error: 'Исполнитель может вносить записи только за себя' });
        target = actor;
      }
      const now = Date.now();
      const entry = {
        id: uid(), employeeId: target.id, employeeName: target.name,
        date: v.value.date, task: v.value.task, hours: v.value.hours, comment: v.value.comment,
        createdAt: now, updatedAt: now,
      };
      db.entries.push(entry); save();
      return json(res, 201, entry);
    }

    let en = p.match(/^\/api\/entries\/([\w-]+)$/);
    if (en) {
      const entry = db.entries.find(x => x.id === en[1]);
      if (!entry) return json(res, 404, { error: 'Запись не найдена' });
      /* исполнитель трогает только собственные записи */
      if (!isAdmin && entry.employeeId !== actor.id)
        return json(res, 403, { error: 'Можно изменять только собственные записи' });
      if (m === 'PUT') {
        const body = await readBody(req);
        const v = validateEntryPayload(body);
        if (v.error) return json(res, 400, { error: v.error });
        if (isAdmin) {
          const emp = emps.find(e => e.id === body.employeeId);
          if (emp) { entry.employeeId = emp.id; entry.employeeName = emp.name; }
        } else {
          entry.employeeId = actor.id;
          entry.employeeName = actor.name;
        }
        entry.date = v.value.date;
        entry.task = v.value.task;
        entry.hours = v.value.hours;
        entry.comment = v.value.comment;
        entry.updatedAt = Date.now();
        save();
        return json(res, 200, entry);
      }
      if (m === 'DELETE') {
        db.entries = db.entries.filter(x => x.id !== entry.id);
        save();
        return json(res, 200, { ok: true });
      }
    }

    /* ---- сводка ---- */
    if (m === 'GET' && p === '/api/stats') {
      const pool = isAdmin ? db.entries : db.entries.filter(e => e.employeeId === actor.id);
      const empPool = isAdmin ? emps : emps.filter(e => e.id === actor.id);
      const today = isoLocal(0);
      const month = today.slice(0, 7);
      const hoursToday = pool.filter(e => e.date === today).reduce((a, e) => a + e.hours, 0);
      const hoursMonth = pool.filter(e => e.date.startsWith(month)).reduce((a, e) => a + e.hours, 0);
      const r = x => Math.round(x * 100) / 100;
      return json(res, 200, {
        employees: empPool.length,
        entries: pool.length,
        hoursToday: r(hoursToday),
        hoursMonth: r(hoursMonth),
        today,
      });
    }

    /* ================= статика ================= */
    if (m === 'GET') {
      const full = path.normalize(path.join(PUBLIC_DIR, p === '/' ? '/index.html' : p));
      if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full).toLowerCase();
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.ico': 'image/x-icon',
        };
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          /* интерфейс обновляется часто — не даём браузеру хранить устаревшие CSS/JS */
          'Cache-Control': 'no-cache',
        });
        return fs.createReadStream(full).pipe(res);
      }
      if (p.startsWith('/api/')) return json(res, 404, { error: 'не найдено: ' + p });
      /* SPA-фолбэк: любой неизвестный путь отдаёт само приложение */
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }

    return json(res, 405, { error: 'метод не поддерживается' });
  } catch (e) {
    return json(res, e.message === 'некорректный JSON' ? 400 : 500, { error: e.message || 'ошибка сервера' });
  }
});

load();
if (!fs.existsSync(DATA_FILE) && !fs.existsSync(EMPS_FILE)) {
  seed();
  console.log('[db] созданы демо-данные (пароль у всех: 1234; администратор: Иванов Сергей)');
} else if (!fs.existsSync(DATA_FILE)) {
  flush();
  console.log('[db] журнал отсутствовал — создан пустой, справочник сохранился');
}
if (!fs.existsSync(PROJECTS_FILE)) {
  flushProjects();
  console.log('[db] проекты отсутствовали — создан пустой файл data/projects.json (справочник задач)');
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ✖ Порт ${PORT} уже занят другой программой — поэтому браузер мог показать`);
    console.error(`    «страница не найдено» от чужого приложения.`);
    console.error(`    Запустите на другом порту:   PORT=8081 node server.js`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🗒  STUFFTIME — журнал учёта рабочего времени');
  console.log(`  локально:   http://localhost:${PORT}`);
  console.log(`  по сети:    http://<IP-этого-компьютера>:${PORT}`);
  console.log('  журнал:     ' + DATA_FILE);
  console.log('  справочник: ' + EMPS_FILE);
  console.log('  проекты:    ' + PROJECTS_FILE);
  console.log('  аватарки:   ' + AVATARS_DIR);
  console.log('');
});
