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
 *     расширения. Поэтому расширение ОТКРЫВАЕТ сервис в браузере,
 *     а не обращается к нему за человека.
 *
 * MV3 в Firefox: это event page (background.scripts), а не service worker.
 * Страница выгружается при простое, поэтому НИКАКОЕ состояние не хранится
 * в переменных модуля — только в browser.storage.
 * ========================================================================== */

/* ПОДСТРАХОВКА ЛОКАЛИЗАЦИИ.
 * T объявлен в lib/i18n.js и загружается перед этим файлом (manifest ->
 * background.scripts). Если его нет — урезанная сборка или тест, который
 * поднимает один background.js, — строки показываются как есть, по-русски.
 * Без этой заглушки отсутствие словаря превращалось бы в ReferenceError
 * в фоновом скрипте, то есть в молчание всего расширения. */
if (typeof T !== 'function') {
  globalThis.T = function (первый) {
    var арги = Array.prototype.slice.call(arguments, 1);
    if (первый && первый.raw) {
      return первый.raw.reduce(function (с, ч, i) {
        return с + ч + (i < арги.length ? String(арги[i]) : '');
      }, '');
    }
    return String(первый).replace(/\{(\d+)\}/g, function (всё, н) {
      return арги[+н] === undefined ? всё : String(арги[+н]);
    });
  };
}

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
      console.info(T('тёмная схема содержимого страниц в этом браузере недоступна'));
      return;
    }
    await browser.browserSettings.overrideContentColorScheme.set({ value });
  } catch (e) {
    // Настройка может быть уже занята другим дополнением или заблокирована.
    // Это не повод падать: интерфейс расширения тёмный в любом случае.
    console.warn(T('не удалось выставить схему содержимого:'), e.message);
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
      title: T('TI: разобрать выделенное на IOC'),
      contexts: ['selection'],
    });
    browser.contextMenus.create({
      id: MENU_LOOKUP,
      title: T('TI: проверить «%s» в инструментах'),
      contexts: ['selection'],
    });
    browser.contextMenus.create({
      id: MENU_SCAN_PAGE,
      title: T('TI: разобрать всю страницу'),
      contexts: ['page'],
    });

    /* Замена расширения Web Archives — без чужого кода в браузере:
     * это обычные вкладки. Какие источники и почему — у openArchives. */
    browser.contextMenus.create({
      id: MENU_ARCHIVE,
      title: T('TI: посмотреть в архивах (4 источника)'),
      contexts: ['page', 'link'],
    });

    /* Замена расширений вида FoxyRecon/Sputnik для ссылок: не открывать
     * подозрительную ссылку, а ЗАБРАТЬ её содержимое в консоль и разобрать.
     * Открытая страница выполняется, забранная — нет. */
    browser.contextMenus.create({
      id: MENU_FETCH_LINK,
      title: T('TI: забрать ссылку в консоль, не открывая'),
      contexts: ['link'],
    });
  }).catch((e) => {
    // Без меню расширение остаётся рабочим (кнопка на панели, панель,
    // консоль), поэтому не падаем. Но и не молчим.
    console.warn(T('не удалось создать контекстное меню:'), e && e.message);
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

/* ------------------------------------------------- горячие клавиши ------
 *
 * Три команды из манифеста. Обработчик один и тот же, что у кнопки
 * и у контекстного меню, и это не экономия строк: три входа, у каждого
 * своя копия логики, расходятся молча, а человек видит это как
 * «с клавиатуры работает иначе, чем мышкой».
 *
 * Слушатель НЕ async — по той же причине, что и у контекстного меню:
 * открытие боковой панели Firefox разрешает только внутри жеста,
 * а первый await жест теряет.
 *
 * Если browser.commands нет (старый Firefox, урезанная сборка),
 * молчим: остальное расширение работает, и валить фон из-за клавиш
 * нельзя. Но и делать вид, что всё в порядке, тоже нельзя — поэтому
 * предупреждение в консоль фона.
 * ---------------------------------------------------------------------- */
/* Наличие API проверяется НАПРЯМУЮ, а не через TICompat.есть('commands').
 *
 * Причина — порядок загрузки. Этот код выполняется на верхнем уровне
 * фона, и обращение к TICompat здесь делает загрузку всего фона
 * зависимой от того, что compat.js уже отработал. Внутри функций так
 * можно: к моменту вызова загружено всё. На верхнем уровне — нельзя.
 *
 * Это не гипотеза: первая версия писала `TICompat.есть('commands')`,
 * и background.test.js, который грузит фон в одиночку (без compat.js,
 * чтобы проверить именно его), упал с ReferenceError — то есть
 * расширение осталось бы вообще без фона, если бы compat.js однажды
 * убрали из background.scripts. Отсутствие горячих клавиш — мелочь,
 * отсутствие фона — нет. */
if (globalThis.browser && browser.commands && browser.commands.onCommand) {
  browser.commands.onCommand.addListener((команда) => {
    выполнитьКоманду(команда).catch((e) => {
      notify(T('Команда «') + команда + T('» не выполнилась: ') + (e && e.message));
    });
  });
} else {
  console.warn(T('browser.commands недоступен — горячие клавиши выключены'));
}

async function выполнитьКоманду(команда) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (команда === 'open-console') {
    // Не требует вкладки вовсе: консоль открывается всегда.
    return browser.tabs.create({ url: browser.runtime.getURL('newtab/newtab.html') });
  }
  if (!tab || !tab.id) return notify(T('Нет активной вкладки'));

  if (команда === 'parse-page') return scanTab(tab);

  if (команда === 'parse-selection') {
    /* Выделение приходится ЧИТАТЬ со страницы.
     *
     * У контекстного меню выделенный текст лежит в info.selectionText —
     * его даёт сам браузер. У горячей клавиши такого поля нет, и это
     * единственная причина, по которой здесь инъекция: прочитать
     * window.getSelection(). Право на неё даёт activeTab, выданный
     * на само нажатие клавиши.
     *
     * Запрет разбора внутренних систем проверяется ДО чтения, а не
     * после: иначе мы бы прочитали текст внутренней системы и только
     * потом решили, что читать его было нельзя. */
    if (/^(about|moz-extension|chrome|resource):/i.test(tab.url || '')) {
      return notify(T('Служебная страница — разбор недоступен'));
    }
    const запрещено = await scanDenied(tab.url || '');
    if (запрещено) {
      return notify(T`Разбор запрещён: «${запрещено}» — внутренняя система.`);
    }
    const res = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(window.getSelection() || ''),
    });
    const текст = (res && res[0] && res[0].result) || '';
    if (!текст.trim()) {
      return notify(T('Ничего не выделено — выделите текст и нажмите ещё раз'));
    }
    return handleText(текст, tab, 'выделение', { openConsole: true });
  }

  notify(T('Неизвестная команда: ') + команда);
}

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
 * систем. Внутренние журналы, трекер задач, вики — это страницы с данными клиентов.
 * Разобрав их «на индикаторы», аналитик переносит клиентские данные
 * в кейс, а оттуда они попадают в экспорт и в отчёт. Один неверный
 * клик по кнопке на вкладке внутренней системы — и TLP-разграничение, вокруг
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
 * а «не сканируй вот этот внутренний портал» нужно прямо сейчас. Добавление
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
  if (!clean) return { ok: false, error: T('пустое имя хоста') };
  const { policy, local } = await scanDenyLists();
  if ([...policy, ...local].some((p) => clean.includes(String(p).toLowerCase()))) {
    return { ok: false, error: T('уже запрещён'), already: true };
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
    return notify(T('Служебная страница — разбор недоступен'));
  }
  const denied = await scanDenied(tab.url || '');
  if (denied) {
    return notify(
      T`Разбор запрещён: «${denied}» — внутренняя система. Извлечённые отсюда `
      + T('индикаторы попали бы в кейс, экспорт и отчёт как публичные данные.'));
  }
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      /* Порядок важен: scan.js подсвечивает и выставляет
       * __tiConsoleClearHighlights, card.js его оборачивает, чтобы
       * снятие подсветки убирало и карточку. */
      files: ['locales/en.js', 'lib/i18n.js', 'lib/ioc.js', 'content/scan.js', 'content/card.js'],
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
      notify(T('Разбор страницы не выполнился: ')
        + failed.map((r) => (r.error && r.error.message) || String(r.error)).join('; '));
    }
    // При успехе scan.js сам отправит результат сообщением 'page-iocs'.
  } catch (e) {
    notify(T('Не удалось прочитать страницу: ') + (e && e.message));
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
    return notify(T('Модуль разбора не загружен — сообщите в SOC, это ошибка сборки'));
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
  if (!url || !/^https?:/i.test(url)) return notify(T('Архивы открываются только для http(s)'));
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
/* Разбор следующей страницы едет сразу в кейс.
 *
 * Флаг одноразовый и живёт между «нажал кнопку» и «пришёл результат».
 * Он НЕ сохраняется: переживший перезапуск фона флаг означал бы, что
 * следующая случайно разобранная страница молча попадёт в кейс.
 * В Chrome фон выгружается сам по себе, и это как раз тот случай,
 * когда потеря состояния — правильное поведение, а не дефект. */
let вКейс = false;

async function stashResult(iocs, pageUrl, source, { openConsole = true } = {}, вКейсЭтот = false) {
  await browser.storage.local.set({
    ti_last_scan: {
      at: new Date().toISOString(),
      pageUrl: pageUrl || null,
      source: source || T('страница'),
      вКейс: вКейсЭтот === true,
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
    console.warn(T('не удалось открыть консоль:'), e.message);
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

/* ========================== СБОР С ПОМЕЧЕННОЙ ВКЛАДКИ (0.58.0) ==========
 *
 * Аналитик нажимает «Собирать с этой вкладки». Дальше каждая страница,
 * открытая В ЭТОЙ вкладке и на ТОМ ЖЕ сайте, разбирается сама, а
 * найденное копится в очереди триажа.
 *
 * ГРАНИЦА ПРОХОДИТ ПО ВКЛАДКЕ, И ЭТО НЕ СМЯГЧЕНИЕ SESSION CAPTURE.
 * У Aperture сбор идёт со всех открываемых страниц, потому что
 * постоянный content-script там и так стоит везде. Здесь кода нет
 * нигде, пока не нажали, и разрешение спрашивается на КОНКРЕТНЫЙ сайт.
 * Почта, SIEM и порталы клиентов в других вкладках не трогаются.
 *
 * В ОЧЕРЕДЬ, А НЕ В КЕЙС. Кейс — утверждение о расследовании: что в нём
 * лежит, то уедет в отчёт и в выгрузку. Автоматически ссыпать туда всё
 * найденное значит сделать его свалкой из баннеров и cdn с попутных
 * страниц.
 *
 * ЗАПРЕТЫ ДЕЙСТВУЮТ ВСЕ. Стоп-лист внутренних систем проверяется
 * на КАЖДОЙ странице сеанса, а не один раз при запуске: вкладка
 * за два часа успевает уйти куда угодно.
 *
 * Правила окончания сеанса — в lib/capture.js, там же они и проверяются.
 */
let СЕАНС = null;                 // текущий сеанс сбора или null

async function прочитатьСеанс() {
  if (СЕАНС) return СЕАНС;
  const o = await browser.storage.local.get(TICapture.КЛЮЧ);
  СЕАНС = o[TICapture.КЛЮЧ] || null;
  /* Сеанс мог пережить перезапуск браузера в хранилище. Продолжать
   * его нельзя: идентификаторы вкладок после перезапуска чужие,
   * и «та же вкладка» — это уже другая страница. */
  if (СЕАНС) {
    const вкладки = await browser.tabs.query({});
    if (!TICapture.живой(СЕАНС, вкладки.map((t) => t.id))) {
      СЕАНС = null;
      await browser.storage.local.remove(TICapture.КЛЮЧ);
    }
  }
  return СЕАНС;
}

async function записатьСеанс(с) {
  СЕАНС = с;
  if (с) await browser.storage.local.set({ [TICapture.КЛЮЧ]: с });
  else await browser.storage.local.remove(TICapture.КЛЮЧ);
  /* Открытая консоль показывает состояние сбора; без сигнала она
   * сообщала бы, что сбор идёт, ещё час после его окончания. */
  browser.runtime.sendMessage({ cmd: 'capture-changed', сеанс: с }).catch(() => {});
}

async function начатьСбор(tab) {
  if (!tab || !tab.id) return { ok: false, error: T('нет вкладки') };
  if (/^(about|chrome|moz-extension|resource|view-source|file):/i.test(tab.url || '')) {
    return { ok: false, error: T('служебная страница') };
  }
  const запрещено = await scanDenied(tab.url || '');
  if (запрещено) {
    return { ok: false, error: T`«${запрещено}» — внутренняя система, сбор запрещён` };
  }
  const с = TICapture.начать(tab.id, tab.url);
  if (!с.источник) return { ok: false, error: T('адрес вкладки не разобран') };
  await записатьСеанс(с);
  await пометитьЗначок(с);
  notify(T`Сбор включён: ${с.источник}. Собираю только с этой вкладки и только `
       + T`с этого сайта. Найденное уходит в очередь триажа.`);
  return { ok: true, сеанс: с };
}

async function остановитьСбор(причина) {
  const с = await прочитатьСеанс();
  if (!с) return { ok: false, error: T('сбор не идёт') };
  await записатьСеанс(null);
  await setBadge(0);
  notify(TICapture.итог(с, причина));
  return { ok: true, итог: TICapture.итог(с, причина) };
}

/* Значок показывает, что сбор ИДЁТ. Молчаливый сбор — это расширение,
 * которое читает страницы, а человек об этом не помнит. */
async function пометитьЗначок(с) {
  try {
    await browser.action.setBadgeText({ text: с ? '●' : '' });
    await browser.action.setBadgeBackgroundColor({ color: '#d97706' });
  } catch (_) { /* API может быть недоступен */ }
}

/**
 * Страница в помеченной вкладке догрузилась — разобрать её.
 *
 * Слушается tabs.onUpdated, а не webNavigation: последний требует
 * отдельного разрешения, которое в Chrome показывается как «Чтение
 * истории просмотров». Платить этим за ту же информацию незачем.
 */
async function страницаВСеансе(tabId, url) {
  const с = await прочитатьСеанс();
  if (!с) return;
  /* ЗАПРЕТ ПРОВЕРЯЕТСЯ ПЕРВЫМ, до правил сеанса.
   *
   * Порядок здесь не косметика. Среди правил сеанса есть защита от
   * каскада перерисовок: страница, пришедшая раньше чем через 800 мс
   * после предыдущей, пропускается. Стояла бы проверка запрета после
   * неё — добавленный посреди сеанса запрет не сработал бы на таких
   * страницах, и сбор продолжался бы на хосте, который аналитик
   * только что запретил. Поймано проверкой в background.test.js.
   *
   * Список сверяется НА КАЖДОЙ странице, а не при запуске: сеанс
   * держится двух часов, и запрет, вступающий в силу со следующего
   * сеанса, — это запрет, который не работает. */
  const запрещено = await scanDenied(url);
  if (запрещено) { await остановитьСбор(T`страница «${запрещено}» — внутренняя система`); return; }

  const реш = TICapture.проверитьСтраницу(с, tabId, url);
  if (реш.стоп) { await остановитьСбор(реш.причина); return; }
  if (!реш.годится) return;

  let текст = '';
  try {
    const res = await browser.scripting.executeScript({
      target: { tabId },
      func: () => (document.body ? document.body.innerText : '').slice(0, 300000),
    });
    текст = (res && res[0] && res[0].result) || '';
  } catch (e) {
    /* Чаще всего это отозванное разрешение на сайт. Сбор прекращается
     * и об этом говорится: тихо продолжать «вхолостую» нельзя. */
    await остановитьСбор(T('нет доступа к странице: ') + ((e && e.message) || e));
    return;
  }
  if (!текст.trim()) return;

  const iocs = globalThis.IOC ? IOC.extractIocs(текст, { withContext: false }) : [];
  let добавлено = 0;
  if (iocs.length && globalThis.TITriage) {
    const raw = (await browser.storage.local.get(TITriage.STORE_KEY))[TITriage.STORE_KEY];
    const r = TITriage.addMany(raw, iocs, { source: url });
    await browser.storage.local.set({ [TITriage.STORE_KEY]: r.store });
    добавлено = r.added;
    browser.runtime.sendMessage({ cmd: 'triage-changed' }).catch(() => {});
  }
  await записатьСеанс(TICapture.учесть(с, url, iocs.length, добавлено));
  await пометитьЗначок(true);
}

if (globalThis.browser && browser.tabs && browser.tabs.onUpdated) {
  browser.tabs.onUpdated.addListener((tabId, изм, tab) => {
    if (изм.status !== 'complete') return;
    страницаВСеансе(tabId, (tab && tab.url) || '').catch((e) => {
      console.warn(T('сбор: ') + ((e && e.message) || e));
    });
  });
}
if (globalThis.browser && browser.tabs && browser.tabs.onRemoved) {
  browser.tabs.onRemoved.addListener(async (tabId) => {
    const с = await прочитатьСеанс();
    if (с && Number(tabId) === с.tabId) await остановитьСбор(TICapture.ПРИЧИНЫ.вкладка);
  });
}

/* ==================================== КАРТОЧКА ИНДИКАТОРА НА СТРАНИЦЕ ====
 *
 * Карточка (content/card.js) сама НИЧЕГО не решает: она спрашивает фон,
 * что можно сделать со значением, и рисует ответ. Решение принимает
 * lib/pivot.js — тот же модуль, которым пользуется консоль.
 *
 * ПОЧЕМУ НЕ В САМОЙ КАРТОЧКЕ. Гейт (режим клиентских данных, свои
 * и клиентские диапазоны, платные сервисы) в двух копиях разойдётся,
 * и разойдётся молча: карточка на чужой странице покажет публичный
 * сервис там, где консоль его закрыла. Цена расхождения — адрес
 * заказчика в VirusTotal, отправленный одним кликом человеком,
 * который был уверен, что расширение это запрещает.
 *
 * Реестр читается один раз и держится в памяти фона. Service worker
 * может быть выгружен между вызовами — тогда чтение повторится;
 * это дешевле, чем хранить копию реестра в storage.
 */
let РЕЕСТР_КЭШ = null;

async function реестр() {
  if (РЕЕСТР_КЭШ) return РЕЕСТР_КЭШ;
  const r = await fetch(browser.runtime.getURL('data/tools.json'));
  РЕЕСТР_КЭШ = await r.json();
  return РЕЕСТР_КЭШ;
}

/** Состояние гейта: режим данных, свои диапазоны, скрытие платных. */
async function состояниеГейта() {
  let managed = {};
  try { managed = (await browser.storage.managed.get()) || {}; } catch (_) { managed = {}; }
  const local = await browser.storage.local.get(['ti_tlp_mode', 'ti_hide_paid']);
  /* Политика сильнее выбора аналитика — как и в консоли: там при
   * lockTlpMode выпадающий список заблокирован. */
  const tlp = managed.lockTlpMode
    ? (managed.defaultTlpMode || 'public')
    : (local.ti_tlp_mode || managed.defaultTlpMode || 'public');
  const свои = globalThis.TIOwnRanges
    ? TIOwnRanges.разобрать(managed.ownRanges, managed.ownDomains)
    : null;
  return { tlp, свои, скрытьПлатные: local.ti_hide_paid === true };
}

/** Что известно про значение из активного кейса. */
async function изКейса(значение, тип) {
  if (!globalThis.TICases) return { вКейсе: false, вердикт: '' };
  const raw = (await browser.storage.local.get(TICases.STORE_KEY))[TICases.STORE_KEY];
  const store = TICases.normalizeStore(raw);
  const кейс = TICases.activeCase(store);
  if (!кейс) return { вКейсе: false, вердикт: '' };
  const ключ = `${тип}|${String(значение).toLowerCase()}`;
  const найден = (кейс.items || []).find(
    (i) => `${i.type}|${String(i.value).toLowerCase()}` === ключ);
  return { вКейсе: !!найден, вердикт: (найден && найден.verdict) || '' };
}

async function карточкаДляЗначения(значение, тип) {
  const [рег, гейт, кейс] = await Promise.all([реестр(), состояниеГейта(), изКейса(значение, тип)]);
  const п = TIPivot.подобрать({
    значение, тип, реестр: рег, tlp: гейт.tlp, свои: гейт.свои,
    скрытьПлатные: гейт.скрытьПлатные,
  });
  return {
    ...п,
    метка: (globalThis.IOC && IOC.TYPE_LABELS && IOC.TYPE_LABELS[тип]) || тип,
    дефанг: (globalThis.IOC && IOC.defang) ? IOC.defang(значение) : значение,
    закрытоСтрокой: TIPivot.строкаОЗакрытом(п.закрыто),
    вКейсе: кейс.вКейсе,
    вердикт: кейс.вердикт,
    tlp: гейт.tlp,
  };
}

/** Добавить одно значение в активный кейс — тем же путём, что панель. */
async function вКейсОдно(значение, тип, источник) {
  if (!globalThis.TICases) return { ok: false, error: T('модуль кейсов не загружен') };
  const raw = (await browser.storage.local.get(TICases.STORE_KEY))[TICases.STORE_KEY];
  const ioc = {
    type: тип,
    value: значение,
    typeLabel: (globalThis.IOC && IOC.TYPE_LABELS && IOC.TYPE_LABELS[тип]) || тип,
  };
  const r = TICases.addItemsToActive(raw, [ioc], { source: источник || T('страница') });
  if (!r.ok) return { ok: false, error: r.error };
  await browser.storage.local.set({ [TICases.STORE_KEY]: r.store });
  /* Вкладка консоли могла быть открыта в момент записи; без сигнала
   * она показывала бы прежний состав кейса до перезагрузки, а её
   * следующее сохранение затёрло бы добавленное отсюда. */
  browser.runtime.sendMessage({ cmd: 'cases-changed' }).catch(() => {});
  return { ok: true, added: r.added, повторов: r.повторов, созданКейс: r.созданКейс };
}

/* ------------------------------------------------- приём от content-script */
browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg?.cmd === 'page-iocs') {
    /* Панель здесь НЕ открывается: сообщение приходит из content-script,
     * жеста уже нет, и вызов всё равно был бы отклонён. Результат
     * открывается в консоли (showConsoleWithScan внутри stashResult),
     * а панель аналитик открывает сам, когда она ему нужна. */
    await stashResult(msg.iocs || [], sender?.tab?.url, T('страница'), {}, вКейс);
    вКейс = false;                       // флаг одноразовый
    return { ok: true };
  }
  /* Разбор страницы по кнопке из попапа. Попап закрывается раньше, чем
   * разбор закончится, поэтому работу делает фоновый скрипт, а не он. */
  if (msg?.cmd === 'scan-active-tab') {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) scanTab(tab);
    return { ok: !!tab };
  }
  /* То же самое, но результат идёт СРАЗУ В КЕЙС.
   *
   * Разница с обычным разбором — одна и существенная: обычный кладёт
   * найденное в выдачу, и что попадёт в кейс, решает аналитик галочками.
   * Здесь он решил заранее, нажав другую кнопку, и это осознанное
   * действие по ОДНОЙ странице.
   *
   * Автоматического сбора со всех открываемых вкладок здесь нет и не
   * будет: это обошло бы и правило «разбор только по кнопке»,
   * и TLP-гейт — достаточно было бы открыть внутреннюю систему, и её
   * содержимое оказалось бы в кейсе, в выгрузке и в отчёте.
   *
   * Сам кейс фон не трогает: флаг едет в storage вместе с выдачей,
   * а добавляет в кейс консоль, где живёт вся работа с кейсом.
   * Два места, пишущие в хранилище кейсов, разошлись бы молча. */
  if (msg?.cmd === 'scan-active-tab-into-case') {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { ok: false };
    вКейс = true;
    scanTab(tab);
    return { ok: true };
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
  /* --- сбор с помеченной вкладки --- */
  if (msg?.cmd === 'capture-start') {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return начатьСбор(tab);
  }
  if (msg?.cmd === 'capture-stop') {
    return остановитьСбор(TICapture.ПРИЧИНЫ.человек);
  }
  if (msg?.cmd === 'capture-state') {
    const с = await прочитатьСеанс();
    return { сеанс: с, подпись: TICapture.подпись(с) };
  }

  /* --- карточка индикатора на странице --- */
  if (msg?.cmd === 'pivot') {
    try {
      return await карточкаДляЗначения(String(msg.значение || ''), String(msg.тип || ''));
    } catch (e) {
      return { ошибка: String((e && e.message) || e), инструменты: [], закрыто: [] };
    }
  }
  if (msg?.cmd === 'pivot-open') {
    const url = String(msg.url || '');
    /* Открывает ФОН, а не страница: часть сайтов блокирует window.open
     * из content-script, и тогда «сервис не открылся» выглядит как
     * поломка расширения. Схема проверяется здесь же: карточка живёт
     * на чужой странице, и адрес приезжает оттуда. */
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'не http(s)' };
    await browser.tabs.create({ url, active: true });
    return { ok: true };
  }
  if (msg?.cmd === 'pivot-to-case') {
    return вКейсОдно(String(msg.значение || ''), String(msg.тип || ''),
                     sender?.tab?.url || T('страница'));
  }
  if (msg?.cmd === 'pivot-console') {
    /* Значение едет В АДРЕСЕ вкладки, а не через хранилище.
     *
     * Первая редакция писала его в storage.local под ключом
     * ti_pivot_value и открывала консоль. Ключ никто не читал:
     * вкладка открывалась пустой. Хранилище здесь ещё и хуже адреса
     * по сути — это общее состояние на все вкладки, и две карточки,
     * нажатые подряд, затёрли бы друг друга. */
    const значение = String(msg.значение || '').slice(0, 2048);
    const target = browser.runtime.getURL('newtab/newtab.html')
                 + '?ioc=' + encodeURIComponent(значение);
    await browser.tabs.create({ url: target, active: true });
    return { ok: true };
  }
  if (msg?.cmd === 'clear-badge') {
    await setBadge(0);
    return { ok: true };
  }
  return undefined;
});
