/* =============================================================================
 * fetchpage.js — забрать страницу по ссылке и достать из неё текст
 * =============================================================================
 *
 * ЗАБИРАЕМ, А НЕ ОТКРЫВАЕМ — и это главное решение здесь
 * -----------------------------------------------------
 * Очевидная реализация «разбора по ссылке» — открыть URL во вкладке
 * и запустить тот же content-script, что работает на открытой странице.
 * Так делать нельзя: открытая страница ВЫПОЛНЯЕТСЯ. Загружаются скрипты,
 * трекеры, фреймы; вредоносная страница получает исполнение в браузере
 * аналитика, а сайт злоумышленника — полноценный отпечаток браузера.
 *
 * Здесь страница забирается через fetch и разбирается как текст:
 * скрипты не выполняются, картинки и фреймы не грузятся, отпечатка
 * браузера нет. Разбор HTML идёт через DOMParser — он строит дерево,
 * но НЕ исполняет <script> и не загружает ресурсы.
 *
 * ЧЕГО ЭТО НЕ РЕШАЕТ, И ОБ ЭТОМ НАПИСАНО В ИНТЕРФЕЙСЕ
 * ---------------------------------------------------
 * Запрос всё равно уходит с адреса аналитика. Инфраструктура, которую
 * вы проверяете, видит обращение и может по нему понять, что ей
 * интересуются. Для отчёта вендора это безразлично, для панели
 * управления злоумышленника — нет.
 *
 * Правильное решение этой части — открытие страницы через свой сервер
 * (в дорожной карте). Пока сервера нет, единственная честная мера —
 * сказать аналитику, что происходит, до того как он нажмёт кнопку.
 * ========================================================================== */

'use strict';

const PAGE_MAX_BYTES = 5 * 1024 * 1024;
// 5 МБ хватает на любой отчёт. Ограничение нужно не ради памяти,
// а чтобы ссылка на дистрибутив не подвесила вкладку намертво.

const PAGE_TIMEOUT_MS = 20000;

// Теги, содержимое которых текстом не является. Вырезаются до извлечения:
// иначе в выдачу попадут доменные имена из кода аналитики и CSS.
const PAGE_DROP_TAGS = 'script,style,noscript,template,svg,canvas,iframe,object,embed';

/* Обвязка страницы. Её содержимое к статье отношения не имеет, а индикаторов
 * там не бывает — бывают соцсети вендора, форма подписки и телефон отдела
 * продаж. На отчёте BI.ZONE подвал дал восемь «индикаторов» из одиннадцати.
 *
 * Сначала по тегам, потом по классам и идентификаторам: семантическую
 * разметку ставят не все, а класс с «footer» или «social» в имени —
 * почти все. */
const CHROME_TAGS = 'nav,header,footer,aside,form,button,select,dialog';
const CHROME_PATTERN = /(^|[-_ ])(nav|menu|header|footer|sidebar|social|share|subscribe|newsletter|cookie|banner|breadcrumb|pagination|related|promo|advert|widget|popup|modal|toolbar|copyright)([-_ ]|$)/i;

/* Блочные теги: между ними при склейке текста нужен перенос строки.
 *
 * Без этого textContent склеивает соседние блоки вплотную, и
 * «<div>ИНН 110-25-34</div><div>info@bi.zone</div>» превращается
 * в «ИНН 110-25-34info@bi.zone» — парсер видит почтовый адрес
 * «110-25-34info@bi.zone», которого на странице нет.
 *
 * Это хуже шума: шум видно и можно снять галочку, а такой адрес
 * выглядит как настоящий индикатор и может уехать в отчёт клиенту.
 * innerText такие переносы ставит сам, но он есть только у отрисованных
 * элементов, а документ из DOMParser не отрисован. */
const BLOCK_TAGS = 'address,article,aside,blockquote,br,dd,div,dl,dt,fieldset,'
  + 'figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,'
  + 'p,pre,section,table,tbody,td,tfoot,th,thead,tr,ul';

