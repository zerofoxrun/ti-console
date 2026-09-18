/* =============================================================================
 * background.js — фоновый event page расширения
 * =============================================================================
 *
 * ЗОНА ОТВЕТСТВЕННОСТИ
 *   - контекстное меню на выделенном тексте;
 *   - кнопка на панели: разбор текущей страницы по требованию;
 *   - шина сообщений между content-script, боковой панелью и новой вкладкой;
 *   - единое хранилище кейса.
 *
 * ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ
 *   - сетевых вызовов к внешним TI-сервисам. Ключи API в расширении не живут:
 *     browser.storage.local доступен пользователю и любому коду в контексте
 *     расширения. Обогащение выполняет бэкенд.
 *
 * MV3 в Firefox: это event page (background.scripts), а не service worker.
 * Страница выгружается при простое, поэтому НИКАКОЕ состояние не хранится
 * в переменных модуля — только в browser.storage.
 * ========================================================================== */

'use strict';

const MENU_SCAN_SELECTION = 'ti-scan-selection';
const MENU_SCAN_PAGE      = 'ti-scan-page';
const MENU_LOOKUP         = 'ti-lookup';
const MENU_ARCHIVE        = 'ti-archive';
const MENU_FETCH_LINK     = 'ti-fetch-link';

/* --------------------------------------------------------- оформление ---
 * Тёмная схема для содержимого страниц.
 *
 * browserSettings.overrideContentColorScheme выставляет
 * layout.css.prefers-color-scheme.content-override — сайты начинают получать
 * prefers-color-scheme: dark. Тёмными станут те, кто это поддерживает;
 * остальные останутся как есть.
 *
 * Принудительная инверсия цветов сознательно НЕ применяется: она искажает
 * страницу, а её скриншот у нас идёт в отчёт как доказательство. Искажённое
 * доказательство хуже светлой страницы.
 *
 * Значение переопределяется политикой: 3rdparty -> contentColorScheme
 * (dark | light | auto). По умолчанию dark.
 * ---------------------------------------------------------------------- */
async function applyColorScheme() {
  let value = 'dark';
  try {
    const managed = await browser.storage.managed.get();
    if (managed && managed.contentColorScheme) value = managed.contentColorScheme;
  } catch (_) { /* политика не задана — остаётся dark */ }

  try {
    if (globalThis.TICompat && TICompat.нет('contentColorScheme')) {
      // В Chrome этой настройки нет. Косметика, интерфейс расширения
      // тёмный в любом случае — но молчать об отличии нельзя.
      console.info('тёмная схема содержимого страниц в этом браузере недоступна');
      return;
    }
    await browser.browserSettings.overrideContentColorScheme.set({ value });
  } catch (e) {
    // Настройка может быть уже занята другим дополнением или заблокирована.
    // Это не повод падать: интерфейс расширения тёмный в любом случае.
    console.warn('не удалось выставить схему содержимого:', e.message);
  }
}

/* ------------------------------------------------- контекстное меню -----
 *
 * МЕНЮ СОЗДАЁТСЯ ПРИ КАЖДОМ ВЫПОЛНЕНИИ ЭТОГО СКРИПТА, а не только
 * в onInstalled. Это исправление дефекта, а не перестраховка.
 *
 * Как выглядело: после перезапуска браузера пункты «TI: …» из правого
 * клика ПРОПАДАЛИ. Возвращались только после переустановки расширения —
 * то есть ровно тогда, когда снова срабатывал onInstalled. Пока сборку
 * обновляли часто, дефект был не виден: каждая новая версия его чинила
 * на один сеанс.
 *
 * Почему так. Это MV3 event page: фоновая страница выгружается при
 * простое и выполняется заново при следующем событии и при старте
 * браузера. onInstalled при этом НЕ срабатывает — он про установку
 * и обновление. Меню, созданное только там, живёт до первой выгрузки.
 *
 * removeAll() перед созданием обязателен: без него повторное
 * выполнение скрипта упало бы на дубликате идентификатора, и меню
 * осталось бы в том состоянии, в каком было.
 * ---------------------------------------------------------------------- */
