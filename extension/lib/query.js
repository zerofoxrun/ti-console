/* =============================================================================
 * query.js — сборка поискового запроса из площадок и шаблона
 * =============================================================================
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ
 * ---------------------------
 * Раньше запрос собирался в двух местах: в ветке SearXNG и в ветке прямого
 * открытия. Логика дублировалась, и в неё въехали три дефекта, каждый
 * из которых выглядел одинаково — «ничего не найдено»:
 *
 *   1. шаблон запроса с оператором site: склеивался с профилем площадок,
 *      тоже дающим site:. Две группы site: через И — это требование
 *      «страница лежит одновременно на x.com и на unit42.paloaltonetworks.com».
 *      Выдача пуста ВСЕГДА, и это логически верный ответ на бессмысленный
 *      вопрос;
 *   2. в профилях часть площадок записана с путём (crowdstrike.com/blog).
 *      Оператор site: путь не берёт: DuckDuckGo его игнорирует или отдаёт
 *      ноль, Google обрабатывает частично и непредсказуемо;
 *   3. в прямом режиме бралось 8 площадок из 19, и это сообщалось, —
 *      но вместе с (1) и (2) сообщение выглядело как единственная причина,
 *      хотя было наименьшей из трёх.
 *
 * Теперь сборка одна, чистая и покрыта тестами. Ошибка такого рода
 * не диагностируется по выдаче: пустой результат выглядит как «ничего
 * не нашлось», а не как «запрос противоречив».
 * ========================================================================== */

'use strict';

/* Сколько площадок влезает в один запрос прямого режима.
 * Ограничение не наше: у поисковых систем есть предел длины строки запроса
 * и числа операторов, за которым запрос молча усекается или отбрасывается. */
const MAX_DIRECT_SITES = 8;

/** Хост без пути. site: понимает только его. */
function hostOf(entry) {
  return String(entry || '').trim().split('/')[0].toLowerCase();
}

/** Есть ли у записи профиля путь, который в site: не попадёт. */
function hasPath(entry) {
  return String(entry || '').includes('/');
}

/**
 * Задаёт ли шаблон свои площадки.
 *
 * Различие между site: и -site: здесь принципиальное:
 *   site:  — сужение, конфликтует с профилем (пересечение пусто);
 *   -site: — исключение, с профилем сочетается нормально.
 * Шаблон «без агрегаторов» состоит только из -site: и профиль не ломает.
 */
