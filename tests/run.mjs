// Автотесты сервера оценок. Запуск: npm test (нужен только Node.js).
// Каждый набор поднимает сервер на свободном порту с временной папкой данных.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'jury-server', 'server.js');
const PASSWORD = '424242';

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer(dataDir) {
  const port = await freePort();
  const backupDir = path.join(dataDir, 'usb');
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, NO_KEEP_AWAKE: '1', JURORS: '3', PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, BACKUP_DIR: backupDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/ping`); if (r.ok) break; } catch {}
    await sleep(50);
  }
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, body, token) => {
    const r = await fetch(base + p, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  const stop = () => new Promise(res => { if (proc.exitCode !== null) return res(); proc.once('exit', res); proc.kill('SIGTERM'); });
  return { port, base, call, stop, proc, output: () => out, backupDir };
}

const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jury-test-'));

async function adminLogin(s) {
  const r = await s.call('/api/admin/login', { password: PASSWORD });
  assert.equal(r.status, 200, 'вход организатора');
  return r.json.token;
}
async function jurorLogins(s, dir) {
  const st = readState(dir);
  const tokens = [];
  for (const j of st.jurors) {
    const r = await s.call('/api/login', { pin: j.pin, device: 'test' });
    assert.equal(r.status, 200, 'вход судьи ' + j.name);
    tokens.push(r.json.token);
  }
  return { tokens, jurors: st.jurors };
}
let opSeq = 0;
const markOps = (perf, marks, submit = true) => {
  const ops = marks.map((v, i) => ({ id: `op${++opSeq}`, type: 'mark', perf, crit: i, val: v, ts: Date.now() }));
  if (submit) ops.push({ id: `op${++opSeq}`, type: 'submit', perf, ts: Date.now() });
  return ops;
};

// ---------- мини-раннер ----------
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ✓ ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e }); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}

// ======================================================================
console.log('\nСервер оценок жюри — автотесты\n');

const dir = tmpDir();
const s = await startServer(dir);
let A, T, J;

await test('сервер стартует, создаёт данные и стартовый бэкап', async () => {
  assert.ok(fs.existsSync(path.join(dir, 'state.json')));
  assert.ok(fs.existsSync(path.join(dir, 'backups', 'state-latest.json')));
  const st = readState(dir);
  assert.equal(st.perfs.length, 8);
  assert.equal(st.criteria.length, 6);
  assert.equal(st.jurors.length, 3);
  assert.equal(new Set(st.jurors.map(j => j.pin)).size, 3, 'PIN разные');
});

await test('страницы открываются', async () => {
  for (const p of ['/', '/jury', '/admin', '/protocol', '/style.css']) {
    const r = await s.call(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await s.call('/nope')).status, 404);
});

await test('вход: верный PIN и пароль пускают, неверные — нет', async () => {
  A = await adminLogin(s);
  ({ tokens: T, jurors: J } = await jurorLogins(s, dir));
  assert.equal((await s.call('/api/login', { pin: '99999' })).status, 401);
  assert.equal((await s.call('/api/admin/login', { password: 'wrong' })).status, 401);
});

await test('судья не может зайти в пульт и выгрузки', async () => {
  assert.equal((await s.call('/api/admin/state', undefined, T[0])).status, 401);
  assert.equal((await s.call('/api/admin/action', { type: 'clearAll', confirm: 'СТЕРЕТЬ' }, T[0])).status, 401);
  assert.equal((await s.call('/export/results.csv?token=' + T[0])).status, 401);
  assert.equal((await s.call('/export/backup.json')).status, 401);
});

await test('судья не видит чужих оценок и PIN', async () => {
  const r = await s.call('/api/state', undefined, T[0]);
  assert.equal(r.status, 200);
  const txt = JSON.stringify(r.json);
  for (const j of J) assert.ok(!txt.includes(`"pin"`), 'в ответе судье нет PIN');
  assert.ok(!('results' in r.json.state));
  assert.ok(!txt.includes(PASSWORD));
});

await test('оценки, отправка и блокировка листа', async () => {
  const r = await s.call('/api/sync', { ops: markOps('p1', [5, 5, 5, 5, 4, 4]) }, T[0]);
  assert.equal(r.status, 200);
  assert.ok(Object.values(r.json.outcome).every(v => v === 'ok'), JSON.stringify(r.json.outcome));
  assert.equal(r.json.state.sheets.p1.submitted, true);
  const again = await s.call('/api/sync', { ops: [{ id: 'late1', type: 'mark', perf: 'p1', crit: 0, val: 0 }] }, T[0]);
  assert.equal(again.json.outcome.late1, 'locked');
  assert.equal(readState(dir).sheets['p1__' + J[0].id].marks[0], 5, 'оценка не изменилась');
});

await test('повторная отправка той же операции не применяется дважды', async () => {
  const op = { id: 'dupe-1', type: 'mark', perf: 'p2', crit: 0, val: 3 };
  await s.call('/api/sync', { ops: [op] }, T[1]);
  const r = await s.call('/api/sync', { ops: [op, op] }, T[1]);
  assert.equal(r.json.outcome['dupe-1'], 'dup');
});

await test('неполный лист нельзя отправить', async () => {
  const r = await s.call('/api/sync', { ops: [{ id: 'inc1', type: 'submit', perf: 'p2' }] }, T[1]);
  assert.equal(r.json.outcome.inc1, 'incomplete');
});

await test('мусорные операции отклоняются', async () => {
  const bad = [
    { id: 'b1', type: 'mark', perf: 'p3', crit: 0, val: 6 },
    { id: 'b2', type: 'mark', perf: 'p3', crit: 0, val: -1 },
    { id: 'b3', type: 'mark', perf: 'p3', crit: 99, val: 1 },
    { id: 'b4', type: 'mark', perf: 'p3', crit: 0, val: 2.5 },
    { id: 'b5', type: 'mark', perf: 'nope', crit: 0, val: 1 },
    { id: 'b6', type: 'hack', perf: 'p3' },
    { id: 'x'.repeat(100), type: 'mark', perf: 'p3', crit: 0, val: 1 },
  ];
  const r = await s.call('/api/sync', { ops: bad }, T[2]);
  assert.equal(r.status, 200);
  assert.ok(Object.values(r.json.outcome).every(v => v !== 'ok'), JSON.stringify(r.json.outcome));
  const sh = readState(dir).sheets['p3__' + J[2].id];
  assert.ok(!sh || sh.marks.every(v => v === null), 'ничего не записалось');
});

await test('битый JSON не роняет сервер', async () => {
  const r = await s.call('/api/sync', '{not json', T[0]);
  assert.ok(r.status >= 400 && r.status < 600);
  assert.equal((await s.call('/api/ping')).status, 200);
});

await test('итог = среднее судей + тайминг (пример из README)', async () => {
  await s.call('/api/sync', { ops: markOps('p1', [5, 5, 5, 5, 5, 4]) }, T[1]);
  await s.call('/api/sync', { ops: markOps('p1', [4, 4, 4, 4, 4, 4]) }, T[2]);
  await s.call('/api/admin/action', { type: 'setDuration', perf: 'p1', seconds: 14 * 60 }, A);
  const st = (await s.call('/api/admin/state', undefined, A)).json;
  const p1 = st.results.find(r => r.perf === 'p1');
  assert.equal(p1.done, 3);
  assert.equal(p1.avg, (28 + 29 + 24) / 3);
  assert.equal(p1.timing, 2);
  assert.equal(p1.total, 27 + 2);
  assert.equal(p1.allSubmitted, true);
});

await test('границы тайминга: 15:00→2, 15:01→1, 17:00→1, 17:01→0', async () => {
  const cases = [[0, 2], [900, 2], [901, 1], [1020, 1], [1021, 0], [3600, 0]];
  for (const [sec, want] of cases) {
    await s.call('/api/admin/action', { type: 'setDuration', perf: 'p8', seconds: sec }, A);
    const st = (await s.call('/api/admin/state', undefined, A)).json;
    assert.equal(st.results.find(r => r.perf === 'p8').timing, want, `${sec} c`);
  }
});

await test('таймер: старт → стоп считает длительность, повторный стоп запрещён', async () => {
  assert.equal((await s.call('/api/admin/action', { type: 'start', perf: 'p2' }, A)).status, 200);
  await sleep(1100);
  assert.equal((await s.call('/api/admin/action', { type: 'stop', perf: 'p2' }, A)).status, 200);
  assert.equal((await s.call('/api/admin/action', { type: 'stop', perf: 'p2' }, A)).status, 400);
  const st = (await s.call('/api/admin/state', undefined, A)).json;
  const r = st.results.find(x => x.perf === 'p2');
  assert.ok(r.seconds >= 1 && r.seconds <= 3, 'секунд: ' + r.seconds);
  assert.equal(st.current, 'p2', 'старт делает постановку текущей');
});

await test('организатор открывает лист для исправления', async () => {
  assert.equal((await s.call('/api/admin/action', { type: 'unlock', perf: 'p1', juror: J[0].id }, A)).status, 200);
  const r = await s.call('/api/sync', { ops: [{ id: 'fix1', type: 'mark', perf: 'p1', crit: 0, val: 3 }] }, T[0]);
  assert.equal(r.json.outcome.fix1, 'ok');
  assert.equal(r.json.state.sheets.p1.submitted, false);
});

await test('отправка листа сразу делает бэкап и CSV, в т.ч. на флешку', async () => {
  const before = fs.readdirSync(path.join(dir, 'backups')).length;
  await s.call('/api/sync', { ops: [{ id: 'resub', type: 'submit', perf: 'p1' }] }, T[0]);
  const files = fs.readdirSync(path.join(dir, 'backups'));
  assert.ok(files.length > before, 'появился новый файл копии');
  assert.ok(files.some(f => f.includes('all_submitted_p1')), 'копия «все сдали»');
  assert.ok(fs.existsSync(path.join(dir, 'backups', 'results-latest.csv')));
  assert.ok(fs.existsSync(path.join(s.backupDir, 'state-latest.json')), 'копия на флешке');
  assert.ok(fs.existsSync(path.join(s.backupDir, 'results-latest.csv')));
});

await test('CSV открывается в Excel: BOM, точка с запятой, места по итогу', async () => {
  const r = await s.call('/export/results.csv?token=' + A);
  assert.equal(r.status, 200);
  const raw = Buffer.from(await (await fetch(s.base + '/export/results.csv?token=' + A)).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF‑8 BOM');
  const lines = r.text.replace(/^﻿/, '').split('\r\n');
  assert.ok(lines[0].startsWith('Место;Институт;'));
  assert.ok(lines[1].startsWith('1;ИГНИСТ;'), lines[1]);
});

await test('новый PIN выкидывает судью со всех устройств', async () => {
  assert.equal((await s.call('/api/admin/action', { type: 'newPin', id: J[2].id }, A)).status, 200);
  assert.equal((await s.call('/api/state', undefined, T[2])).status, 401);
  const pin = readState(dir).jurors.find(j => j.id === J[2].id).pin;
  const r = await s.call('/api/login', { pin });
  assert.equal(r.status, 200);
  T[2] = r.json.token;
});

await test('журнал цел, а ручная правка файла обнаруживается', async () => {
  let j = (await s.call('/api/admin/journal', undefined, A)).json;
  assert.equal(j.ok, true);
  assert.ok(j.count > 20);
  const file = path.join(dir, 'journal.jsonl');
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const i = lines.findIndex(l => l.includes('"act":"mark"'));
  lines[i] = lines[i].replace(/"val":\d/, '"val":0');
  fs.writeFileSync(file, lines.join('\n'));
  j = (await s.call('/api/admin/journal', undefined, A)).json;
  assert.equal(j.ok, false);
  assert.equal(j.brokenAt, i + 1);
  fs.writeFileSync(file, original);
});

await test('много судей одновременно: оценки не теряются', async () => {
  for (let k = 0; k < 7; k++) await s.call('/api/admin/action', { type: 'addJuror' }, A);
  const st = readState(dir);
  const extra = st.jurors.slice(3);
  const toks = [];
  for (const j of extra) toks.push((await s.call('/api/login', { pin: j.pin })).json.token);
  await Promise.all(toks.map((t, k) => s.call('/api/sync', { ops: markOps('p3', [k % 6, 1, 2, 3, 4, 5]) }, t)));
  const after = readState(dir);
  extra.forEach((j, k) => {
    const sh = after.sheets['p3__' + j.id];
    assert.ok(sh && sh.submitted, j.name + ' отправил');
    assert.equal(sh.marks[0], k % 6);
  });
});

await test('восстановление из скачанной копии', async () => {
  const backup = (await s.call('/export/backup.json?token=' + A)).json;
  await s.call('/api/admin/action', { type: 'clearAll', confirm: 'СТЕРЕТЬ' }, A);
  assert.equal(Object.keys(readState(dir).sheets).length, 0);
  const r = await s.call('/api/admin/action', { type: 'restoreState', data: backup }, A);
  assert.equal(r.status, 200);
  assert.ok(readState(dir).sheets['p1__' + J[0].id].submitted);
  assert.equal((await s.call('/api/admin/state', undefined, A)).status, 200, 'организатор не выкинут');
});

await test('восстановление из урезанного файла не ломает сервер', async () => {
  const st = readState(dir);
  const r = await s.call('/api/admin/action', { type: 'restoreState', data: { perfs: st.perfs, jurors: st.jurors } }, A);
  assert.ok(r.status === 200 || r.status === 400);
  assert.equal((await s.call('/api/admin/state', undefined, A)).status, 200, 'пульт работает');
  assert.equal((await s.call('/api/state', undefined, T[0])).status, 200, 'судья работает');
  const ok = await s.call('/api/sync', { ops: [{ id: 'after-restore', type: 'mark', perf: 'p5', crit: 0, val: 2 }] }, T[0]);
  assert.equal(ok.status, 200);
});

await test('восстановление мусора отклоняется', async () => {
  for (const data of [null, {}, { perfs: 'x', jurors: [] }, { perfs: [], jurors: [{}], sheets: 5 }]) {
    const r = await s.call('/api/admin/action', { type: 'restoreState', data }, A);
    assert.equal(r.status, 400, JSON.stringify(data));
  }
  assert.equal((await s.call('/api/admin/state', undefined, A)).status, 200);
});

await test('после перезапуска сервера всё на месте, вход сохраняется', async () => {
  await s.call('/api/sync', { ops: markOps('p4', [1, 2, 3, 4, 5, 0]) }, T[1]);
  const before = readState(dir);
  await s.stop();
  const s2 = await startServer(dir);
  try {
    const r = await s2.call('/api/state', undefined, T[1]);
    assert.equal(r.status, 200, 'токен судьи действует после перезапуска');
    assert.deepEqual(r.json.state.sheets.p4.marks, [1, 2, 3, 4, 5, 0]);
    assert.equal(readState(dir).adminPassword, before.adminPassword);
    const j = (await s2.call('/api/admin/journal', undefined, A)).json;
    assert.equal(j.ok, true, 'журнал продолжает цепочку');
  } finally { await s2.stop(); }
});

await test('5 неверных PIN подряд — блокировка на минуту, верный PIN сбрасывает счётчик', async () => {
  const d = tmpDir();
  const s = await startServer(d);
  try {
    const pin0 = readState(d).jurors[0].pin;
    for (let i = 0; i < 4; i++) await s.call('/api/login', { pin: '00000' });
    assert.equal((await s.call('/api/login', { pin: pin0 })).status, 200, 'после 4 ошибок верный PIN проходит');
    for (let i = 0; i < 4; i++) await s.call('/api/login', { pin: '00000' });
    assert.equal((await s.call('/api/login', { pin: pin0 })).status, 200, 'счётчик сброшен успешным входом');
  for (let i = 0; i < 5; i++) await s.call('/api/login', { pin: '00000' });
    const r = await s.call('/api/login', { pin: pin0 });
    assert.equal(r.status, 429, 'даже верный PIN временно не принимается');
  } finally { await s.stop(); }
});

await test('повреждённый state.json: сервер поднимает последнюю целую копию', async () => {
  const d = tmpDir();
  const s1 = await startServer(d);
  const pins = readState(d).jurors.map(j => j.pin);
  await s1.stop();
  fs.writeFileSync(path.join(d, 'state.json'), '{"perfs": [ обрыв');
  const s3 = await startServer(d);
  try {
    assert.equal(s3.proc.exitCode, null, 'сервер работает');
    assert.match(s3.output(), /восстановлены из резервной копии/);
    assert.deepEqual(readState(d).jurors.map(j => j.pin), pins, 'PIN те же');
    assert.ok(fs.readdirSync(d).some(f => f.startsWith('state.corrupt-')), 'повреждённый файл отложен');
  } finally { await s3.stop(); }
});

await test('повреждённый state.json и нет копий: сервер останавливается с понятной ошибкой', async () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'state.json'), 'мусор');
  const s4 = await startServer(d);
  await sleep(300);
  const code = s4.proc.exitCode;
  const out = s4.output();
  await s4.stop();
  assert.equal(code, 1);
  assert.match(out, /повреждён/);
  assert.equal(fs.readFileSync(path.join(d, 'state.json'), 'utf8'), 'мусор', 'исходный файл не затёрт');
});

await test('порт занят чужой программой: сервер сам берёт следующий', async () => {
  const port = await freePort();
  const blocker = net.createServer().listen(port, '0.0.0.0');
  await new Promise(r => blocker.once('listening', r));
  const d = tmpDir();
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, NO_KEEP_AWAKE: '1', PORT: String(port), DATA_DIR: d, ADMIN_PASSWORD: PASSWORD } });
  let out = ''; proc.stdout.on('data', c => { out += c; }); proc.stderr.on('data', c => { out += c; });
  try {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port + 1}/api/ping`)).ok; } catch {}
      if (!ok) await sleep(100);
    }
    assert.ok(ok, 'сервер отвечает на следующем порту\n' + out);
    assert.match(out, new RegExp(`Порт ${port} занят`));
    assert.match(out, new RegExp(`:${port + 1}`), 'в окне напечатан новый адрес');
  } finally { proc.kill(); blocker.close(); }
});