/* =============================================================================
 * СТРАНИЦЫ, КОТОРЫЕ ОТРИСОВЫВАЮТСЯ СКРИПТАМИ
 * =============================================================================
 *
 * Мы забираем HTML и НЕ выполняем скрипты — в этом весь смысл забора
 * вместо открытия. Но у части сайтов, включая блоги вендоров, в HTML
 * приходит только оболочка: шапка, подвал и пустой контейнер, а статья
 * подставляется скриптом уже в браузере.
 *
 * Для таких страниц забор возвращает обвязку и ничего больше. Разбор
 * отчёта BI.ZONE дал одиннадцать «индикаторов» — все из подвала — и ни
 * одного хеша, хотя отчёт про новые инструменты группировки без хешей
 * не бывает. Статьи в забранном HTML просто не было.
 *
 * ЧТО С ЭТИМ ДЕЛАЕТСЯ ЗДЕСЬ
 *   1. Такая страница РАСПОЗНАЁТСЯ и называется вслух. Сказать
 *      «0 индикаторов» про страницу, которую мы не смогли прочитать, —
 *      значит соврать: это утверждение о странице, а не о нашем заборе.
 *   2. Делается попытка достать текст из встроенного JSON: фреймворки
 *      вроде Next.js кладут данные страницы в <script type="application/json">.
 *      Это разбор JSON, а не выполнение кода, — безопасно.
 *   3. Если не вышло — аналитику говорится, что делать: открыть страницу
 *      и нажать кнопку TI на панели. Разбор ОТКРЫТОЙ страницы читает
 *      отрисованный DOM и работает там, где забор бессилен.
 * ========================================================================== */

/* Короче этого текст статьи не бывает. Значение с запасом вниз:
 * ошибиться в сторону «промолчать» тут хуже, чем предупредить лишний раз. */
const MIN_ARTICLE_CHARS = 900;

/* Во сколько раз HTML больше извлечённого текста. У обычной статьи
 * разметки в несколько раз больше текста; у оболочки SPA — в десятки. */
const SHELL_RATIO = 25;

/* Достаёт длинные строки из встроенного в страницу JSON.
 *
 * Работает по сырому HTML, а не по DOM: скрипты из дерева вырезаются
 * раньше. Это разбор JSON.parse, никакого выполнения.
 *
 * Берутся только строки длиннее порога: короткие — это идентификаторы,
 * классы и ключи конфигурации, от них один шум. Длинные — проза статьи
 * и, если повезло, таблица индикаторов.
 */
function extractJsonText(html, minLen = 80) {
  const out = [];
  const re = /<script[^>]*type=["'](?:application\/json|application\/ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m, budget = 400;
  while ((m = re.exec(html)) && budget > 0) {
    let data;
    try { data = JSON.parse(m[1]); } catch (_) { continue; }
    const stack = [data];
    let steps = 200000;                       // защита от гигантского дерева
    while (stack.length && steps-- > 0 && budget > 0) {
      const v = stack.pop();
      if (typeof v === 'string') {
        if (v.length >= minLen) { out.push(v); budget--; }
      } else if (Array.isArray(v)) {
        for (const x of v) stack.push(x);
      } else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) stack.push(v[k]);
      }
    }
  }
  // Внутри JSON проза часто лежит как HTML-фрагмент — снимаем теги грубо,
  // полноценный разбор тут не нужен: нам нужны индикаторы, а не вёрстка.
  const seen = new Set();
  return out
    .map((t) => t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '))
    .filter((t) => { if (seen.has(t)) return false; seen.add(t); return true; })
    .join('\n');
}

/** Похоже ли, что страница отрисовывается скриптами. */
function looksLikeShell(html, text) {
  const t = (text || '').trim().length;
  if (t >= MIN_ARTICLE_CHARS) return false;
  return (html || '').length > t * SHELL_RATIO;
}

