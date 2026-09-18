/* =============================================================================
 * noise.js — отделение индикаторов от обвязки страницы
 * =============================================================================
 *
 * ЗАДАЧА
 * ------
 * Аналитик забирает отчёт вендора по ссылке и получает вперемешку:
 * индикаторы из отчёта и всё, что относится к САМОМУ ВЕНДОРУ — его
 * соцсети, блог на medium, канал в telegram, адрес для связи.
 * На отчёте BI.ZONE из одиннадцати «индикаторов» настоящими не были
 * ни одного: восемь ссылок на площадки компании и два её адреса почты.
 *
 * ЧЕГО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ
 * --------------------------
 * Он НЕ решает, что является индикатором компрометации. Это решение
 * аналитика, и никакой список правил его не заменит: домен вендора
 * бывает индикатором — ровно тогда, когда взломали вендора.
 *
 * Он решает задачу поменьше и разрешимую: отличить содержимое страницы
 * от её обвязки. Правила детерминированные, у каждого отброшенного
 * значения есть причина, и НИЧЕГО НЕ ПРОПАДАЕТ — отсеянное показывается
 * отдельной группой и возвращается одним щелчком.
 *
 * ПОЧЕМУ НЕ УДАЛЯТЬ МОЛЧА
 * -----------------------
 * Молчаливое удаление — это второй способ соврать аналитику. Первый,
 * показать сто адресов вендора вместо трёх индикаторов, мы только что
 * исправили; заменять его на «а вот этого вы не увидите» нельзя.
 * Отсеянное видно, посчитано и объяснено.
 * ========================================================================== */

'use strict';

/* Площадки, присутствие на которых есть у любой компании.
 *
 * Список намеренно КОРОТКИЙ и состоит только из соцсетей, мессенджеров
 * и блог-платформ, то есть того, что в отчёте про угрозу появляется
 * в подвале, а не в таблице индикаторов.
 *
 * Чего здесь СОЗНАТЕЛЬНО НЕТ и быть не должно:
 *   github.com, gitlab.com  — там регулярно лежит вредоносная нагрузка,
 *                             ссылка на репозиторий бывает индикатором;
 *   pastebin.com и подобные — там лежат конфиги и дампы;
 *   *.blogspot.com, *.wordpress.com — бесплатный хостинг, на нём
 *                             поднимают фишинг.
 * Включить их сюда значило бы прятать настоящие индикаторы, а это хуже
 * шума: шум виден, спрятанное — нет.
 */
const PLATFORM_HOSTS = [
  'x.com', 'twitter.com', 't.me', 'telegram.me', 'telegram.org',
  'vk.com', 'ok.ru', 'dzen.ru', 'max.ru', 'rutube.ru',
  'linkedin.com', 'facebook.com', 'instagram.com', 'threads.net',
  'youtube.com', 'youtu.be', 'whatsapp.com', 'viber.com',
  'medium.com', 'habr.com', 'substack.com', 'mastodon.social',
  'infosec.exchange', 'bsky.app',
];

/* Домены самих поисковых и агрегаторных сервисов: ссылка на карточку
 * VirusTotal — это ссылка на отчёт о вредоносе, а не сам вредонос. */
const AGGREGATOR_HOSTS = [
  'virustotal.com', 'any.run', 'tria.ge', 'hybrid-analysis.com',
  'urlscan.io', 'abuse.ch', 'malpedia.caad.fkie.fraunhofer.de',
  'attack.mitre.org', 'nvd.nist.gov', 'cve.org', 'cve.mitre.org',
];

const REASON = {
  SOURCE: 'сайт источника',
  PLATFORM: 'площадка присутствия',
  AGGREGATOR: 'ссылка на карточку сервиса',
  FURNITURE: 'колонтитул — повторяется по всему документу',
  REFS: 'раздел ссылок и дополнительных материалов',
  CONTACT: 'контактная строка в конце отчёта',
};