await test('сервер уже запущен: второй экземпляр не стартует на тех же данных', async () => {
  const d = tmpDir();
  const s1 = await startServer(d);
  try {
    const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, NO_KEEP_AWAKE: '1', PORT: String(s1.port), DATA_DIR: d } });
    let out = ''; proc.stdout.on('data', c => { out += c; });
    const code = await new Promise(r => proc.on('exit', r));
    assert.equal(code, 0);
    assert.match(out, /УЖЕ запущен/);
    assert.equal((await s1.call('/api/ping')).status, 200, 'первый сервер работает');
  } finally { await s1.stop(); }
});

await test('по умолчанию 9 судей с разными PIN', async () => {
  const d = tmpDir();
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, NO_KEEP_AWAKE: '1', JURORS: '', PORT: String(port), DATA_DIR: d } });
  try {
    for (let i = 0; i < 60 && !fs.existsSync(path.join(d, 'state.json')); i++) await sleep(50);
    await sleep(100);
    const st = readState(d);
    assert.equal(st.jurors.length, 9);
    assert.equal(new Set(st.jurors.map(j => j.pin)).size, 9);
    assert.equal(st.jurors[8].name, 'Жюри 9');
  } finally { proc.kill(); }
});

await test('после перезапуска сервер остаётся на том же порту (адрес у жюри не меняется)', async () => {
  const d = tmpDir();
  const s1 = await startServer(d);
  const port = s1.port;
  await s1.stop();
  assert.equal(readState(d).lastPort, port);
  const env = { ...process.env, NO_KEEP_AWAKE: '1', DATA_DIR: d };
  delete env.PORT;
  const proc = spawn(process.execPath, [SERVER], { env });
  try {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port}/api/ping`)).ok; } catch {}
      if (!ok) await sleep(100);
    }
    assert.ok(ok, 'без PORT сервер снова на порту ' + port);
  } finally { proc.kill(); }
});

await test('старая установка с 3 судьями дополняется до 9, PIN и оценки сохраняются', async () => {
  const d = tmpDir();
  const s1 = await startServer(d);            // JURORS=3, как в старой версии
  const A1 = await adminLogin(s1);
  const old = readState(d).jurors;
  const t = (await s1.call('/api/login', { pin: old[0].pin })).json.token;
  await s1.call('/api/sync', { ops: markOps('p1', [1, 2, 3, 4, 5, 5]) }, t);
  await s1.stop();
  const env = { ...process.env, NO_KEEP_AWAKE: '1', DATA_DIR: d, PORT: String(await freePort()) };
  delete env.JURORS;
  const proc = spawn(process.execPath, [SERVER], { env });
  let out = ''; proc.stdout.on('data', c => { out += c; });
  try {
    for (let i = 0; i < 60 && !/Добавлены судьи/.test(out); i++) await sleep(100);
    const st = readState(d);
    assert.equal(st.jurors.length, 9);
    assert.deepEqual(st.jurors.slice(0, 3).map(j => j.pin), old.map(j => j.pin));
    assert.equal(new Set(st.jurors.map(j => j.pin)).size, 9);
    assert.ok(st.sheets['p1__' + old[0].id].submitted, 'оценки на месте');
  } finally { proc.kill(); }
  void A1;
});

await test('переименованных вручную судей не дополняет', async () => {
  const d = tmpDir();
  const s1 = await startServer(d);
  const A1 = await adminLogin(s1);
  await s1.call('/api/admin/action', { type: 'renameJuror', id: 'j1', name: 'Иванова' }, A1);
  await s1.stop();
  const env = { ...process.env, NO_KEEP_AWAKE: '1', DATA_DIR: d, PORT: String(await freePort()) };
  delete env.JURORS;
  const proc = spawn(process.execPath, [SERVER], { env });
  try {
    await sleep(800);
    assert.equal(readState(d).jurors.length, 3);
  } finally { proc.kill(); }
});

// ---------- итог ----------
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} из ${results.length} проверок прошли${failed.length ? `, упали: ${failed.length}` : ''}.\n`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