/* Разрешение на доступ к произвольным сайтам. Запрашивается у аналитика
 * при первом использовании, а не выдаётся молча при установке.
 *
 * ПОЧЕМУ ЗДЕСЬ КЕШ, А НЕ ПРОСТО contains() ПЕРЕД request()
 * -------------------------------------------------------
 * permissions.request() обязан вызываться при действующем жесте
 * пользователя. Любой await ДО него этот жест теряет, и Firefox отклоняет
 * вызов, не показав диалога. А permissions.contains() — сам по себе await.
 * Поэтому проверка делается заранее (warmPermission при загрузке страницы),
 * а в обработчике клика request() вызывается первым же действием. */
const NEED = { origins: ['<all_urls>'] };
let hasHostPermission = null;          // null — ещё не проверяли

/** Вызывается при инициализации страницы, вне обработчика клика. */
async function warmPermission() {
  if (typeof browser === 'undefined' || !browser.permissions) {
    hasHostPermission = true;          // вне расширения (демо-сборка, тесты)
    return true;
  }
  hasHostPermission = await browser.permissions.contains(NEED);
  return hasHostPermission;
}

/** Вызывать ТОЛЬКО из обработчика действия пользователя и первым await. */
async function ensurePermission() {
  if (hasHostPermission === null) await warmPermission();
  if (hasHostPermission) return true;
  hasHostPermission = await browser.permissions.request(NEED);
  return hasHostPermission;
}

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('пустая ссылка');
  // Аналитики регулярно вставляют дефанг: hxxps://evil[.]com
  if (globalThis.IOC && typeof IOC.refang === 'function') u = IOC.refang(u);

  /* Чужую схему надо отвергнуть ДО того, как дописывать свою.
   *
   * Наивный порядок — «нет https:// впереди, значит допишем» — на входе
   * file:///etc/passwd даёт https://file:///etc/passwd. Локальный файл так
   * не прочитается, но аналитик получает не отказ, а бессмысленный запрос
   * к хосту «file» и ошибку сети, из которой ничего не понять. Ошибка
   * во вводе должна называться ошибкой во вводе.
   *
   * Двоеточие в example.com:8080 — это порт, а не схема. Отличаем так же,
   * как браузеры: после двоеточия цифра — значит порт. */
  const scheme = /^([a-z][a-z0-9+.\-]*):/i.exec(u);
  if (scheme && !/^\d/.test(u.slice(scheme[0].length))) {
    const s = scheme[1].toLowerCase();
    if (s !== 'http' && s !== 'https') {
      throw new Error(`схема ${s}: не поддерживается — забрать можно только http и https`);
    }
  }

  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try {
    parsed = new URL(u);
  } catch (_) {
    throw new Error('это не похоже на ссылку');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('поддерживаются только http и https');
  }
  const внутр = internalHostReason(parsed.hostname);
  if (внутр) throw new Error(внутр);
  return parsed.href;
}

/* ====================== ВНУТРЕННИЙ КОНТУР ЗАБИРАТЬ НЕЛЬЗЯ ==============
 *
 * Политика Firefox закрывает внутренние зоны через WebsiteFilter, но он
 * запрещает ПЕРЕХОД, а не fetch из расширения. То есть этот забор ходил
 * мимо главного технического барьера проекта: адрес вида
 * https://wiki.corp/incident-2026 забирался и его содержимое попадало
 * в разбор, а оттуда — в кейс и в выгрузку.
 *
 * Список повторяет тот, что в background.scanDenylist: правило «внутренние
 * системы не трогаем» должно быть одно, а не два похожих.
 * ==================================================================== */
const INTERNAL_SUFFIX = ['.internal', '.local', '.corp', '.lan', '.home.arpa', '.intranet'];
const INTERNAL_EXACT = ['localhost'];