function createMenus() {
  return browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: MENU_SCAN_SELECTION,
      title: 'TI: разобрать выделенное на IOC',
      contexts: ['selection'],
    });
    browser.contextMenus.create({
      id: MENU_LOOKUP,
      title: 'TI: проверить «%s» в инструментах',
      contexts: ['selection'],
    });
    browser.contextMenus.create({
      id: MENU_SCAN_PAGE,
      title: 'TI: разобрать всю страницу',
      contexts: ['page'],
    });

    /* Замена расширения Web Archives — без чужого кода в браузере:
     * это обычные вкладки. Какие источники и почему — у openArchives. */
    browser.contextMenus.create({
      id: MENU_ARCHIVE,
      title: 'TI: посмотреть в архивах (4 источника)',
      contexts: ['page', 'link'],
    });

    /* Замена расширений вида FoxyRecon/Sputnik для ссылок: не открывать
     * подозрительную ссылку, а ЗАБРАТЬ её содержимое в консоль и разобрать.
     * Открытая страница выполняется, забранная — нет. */
    browser.contextMenus.create({
      id: MENU_FETCH_LINK,
      title: 'TI: забрать ссылку в консоль, не открывая',
      contexts: ['link'],
    });
  }).catch((e) => {
    // Без меню расширение остаётся рабочим (кнопка на панели, панель,
    // консоль), поэтому не падаем. Но и не молчим.
    console.warn('не удалось создать контекстное меню:', e && e.message);
  });
}

/* Вызов на верхнем уровне — это и есть исправление: он отрабатывает
 * при каждом выполнении фоновой страницы, в том числе после её выгрузки
 * и при старте браузера. Проверяется в CI и в background.test.js. */
createMenus();

browser.runtime.onStartup.addListener(() => {
  applyColorScheme();
  createMenus();
});

/* ------------------------------------------------------------- установка */
browser.runtime.onInstalled.addListener(() => {
  applyColorScheme();
  createMenus();
});

/* --------------------------------------------------------- обработчики -- */
/* Слушатель НЕ async намеренно.
 *
 * sidebarAction.open() Firefox разрешает только внутри пользовательского
 * жеста, и первый же await этот жест теряет: вызов после await молча
 * отклоняется. Раньше открытие панели стояло в конце цепочки await'ов —
 * то есть не работало никогда.
 *
 * Поэтому: панель открывается ПЕРВЫМ действием, разбор запускается
 * следом и уже асинхронно. */
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SCAN_SELECTION) {
    // Разбор выделенного открывает консоль — как и разбор страницы.
    handleText(info.selectionText || '', tab, 'выделение', { openConsole: true });
  } else if (info.menuItemId === MENU_SCAN_PAGE) {
    scanTab(tab);
  } else if (info.menuItemId === MENU_LOOKUP) {
    TICompat.открытьПанель(tab && tab.id).catch(() => {});   // до await, пока есть жест
    handleText(info.selectionText || '', tab, 'выделение', { openConsole: false });
  } else if (info.menuItemId === MENU_ARCHIVE) {
    openArchives(info.linkUrl || info.pageUrl || tab?.url || '');
  } else if (info.menuItemId === MENU_FETCH_LINK) {
    openConsoleWithUrl(info.linkUrl || '');
  }
});

// Клик по кнопке на панели = разбор текущей страницы.
// activeTab даёт право на инъекцию именно в этот момент и именно в эту вкладку.
browser.action.onClicked.addListener((tab) => scanTab(tab));

/* --------------------------------------------------------------- логика */

/**
 * Инъекция парсера в активную вкладку.
 * Используется scripting.executeScript, а не постоянный content-script:
 * расширение не читает страницы, пока аналитик его об этом не попросил.
 */
