/* =============================================================================
 * triage.js — входящие на триаж
 * =============================================================================
 *
 * ЗАЧЕМ
 * -----
 * Выдача разбора живёт до следующего разбора. Аналитик разобрал письмо,
 * не успел всё просмотреть, разобрал следующее — и первого больше нет.
 * Уцелевает только то, что он успел положить в кейс, а «положить в кейс»
 * — это уже решение, которое на середине триажа принимать рано.
 *
 * Очередь закрывает промежуток между «нашлось» и «решено»: разобранное
 * копится здесь, переживает следующий разбор и уходит отсюда либо в кейс,
 * либо в отбой — и то и другое осознанным действием.
 *
 * ПОЧЕМУ НЕ «АВТОМАТИЧЕСКИ ВСЁ В КЕЙС»
 * ------------------------------------
 * Кейс — это утверждение о расследовании: что в нём лежит, то попадёт
 * в отчёт и в выгрузку. Ссыпать туда всё найденное значит сделать кейс
 * свалкой и обесценить вердикты. Очередь и кейс — разные вещи, и граница
 * между ними проходит по решению человека.
 *
 * ЧТО ЗДЕСЬ НЕ ХРАНИТСЯ
 * ---------------------
 * Ни текста источника, ни контекста сверх того, что уже есть в самом
 * индикаторе. Очередь — это список «посмотреть», а не второй архив
 * содержимого расследования.
 *
 * ОТБОЙ ПОМНИТСЯ
 * --------------
 * Отклонённое значение не всплывает снова при следующем разборе того же
 * отчёта: иначе очередь превращается в шум, который проще игнорировать
 * целиком. Список отбоя хранится отдельно и обрезается по возрасту.
 * ========================================================================== */

'use strict';

(function initTriage() {

if (typeof globalThis !== 'undefined' && globalThis.TITriage
    && typeof globalThis.TITriage.addMany === 'function') return;

const STORE_KEY = 'ti_triage';

/* Потолок очереди. Разобранный отчёт даёт сотни значений; очередь,
 * которая копится без предела, перестаёт быть списком «посмотреть»
 * и становится вторым кейсом. Обрезка НАЗЫВАЕТСЯ в интерфейсе. */
const MAX_ITEMS = 300;

/* Сколько помнить отбой. Месяц — примерно срок, за который тот же отчёт
 * может прийти повторно; дольше держать список отклонённого незачем. */
const DISMISS_DAYS = 30;

const key = (i) => `${i.type}|${String(i.value).toLowerCase()}`;

function emptyStore() { return { items: [], dismissed: [], truncated: 0 }; }

/** Привести прочитанное из хранилища к рабочему виду. */
function normalize(raw) {
  const s = emptyStore();
  if (!raw || typeof raw !== 'object') return s;
  for (const i of (Array.isArray(raw.items) ? raw.items : [])) {
    if (!i || !i.value || !i.type) continue;
    s.items.push({
      type: String(i.type),
      typeLabel: i.typeLabel || String(i.type),
      value: String(i.value),
      flags: Array.isArray(i.flags) ? i.flags : [],
      source: i.source || '',
      seenAt: i.seenAt || new Date(0).toISOString(),
      count: Number(i.count) > 0 ? Number(i.count) : 1,
    });
  }
  for (const d of (Array.isArray(raw.dismissed) ? raw.dismissed : [])) {
    if (d && d.k) s.dismissed.push({ k: String(d.k), t: d.t || new Date(0).toISOString() });
  }
  s.truncated = Number(raw.truncated) > 0 ? Number(raw.truncated) : 0;
  return s;
}

/** Убрать из отбоя то, что уже старше срока. */
function pruneDismissed(store, now) {
  const край = new Date(now || Date.now()).getTime() - DISMISS_DAYS * 86400000;
  return {
    ...store,
    dismissed: store.dismissed.filter((d) => new Date(d.t).getTime() >= край),
  };
}

/**
 * Добавить найденное в очередь.
 *
 * НЕ добавляется: то, что уже в очереди (обновляется только счётчик),
 * то, что уже в кейсе, и то, что аналитик отклонил.
 *
 * @param {object} store
 * @param {Array}  found    результат разбора
 * @param {object} opts     {source, inCase: Set|Array, now}
 * @returns {{store, added, повторов, вКейсе, отклонено}}
 */
function addMany(store, found, opts = {}) {
  const now = opts.now || new Date().toISOString();
  let s = pruneDismissed(normalize(store), now);

  const inCase = new Set(
    (opts.inCase instanceof Set ? [...opts.inCase] : (opts.inCase || []))
      .map((i) => (typeof i === 'string' ? i : key(i))),
  );
  const отклонённые = new Set(s.dismissed.map((d) => d.k));
  const есть = new Map(s.items.map((i) => [key(i), i]));

  let added = 0, повторов = 0, вКейсе = 0, отклонено = 0;
  for (const i of (Array.isArray(found) ? found : [])) {
    if (!i || !i.value || !i.type) continue;
    const k = key(i);
    if (inCase.has(k)) { вКейсе++; continue; }
    if (отклонённые.has(k)) { отклонено++; continue; }
    const прежний = есть.get(k);
    if (прежний) {
      прежний.count += 1;
      прежний.seenAt = now;
      повторов++;
      continue;
    }
    const n = {
      type: String(i.type), typeLabel: i.typeLabel || String(i.type),
      value: String(i.value), flags: Array.isArray(i.flags) ? i.flags : [],
      source: opts.source || i.source || '', seenAt: now, count: 1,
    };
    s.items.push(n);
    есть.set(k, n);
    added++;
  }

  /* Обрезка с ГОЛОВЫ: самое старое уходит первым, но факт обрезки
   * запоминается и показывается — молча потерять строку из списка
   * «посмотреть» нельзя. */
  if (s.items.length > MAX_ITEMS) {
    const лишних = s.items.length - MAX_ITEMS;
    s.items = s.items.slice(лишних);
    s.truncated += лишних;
  }
  return { store: s, added, повторов, вКейсе, отклонено };
}

/** Убрать значения из очереди (после переноса в кейс). Отбой НЕ ставится. */
function take(store, keys) {
  const s = normalize(store);
  const set = new Set((keys || []).map((k) => String(k)));
  return { ...s, items: s.items.filter((i) => !set.has(key(i))) };
}

/** Отклонить: убрать из очереди и запомнить, чтобы не всплывало снова. */
function dismiss(store, keys, now) {
  const s = normalize(store);
  const t = now || new Date().toISOString();
  const set = new Set((keys || []).map((k) => String(k)));
  const dismissed = s.dismissed.slice();
  for (const k of set) if (!dismissed.some((d) => d.k === k)) dismissed.push({ k, t });
  return { ...s, items: s.items.filter((i) => !set.has(key(i))), dismissed };
}

/** Забыть отбой целиком: аналитик решил пересмотреть отклонённое. */
function forgetDismissed(store) {
  return { ...normalize(store), dismissed: [] };
}

/** Сводка для подписи блока. */
function summary(store) {
  const s = normalize(store);
  const byType = {};
  for (const i of s.items) byType[i.typeLabel || i.type] = (byType[i.typeLabel || i.type] || 0) + 1;
  return {
    всего: s.items.length,
    отклонено: s.dismissed.length,
    обрезано: s.truncated,
    поТипам: byType,
  };
}

const API = { STORE_KEY, MAX_ITEMS, DISMISS_DAYS, emptyStore, normalize,
              addMany, take, dismiss, forgetDismissed, summary, key };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.TITriage = API;

})();