/* =============================================================================
 * СТРУКТУРА ДОКУМЕНТА
 * =============================================================================
 *
 * Правила выше работают со ЗНАЧЕНИЕМ: кто владелец хоста. Для забранной
 * страницы этого хватало, для загруженного файла — нет: у файла нет
 * хоста-источника, и обвязка в нём устроена иначе.
 *
 * Поймано на отчёте заказчика (15 страниц). В основной список попали:
 *
 *   soc@example.org ×15   — строка «Email: soc@example.org» стоит
 *                          колонтитулом на КАЖДОЙ странице;
 *   два адреса статей    — из раздела «Ссылки и дополнительные материалы».
 *
 * Ни то, ни другое не является индикатором компрометации, и оба видны
 * не по значению, а по МЕСТУ в документе. Отсюда два правила ниже.
 *
 * Что здесь НЕ делается: ничего не удаляется. Значение уходит в ту же
 * группу «отсеяно как обвязка», с причиной, и возвращается одним щелчком.
 * ========================================================================== */

/* Колонтитул: строка повторяется не меньше трёх раз И её вхождения
 * растянуты по документу. Растянутость обязательна — без неё правило
 * съело бы список одинаковых строк, идущих подряд. */
const FURNITURE_MIN_REPEATS = 3;
const FURNITURE_MIN_SPREAD = 0.6;

/* Потолок на число РАЗНЫХ строк-колонтитулов. Если их больше, документ
 * устроен не так, как мы предполагаем, и правило отключается целиком:
 * лучше оставить шум, чем спрятать половину документа. */
const FURNITURE_MAX_KINDS = 12;

/* Заголовок раздела ссылок. Список закрытый и короткий: слово «источники»
 * в середине отчёта означает совсем другое. */
const REFS_HEADINGS = [
  'ссылки и дополнительные материалы',
  'дополнительные материалы',
  'ссылки',
  'источники',
  'использованные источники',
  'references',
  'further reading',
  'sources',
];

/* Раздел ссылок бывает только в конце. Заголовок, найденный раньше,
 * игнорируется: в середине документа «Ссылки» — это заголовок таблицы
 * индикаторов не реже, чем список литературы. */
const REFS_MIN_POSITION = 0.75;

/* Приглашение написать: строка с адресом и такой формулировкой в хвосте
 * документа — контакт вендора, а не индикатор. Список намеренно узкий:
 * каждое слово здесь означает «напишите нам», а не «атакующие писали». */
const CONTACT_HINT = new RegExp([
  'напишите нам', 'свяжитесь с нами', 'пишите на', 'обратная связь',
  'по вопросам', 'контакты?:', 'для связи',
  'contact us', 'reach out', 'get in touch', 'for more information',
  'to learn more', 'questions\\?', 'feedback',
].join('|'), 'i');

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Найти в тексте обвязку: строки-колонтитулы и хвостовой раздел ссылок.
 *
 * @param {string} text
 * @returns {{lines: string[], furniture: Set<number>, refsFrom: number|null}}
 */