/* Домены, которые НЕ разбираем, даже по явной команде.
 *
 * У Aperture есть отключение подсветки по доменам, и в их модели это
 * удобство: детект там работает автоматически на каждой странице.
 * У нас он не работает автоматически нигде — парсер внедряется только
 * по кнопке, — поэтому прямой перенос этой функции бессмысленен.
 *
 * Что действительно нужно на её месте: ЗАПРЕТ разбора внутренних
 * систем. Kibana, трекер задач, вики — это страницы с данными клиентов.
 * Разобрав их «на индикаторы», аналитик переносит клиентские данные
 * в кейс, а оттуда они попадают в экспорт и в отчёт. Один неверный
 * клик по кнопке на вкладке с Kibana — и TLP-разграничение, вокруг
 * которого построена вся система, обойдено изнутри.
 *
 * Список приезжает политикой (scanDenylist), умолчание — внутренние
 * зоны. Шаблон: подстрока имени хоста, без регистра.
 */
const DEFAULT_SCAN_DENY = ['.internal', '.local', '.corp', 'localhost'];

/* Локальные исключения аналитика.
 *
 * ПРАВИЛО, КОТОРОЕ НЕЛЬЗЯ НАРУШИТЬ: локальный список только ДОБАВЛЯЕТ
 * запреты. Убрать из него то, что запрещено политикой, нельзя —
 * иначе аналитик одним кликом снимал бы барьер, поставленный SOC,
 * и запрет разбора внутренних систем перестал бы быть гарантией.
 *
 * Зачем он вообще: список политики меняется только новой сборкой,
 * а «не сканируй вот эту вики» нужно прямо сейчас. Добавление
 * запрета — безопасная операция по определению: хуже от лишнего
 * запрета не станет никому, кроме самого аналитика.
 */
const LOCAL_DENY_KEY = 'ti_scan_deny_local';

async function scanDenyLists() {
  let policy = DEFAULT_SCAN_DENY;
  try {
    const m = await browser.storage.managed.get();
    if (Array.isArray(m?.scanDenylist)) policy = m.scanDenylist;
  } catch (_) { /* политика не задана — остаётся умолчание */ }

  let local = [];
  try {
    const st = await browser.storage.local.get(LOCAL_DENY_KEY);
    if (Array.isArray(st[LOCAL_DENY_KEY])) local = st[LOCAL_DENY_KEY];
  } catch (_) { /* нет локального списка */ }

  return { policy, local };
}

async function scanDenied(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return null; }
  const { policy, local } = await scanDenyLists();
  // Объединение, а не замена: политика поверх локального списка.
  const all = [...policy, ...local];
  return all.find((p) => host.includes(String(p).toLowerCase())) || null;
}

/** Добавить хост в локальный список. Политику не трогает. */
async function addLocalDeny(host) {
  const clean = String(host || '').trim().toLowerCase();
  if (!clean) return { ok: false, error: 'пустое имя хоста' };
  const { policy, local } = await scanDenyLists();
  if ([...policy, ...local].some((p) => clean.includes(String(p).toLowerCase()))) {
    return { ok: false, error: 'уже запрещён', already: true };
  }
  const next = [...local, clean].slice(-200);
  await browser.storage.local.set({ [LOCAL_DENY_KEY]: next });
  return { ok: true, local: next };
}

/** Убрать хост ИЗ ЛОКАЛЬНОГО списка. Записи политики недоступны. */
async function removeLocalDeny(host) {
  const clean = String(host || '').trim().toLowerCase();
  const { local } = await scanDenyLists();
  const next = local.filter((p) => p !== clean);
  await browser.storage.local.set({ [LOCAL_DENY_KEY]: next });
  return { ok: true, local: next };
}

