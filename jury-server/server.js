#!/usr/bin/env node
'use strict';
// Сервер оценок жюри ЗКНП. Без внешних зависимостей: нужен только Node.js (работает на Windows, macOS, Linux).
// Данные: data/state.json (текущее состояние), data/journal.jsonl (журнал каждого действия),
// data/backups/ (копии каждую минуту при изменениях + гарантированный полный срез каждые 15 минут + мгновенно после отправки судей),
// плюс автоопределение внешней флешки на Mac/Windows/Linux.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Порт: PORT=… при запуске, иначе тот, на котором сервер работал в прошлый раз, иначе 8080
let PORT, FIRST_PORT;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const JOURNAL_FILE = path.join(DATA, 'journal.jsonl');
const LOCAL_BACKUPS = path.join(DATA, 'backups');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(LOCAL_BACKUPS, { recursive: true });

const DEFAULT_CRITERIA = [
  'Идея и сценарий (Цельность замысла, связь с темой, логика сюжета)',
  'Актерское мастерство (Выразительность, сценическая речь, уверенность на сцене)',
  'Музыкальное оформление (Музыка, её связь с сюжетом)',
  'Визуальное оформление (Декорации и свет, их связь с сюжетом)',
  'Костюмы и образы (Соответствие персонажам и сюжету)',
  'Общее впечатление (Эмоциональный отклик, запоминаемость)',
];

const SEED_PERFS = [
  ['ИГНИСТ', 'Стены Урука', 'Шумеры · Режиссёр: Анастасия Марышева'],
  ['ИПТД', 'Под небом Киото', 'Япония · Режиссёр: Анна Жидкова'],
  ['ИКИ', 'Когда звёзды погасли', 'Греция · Режиссёр: Виктория Кирюшина'],
  ['ЮИН', 'Сердце Гора', 'Египет · Режиссёры: Артём Чернов, Валерия Короткова'],
  ['ИФМЕН', 'Между двух миров', 'Рим · Режиссёр: Ульяна Лыхина'],
  ['ИУЭФ', 'Тайцзи: Тень, что съела Солнце', 'Китай · Режиссёр: Стелла Багманян'],
  ['ИВИТШ', 'Степи души', 'Монголы · Режиссёр: Артём Колесников'],
  ['ИПП', 'Как приручить дракона', 'Скандинавия · Режиссёр: Ангелина Рудамёткина'],
];

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');

function newPin(state) {
  const used = new Set(state.jurors.map(j => j.pin));
  let pin;
  do { pin = String(crypto.randomInt(0, 10000)).padStart(4, '0'); } while (used.has(pin));
  return pin;
}

function defaultState() {
  const s = {
    adminPassword: process.env.ADMIN_PASSWORD || String(crypto.randomInt(100000, 1000000)),
    criteria: DEFAULT_CRITERIA.slice(),
    maxMark: 5,
    limitMin: 15, // до 15 мин включительно — 2 балла
    hardMin: 17,  // 16–17 мин (до 17:00 включительно) — 1 балл, более 17 мин — 0 баллов
    jurors: [],
    perfs: SEED_PERFS.map(([institute, title, description], i) => ({
      id: 'p' + (i + 1),
      order: i + 1,
      institute,
      title,
      description,
      startedAt: null,
      endedAt: null,
    })),
    current: 'p1',
    sheets: {},     // "<perf>__<juror>" -> { marks, submitted, submittedAt, updatedAt }
    sessions: {},   // token -> { role, juror?, created, device }
    appliedOps: {}, // id операции с устройства судьи -> время; защищает от двойной отправки
    lastSeen: {},   // juror -> время последнего запроса
  };
  // По умолчанию 9 судей; другое число — JURORS=5 при первом запуске (потом — в пульте)
  const count = Math.min(50, Math.max(1, Math.floor(+process.env.JURORS) || 9));
  for (let i = 1; i <= count; i++) s.jurors.push({ id: 'j' + i, name: 'Жюри ' + i, pin: newPin(s) });
  return s;
}