function dorkSetsScope(tpl) {
  return /(^|\s|\()site:/.test(String(tpl || ''));
}

/**
 * Собирает запрос.
 *
 * @param {object} o
 * @param {string} o.query    что ищем (уже с применённым шаблоном, если он был)
 * @param {string[]} o.domains площадки профиля
 * @param {boolean} o.scoped  задал ли шаблон свои площадки
 * @param {number} o.limit    сколько площадок брать (0 — все)
 * @returns {{q: string, used: string[], dropped: string[], warnings: string[]}}
 */
function buildQuery({ query, domains = [], scoped = false, limit = 0 }) {
  const warnings = [];
  const q0 = String(query || '').trim();

  /* Шаблон сам задал площадки — профиль НЕ применяем.
   * Молча применить оба означало бы гарантированно пустую выдачу,
   * а молчаливая пустая выдача — худший из возможных ответов:
   * она неотличима от «действительно ничего нет». */
  if (scoped) {
    warnings.push('Шаблон задаёт свои площадки — профиль источников не применён. '
                + 'Два набора site: через И дали бы пустую выдачу всегда.');
    return { q: q0, used: [], dropped: [], warnings };
  }

  /* Пара «хост + был ли путь» держится вместе намеренно.
   * Отдельные массивы разъезжаются по индексам на первом же дубле:
   * github.com/SigmaHQ/sigma и github.com/elastic/detection-rules
   * дают один хост, и всё, что считалось по номеру, съезжает. */
  const entries = [];
  const seen = new Set();
  const withPath = [];
  const свернулись = [];
  for (const d of domains) {
    const h = hostOf(d);
    if (!h) continue;
    if (seen.has(h)) { свернулись.push(d); continue; }   // после отбрасывания пути возможны дубли
    seen.add(h);
    entries.push({ host: h, path: hasPath(d) });
    if (hasPath(d)) withPath.push(d);
  }

  /* При усечении берём сначала площадки БЕЗ пути.
   *
   * Список усекается до предела длины запроса, и брать первые попавшиеся
   * — значит с равной вероятностью взять запись вида
   * microsoft.com/en-us/security/blog, которая после отбрасывания пути
   * превращается в site:microsoft.com и топит выдачу всем остальным
   * майкрософтом. Площадка с собственным хостом даёт точный результат,
   * поэтому в ограниченный список она идёт первой.
   *
   * Сортировка устойчивая: внутри каждой группы порядок из профиля
   * сохраняется, он там осмысленный.
   */
  const ordered = limit > 0
    ? entries.filter((e) => !e.path).concat(entries.filter((e) => e.path)).map((e) => e.host)
    : entries.map((e) => e.host);
  const used = limit > 0 ? ordered.slice(0, limit) : ordered;
  const dropped = limit > 0 ? ordered.slice(limit) : [];

  /* Несколько записей одного домена дают ОДИН site:, а в списке профиля
   * при этом значатся все. Раньше лишние отбрасывались молча: десять
   * записей github.com/<репозиторий> выглядели как десять площадок
   * и превращались в одну. Аналитик считает, что охват шире, чем он есть,
   * — и это ровно тот случай, когда пустая выдача неотличима от честного
   * «ничего нет». */
  if (свернулись.length) {
    warnings.push(`${свернулись.length} записей свернулись в уже указанный домен `
      + '(site: понимает только домен, не раздел): '
      + свернулись.slice(0, 3).join(', ')
      + (свернулись.length > 3 ? ' и др.' : ''));
  }

  if (withPath.length) {
    /* Путь отбрасывается не по нашему выбору. Сказать об этом надо,
     * потому что точность падает заметно: site:microsoft.com вместо
     * раздела про безопасность — это весь microsoft.com. */
    warnings.push(`У ${withPath.length} площадок задан раздел сайта, `
      + 'а оператор site: понимает только домен. Поиск идёт по всему домену — '
      + 'выдача будет шумнее: ' + withPath.slice(0, 3).join(', ')
      + (withPath.length > 3 ? ' и др.' : ''));
  }
  if (dropped.length) {
    warnings.push(`Взято ${used.length} площадок из ${entries.length}: `
      + 'у поисковых систем есть предел длины запроса. '
      + 'Полный охват — только через SearXNG.');
  }

  const q = used.length ? `${q0} (${used.map((h) => `site:${h}`).join(' OR ')})` : q0;
  return { q, used, dropped, warnings };
}

/**
 * Адрес запроса к SearXNG.
 *
 * Базовый адрес может указывать на ПОДПУТЬ: в политике по умолчанию стоит
 * https://ti.example.ru/searx, потому что SearXNG обычно живёт за обратным
 * прокси рядом с остальным.
 *
 * Поэтому «/search» нельзя: ведущая косая черта делает путь абсолютным,
 * и new URL('/search', 'https://host/searx') даёт 'https://host/search' —
 * подпуть теряется, запрос уходит в никуда и возвращает 404. Чтобы путь
 * базы сохранился, нужен ОТНОСИТЕЛЬНЫЙ 'search' и база, заканчивающаяся
 * косой чертой.
 */
function searxUrl(base, q, time, lang) {
  const root = String(base || '').replace(/\/+$/, '') + '/';
  const u = new URL('search', root);
  u.searchParams.set('q', q);
  if (time) u.searchParams.set('time_range', time);
  if (lang) u.searchParams.set('language', lang);
  u.searchParams.set('safesearch', '0');
  return u.toString();
}

const DDG_TIME = { day: 'd', week: 'w', month: 'm', year: 'y' };

/** Адрес запроса к DuckDuckGo (прямой режим, без своего сервера). */
function directUrl(q, time) {
  let u = 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
  if (time && DDG_TIME[time]) u += '&df=' + DDG_TIME[time];
  return u;
}

const QUERY_API = {
  buildQuery, searxUrl, directUrl, hostOf, hasPath, dorkSetsScope,
  MAX_DIRECT_SITES,
};
if (typeof module !== 'undefined' && module.exports) module.exports = QUERY_API;
if (typeof globalThis !== 'undefined') globalThis.TIQuery = QUERY_API;