async function scanTab(tab) {
  if (!tab || !tab.id) return;
  if (/^(about|moz-extension|resource|chrome):/i.test(tab.url || '')) {
    return notify('Служебная страница — разбор недоступен');
  }
  const denied = await scanDenied(tab.url || '');
  if (denied) {
    return notify(
      `Разбор запрещён: «${denied}» — внутренняя система. Извлечённые отсюда `
      + 'индикаторы попали бы в кейс, экспорт и отчёт как публичные данные.');
  }
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['lib/ioc.js', 'content/scan.js'],
    });

    /* Результат инъекции ПРОВЕРЯЕТСЯ, а не игнорируется.
     *
     * executeScript может выполниться «успешно» и вернуть ошибку внутри
     * результата — например, если внедрённый скрипт бросил исключение.
     * Раньше этот массив никто не смотрел, и такая ошибка означала
     * молчание: подсветки нет, консоль не открылась, в интерфейсе
     * ни слова. Именно так выглядел дефект с повторной инъекцией. */
    const failed = (results || []).filter((r) => r && r.error);
    if (failed.length) {
      notify('Разбор страницы не выполнился: '
        + failed.map((r) => (r.error && r.error.message) || String(r.error)).join('; '));
    }
    // При успехе scan.js сам отправит результат сообщением 'page-iocs'.
  } catch (e) {
    notify('Не удалось прочитать страницу: ' + (e && e.message));
  }
}

/**
 * Разбор произвольного текста (выделения) в фоновом скрипте.
 *
 * openConsole решает, куда уходит результат:
 *   true  — открыть консоль с выдачей. Так работает «разобрать
 *           выделенное»: аналитик просил разбор, ему нужен список
 *           с карточками, инструментами и кнопкой «в кейс»;
 *   false — оставить в боковой панели рядом со страницей. Так работает
 *           «проверить в инструментах»: это быстрая проверка одного
 *           значения, и уводить человека с отчёта ради неё не надо.
 *
 * До 0.24.0 оба пункта меню вызывали одно и то же, то есть отличались
 * только названием.
 */
async function handleText(text, tab, source, { openConsole = true } = {}) {
  if (!globalThis.IOC) {
    // Сюда попасть нельзя: ioc.js объявлен в background.scripts.
    // Но если объявление уберут, дефект обязан быть слышным, а не
    // выглядеть как «пункт меню ничего не делает».
    return notify('Модуль разбора не загружен — сообщите в SOC, это ошибка сборки');
  }
  const iocs = IOC.extractIocs(text);
  await stashResult(iocs, tab?.url, source, { openConsole });
}

/* Открыть страницу в архивах. Замена расширения Web Archives.
 *
 * Список сверен с wiki проекта dessant/web-archives: там восемь
 * источников. Взяты не все, а те, что отвечают на разные вопросы:
 *
 *   Wayback           — основной архив, уважает robots.txt и запросы
 *                       на удаление, поэтому панель после жалобы
 *                       из него исчезает;
 *   archive.today      — не уважает, и то же самое там остаётся;
 *   Ghostarchive       — берёт видео и Twitter/X, которые Wayback
 *                       архивирует плохо или не архивирует вовсе;
 *   Software Heritage  — архив ИСХОДНОГО КОДА: удалённый с GitHub
 *                       репозиторий с вредоносным пакетом остаётся там.
 *
 * Не взяты: Google Cache (убран Google в 2024), WebCite (не принимает
 * новые архивы), Megalodon (узкая японская ниша), Perma.cc (требует
 * учётной записи и лимитирован — это фиксация доказательства,
 * а не «посмотреть», и такой пункт меню вводил бы в заблуждение).
 */
async function openArchives(url) {
  if (!url || !/^https?:/i.test(url)) return notify('Архивы открываются только для http(s)');
  const host = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
  const targets = [
    'https://web.archive.org/web/*/' + url,
    'https://archive.ph/newest/' + url,
    'https://ghostarchive.org/search?term=' + encodeURIComponent(url),
    // Software Heritage ищет по происхождению, то есть по адресу
    // репозитория, — отсюда поиск по хосту, а не по полному URL.
    'https://archive.softwareheritage.org/browse/search/?q='
      + encodeURIComponent(host || url) + '&with_visit=true&with_content=true',
  ];
  for (const t of targets) {
    // Пауза между вкладками: без неё Firefox схлопывает их в одну
    // при быстром открытии подряд. Тот же приём, что в openSelectedIn.
    await browser.tabs.create({ url: t, active: false });
    await new Promise((r) => setTimeout(r, 120));
  }
}