// ---------- Хранение ----------
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// На Windows антивирус или индексатор может на миг занять файл — тогда повторяем
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(25);
    }
  }
}
function writeFileDurable(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, text);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  renameRetry(tmp, file);
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
function validState(d) {
  return isObj(d) && Array.isArray(d.perfs) && Array.isArray(d.jurors)
    && d.perfs.every(p => isObj(p) && typeof p.id === 'string' && p.id)
    && d.jurors.every(j => isObj(j) && typeof j.id === 'string' && j.id && typeof j.pin === 'string')
    && (d.sheets === undefined || isObj(d.sheets));
}
// Достраивает недостающие поля, чтобы урезанная или старая копия не ломала сервер
function normalizeState(d) {
  const num = (v, def) => Number.isFinite(v) ? v : def;
  const limitMin = +d.limitMin > 0 ? +d.limitMin : 15;
  const sheets = {};
  for (const [k, sh] of Object.entries(isObj(d.sheets) ? d.sheets : {})) {
    if (isObj(sh)) sheets[k] = { ...sh, marks: Array.isArray(sh.marks) ? sh.marks : [], submitted: !!sh.submitted };
  }
  return {
    adminPassword: typeof d.adminPassword === 'string' && d.adminPassword ? d.adminPassword : String(crypto.randomInt(100000, 1000000)),
    criteria: Array.isArray(d.criteria) && d.criteria.length ? d.criteria.map(String) : DEFAULT_CRITERIA.slice(),
    maxMark: Number.isInteger(d.maxMark) && d.maxMark > 0 ? d.maxMark : 5,
    limitMin,
    hardMin: +d.hardMin >= limitMin ? +d.hardMin : Math.max(17, limitMin),
    jurors: d.jurors.map(j => ({ id: j.id, name: String(j.name || j.id), pin: j.pin })),
    perfs: d.perfs.map((p, i) => ({
      id: p.id, order: num(p.order, i + 1),
      institute: String(p.institute || ''), title: String(p.title || ''), description: String(p.description || ''),
      startedAt: num(p.startedAt, null), endedAt: num(p.endedAt, null),
    })),
    current: d.perfs.some(p => p.id === d.current) ? d.current : ((d.perfs[0] || {}).id || null),
    sheets,
    sessions: isObj(d.sessions) ? d.sessions : {},
    appliedOps: isObj(d.appliedOps) ? d.appliedOps : {},
    lastSeen: isObj(d.lastSeen) ? d.lastSeen : {},
    lastPort: Number.isInteger(d.lastPort) ? d.lastPort : null,
  };
}

function tryRead(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return validState(d) ? d : null; } catch { return null; }
}

let state;
if (fs.existsSync(STATE_FILE)) {
  let loaded = tryRead(STATE_FILE);
  if (!loaded) {
    // Файл повреждён: откладываем его в сторону и берём самую свежую целую копию
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const aside = path.join(DATA, `state.corrupt-${stamp}.json`);
    fs.copyFileSync(STATE_FILE, aside);
    const candidates = ['state-latest.json', ...fs.readdirSync(LOCAL_BACKUPS).filter(f => f.startsWith('state-2')).sort().reverse()];
    const from = candidates.find(f => fs.existsSync(path.join(LOCAL_BACKUPS, f)) && tryRead(path.join(LOCAL_BACKUPS, f)));
    if (!from) {
      console.error(`\n  ОШИБКА: файл данных повреждён, целой резервной копии нет.\n  Повреждённый файл сохранён как ${aside}\n  Восстановите data/state.json из копии на флешке (jury-backup/state-latest.json) и запустите снова.\n`);
      process.exit(1);
    }
    loaded = tryRead(path.join(LOCAL_BACKUPS, from));
    console.error(`\n  ВНИМАНИЕ: data/state.json был повреждён (сохранён как ${path.basename(aside)}).\n  Данные восстановлены из резервной копии ${from}.\n`);
  }
  state = normalizeState(loaded);
  // Если в старом state остались шаблонные "Критерий 1..6", обновим на критерии ЗКНП
  if (state.criteria[0] === 'Критерий 1') state.criteria = DEFAULT_CRITERIA.slice();
  writeFileDurable(STATE_FILE, JSON.stringify(state, null, 1));
} else {
  state = defaultState();
  writeFileDurable(STATE_FILE, JSON.stringify(state, null, 1));
}
PORT = +process.env.PORT || state.lastPort || 8080;
FIRST_PORT = PORT;
let dirtySinceBackup = true;
function save() {
  writeFileDurable(STATE_FILE, JSON.stringify(state, null, 1));
  dirtySinceBackup = true;
}