function documentParts(text) {
  const lines = String(text || '').split(/\r?\n/);
  const пусто = { lines, furniture: new Set(), refsFrom: null, contact: new Set() };
  if (lines.length < 6) return пусто;

  /* --- колонтитулы --- */
  const где = new Map();
  for (let i = 0; i < lines.length; i++) {
    const k = norm(lines[i]);
    if (!k || k.length > 200) continue;
    if (!где.has(k)) где.set(k, []);
    где.get(k).push(i);
  }
  const колонтитулы = [];
  for (const [k, idx] of где) {
    if (idx.length < FURNITURE_MIN_REPEATS) continue;
    const spread = (idx[idx.length - 1] - idx[0]) / Math.max(1, lines.length - 1);
    if (spread < FURNITURE_MIN_SPREAD) continue;
    колонтитулы.push(k);
  }
  const furniture = new Set();
  if (колонтитулы.length && колонтитулы.length <= FURNITURE_MAX_KINDS) {
    for (const k of колонтитулы) for (const i of где.get(k)) furniture.add(i);
  }

  /* --- раздел ссылок --- */
  let refsFrom = null;
  const порог = Math.floor(lines.length * REFS_MIN_POSITION);
  for (let i = порог; i < lines.length; i++) {
    const k = norm(lines[i]).replace(/[:：]\s*$/, '');
    if (REFS_HEADINGS.includes(k)) { refsFrom = i; break; }
  }

  /* --- контактные строки в хвосте ---
   *
   * «Чтобы узнать больше об отчётах, напишите нам: intelreports@kaspersky.com»
   * — это адрес вендора, а не индикатор. Правило по хосту его не ловит:
   * у вставленного текста нет хоста-источника. Правило про колонтитул
   * тоже: строка встречается один раз.
   *
   * Ловится по ПРИГЛАШЕНИЮ НАПИСАТЬ рядом с адресом и по положению
   * в конце документа. Одного приглашения мало: «жертва получила письмо,
   * в котором просили написать на ...» — это описание атаки, и адрес
   * там индикатор. Поэтому нужна ещё и хвостовая четверть, где разбора
   * инцидента уже нет.
   *
   * Найденное не удаляется, а показывается отдельной группой с причиной:
   * адрес вендора бывает индикатором, когда взломали вендора. */
  const contact = new Set();
  for (let i = порог; i < lines.length; i++) {
    if (!/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/.test(lines[i])) continue;
    /* Приглашение ищется и в ПРЕДЫДУЩЕЙ строке: вёрстка регулярно
     * разрывает фразу — «...напишите\nнам: intelreports@kaspersky.com».
     * Проверка одной строки такой случай не видит. */
    const пред = i > 0 ? lines[i - 1] : '';
    if (!CONTACT_HINT.test(lines[i]) && !CONTACT_HINT.test(пред + ' ' + lines[i])) continue;
    contact.add(i);
  }

  return { lines, furniture, refsFrom, contact };
}

/** Текст только из строк обвязки. Пустая строка, если обвязки нет. */
function chromeTextOf(parts) {
  const { lines, furniture, refsFrom } = parts;
  const contact = parts.contact || new Set();
  const взять = [];
  for (let i = 0; i < lines.length; i++) {
    if (furniture.has(i) || contact.has(i)
        || (refsFrom !== null && i >= refsFrom)) взять.push(lines[i]);
    else взять.push('');          // пустая строка вместо содержимого:
  }                               // так номера строк не съезжают и склейка
  return взять.join('\n');        // переносов не срастит чужие куски
}

/**
 * Разметить обвязку ДОКУМЕНТА: колонтитулы и раздел ссылок.
 *
 * Значение считается обвязкой, только если ВСЕ его вхождения лежат
 * в обвязке. Сравниваются счётчики: сколько раз значение встретилось
 * во всём тексте и сколько — в обвязке. Домен, стоящий и в таблице
 * индикаторов, и в списке литературы, остаётся индикатором.
 *
 * @param {Array}    iocs     результат разбора ВСЕГО текста
 * @param {string}   text     тот же текст
 * @param {Function} extract  IOC.extractIocs — передаётся снаружи, чтобы
 *                            этот модуль не зависел от порядка загрузки
 * @returns {{furniture: number, refs: number}} сколько чего помечено
 */
function markDocumentNoise(iocs, text, extract) {
  const итог = { furniture: 0, refs: 0, contact: 0 };
  if (!Array.isArray(iocs) || !iocs.length || typeof extract !== 'function') return итог;

  const parts = documentParts(text);
  if (!parts.furniture.size && parts.refsFrom === null && !parts.contact.size) return итог;

  const вОбвязке = new Map();
  for (const i of extract(chromeTextOf(parts), { withContext: false })) {
    вОбвязке.set(`${i.type}|${String(i.value).toLowerCase()}`, i.count || 1);
  }
  if (!вОбвязке.size) return итог;

  /* Раздельные счётчики нужны, чтобы назвать причину. Строки раздела
   * ссылок и строки колонтитулов считаются отдельно. */
  const толькоКолонтитул = new Map();
  const толькоКонтакт = new Map();
  if (parts.contact.size) {
    const t = parts.lines.map((l, i) => (parts.contact.has(i) ? l : '')).join('\n');
    for (const i of extract(t, { withContext: false })) {
      толькоКонтакт.set(`${i.type}|${String(i.value).toLowerCase()}`, i.count || 1);
    }
  }
  if (parts.furniture.size) {
    const t = parts.lines.map((l, i) => (parts.furniture.has(i) ? l : '')).join('\n');
    for (const i of extract(t, { withContext: false })) {
      толькоКолонтитул.set(`${i.type}|${String(i.value).toLowerCase()}`, i.count || 1);
    }
  }

  for (const ioc of iocs) {
    if (ioc.noise) continue;                       // уже отсеяно правилом по хосту
    const k = `${ioc.type}|${String(ioc.value).toLowerCase()}`;
    const вне = (ioc.count || 1) - (вОбвязке.get(k) || 0);
    if (вне > 0) continue;                         // встречается и вне обвязки
    if (!вОбвязке.has(k)) continue;

    ioc.noise = true;
    if (толькоКолонтитул.has(k)) { ioc.noiseReason = REASON.FURNITURE; итог.furniture++; }
    else if (толькоКонтакт.has(k)) { ioc.noiseReason = REASON.CONTACT; итог.contact++; }
    else { ioc.noiseReason = REASON.REFS; итог.refs++; }
  }
  return итог;
}

