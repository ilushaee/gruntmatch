/**
 * Общая база заявок для карты «Грунт рядом».
 * Таблица → Расширения → Apps Script → вставить этот код → Начать развёртывание → Веб-приложение
 * (Запуск от имени: я; Доступ: все). Полученную ссылку …/exec вписать в API_URL в index.html.
 *
 * Чтобы убрать заявку с карты, поставьте в столбце «Статус» значение «скрыта».
 */
var SHEET_NAME = 'Заявки';
var COLS = ['id', 'status', 'type', 'volume', 'kind', 'place', 'lat', 'lng', 'company', 'contact', 'phone', 'whatsapp', 'note', 'date', 'key'];
var HEAD = ['ID', 'Статус', 'Тип', 'Объём, м³', 'Вид грунта', 'Адрес', 'Широта', 'Долгота', 'Компания', 'ФИО', 'Телефон', 'WhatsApp', 'Комментарий', 'Дата', 'Ключ (не менять)'];
var ON = 'на карте', OFF = 'скрыта', DELETED = 'удалена';
var KINDS = ['чистого насыпного грунта', 'грунта после котлована', 'грунта со строительным мусором', 'плодородного грунта',
             'песка', 'глины', 'суглинка', 'торфа', 'грунта для отсыпки участка', 'грунта любого типа'];
var MAX_PER_HOUR = 60;    // новых заявок в час на весь сайт
var MAX_PER_PHONE = 10;   // одновременно показанных заявок с одного номера
var CACHE_KEY = 'list';

function doGet() {
  try {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(CACHE_KEY);
    if (hit) return text_(hit);
    var out = withLock_(function () {
      var s = JSON.stringify({ ok: true, items: readAll_().filter(isShown_).map(publicItem_) });
      try { cache.put(CACHE_KEY, s, 30); } catch (e) { /* список больше лимита кэша, отдаём без него */ }
      return s;
    });
    return text_(out);
  } catch (e) {
    return fail_('Не удалось прочитать заявки. Попробуйте ещё раз.');
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.website) return fail_('Заявка не принята.');   // поле-ловушка для ботов
    if (!/^[0-9a-f]{64}$/.test(String(body.key || ''))) return fail_('Нет ключа заявки.');
    var hash = sha_(body.key);
    return withLock_(function () {
      if (body.action === 'add') return add_(body.item, hash);
      if (body.action === 'update') return change_(body.id, hash, body.item);
      if (body.action === 'delete') return change_(body.id, hash, null);
      return fail_('Неизвестное действие.');
    });
  } catch (err) {
    return fail_(err && err.user ? err.user : 'Не удалось сохранить заявку. Попробуйте ещё раз.');
  }
}

function add_(raw, hash) {
  var rows = readAll_();
  // повтор того же запроса (ответ потерялся по дороге) не создаёт вторую заявку
  var same = rows.filter(function (r) { return r.key === hash; })[0];
  if (same) return change_(same.id, hash, raw);

  var it = check_(raw);
  limitPhone_(rows, it, null);
  var cache = CacheService.getScriptCache();
  var slot = 'n' + Math.floor(Date.now() / 3600000);
  var n = Number(cache.get(slot) || 0);
  if (n >= MAX_PER_HOUR) bad_('Сейчас слишком много новых заявок. Попробуйте через час.');

  it.id = 's-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  it.status = ON;
  it.date = Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd');
  it.key = hash;
  var sh = sheet_();
  writeRow_(sh, sh.getLastRow() + 1, it);
  cache.put(slot, String(n + 1), 3600);
  cache.remove(CACHE_KEY);
  return json_({ ok: true, item: publicItem_(it) });
}

// raw === null — удаление (строка остаётся в таблице со статусом «удалена»)
function change_(id, hash, raw) {
  var rows = readAll_();
  var cur = rows.filter(function (r) { return r.id === String(id); })[0];
  if (!cur || cur.key !== hash) bad_('Эту заявку можно менять только с того устройства, где её добавили.');
  if (cur.status === DELETED && raw === null) return json_({ ok: true });
  if (cur.status !== ON) bad_('Заявка снята с карты.');
  var it = cur;
  if (raw === null) {
    it.status = DELETED;
  } else {
    var upd = check_(raw);
    limitPhone_(rows, upd, cur.id);
    Object.keys(upd).forEach(function (k) { it[k] = upd[k]; });
  }
  writeRow_(sheet_(), cur.row, it);
  CacheService.getScriptCache().remove(CACHE_KEY);
  return json_({ ok: true, item: raw === null ? null : publicItem_(it) });
}