// Журнал с цепочкой хешей: каждая строка содержит хеш предыдущей,
// поэтому правку или удаление строки задним числом видно при проверке.
let lastHash = '0';
let journalCount = 0;
if (fs.existsSync(JOURNAL_FILE)) {
  const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean);
  journalCount = lines.length;
  if (lines.length) lastHash = JSON.parse(lines[lines.length - 1]).hash;
}
function hashLine(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function journal(entry) {
  const line = { t: Date.now(), ...entry, prev: lastHash };
  line.hash = hashLine(line);
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(line) + '\n');
  lastHash = line.hash;
  journalCount++;
  dirtySinceBackup = true;
}
function readJournal() {
  if (!fs.existsSync(JOURNAL_FILE)) return { lines: [], ok: true, brokenAt: null };
  const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  let prev = '0', brokenAt = null;
  for (let i = 0; i < lines.length; i++) {
    const { hash, ...rest } = lines[i];
    if (rest.prev !== prev || hashLine(rest) !== hash) { brokenAt = i + 1; break; }
    prev = hash;
  }
  return { lines, ok: brokenAt === null, brokenAt };
}

// Автоопределение внешней флешки на macOS, Windows и Linux
function resolveExternalBackupDir() {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  try {
    if (process.platform === 'darwin' && fs.existsSync('/Volumes')) {
      for (const name of fs.readdirSync('/Volumes')) {
        if (name === 'Macintosh HD' || name.startsWith('.')) continue;
        const full = path.join('/Volumes', name);
        try {
          if (fs.statSync(full).isDirectory()) {
            fs.accessSync(full, fs.constants.W_OK);
            return path.join(full, 'jury-backup');
          }
        } catch (err) { /* пропускаем недоступный том */ }
      }
    } else if (process.platform === 'win32') {
      for (const letter of ['D', 'E', 'F', 'G', 'H']) {
        const root = `${letter}:\\`;
        const marker = path.join(root, 'jury-backup');
        if (fs.existsSync(marker)) return marker;
      }
    } else {
      const user = os.userInfo().username;
      for (const base of [`/media/${user}`, `/run/media/${user}`, '/mnt']) {
        if (!fs.existsSync(base)) continue;
        for (const name of fs.readdirSync(base)) {
          const full = path.join(base, name);
          try {
            if (fs.statSync(full).isDirectory()) {
              fs.accessSync(full, fs.constants.W_OK);
              return path.join(full, 'jury-backup');
            }
          } catch (err) { /* пропускаем */ }
        }
      }
    }
  } catch (err) { /* игнорируем ошибки сканирования томов */ }
  return '';
}

const backupStatus = { local: null, external: null, externalError: null, lastReason: null, dir: null };