/**
 * Подставить ссылку в поле «забрать по ссылке» новой вкладки консоли.
 *
 * Открывается НАША страница с подставленной ссылкой, а не сама ссылка.
 * Разница принципиальная: подозрительная страница так и не выполняется
 * в браузере аналитика, её содержимое приезжает текстом. Забор всё равно
 * начинается только по кнопке — решение уходить ли запросом на чужую
 * инфраструктуру остаётся за аналитиком.
 */
async function openConsoleWithUrl(url) {
  if (!url) return;
  const target = browser.runtime.getURL('newtab/newtab.html')
               + '?fetch=' + encodeURIComponent(url);
  await browser.tabs.create({ url: target, active: true });
}

/* ЗДЕСЬ БЫЛА ЗАГРУЗКА ioc.js ЧЕРЕЗ new Function(). ОНА НЕ РАБОТАЛА.
 *
 * Код был такой:
 *   const src = await (await fetch(getURL('lib/ioc.js'))).text();
 *   new Function(src)();
 *
 * И он падал ВСЕГДА, на первом же вызове: конструктор Function — это
 * eval, а CSP расширения запрещает eval на страницах расширения,
 * включая фоновую. В MV3 это не настраивается: «Manifest V3 does not
 * allow 'unsafe-eval' in script-src» (MDN, content_security_policy).
 *
 * Как выглядел дефект снаружи: пункт меню «разобрать выделенное на IOC»
 * не делал НИЧЕГО. Ни консоли, ни панели, ни цифры на значке. Ошибка
 * оставалась в консоли фоновой страницы, которую никто не открывает.
 *
 * Почему разбор всей страницы при этом работал: там ioc.js внедряется
 * в саму страницу через scripting.executeScript, и фоновому скрипту
 * разбирать ничего не надо — он получает готовый результат сообщением.
 * То есть сломан был ровно один путь из двух, и тот, что реже.
 *
 * Правильное решение — объявить ioc.js в manifest.background.scripts.
 * Firefox грузит их по порядку в один контекст, IOC оказывается
 * определён до первого клика, никакого eval. Проверяется в CI:
 * и наличие ioc.js в background.scripts, и отсутствие eval в коде.
 *
 * Отдельно стоит записать: addons-linter про этот eval предупреждал
 * (DANGEROUS_EVAL), и предупреждение считали шумом. Оно было дефектом. */

/**
 * Результат разбора кладётся в storage под ключ последней сессии,
 * панель и новая вкладка читают его оттуда. Прямой messaging ненадёжен:
 * панель может быть закрыта в момент разбора.
 */
async function stashResult(iocs, pageUrl, source, { openConsole = true } = {}) {
  await browser.storage.local.set({
    ti_last_scan: {
      at: new Date().toISOString(),
      pageUrl: pageUrl || null,
      source: source || 'страница',
      iocs,
    },
  });
  browser.runtime.sendMessage({ cmd: 'iocs-scanned', count: iocs.length }).catch(() => {});
  await setBadge(iocs.length);
  if (openConsole) await showConsoleWithScan(iocs.length);
}

/* Открыть консоль с результатом разбора страницы.
 *
 * ЗАЧЕМ. Раньше разбор открытой страницы заканчивался подсветкой
 * и цифрой на значке. Дальше аналитик должен был сам сообразить открыть
 * боковую панель — и, если она закрыта, результата он не видел вовсе:
 * выглядело так, будто кнопка просто подсветила текст и ничего больше.
 *
 * Теперь результат открывается там же, где идёт вся остальная работа:
 * в консоли, с карточками, инструментами, плейбуками и кнопкой
 * «в кейс». Разбор страницы перестаёт быть тупиком.
 *
 * СУЩЕСТВУЮЩАЯ ВКЛАДКА ПЕРЕИСПОЛЬЗУЕТСЯ. Плодить по вкладке на каждое
 * нажатие — это ровно тот сценарий «сто вкладок», ради ухода от которого
 * весь проект и затевался.
 */