/* ============ ЧЕМ ИМЕННО РИСКУЕТ ЭТОТ КОНКРЕТНЫЙ АДРЕС ================
 *
 * Постоянный баннер «запрос уйдёт с вашего адреса» убран: он висел всегда
 * и поэтому не читался. Но у забора есть риски, которые зависят ОТ ССЫЛКИ,
 * и вот их сказать надо — ровно тогда, когда они появились.
 *
 * Два признака считаются локально, до всякого запроса:
 *
 *  1. Ссылка УНИКАЛЬНА — в ней длинный непроизносимый параметр или
 *     сегмент пути. Такая ссылка выдавалась одному получателю, и по ней
 *     владелец узнает не «кто-то интересовался», а именно вас.
 *
 *  2. Хост УЖЕ ЕСТЬ В РАЗБОРЕ — то есть аналитик забирает страницу
 *     инфраструктуры, которую сам же и расследует. Для панели управления
 *     злоумышленника это сигнал «нас заметили».
 *
 * Оба признака — предупреждения, а не запреты: решение за аналитиком.
 * ==================================================================== */

/* Длина, с которой строка перестаёт быть словом и начинается токеном.
 * Не подобрана: 16 символов base-конвертированного значения — это уже
 * 80+ бит, столько не бывает у осмысленного слова в адресе. */
const TOKEN_MIN = 16;
const TOKENISH = new RegExp(`^[A-Za-z0-9_\\-]{${TOKEN_MIN},}$`);

function looksLikeToken(v) {
  const s2 = String(v || '');
  if (!TOKENISH.test(s2)) return false;

  /* Слаг из слов — не токен: `muddled-libra-okta`, `threat-intelligence-report`
   * встречаются в адресах отчётов постоянно. Считаем слагом, если все части
   * между дефисами и подчёркиваниями — слова или короткие числа (год, номер). */
  const части = s2.split(/[-_]/);
  const этоСлаг = части.length > 1
    && части.every((p) => /^[A-Za-z]{2,}$/.test(p) || /^\d{1,4}$/.test(p));
  if (этоСлаг) return false;

  // Длинный hex — идентификатор без вариантов.
  if (/^[0-9a-f]{16,}$/i.test(s2)) return true;

  /* Две и более цифры либо смешанный регистр. Одна цифра бывает в обычных
   * адресах («part2»), две вразброс — уже признак сгенерированной строки. */
  const цифр = (s2.match(/\d/g) || []).length;
  const смешанныйРегистр = /[a-z]/.test(s2) && /[A-Z]/.test(s2);

  /* Сторона ошибки выбрана намеренно. Лишнее предупреждение аналитик
   * прочитает и пропустит; пропущенная персональная ссылка молча свяжет
   * его имя с проверкой. */
  return цифр >= 2 || смешанныйРегистр;
}

/**
 * Что сказать про конкретную ссылку перед забором.
 * @param {string} url
 * @param {string[]} knownHosts хосты, уже встречающиеся в разборе/кейсе
 * @returns {string[]} предупреждения (может быть пусто)
 */
function fetchRisks(url, knownHosts = []) {
  const out = [];
  let u;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); } catch (_) { return out; }

  const токены = [];
  for (const [, v] of u.searchParams) if (looksLikeToken(v)) токены.push(v);
  for (const seg of u.pathname.split('/')) if (looksLikeToken(seg)) токены.push(seg);
  if (u.hash && looksLikeToken(u.hash.slice(1))) токены.push(u.hash.slice(1));
  if (токены.length) {
    out.push('Ссылка выглядит персональной: в ней длинный уникальный параметр. '
           + 'По такой ссылке владелец узнает не «кто-то интересовался», а именно вас.');
  }

  const host = u.hostname.toLowerCase();
  const known = new Set((knownHosts || []).map((h) => String(h || '').toLowerCase()));
  if (known.has(host) || [...known].some((k) => k && host.endsWith('.' + k))) {
    out.push(`${host} уже есть в вашем разборе. Забирая страницу, вы сообщаете владельцу `
           + 'этого хоста, что им интересуются — для панели управления это сигнал.');
  }
  return out;
}