function backup(force = false, reason = 'auto') {
  if (!force && !dirtySinceBackup) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = reason && reason !== 'auto' ? `-${reason.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
  try {
    fs.copyFileSync(STATE_FILE, path.join(LOCAL_BACKUPS, `state-${stamp}${tag}.json`));
    fs.copyFileSync(STATE_FILE, path.join(LOCAL_BACKUPS, 'state-latest.json'));
    if (fs.existsSync(JOURNAL_FILE)) {
      fs.copyFileSync(JOURNAL_FILE, path.join(LOCAL_BACKUPS, 'journal-latest.jsonl'));
    }
    writeFileDurable(path.join(LOCAL_BACKUPS, 'results-latest.csv'), resultsCsv());
    const old = fs.readdirSync(LOCAL_BACKUPS).filter(f => f.startsWith('state-2')).sort();
    old.slice(0, Math.max(0, old.length - 500)).forEach(f => fs.unlinkSync(path.join(LOCAL_BACKUPS, f)));
    backupStatus.local = Date.now();
    backupStatus.lastReason = reason;
  } catch (e) { console.error('Локальная копия не сделана:', e.message); }

  const extDir = resolveExternalBackupDir();
  backupStatus.dir = extDir || null;
  if (extDir) {
    try {
      fs.mkdirSync(extDir, { recursive: true });
      fs.copyFileSync(STATE_FILE, path.join(extDir, `state-${stamp}${tag}.json`));
      fs.copyFileSync(STATE_FILE, path.join(extDir, 'state-latest.json'));
      if (fs.existsSync(JOURNAL_FILE)) {
        fs.copyFileSync(JOURNAL_FILE, path.join(extDir, 'journal-latest.jsonl'));
      }
      writeFileDurable(path.join(extDir, 'results-latest.csv'), resultsCsv());
      backupStatus.external = Date.now();
      backupStatus.externalError = null;
    } catch (e) { backupStatus.externalError = e.message; }
  }
  dirtySinceBackup = false;
}

// 1. Быстрая проверка каждую минуту (сохраняет, если были изменения)
setInterval(() => backup(false, '1min'), 60 * 1000);
// 2. Гарантированный полный бэкап каждые 15 минут (безусловно)
setInterval(() => backup(true, '15min'), 15 * 60 * 1000);

// ---------- Подсчёт ----------
// Тайминг ЗКНП:
// 2 балла — постановка до 15 минут включительно (<= limitMin * 60)
// 1 балл — постановка 16–17 минут (<= hardMin * 60)
// 0 баллов — постановка более 17 минут (> hardMin * 60)
function timingPoints(sec) {
  if (sec == null) return null;
  if (sec <= state.limitMin * 60) return 2;
  if (sec <= state.hardMin * 60) return 1;
  return 0;
}
const perfSeconds = p => (p.startedAt && p.endedAt) ? Math.max(0, Math.floor((p.endedAt - p.startedAt) / 1000)) : null;
const sortedPerfs = () => state.perfs.slice().sort((a, b) => a.order - b.order);

function normMarks(marks) {
  const n = state.criteria.length;
  return Array.from({ length: n }, (_, i) => (marks && typeof marks[i] === 'number') ? marks[i] : null);
}

function results() {
  return sortedPerfs().map(p => {
    const sheets = state.jurors.map(j => {
      const sh = state.sheets[p.id + '__' + j.id];
      const marks = normMarks(sh && sh.marks);
      const filled = marks.filter(v => v !== null).length;
      return {
        juror: j.id,
        name: j.name,
        marks,
        filled,
        sum: marks.reduce((a, v) => a + (v || 0), 0),
        submitted: !!(sh && sh.submitted),
        submittedAt: sh && sh.submittedAt,
      };
    });
    const done = sheets.filter(s => s.submitted && s.filled === state.criteria.length);
    const avg = done.length ? done.reduce((a, s) => a + s.sum, 0) / done.length : null;
    const sec = perfSeconds(p);
    const tp = timingPoints(sec);
    const allSubmitted = state.jurors.length > 0 && done.length === state.jurors.length;
    return {
      perf: p.id,
      institute: p.institute,
      title: p.title,
      seconds: sec,
      timing: tp,
      done: done.length,
      allSubmitted,
      avg,
      total: avg == null ? null : avg + (tp || 0),
      sheets,
    };
  });
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2e6) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { e.status = 400; e.message = 'Неверный формат запроса'; reject(e); }
    });
    req.on('error', reject);
  });
}
function session(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  const s = token && state.sessions[token];
  return s ? { token, ...s } : null;
}
const clientIp = req => (req.socket.remoteAddress || '').replace('::ffff:', '');

// защита от перебора PIN и пароля
const fails = {};
function blocked(ip) { const f = fails[ip]; return f && f.until > Date.now(); }
function failed(ip) {
  const f = fails[ip] || (fails[ip] = { n: 0, until: 0 });
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 60 * 1000; f.n = 0; }
}

function jurorView(jurorId) {
  const j = state.jurors.find(x => x.id === jurorId);
  const sheets = {};
  for (const p of state.perfs) {
    const sh = state.sheets[p.id + '__' + jurorId];
    if (sh) sheets[p.id] = { marks: normMarks(sh.marks), submitted: !!sh.submitted };
  }
  return {
    now: Date.now(),
    juror: { id: j.id, name: j.name },
    criteria: state.criteria, maxMark: state.maxMark, limitMin: state.limitMin, hardMin: state.hardMin,
    current: state.current,
    perfs: sortedPerfs().map(({ id, institute, title, description, startedAt, endedAt }) => ({ id, institute, title, description, startedAt, endedAt })),
    sheets,
  };
}

function checkAllSubmittedForPerf(perfId) {
  if (!state.jurors.length) return false;
  return state.jurors.every(j => {
    const sh = state.sheets[perfId + '__' + j.id];
    return sh && sh.submitted && normMarks(sh.marks).every(v => v !== null);
  });
}

function applyOp(jurorId, op, device) {
  if (!op || typeof op.id !== 'string' || op.id.length > 64) return 'bad';
  if (state.appliedOps[op.id]) return 'dup';
  state.appliedOps[op.id] = Date.now();
  const perf = state.perfs.find(p => p.id === op.perf);
  if (!perf) return 'no-perf';
  const key = perf.id + '__' + jurorId;
  const sh = state.sheets[key] || (state.sheets[key] = { marks: normMarks([]), submitted: false });
  sh.marks = normMarks(sh.marks);
  if (sh.submitted) { journal({ who: jurorId, act: 'rejected-locked', perf: perf.id, op, device }); return 'locked'; }
  if (op.type === 'mark') {
    const i = op.crit, v = op.val;
    if (!Number.isInteger(i) || i < 0 || i >= state.criteria.length) return 'bad';
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= state.maxMark)) return 'bad';
    sh.marks[i] = v;
    sh.updatedAt = Date.now();
    journal({ who: jurorId, act: 'mark', perf: perf.id, crit: i, val: v, tabletTime: op.ts, device });
    return 'ok';
  }
  if (op.type === 'submit') {
    if (sh.marks.some(v => v === null)) return 'incomplete';
    sh.submitted = true; sh.submittedAt = Date.now();
    journal({ who: jurorId, act: 'submit', perf: perf.id, marks: sh.marks, sum: sh.marks.reduce((a, v) => a + v, 0), tabletTime: op.ts, device });
    save();
    // Мгновенный бэкап при каждой отправке листа судьёй, и отдельно когда все судьи сдали постановку
    if (checkAllSubmittedForPerf(perf.id)) {
      journal({ who: 'admin', act: 'all-submitted', perf: perf.id });
      backup(true, `all_submitted_${perf.id}`);
    } else {
      backup(true, `submit_${perf.id}_${jurorId}`);
    }
    return 'ok';
  }
  return 'bad';
}

function adminAction(a) {
  const perf = id => state.perfs.find(p => p.id === id);
  const jur = id => state.jurors.find(j => j.id === id);
  switch (a.type) {
    case 'start': { const p = perf(a.perf); if (!p) return 'no-perf'; p.startedAt = Date.now(); p.endedAt = null; state.current = p.id; break; }
    case 'stop': { const p = perf(a.perf); if (!p || !p.startedAt || p.endedAt) return 'bad'; p.endedAt = Date.now(); save(); backup(true, `stop_${p.id}`); break; }
    case 'reset': { const p = perf(a.perf); if (!p) return 'no-perf'; p.startedAt = null; p.endedAt = null; break; }
    case 'setDuration': {
      const p = perf(a.perf);
      const sec = Math.max(0, Math.round(+a.seconds || 0));
      if (!p) return 'no-perf';
      p.endedAt = Date.now();
      p.startedAt = p.endedAt - sec * 1000;
      break;
    }
    case 'setCurrent': { if (!perf(a.perf)) return 'no-perf'; state.current = a.perf; break; }
    case 'unlock': { const sh = state.sheets[a.perf + '__' + a.juror]; if (!sh) return 'bad'; sh.submitted = false; sh.submittedAt = null; break; }
    case 'forceBackup': { save(); backup(true, 'manual'); break; }
    case 'restoreState': {
      if (!validState(a.data)) return 'bad';
      backup(true, 'before_restore');
      const keepSessions = state.sessions;
      const keepPassword = state.adminPassword;
      const restored = normalizeState(a.data);
      state = { ...restored, adminPassword: a.data.adminPassword || keepPassword, sessions: { ...restored.sessions, ...keepSessions } };
      save();
      backup(true, 'after_restore');
      break;
    }
    case 'saveConfig': {
      if (!Array.isArray(a.criteria) || !a.criteria.length || a.criteria.length > 20) return 'bad';
      state.criteria = a.criteria.map(c => String(c).slice(0, 300));
      const lim = +a.limitMin, hard = +a.hardMin;
      if (lim > 0 && hard >= lim) { state.limitMin = lim; state.hardMin = hard; }
      break;
    }
    case 'resetDefaultCriteria': {
      state.criteria = DEFAULT_CRITERIA.slice();
      state.limitMin = 15;
      state.hardMin = 17;
      break;
    }
    case 'savePerf': {
      const f = { institute: String(a.institute || '').slice(0, 200), title: String(a.title || '').slice(0, 300), description: String(a.description || '').slice(0, 1000) };
      if (a.id) { const p = perf(a.id); if (!p) return 'no-perf'; Object.assign(p, f); }
      else state.perfs.push({ id: 'p' + rid(4), order: Math.max(0, ...state.perfs.map(p => p.order)) + 1, ...f, startedAt: null, endedAt: null });
      break;
    }
    case 'deletePerf': { state.perfs = state.perfs.filter(p => p.id !== a.id); if (state.current === a.id) state.current = (sortedPerfs()[0] || {}).id || null; break; }
    case 'movePerf': {
      const list = sortedPerfs(), i = list.findIndex(p => p.id === a.id), j = i + (a.dir > 0 ? 1 : -1);
      if (i < 0 || j < 0 || j >= list.length) return 'bad';
      [list[i].order, list[j].order] = [list[j].order, list[i].order];
      break;
    }
    case 'addJuror': { state.jurors.push({ id: 'j' + rid(3), name: String(a.name || 'Жюри ' + (state.jurors.length + 1)).slice(0, 100), pin: newPin(state) }); break; }
    case 'renameJuror': { const j = jur(a.id); if (!j) return 'bad'; j.name = String(a.name || j.name).slice(0, 100); break; }
    case 'deleteJuror': { state.jurors = state.jurors.filter(j => j.id !== a.id); dropSessions(a.id); break; }
    case 'newPin': { const j = jur(a.id); if (!j) return 'bad'; j.pin = newPin(state); dropSessions(a.id); break; }
    case 'logoutJuror': { dropSessions(a.id); break; }
    case 'clearAll': {
      if (a.confirm !== 'СТЕРЕТЬ') return 'bad';
      backup(true, 'before_clear');
      state.sheets = {}; state.perfs.forEach(p => { p.startedAt = null; p.endedAt = null; });
      break;
    }
    default: return 'bad';
  }
  return 'ok';
}
function dropSessions(jurorId) {
  for (const [t, s] of Object.entries(state.sessions)) if (s.role === 'juror' && s.juror === jurorId) delete state.sessions[t];
}

function adminState() {
  const now = Date.now();
  return {
    now,
    criteria: state.criteria, maxMark: state.maxMark, limitMin: state.limitMin, hardMin: state.hardMin,
    current: state.current,
    perfs: sortedPerfs(),
    jurors: state.jurors.map(j => ({
      ...j,
      online: !!(state.lastSeen[j.id] && now - state.lastSeen[j.id] < 10000),
      lastSeen: state.lastSeen[j.id] || null,
      devices: Object.values(state.sessions).filter(s => s.juror === j.id).length,
    })),
    results: results(),
    backup: { ...backupStatus, dir: resolveExternalBackupDir() || null },
    journalCount,
    addresses: lanAddresses(),
    port: PORT,
  };
}

const csvCell = v => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const num = v => v == null ? '' : String(Math.round(v * 100) / 100).replace('.', ',');
const mmss = s => s == null ? '' : String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
function resultsCsv() {
  const res = results().filter(r => r.total != null).sort((a, b) => b.total - a.total);
  const rest = results().filter(r => r.total == null);
  const rows = [['Место', 'Институт', 'Постановка', 'Время', 'Баллы за тайминг (0-2)', 'Судей отправили', 'Среднее жюри (макс 30)', 'Итог (макс 32)', ...state.jurors.map(j => j.name + ' (сумма из 30)')]];
  [...res, ...rest].forEach((r, i) => rows.push([r.total == null ? '' : i + 1, r.institute, r.title, mmss(r.seconds), r.timing ?? '', r.done, num(r.avg), num(r.total), ...r.sheets.map(s => s.submitted ? s.sum : '')]));
  rows.push([]);
  rows.push(['Оценки по критериям ЗКНП']);
  rows.push(['Институт', 'Судья', ...state.criteria, 'Сумма (из 30)', 'Отправлено']);
  results().forEach(r => r.sheets.forEach(s => rows.push([r.institute, s.name, ...s.marks.map(v => v ?? ''), s.sum, s.submitted ? 'да' : 'нет'])));
  return '\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

const STATIC = { '/': 'jury.html', '/jury': 'jury.html', '/admin': 'admin.html', '/protocol': 'protocol.html', '/style.css': 'style.css' };

// Выполним стартовый бэкап при запуске
backup(true, 'startup');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);
  try {
    if (req.method === 'GET' && STATIC[p]) {
      const file = path.join(PUBLIC, STATIC[p]);
      const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
      return send(res, 200, fs.readFileSync(file), type);
    }
    if (req.method === 'GET' && p === '/api/ping') {
      return send(res, 200, { app: 'jury-zknp', ok: true, port: PORT });
    }

    // --- судья ---
    if (req.method === 'POST' && p === '/api/login') {
      if (blocked(ip)) return send(res, 429, { error: 'Слишком много попыток. Подождите минуту.' });
      const b = await readBody(req);
      const j = state.jurors.find(x => x.pin === String(b.pin || ''));
      if (!j) { failed(ip); journal({ who: 'unknown', act: 'login-failed', ip }); return send(res, 401, { error: 'Неверный PIN' }); }
      delete fails[ip];
      const token = rid();
      state.sessions[token] = { role: 'juror', juror: j.id, created: Date.now(), device: String(b.device || '').slice(0, 120), ip };
      journal({ who: j.id, act: 'login', ip, device: b.device });
      save();
      return send(res, 200, { token, state: jurorView(j.id) });
    }
    if (p === '/api/state' || p === '/api/sync') {
      const s = session(req, url);
      if (!s || s.role !== 'juror' || !state.jurors.some(j => j.id === s.juror)) return send(res, 401, { error: 'Нужно войти заново' });
      state.lastSeen[s.juror] = Date.now();
      if (p === '/api/sync' && req.method === 'POST') {
        const b = await readBody(req);
        const ops = Array.isArray(b.ops) ? b.ops.slice(0, 500) : [];
        const outcome = {};
        for (const op of ops) outcome[op && op.id] = applyOp(s.juror, op, s.device);
        if (ops.length) save();
        return send(res, 200, { outcome, state: jurorView(s.juror) });
      }
      return send(res, 200, { state: jurorView(s.juror) });
    }

    // --- организатор ---
    if (req.method === 'POST' && p === '/api/admin/login') {
      if (blocked(ip)) return send(res, 429, { error: 'Слишком много попыток. Подождите минуту.' });
      const b = await readBody(req);
      if (String(b.password || '') !== state.adminPassword) { failed(ip); journal({ who: 'unknown', act: 'admin-login-failed', ip }); return send(res, 401, { error: 'Неверный пароль' }); }
      delete fails[ip];
      const token = rid();
      state.sessions[token] = { role: 'admin', created: Date.now(), ip };
      journal({ who: 'admin', act: 'login', ip });
      save();
      return send(res, 200, { token });
    }
    if (p.startsWith('/api/admin/') || p.startsWith('/export/')) {
      const s = session(req, url);
      if (!s || s.role !== 'admin') return send(res, 401, { error: 'Нужен пароль организатора' });
      if (p === '/api/admin/state') return send(res, 200, adminState());
      if (p === '/api/admin/action' && req.method === 'POST') {
        const a = await readBody(req);
        const r = adminAction(a);
        if (r === 'ok') { journal({ who: 'admin', act: a.type, args: a.type === 'restoreState' ? { restored: true } : a, ip }); save(); }
        return send(res, r === 'ok' ? 200 : 400, { result: r, state: adminState() });
      }
      if (p === '/api/admin/journal') {
        const j = readJournal();
        const limit = Math.min(+url.searchParams.get('limit') || 300, 5000);
        return send(res, 200, { ok: j.ok, brokenAt: j.brokenAt, count: j.lines.length, lines: j.lines.slice(-limit).reverse() });
      }
      if (p === '/export/results.csv') {
        return send(res, 200, resultsCsv(), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="results-ZKNP-${new Date().toISOString().slice(0, 10)}.csv"` });
      }
      if (p === '/export/backup.json') {
        return send(res, 200, fs.readFileSync(STATE_FILE), 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="state-backup-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json"` });
      }
    }
    send(res, 404, { error: 'Не найдено' });
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: (e.status ? '' : 'Ошибка сервера: ') + e.message });
  }
});

// Порт занят: если это уже наш сервер — второй не запускаем (иначе два сервера пишут одни данные),
// иначе занят чужой программой — пробуем следующие порты.
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') { console.error('\n  ОШИБКА запуска сервера:', e.message); process.exit(1); }
  http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 1500 }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      if (body.includes('jury-zknp')) {
        console.log(`\n  Сервер жюри УЖЕ запущен на порту ${PORT} (в другом окне).`);
        console.log(`  Пульт: http://localhost:${PORT}/admin — второй сервер не нужен.\n`);
        process.exit(0);
      }
      nextPort();
    });
  }).on('error', nextPort).on('timeout', function () { this.destroy(); });
});
function nextPort() {
  if (PORT >= FIRST_PORT + 10) {
    console.error(`\n  ОШИБКА: порты ${FIRST_PORT}–${PORT} заняты другими программами. Запустите с другим портом, например PORT=9090.\n`);
    process.exit(1);
  }
  console.log(`  Порт ${PORT} занят другой программой — пробую ${PORT + 1}.`);
  PORT++;
  server.listen(PORT, '0.0.0.0');
}