/** Хост из значения индикатора. Для домена это он сам. */
function hostOfValue(type, value) {
  const v = String(value || '').trim();
  if (type === 'domain') return v.toLowerCase();
  if (type === 'url') {
    try { return new URL(v).hostname.toLowerCase(); } catch (_) { return ''; }
  }
  if (type === 'email') return (v.split('@')[1] || '').toLowerCase();
  return '';
}

/** host принадлежит base или его поддомену. */
function under(host, base) {
  if (!host || !base) return false;
  const h = host.toLowerCase(), b = base.toLowerCase();
  return h === b || h.endsWith('.' + b);
}

/**
 * Помечает индикатор как обвязку страницы, если это так.
 *
 * @param {{type: string, value: string}} ioc
 * @param {{sourceHost?: string}} ctx  хост страницы, с которой забран текст
 * @returns {{noise: boolean, reason: string}}
 */
function classify(ioc, ctx = {}) {
  const type = ioc && ioc.type;
  if (!['url', 'domain', 'email'].includes(type)) return { noise: false, reason: '' };

  const host = hostOfValue(type, ioc.value);
  if (!host) return { noise: false, reason: '' };

  /* Сайт источника. Отчёт вендора ссылается сам на себя десятками
   * способов: другие статьи, продукты, форма обратной связи. */
  if (ctx.sourceHost && under(host, ctx.sourceHost)) {
    return { noise: true, reason: REASON.SOURCE };
  }
  /* Обратное тоже бывает: источник bi.zone, а в подвале ссылка
   * на bi-zone.medium.com — хост чужой, но это та же компания.
   * Ловится следующим правилом как площадка. */
  for (const p of PLATFORM_HOSTS) {
    if (under(host, p)) return { noise: true, reason: REASON.PLATFORM };
  }
  for (const a of AGGREGATOR_HOSTS) {
    if (under(host, a)) return { noise: true, reason: REASON.AGGREGATOR };
  }
  return { noise: false, reason: '' };
}

/**
 * Размечает список. Возвращает ТОТ ЖЕ список с полями noise/noiseReason —
 * ничего не выбрасывая. Решение, что показывать, принимает интерфейс.
 */
function markNoise(iocs, ctx = {}) {
  for (const i of iocs || []) {
    const r = classify(i, ctx);
    i.noise = r.noise;
    if (r.noise) i.noiseReason = r.reason; else delete i.noiseReason;
  }
  return iocs;
}

/** Хост страницы, с которой забрали текст. '' если источник не ссылка. */
function sourceHostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch (_) { return ''; }
}

const NOISE_API = {
  classify, markNoise, sourceHostOf, hostOfValue, under,
  documentParts, chromeTextOf, markDocumentNoise,
  PLATFORM_HOSTS, AGGREGATOR_HOSTS, REASON, REFS_HEADINGS,
  FURNITURE_MIN_REPEATS, FURNITURE_MIN_SPREAD, FURNITURE_MAX_KINDS, REFS_MIN_POSITION,
};
if (typeof module !== 'undefined' && module.exports) module.exports = NOISE_API;
if (typeof globalThis !== 'undefined') globalThis.TINoise = NOISE_API;