/** Причина отказа строкой, либо null. */
function internalHostReason(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  if (INTERNAL_EXACT.includes(h)) return `${h} — это локальная машина, забирать нечего`;
  for (const suf of INTERNAL_SUFFIX) {
    if (h.endsWith(suf)) {
      return `${h} — внутренняя зона (${suf}). Внутренние системы через TI-браузер не забираются`;
    }
  }
  // Литеральные адреса нероутируемых диапазонов.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b2] = [Number(m[1]), Number(m[2])];
    const приват = a === 10
      || (a === 172 && b2 >= 16 && b2 <= 31)
      || (a === 192 && b2 === 168)
      || a === 127
      || (a === 169 && b2 === 254)
      || (a === 100 && b2 >= 64 && b2 <= 127);
    if (приват) return `${h} — адрес внутренней сети. Внутренние системы через TI-браузер не забираются`;
  }
  if (h === '[::1]' || h === '::1') return 'это локальная машина, забирать нечего';
  return null;
}

const LINK_ATTRS = ['href', 'src', 'data-url', 'action'];

/* Что из атрибутов брать, а что выбрасывать.
 *
 * javascript: — это код, а не адрес. data: и blob: — встроенное содержимое:
 * у base64-картинки на мегабайт нет ни одного индикатора, зато есть
 * мегабайт мусора, в котором парсер найдёт «домены» из случайных букв.
 * Голый якорь #section адресом тоже не является.
 *
 * Функция вынесена отдельно и покрыта тестом: именно здесь решается,
 * что попадёт на вход парсеру индикаторов, и ошибка тут даёт либо шум,
 * либо потерю настоящего адреса. */