server.listen(PORT, '0.0.0.0');
server.on('listening', () => {
  const addrs = lanAddresses();
  const extDir = resolveExternalBackupDir();
  console.log('\n  ======================================================');
  console.log('  Сервер оценок жюри ЗКНП запущен (макс. 32 балла)');
  console.log('  ======================================================\n');
  console.log('  Пульт организатора (на этом ПК): http://localhost:' + PORT + '/admin');
  console.log('  Пароль организатора:             ' + state.adminPassword + '\n');
  console.log('  Адрес для ноутбуков и планшетов жюри (в одной Wi-Fi сети):');
  if (!addrs.length) console.log('    (сети нет — подключитесь к роутеру/хотспоту или включите раздачу Wi‑Fi)');
  addrs.forEach(a => console.log('    http://' + a.address + ':' + PORT + '    (' + a.name + ')'));
  console.log('\n  PIN судей:');
  state.jurors.forEach(j => console.log('    ' + j.name.padEnd(20) + j.pin));
  console.log('\n  Автобэкап: мгновенно при отправке оценок + каждую минуту + полный срез каждые 15 мин.');
  console.log('  Локальные данные: ' + DATA);
  if (extDir) console.log('  Копии на внешнюю флешку: ' + extDir);
  if (state.lastPort !== PORT) { state.lastPort = PORT; save(); }
  if (PORT !== FIRST_PORT) console.log(`  ВНИМАНИЕ: порт ${FIRST_PORT} был занят, сервер работает на порту ${PORT} — у жюри адрес с :${PORT}.`);
  console.log('  Не закрывайте это окно до конца конкурса.\n');
});

