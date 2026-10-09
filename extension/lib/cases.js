/* =============================================================================
 * cases.js — несколько кейсов в одном профиле
 * =============================================================================
 *
 * ЗАЧЕМ ЭТО ПОЯВИЛОСЬ
 * -------------------
 * Кейс был ОДИН на профиль: `ti_case_items` — плоский массив. Аналитик
 * разобрал один отчёт, не очистил кейс, вечером разобрал другой
 * и выгрузил CSV. В файле оба, вперемешку.
 *
 * ЧТО ДАЁТ РАЗДЕЛЕНИЕ
 * -------------------
 * У каждого кейса свои индикаторы и своя хронология; экспорт, отчёт
 * и сводка берут только активный. Расследования физически не пересекаются,
 * и «очистить кейс перед новым разбором» перестаёт быть ритуалом,
 * от соблюдения которого зависит содержимое выгрузки.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: ОТДЕЛЬНОГО ПОЛЯ «КЛИЕНТ»
 * ---------------------------------------------------
 * Оно было в 0.28.0 и убрано решением заказчика. Имя заказчика — это
 * то, что незачем хранить в профиле браузера отдельным полем, класть
 * в файлы выгрузки и держать на экране, который попадает в скриншоты.
 * Чьё расследование — пишется в НАЗВАНИИ кейса, свободным текстом,
 * и остаётся ровно там, где его написал аналитик.
 *
 * Для тех, у кого метка успела появиться, она при чтении хранилища
 * подклеивается к названию: молча потерять уже введённый текст нельзя.
 *
 * УДАЛЕНИЕ КЕЙСА УДАЛЯЕТ ЕГО ХРОНОЛОГИЮ. То же правило, что и у очистки:
 * иначе удалённые индикаторы остаются в профиле записями журнала.
 * ========================================================================== */

'use strict';