async function showConsoleWithScan(count) {
  const url = browser.runtime.getURL('newtab/newtab.html');
  try {
    const open = await browser.tabs.query({ url: url + '*' });
    if (open.length) {
      // Уже открыта — поднимаем её и говорим обновиться.
      await browser.tabs.update(open[0].id, { active: true, url: url + '?scan=1' });
      await browser.windows.update(open[0].windowId, { focused: true }).catch(() => {});
    } else {
      await browser.tabs.create({ url: url + '?scan=1', active: true });
    }
  } catch (e) {
    // Не открылось — не беда: результат лежит в storage, боковая панель
    // и значок работают как раньше. Молча ломать разбор из-за вкладки
    // нельзя.
    console.warn('не удалось открыть консоль:', e.message);
  }
}

async function setBadge(n) {
  try {
    await browser.action.setBadgeText({ text: n ? String(n) : '' });
    await browser.action.setBadgeBackgroundColor({ color: n ? '#1f6feb' : null });
  } catch (_) { /* API может быть недоступен в старых сборках */ }
}

/* Сообщение аналитику.
 *
 * ДВА КАНАЛА, И ВТОРОЙ ПОЯВИЛСЯ НЕ ОТ ХОРОШЕЙ ЖИЗНИ. Тост в консоли
 * виден только тому, кто на консоль смотрит. А в момент «разобрать всю
 * страницу» человек смотрит на разбираемую страницу — то есть на другую
 * вкладку. Любой отказ (внутренняя система, ошибка инъекции) выглядел
 * при этом как «нажал и ничего не произошло»: сообщение честно
 * отправлялось в пустоту.
 *
 * Системное уведомление видно поверх любой вкладки. Разрешение
 * notifications не даёт доступа ни к страницам, ни к данным — это
 * дешёвая цена за то, чтобы отказ нельзя было пропустить. */
function notify(message) {
  browser.runtime.sendMessage({ cmd: 'notify', message }).catch(() => {});
  try {
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: 'TI Console',
      message: String(message).slice(0, 300),
    }).catch(() => {});
  } catch (_) {
    // API может быть недоступен — тогда остаётся тост в консоли.
  }
}

/* ------------------------------------------------- приём от content-script */
browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg?.cmd === 'page-iocs') {
    /* Панель здесь НЕ открывается: сообщение приходит из content-script,
     * жеста уже нет, и вызов всё равно был бы отклонён. Результат
     * открывается в консоли (showConsoleWithScan внутри stashResult),
     * а панель аналитик открывает сам, когда она ему нужна. */
    await stashResult(msg.iocs || [], sender?.tab?.url, 'страница');
    return { ok: true };
  }
  /* Разбор страницы по кнопке из попапа. Попап закрывается раньше, чем
   * разбор закончится, поэтому работу делает фоновый скрипт, а не он. */
  if (msg?.cmd === 'scan-active-tab') {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) scanTab(tab);
    return { ok: !!tab };
  }
  if (msg?.cmd === 'get-last-scan') {
    const { ti_last_scan } = await browser.storage.local.get('ti_last_scan');
    return ti_last_scan || null;
  }
  if (msg?.cmd === 'deny-list') {
    return scanDenyLists();
  }
  if (msg?.cmd === 'deny-add') {
    return addLocalDeny(msg.host);
  }
  if (msg?.cmd === 'deny-remove') {
    return removeLocalDeny(msg.host);
  }
  if (msg?.cmd === 'clear-badge') {
    await setBadge(0);
    return { ok: true };
  }
  return undefined;
});