// Не даём ноутбуку-серверу уснуть, пока работает сервер. Помощник сам завершится вместе с сервером.
// Закрытие крышки это не перебивает (кроме Linux) — крышку держим открытой.
function keepAwake() {
  if (process.env.NO_KEEP_AWAKE) return;
  const { spawn } = require('child_process');
  const pid = String(process.pid);
  let cmd, args, label;
  if (process.platform === 'darwin') {
    cmd = 'caffeinate'; args = ['-dims', '-w', pid]; label = 'caffeinate';
  } else if (process.platform === 'win32') {
    const ps = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; ` +
      `[W.P]::SetThreadExecutionState([uint32]'0x80000003') | Out-Null; ` +
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`;
    cmd = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps]; label = 'SetThreadExecutionState';
  } else {
    cmd = 'systemd-inhibit';
    args = ['--what=idle:sleep:handle-lid-switch', '--who=Оценки жюри', '--why=Идёт конкурс', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'];
    label = 'systemd-inhibit';
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log('  (Не удалось запретить сон автоматически — отключите сон в настройках питания.)'));
    child.on('spawn', () => console.log(`  Сон ноутбука отключён на время работы сервера (${label}).`));
    process.on('exit', () => { try { child.kill(); } catch {} });
  } catch { /* не критично */ }
}
keepAwake();

function shutdown() { try { backup(true, 'shutdown'); } catch (err) { /* ignore */ } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