function limitPhone_(rows, it, exceptId) {
  var num = it.phone || it.whatsapp;
  var n = rows.filter(function (r) { return isShown_(r) && r.id !== exceptId && (r.phone || r.whatsapp) === num; }).length;
  if (n >= MAX_PER_PHONE) bad_('С этого номера уже много заявок. Удалите неактуальные.');
}

function check_(o) {
  if (!o || typeof o !== 'object') bad_('Пустая заявка.');
  var it = {
    type: o.type, volume: Number(o.volume), kind: String(o.kind || ''), place: clean_(o.place, 200),
    lat: Number(o.lat), lng: Number(o.lng), company: clean_(o.company, 120), contact: clean_(o.contact, 120),
    phone: phone_(o.phone), whatsapp: phone_(o.whatsapp), note: clean_(o.note, 600)
  };
  if (it.type !== 'have' && it.type !== 'need') bad_('Не выбран тип заявки.');
  if (!(it.volume > 0 && it.volume <= 1000000)) bad_('Проверьте объём.');
  if (KINDS.indexOf(it.kind) < 0) bad_('Не выбран вид грунта.');
  if (!it.place) bad_('Укажите адрес.');
  if (!(it.lat >= 54.15 && it.lat <= 57.05 && it.lng >= 34.9 && it.lng <= 40.5)) bad_('Точка должна быть в Москве или области.');
  if (!it.phone && !it.whatsapp) bad_('Укажите телефон.');
  return it;
}
function phone_(v) {
  if (!v) return '';
  var d = String(v).replace(/\D/g, '');
  if (!/^7\d{10}$/.test(d)) bad_('Проверьте номер телефона.');
  return d;
}
// убираем управляющие символы и начало, которое таблица приняла бы за формулу
function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/^[\s=+\-@']+/, '').trim().slice(0, max);
}

// ---------- таблица ----------
function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_NAME);
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
  sh.setFrozenRows(1);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList([ON, OFF, DELETED], true).build();
  sh.getRange(2, COLS.indexOf('status') + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
  sh.hideColumns(COLS.indexOf('key') + 1);
  return sh;
}
function readAll_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, COLS.length).getValues().map(function (v, i) {
    var r = { row: i + 2 };
    COLS.forEach(function (c, j) {
      r[c] = v[j] instanceof Date ? Utilities.formatDate(v[j], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v[j]).replace(/^'/, '').trim();
    });
    ['volume', 'lat', 'lng'].forEach(function (c) { r[c] = Number(String(r[c]).replace(',', '.')); });
    ['phone', 'whatsapp'].forEach(function (c) { r[c] = r[c].replace(/\D/g, ''); });
    r.type = /^нуж/i.test(r.type) ? 'need' : 'have';
    r.id = r.id || 'row' + r.row;   // строку вписали в таблицу вручную
    return r;
  });
}
function writeRow_(sh, row, it) {
  var v = COLS.map(function (c) {
    if (c === 'volume' || c === 'lat' || c === 'lng') return it[c];
    if (c === 'type') return it.type === 'need' ? 'нужен' : 'есть';
    if (c === 'status') return it.status;
    return it[c] ? "'" + it[c] : '';   // апостроф: таблица хранит как текст
  });
  sh.getRange(row, 1, 1, COLS.length).setValues([v]);
}
function isShown_(r) {
  return r.status === ON && r.volume > 0 && r.place && r.lat >= 54.15 && r.lat <= 57.05 && r.lng >= 34.9 && r.lng <= 40.5;
}
// наружу уходит всё, кроме ключа, статуса и номера строки
function publicItem_(r) {
  return {
    id: r.id, type: r.type, volume: r.volume, kind: r.kind, place: r.place, lat: r.lat, lng: r.lng,
    title: (r.type === 'need' ? 'Нужно ' : 'Есть ') + String(r.volume).replace('.', ',') + ' м³ ' + (r.kind || 'грунта'),
    company: r.company, contact: r.contact, note: r.note,
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd'),
    phone: r.phone ? '+' + r.phone : '', whatsapp: r.whatsapp ? '+' + r.whatsapp : ''
  };
}

// ---------- служебное ----------
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s).map(function (b) {
    return ('0' + (b & 255).toString(16)).slice(-2);
  }).join('');
}
function bad_(msg) { var e = new Error(msg); e.user = msg; throw e; }
function fail_(msg) { return json_({ ok: false, error: msg }); }
function json_(o) { return text_(JSON.stringify(o)); }
function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON); }