(function initCases() {

if (typeof globalThis !== 'undefined' && globalThis.TICases
    && typeof globalThis.TICases.activeCase === 'function') return;

const STORE_KEY = 'ti_cases';
const ACTIVE_KEY = 'ti_active_case';
const LEGACY_ITEMS = 'ti_case_items';
const LEGACY_TIMELINE = 'ti_case_timeline';
const MAX_CASES = 50;

const DEFAULT_TLP = 'TLP:AMBER';

/* Идентификатор кейса. Время + случайная часть: время даёт порядок
 * и читаемость в выгрузке, случайная часть исключает совпадение при
 * двух созданиях в одну миллисекунду. */
function makeId(now, rnd) {
  const t = Number.isFinite(now) ? now : Date.now();
  const r = typeof rnd === 'number' ? rnd : Math.random();
  return t.toString(36) + '-' + Math.floor(r * 1e6).toString(36);
}

function newCase(opts = {}) {
  const now = opts.now || new Date().toISOString();
  return {
    id: opts.id || makeId(Date.parse(now), opts.rnd),
    title: String(opts.title || '').trim(),
    tlp: opts.tlp || DEFAULT_TLP,
    createdAt: now,
    updatedAt: now,
    items: Array.isArray(opts.items) ? opts.items : [],
    timeline: Array.isArray(opts.timeline) ? opts.timeline : [],
  };
}

function emptyStore() { return { cases: [], activeId: null }; }

/* Отбор пригодных элементов массива с подсчётом выброшенного.
 *
 * Пригодный — непустой объект. Этого достаточно: дальше по коду
 * читаются поля (`i.type`, `событие.kind`), и падает именно обращение
 * к полю у `null`, строки или числа. Более строгую проверку делать
 * нельзя: запись из будущей версии с незнакомыми полями — это ещё
 * не мусор, и выбрасывать её было бы потерей работы аналитика. */
function чистые(массив, счёт, ключ) {
  if (!Array.isArray(массив)) return [];
  const годные = массив.filter((e) => e && typeof e === 'object');
  const выброшено = массив.length - годные.length;
  if (выброшено) счёт[ключ] = (счёт[ключ] || 0) + выброшено;
  return годные;
}

/* Приведение прочитанного из storage к рабочему виду.
 *
 * Хранилище переживает откаты сборки и ручные правки, поэтому здесь
 * не доверяется ничему: битый кейс выбрасывается, а не роняет консоль. */
function normalizeStore(raw) {
  const store = emptyStore();
  const выброшено = {};
  const cases = raw && Array.isArray(raw.cases) ? raw.cases : [];
  for (const c of cases) {
    if (!c || typeof c !== 'object' || !c.id) continue;
    /* Метка клиента из 0.28.0 подклеивается к названию, а не выбрасывается:
     * это текст, который аналитик уже ввёл руками. Терять его молча
     * при обновлении нельзя. */
    const legacyClient = String(c.client || '').trim();
    const plainTitle = String(c.title || '').trim();
    store.cases.push({
      id: String(c.id),
      title: legacyClient && !plainTitle.includes(legacyClient)
        ? (plainTitle ? `${legacyClient} — ${plainTitle}` : legacyClient)
        : plainTitle,
      tlp: c.tlp || DEFAULT_TLP,
      createdAt: c.createdAt || new Date(0).toISOString(),
      updatedAt: c.updatedAt || c.createdAt || new Date(0).toISOString(),
      /* ПУСТЫЕ ЭЛЕМЕНТЫ ВЫБРАСЫВАЮТСЯ, и выброшенное считается.
       *
       * `null` среди индикаторов роняет выгрузку в CSV и STIX
       * и разметку обвязки; `null` в хронологии роняет ВСЁ, что её
       * читает: отрисовку вкладки кейса, скелет отчёта, выгрузку
       * в Markdown и передачу смены — каждая функция обращается
       * к `событие.kind`.
       *
       * Хранилище читается при КАЖДОМ запуске, поэтому один `null`
       * ломал вкладку навсегда, и причину на экране увидеть было
       * нечем. importCase такие элементы чистил у индикаторов
       * и не чистил у хронологии — асимметрия в одной функции;
       * normalizeStore не чистил ни тех, ни других.
       *
       * Откуда берётся: файл кейса, собранный скриптом или правленый
       * руками, слияние двух выгрузок, выгрузка другой версии,
       * оборванная запись в storage. Вредоносного умысла не требуется.
       *
       * Счётчик нужен, чтобы чистка НЕ БЫЛА МОЛЧАЛИВОЙ: молча
       * выброшенная работа аналитика — тот же класс дефекта, что
       * молчаливая поломка. Его показывает storeProblems. */
      items: чистые(c.items, выброшено, 'items'),
      timeline: чистые(c.timeline, выброшено, 'timeline'),
    });
  }
  store.activeId = raw && raw.activeId && store.cases.some((c) => c.id === raw.activeId)
    ? raw.activeId
    : (store.cases[0] ? store.cases[0].id : null);
  /* Поле появляется ТОЛЬКО когда что-то выброшено. Пустой объект
   * в каждом хранилище уехал бы в выгрузку кейса и в сравнение
   * состояний, где ему делать нечего. */
  if (Object.keys(выброшено).length) store.выброшено = выброшено;
  return store;
}

/* Перенос старого одиночного кейса.
 *
 * Старые ключи НЕ УДАЛЯЮТСЯ. Это не забывчивость: если перенос где-то
 * ошибётся, единственная копия работы аналитика не должна исчезнуть
 * вместе с ошибкой. Ключи остаются как резервная копия до следующей
 * сборки, и об этом написано в интерфейсе.
 *
 * Название перенесённого кейса — «Кейс до разделения»: выдумывать
 * осмысленное неоткуда, а видимая заглушка лучше правдоподобной догадки. */
function migrateLegacy(legacy, opts = {}) {
  /* Значение по умолчанию в сигнатуре НЕ спасает от null: оно
   * подставляется только для undefined. Хранилище переживает откаты
   * сборки, и там встречается ровно null. Поймал тест. */
  const src = legacy && typeof legacy === 'object' ? legacy : {};
  const items = Array.isArray(src.items) ? src.items : [];
  const timeline = Array.isArray(src.timeline) ? src.timeline : [];
  if (!items.length && !timeline.length) return { migrated: false, store: emptyStore() };

  const c = newCase({
    now: opts.now || new Date().toISOString(),
    rnd: opts.rnd,
    title: String(src.title || '').trim() || T('Кейс до разделения'),
    tlp: src.tlp || DEFAULT_TLP,
    items,
    timeline,
  });
  return { migrated: true, store: { cases: [c], activeId: c.id } };
}

function activeCase(store) {
  if (!store || !Array.isArray(store.cases)) return null;
  return store.cases.find((c) => c.id === store.activeId) || null;
}

function setActive(store, id) {
  if (!store || !Array.isArray(store.cases)) return emptyStore();
  if (!store.cases.some((c) => c.id === id)) return store;
  return { ...store, activeId: id };
}

function addCase(store, opts = {}) {
  const base = store && Array.isArray(store.cases) ? store.cases : [];
  const c = newCase(opts);
  const cases = [...base, c].slice(-MAX_CASES);
  return { store: { cases, activeId: c.id }, added: c };
}

/* Удаление кейса уносит его индикаторы И хронологию: они лежат внутри
 * самого кейса, отдельных ключей нет. Это сделано специально — так
 * «удалить» не может оставить половину. */
function removeCase(store, id) {
  if (!store || !Array.isArray(store.cases)) return emptyStore();
  const cases = store.cases.filter((c) => c.id !== id);
  const activeId = store.activeId === id ? (cases[0] ? cases[0].id : null) : store.activeId;
  return { cases, activeId };
}

function updateCase(store, id, patch = {}) {
  if (!store || !Array.isArray(store.cases)) return emptyStore();
  const cases = store.cases.map((c) => {
    if (c.id !== id) return c;
    const next = { ...c };
    if ('title' in patch) next.title = String(patch.title || '').trim();
    if ('tlp' in patch) next.tlp = patch.tlp || c.tlp;
    if ('items' in patch && Array.isArray(patch.items)) next.items = patch.items;
    if ('timeline' in patch && Array.isArray(patch.timeline)) next.timeline = patch.timeline;
    next.updatedAt = patch.now || new Date().toISOString();
    return next;
  });
  return { ...store, cases };
}

/* ==================== ДОБАВЛЕНИЕ ИНДИКАТОРОВ В АКТИВНЫЙ КЕЙС ==========
 *
 * Общая точка для главной вкладки и боковой панели. Появилась после
 * дефекта, который иначе не ловится ни одним модульным тестом:
 * панель писала в СТАРЫЙ ключ `ti_case_items`, а вкладка с 0.28.0
 * читает `ti_cases`. Комментарий в панели при этом уверял, что ключ
 * тот же. Снаружи это выглядело так: аналитик на странице нажимает
 * «В кейс», панель отвечает «+7», в кейсе ничего не появляется.
 *
 * Хуже тихой потери был второй исход: на профиле, где перенос ещё не
 * выполнялся, накопленное панелью подхватывалось переносом и ложилось
 * ОДНИМ кейсом — то есть индикаторы разных заказчиков в одном месте.
 *
 * Если кейсов нет вообще, создаётся первый: смешивать не с чем.
 * Если кейс есть — только активный, никаких догадок.
 */
function addItemsToActive(store, items, opts = {}) {
  const now = opts.now || new Date().toISOString();
  let s = normalizeStore(store);
  let созданКейс = false;

  if (!activeCase(s)) {
    if (s.cases.length) return { ok: false, error: T('активный кейс не выбран'), store: s, added: 0 };
    /* Название пустое намеренно: главная вкладка покажет «кейс без
     * названия» как проблему и аналитик его назовёт. Правдоподобная
     * выдумка вроде имени хоста была бы хуже видимого пробела. */
    const r = addCase(s, { title: '', now, rnd: opts.rnd });
    s = r.store;
    созданКейс = true;
  }

  const act = activeCase(s);
  const list = act.items.slice();
  const seen = new Set(list.map((i) => `${i.type}|${String(i.value).toLowerCase()}`));
  let added = 0, повторов = 0;
  for (const i of (Array.isArray(items) ? items : [])) {
    if (!i || !i.value) continue;
    const k = `${i.type}|${String(i.value).toLowerCase()}`;
    if (seen.has(k)) { повторов++; continue; }
    seen.add(k);
    list.push({ ...i, addedAt: now, source: opts.source || i.source || T('страница') });
    added++;
  }
  return {
    ok: true, added, повторов, созданКейс,
    store: updateCase(s, act.id, { items: list, now }),
    caseId: act.id,
  };
}

/* Подпись кейса в списке и в шапке. */
function caseLabel(c) {
  if (!c) return '—';
  const title = c.title || T('без названия');
  return `${title} (${c.items.length})`;
}

/* Импорт ранее выгруженного case.json.
 *
 * Импорт ВСЕГДА создаёт НОВЫЙ кейс и никогда не дополняет активный.
 * Дополнение активного — это ровно тот способ смешать двух клиентов
 * одним кликом, ради устранения которого всё и делалось.
 *
 * Название берётся из файла; если его там нет — «Импортированный кейс». */
function importCase(store, data, opts = {}) {
  const warnings = [];
  if (!data || typeof data !== 'object') {
    return { ok: false, error: T('файл не разбирается как JSON-выгрузка кейса') };
  }
  const items = Array.isArray(data.items) ? data.items
    : (Array.isArray(data.cases) && data.cases[0] && Array.isArray(data.cases[0].items)
        ? data.cases[0].items : null);
  if (!items) {
    return { ok: false, error: T('в файле нет массива items — это не выгрузка кейса') };
  }
  const timelineRaw = Array.isArray(data.timeline) ? data.timeline : [];
  if (!timelineRaw.length) warnings.push(T('в файле нет хронологии: она была выгружена до 0.23.0 либо не велась'));

  const bad = items.filter((i) => !i || typeof i.value !== 'string').length;
  if (bad) warnings.push(T`записей без значения: ${bad} — пропущены`);

  /* Хронология чистится ТАК ЖЕ, КАК items, и выброшенное так же
   * считается. Раньше здесь стояла только проверка Array.isArray,
   * а элементы не смотрели вовсе — асимметрия в одной функции, на одном
   * и том же непроверенном файле.
   *
   * Цена была не «кривая строка в списке»: `null` в хронологии роняет
   * отрисовку вкладки кейса, скелет отчёта, выгрузку в Markdown
   * и передачу смены — все они читают `событие.kind`. Кейс при этом
   * уже записан в хранилище, то есть вкладка оставалась сломанной
   * и после перезапуска, без единого слова на экране. */
  const timeline = timelineRaw.filter((e) => e && typeof e === 'object');
  const badTl = timelineRaw.length - timeline.length;
  if (badTl) warnings.push(T`событий хронологии без содержимого: ${badTl} — пропущены`);

  const res = addCase(store, {
    now: opts.now || new Date().toISOString(),
    rnd: opts.rnd,
    title: String(data.title || '').trim() || T('Импортированный кейс'),
    tlp: data.tlp || DEFAULT_TLP,
    items: items.filter((i) => i && typeof i.value === 'string'),
    timeline,
  });
  return { ok: true, store: res.store, added: res.added, warnings };
}

/* Проверка хранилища. Возвращает список проблем, которые стоит показать
 * аналитику: они не мешают работе, но о них лучше знать.
 *
 * Проверок стало меньше после того, как убрали метку клиента: остались
 * те, что про состояние хранилища, а не про заполненность полей. */
function storeProblems(store) {
  if (!store || !Array.isArray(store.cases)) return [T('хранилище кейсов не прочитано')];
  const act = activeCase(store);
  if (!act) return [T('активный кейс не выбран')];
  const out = [];
  if (!act.title) out.push(T('у активного кейса нет названия — в списке он неотличим от других'));
  /* Выброшенное при чтении хранилища НАЗЫВАЕТСЯ. Записи, испортившиеся
   * в storage, приходится выбрасывать — иначе они роняют выгрузку
   * и вкладку кейса, — но делать это молча нельзя: аналитик обязан
   * знать, что часть его работы до него не доехала, а не обнаружить
   * потом расхождение в отчёте. */
  const в = store.выброшено;
  if (в && (в.items || в.timeline)) {
    const части = [];
    if (в.items) части.push(T`индикаторов: ${в.items}`);
    if (в.timeline) части.push(T`событий хронологии: ${в.timeline}`);
    out.push(T`при чтении хранилища выброшены испорченные записи (${части.join(', ')}) — `
             + T('они ломали выгрузку кейса; проверьте полноту по своей выгрузке'));
  }
  return out;
}

/* Ключ сравнения. Тот же, что iocKey в newtab.js: тип плюс значение
 * в нижнем регистре. Держать два разных правила сравнения в одном
 * проекте — способ получить «новый» и «уже в кейсе» одновременно
 * для одного значения. */
function ключИндикатора(i) {
  return `${i && i.type}|${String(i && i.value || '').toLowerCase()}`;
}

/**
 * Сколько из разобранного уже лежит в кейсе, а сколько ново.
 *
 * ЧТО ЭТО ЗА ФУНКЦИЯ. Первый вопрос при очередном отчёте — не «какие
 * тут индикаторы», а «что из этого мы ещё не видели». До сих пор ответ
 * собирался глазами по меткам «уже в кейсе» на карточках.
 *
 * ПОЧЕМУ ВТОРОЙ АРГУМЕНТ — СПИСОК, А НЕ ХРАНИЛИЩЕ. Сюда передаются
 * индикаторы ОДНОГО кейса, и это не экономия, а граница. Поля «клиент»
 * у кейса нет с 0.29.0: имя заказчика живёт в названии свободным
 * текстом. Значит единственное, что не даёт вердикту одного заказчика
 * всплыть в кейсе другого, — то, что сравнение идёт с активным кейсом
 * и ни с каким больше. Сравнение по всем кейсам («видели раньше») —
 * другая функция, и ей поле «клиент» необходимо.
 *
 * Обвязка страницы в счёт не идёт: она не попадает в кейс, и включать
 * её в «новых» значило бы расходиться с тем, что аналитик видит
 * на экране.
 */
function новизна(iocs, items) {
  const вКейсе = new Set((items || []).map(ключИндикатора));
  let новых = 0, известных = 0;
  for (const i of iocs || []) {
    if (!i || i.noise) continue;
    if (вКейсе.has(ключИндикатора(i))) известных++;
    else новых++;
  }
  return { новых, известных, всего: новых + известных };
}

const CASES_API = {
  STORE_KEY, ACTIVE_KEY, LEGACY_ITEMS, LEGACY_TIMELINE, MAX_CASES, DEFAULT_TLP,
  makeId, newCase, emptyStore, normalizeStore, migrateLegacy,
  activeCase, setActive, addCase, removeCase, updateCase, caseLabel,
  importCase, storeProblems, addItemsToActive,
  новизна, ключИндикатора,
};
if (typeof module !== 'undefined' && module.exports) module.exports = CASES_API;
if (typeof globalThis !== 'undefined') globalThis.TICases = CASES_API;

})();