function isUsefulAttrValue(v) {
  return !!v && !/^\s*(javascript|data|blob|vbscript|about|#)/i.test(v);
}

/**
 * HTML -> текст. DOMParser строит дерево, но ничего не выполняет:
 * <script> не запускается, картинки и фреймы не грузятся.
 *
 * ЧТО ЗДЕСЬ НЕ ПОКРЫТО ТЕСТОМ И ПОЧЕМУ
 * ------------------------------------
 * Обход дерева проверяется только в живом Firefox: в Node нет DOMParser,
 * а подставлять чужую реализацию нельзя — у неё другое поведение
 * (например, нет innerText), и зелёный тест доказывал бы работу подставы,
 * а не нашего кода. Поэтому решения, в которых можно ошибиться, вынесены
 * в чистые функции рядом — isUsefulAttrValue и normalizeUrl, — и покрыты
 * тестами, а здесь остался тонкий слой склейки.
 */
/* Выбирает узел со статьёй. Если разметка семантическая — берём её,
 * иначе весь body: угадывать «самый большой блок текста» по эвристике
 * здесь не будем, цена ошибки — потерянная таблица индикаторов. */
function articleRoot(doc) {
  return doc.querySelector('article') || doc.querySelector('main') || doc.body;
}

/** Убирает обвязку: сначала по тегам, потом по именам классов и id. */
function stripChrome(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll(CHROME_TAGS).forEach((el) => el.remove());
  root.querySelectorAll('[class],[id],[role]').forEach((el) => {
    const mark = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (CHROME_PATTERN.test(mark) || ['navigation', 'banner', 'contentinfo'].includes(role)) {
      el.remove();
    }
  });
}

/**
 * HTML -> текст. DOMParser строит дерево, но ничего не выполняет:
 * <script> не запускается, картинки и фреймы не грузятся.
 *
 * ЧТО ЗДЕСЬ НЕ ПОКРЫТО ТЕСТОМ И ПОЧЕМУ
 * ------------------------------------
 * Обход дерева проверяется только в живом Firefox: в Node нет DOMParser,
 * а подставлять чужую реализацию нельзя — у неё другое поведение
 * (например, нет innerText), и зелёный тест доказывал бы работу подставы,
 * а не нашего кода. Поэтому решения, в которых можно ошибиться, вынесены
 * в чистые функции рядом — isUsefulAttrValue, normalizeUrl, CHROME_PATTERN, —
 * и покрыты тестами, а здесь остался тонкий слой склейки.
 */
function htmlToText(html) {
  const notes = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Содержимое этих тегов текстом не является. Убирается ДО извлечения:
  // иначе в выдачу попадут домены из кода аналитики и из CSS.
  doc.querySelectorAll(PAGE_DROP_TAGS).forEach((el) => el.remove());

  const title = (doc.title || '').trim();
  const root = articleRoot(doc);

  /* Страховка: вырезание обвязки не имеет права съесть статью.
   *
   * Правила вырезания работают по именам классов, а имена бывают любые —
   * в том числе сгенерированные сборщиком. Если после вырезания текста
   * почти не осталось, значит правило зацепило содержимое, и надёжнее
   * вернуть страницу целиком: лишний шум аналитик отфильтрует глазами,
   * пропавшую таблицу индикаторов он не восстановит никак.
   *
   * Порог 40%: обвязка редко составляет больше половины текста статьи. */
  const before = (root && root.textContent ? root.textContent : '').trim().length;
  stripChrome(root);
  const after = (root && root.textContent ? root.textContent : '').trim().length;
  if (before > 0 && after < before * 0.4) {
    // Дерево уже испорчено — разбираем заново и обвязку не трогаем.
    const doc2 = new DOMParser().parseFromString(html, 'text/html');
    doc2.querySelectorAll(PAGE_DROP_TAGS).forEach((el) => el.remove());
    notes.push('Вырезание обвязки убрало бы большую часть текста — '
             + 'отменено, страница разобрана целиком. В выдаче будет лишнее.');
    return textFrom(doc2, articleRoot(doc2), title, html, notes);
  }

  return textFrom(doc, root, title, html, notes);
}

/** Склейка текста из подготовленного дерева. */
function textFrom(doc, root, title, html, notes) {

  // Ссылки берём отдельно — индикатор часто живёт в href, а не в тексте, —
  // но ТОЛЬКО из статьи: в подвале их сотня и ни одной по делу.
  const hrefs = [];
  if (root && root.querySelectorAll) {
    root.querySelectorAll(LINK_ATTRS.map((a) => `[${a}]`).join(',')).forEach((el) => {
      for (const attr of LINK_ATTRS) {
        const v = el.getAttribute && el.getAttribute(attr);
        if (isUsefulAttrValue(v)) hrefs.push(v);
      }
    });
  }

  /* Перенос строки после каждого блочного элемента — до того, как
   * забирать текст. Иначе соседние блоки склеиваются вплотную
   * и порождают значения, которых на странице нет. */
  if (root && root.querySelectorAll) {
    root.querySelectorAll(BLOCK_TAGS).forEach((el) => {
      el.appendChild(doc.createTextNode('\n'));
    });
  }

  const body = (root ? root.textContent : '') || '';
  let text = [title, body, ...hrefs].join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  /* Страница отрисовывается скриптами — статьи в HTML нет.
   * Пробуем достать её из встроенного JSON; это разбор данных,
   * а не выполнение кода. */
  if (looksLikeShell(html, body)) {
    const fromJson = extractJsonText(html);
    if (fromJson.trim().length > body.trim().length) {
      text = [title, fromJson, ...hrefs].join('\n').replace(/\n{3,}/g, '\n\n');
      notes.push('В HTML страницы статьи не было — она отрисовывается скриптами. '
               + 'Текст восстановлен из встроенных данных страницы; '
               + 'он может быть неполным.');
    } else {
      /* Восстановить не удалось. Сказать об этом ОБЯЗАТЕЛЬНО:
       * «0 индикаторов» — это утверждение о странице, а мы её
       * не прочитали. Разные вещи, и путать их нельзя. */
      notes.push('Страница отрисовывается скриптами: в HTML пришла только '
               + 'оболочка без статьи. Разбирать нечего — это НЕ значит, '
               + 'что на странице нет индикаторов. Откройте её и нажмите '
               + 'кнопку TI на панели: разбор открытой страницы читает '
               + 'отрисованный текст.');
    }
  }

  return { title, text, notes };
}

/**
 * Забирает страницу и возвращает { url, title, text, bytes, contentType }.
 * Бросает Error с понятным текстом — он показывается аналитику как есть.
 */
async function fetchPageText(rawUrl) {
  const url = normalizeUrl(rawUrl);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      // Куки не отправляем: заходим как аноним, а не как аналитик
      // со своими сессиями. Иначе на чужой сайт уедет корпоративная
      // авторизация, если домены случайно совпадут.
      credentials: 'omit',
      // Реферер не отправляем: он выдаёт, откуда пришёл запрос.
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`не ответил за ${PAGE_TIMEOUT_MS / 1000} с`);
    // Сюда же попадает блокировка расширением uBlock и отсутствие сети.
    throw new Error('не удалось соединиться: ' + (e.message || e));
  }
  clearTimeout(timer);

  if (!resp.ok) throw new Error(`сервер ответил ${resp.status}`);

  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  if (/^(image|audio|video|application\/(zip|octet-stream|pdf))/.test(ctype)) {
    // PDF отдельной строкой: он встречается часто, и совет должен быть
    // конкретным, а не «неподдерживаемый тип».
    if (ctype.includes('pdf')) {
      throw new Error('это PDF. Скачайте файл и разберите через «Загрузить файл»');
    }
    throw new Error(`это ${ctype.split(';')[0]}, а не страница`);
  }

  const buf = await resp.arrayBuffer();
  if (buf.byteLength > PAGE_MAX_BYTES) {
    throw new Error(`страница больше ${PAGE_MAX_BYTES / 1024 / 1024} МБ — разберите вручную`);
  }

  // Кодировку берём из заголовка; без неё считаем UTF-8. Русские страницы
  // в windows-1251 ещё встречаются, и без учёта кодировки текст
  // превращается в мусор, а индикаторы в нём — теряются.
  let charset = (ctype.match(/charset=([\w-]+)/) || [])[1] || 'utf-8';
  let raw;
  try {
    raw = new TextDecoder(charset).decode(buf);
  } catch (_) {
    raw = new TextDecoder('utf-8').decode(buf);
  }
  // Если кодировка объявлена только в <meta>, перечитываем.
  const metaCs = (raw.slice(0, 2048).match(/charset=["']?([\w-]+)/i) || [])[1];
  if (metaCs && metaCs.toLowerCase() !== charset.toLowerCase()) {
    try { raw = new TextDecoder(metaCs).decode(buf); } catch (_) { /* оставляем как есть */ }
  }

  const isHtml = /html|xml/.test(ctype) || /^\s*<(!doctype|html)/i.test(raw);
  const { title, text, notes } = isHtml
    ? htmlToText(raw)
    : { title: '', text: raw, notes: [] };

  return {
    url: resp.url || url,
    title,
    text,
    notes: notes || [],
    bytes: buf.byteLength,
    contentType: ctype.split(';')[0] || 'неизвестно',
    redirected: resp.url && resp.url !== url,
  };
}

/* Имя намеренно уникально в пределах всех lib/*.js: файлы подключаются
 * обычными <script>, у них ОБЩАЯ глобальная область, и два `const API`
 * в разных файлах дают SyntaxError, который валит страницу целиком.
 * Уникальность проверяется в CI (job test:config). */
const FETCH_API = {
  internalHostReason, fetchRisks, looksLikeToken,
  fetchPageText, normalizeUrl, htmlToText, isUsefulAttrValue,
  ensurePermission, warmPermission,
  PAGE_MAX_BYTES, PAGE_TIMEOUT_MS, PAGE_DROP_TAGS, LINK_ATTRS,
  CHROME_TAGS, CHROME_PATTERN, BLOCK_TAGS,
  extractJsonText, looksLikeShell, MIN_ARTICLE_CHARS, SHELL_RATIO,
};
if (typeof module !== 'undefined' && module.exports) module.exports = FETCH_API;
if (typeof globalThis !== 'undefined') globalThis.TIFetch = FETCH_API;
