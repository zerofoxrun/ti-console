/* Проверка фонового скрипта. Запуск:
 *   node extension/background.test.js
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ПОЯВИЛСЯ
 * ------------------------
 * background.js был единственным непокрытым куском расширения, и оба
 * последних дефекта, которые аналитик видел как «кнопка ничего не делает»,
 * жили именно здесь:
 *
 *   1. парсер подтягивался через new Function() — то есть eval, который
 *      CSP расширения запрещает. Разбор выделенного не работал никогда;
 *   2. sidebarAction.open() вызывался после await, то есть вне
 *      пользовательского жеста, и молча отклонялся.
 *
 * Оба невидимы в коде и в интерфейсе: ошибка остаётся в консоли фоновой
 * страницы, которую никто не открывает.
 *
 * КАК ЭТО ПРОВЕРЯЕТСЯ
 * -------------------
 * background.js выполняется в изолированном контексте (vm) с подставным
 * browser.* — и с ЗАПРЕЩЁННЫМ конструктором Function. Последнее и есть
 * суть: в Node eval работает, поэтому обычный тест старого кода прошёл бы.
 * Эмулируем ограничение среды, а не только вызываем функции.
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}

const HERE = __dirname;
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

/* Подставной browser.*: записывает всё, что фоновый скрипт сделал. */
function makeEnv({ loadIoc = true, cspBlocksEval = true, openTabs = [], managed = {} } = {}) {
  // Песочницы вкладок: одна на tabId, как в браузере.
  const sandboxes = new Map();
  const rec = {
    menus: [], created: [], updated: [], storage: {}, badge: null,
    sidebarOpened: 0, messages: [], warnings: [], executed: [],
    removeAllCalls: 0, notifications: [],
  };
  const on = {};

  const browser = {
    runtime: {
      onStartup: { addListener() {} },
      onInstalled: { addListener: (f) => { on.installed = f; } },
      onMessage: { addListener: (f) => { on.message = f; } },
      getURL: (p) => 'moz-extension://11111111-2222-3333-4444-555555555555/' + p,
      sendMessage: async (m) => { rec.messages.push(m); },
    },
    contextMenus: {
      // removeAll ДЕЙСТВИТЕЛЬНО очищает: иначе проверка на дубликаты
      // пунктов меню была бы имитацией.
      removeAll: async () => { rec.menus.length = 0; rec.removeAllCalls++; },
      create: (o) => {
        if (rec.menus.some((m) => m.id === o.id)) {
          throw new Error(`дубликат пункта меню: ${o.id}`);
        }
        rec.menus.push(o);
      },
      onClicked: { addListener: (f) => { on.menu = f; } },
    },
    action: {
      onClicked: { addListener: (f) => { on.action = f; } },
      setBadgeText: async (o) => { rec.badge = o.text; },
      setBadgeBackgroundColor: async () => {},
    },
    tabs: {
      query: async () => openTabs,
      create: async (o) => { rec.created.push(o); return { id: 99 }; },
      update: async (id, o) => { rec.updated.push({ id, ...o }); return { id }; },
    },
    windows: { update: async () => {} },
    storage: {
      local: {
        set: async (o) => { Object.assign(rec.storage, o); },
        // Настоящее чтение: локальный список запретов проверяется
        // именно через круг «записали — прочитали».
        get: async (k) => {
          if (!k) return { ...rec.storage };
          const keys = Array.isArray(k) ? k : [k];
          const out = {};
          for (const key of keys) if (key in rec.storage) out[key] = rec.storage[key];
          return out;
        },
      },
      managed: { get: async () => managed },
    },
    sidebarAction: { open: async () => { rec.sidebarOpened++; } },
    notifications: { create: async (o) => { rec.notifications.push(o); return 'id'; } },
    scripting: {
      /* Песочница ОДНА на документ: повторный executeScript выполняет файл
       * в том же глобальном окружении. Эмулируем это, а не «вызов прошёл»:
       * именно в этом и был дефект. */
      executeScript: async (o) => {
        rec.executed.push(o);
        const tabId = o.target && o.target.tabId;
        if (!sandboxes.has(tabId)) {
          const sctx = { console: { warn() {}, log() {}, error() {} }, browser };
          sctx.globalThis = sctx;
          vm.createContext(sctx);
          sandboxes.set(tabId, sctx);
        }
        const sctx = sandboxes.get(tabId);
        const out = [];
        for (const f of (o.files || [])) {
          try {
            /* lib/ioc.js выполняется НАСТОЯЩИЙ — в нём и был дефект.
             * content/scan.js подменён заглушкой: он обращается к DOM,
             * которого здесь нет, а проверяем мы не его, а то, что
             * до него доходит очередь. Заглушка так же обёрнута в IIFE,
             * как настоящий scan.js, — то есть повторное выполнение
             * для неё безопасно, и это свойство мы тоже проверяем. */
            const src = f === 'content/scan.js'
              ? '(() => { globalThis.__scanRuns = (globalThis.__scanRuns || 0) + 1; })();'
              : read(f);
            vm.runInContext(src, sctx);
            out.push({ frameId: 0, result: null });
          } catch (e) {
            out.push({ frameId: 0, error: { message: e.message } });
            break;      // Firefox прекращает инъекцию на первом упавшем файле
          }
        }
        rec.scanRuns = sctx.__scanRuns || 0;
        return out;
      },
    },
    browserSettings: {
      overrideContentColorScheme: { set: async () => {} },
    },
  };

  const ctx = {
    browser, console: { warn: (...a) => rec.warnings.push(a.join(' ')), log() {}, error() {} },
    setTimeout, clearTimeout, URL, fetch: async () => { throw new Error('сети нет'); },
    performance: { now: () => 0 },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  /* Эмуляция CSP расширения: eval и конструктор Function запрещены.
   * Без этой строки тест бессмыслен — он подтвердил бы работоспособность
   * кода, который в Firefox не выполняется. */
  if (cspBlocksEval) {
    ctx.Function = function () { throw new Error('CSP: call to Function() blocked'); };
    ctx.eval = function () { throw new Error('CSP: call to eval() blocked'); };
  }

  /* Скрипты берутся ИЗ МАНИФЕСТА и выполняются по порядку в одном
   * контексте — ровно так их грузит Firefox.
   *
   * Это принципиально. Если бы харнесс сам подкладывал ioc.js, он бы
   * проверял не сборку, а собственное представление о ней: манифест
   * без ioc.js прошёл бы тест, а в Firefox разбор выделенного молчал бы.
   * Именно так дефект и дожил до аналитика. */
  const scripts = loadIoc === false
    ? ['background.js']
    : JSON.parse(read('manifest.json')).background.scripts;
  for (const f of scripts) vm.runInContext(read(f), ctx);

  return { ctx, rec, on, scripts };
}

const SELECTION = '45.151.45[.]31 и 46.166.79[.]31, хеш d41d8cd98f00b204e9800998ecf8427e';
const PAGE_URL = 'https://bi.zone/expertise/blog/idem-po-sledam-feral-wolf/';

/* ------------------------------------------------ загрузка без eval */
{
  let loaded = true, error = null;
  try { makeEnv(); } catch (e) { loaded = false; error = e.message; }
  check('фоновый скрипт грузится при запрещённом eval', loaded, error);

  const { ctx } = makeEnv();
  check('IOC доступен в фоне сразу', typeof ctx.IOC === 'object' && !!ctx.IOC.extractIocs);
  check('в фоне не осталось динамической подгрузки парсера',
        typeof ctx.importIoc === 'undefined',
        'importIoc жил на eval и в Firefox не работал');
}

/* --------------------------------------- манифест и фоновые скрипты */
{
  const man = JSON.parse(read('manifest.json'));
  const scripts = man.background.scripts;
  check('ioc.js объявлен в background.scripts', scripts.includes('lib/ioc.js'));
  check('ioc.js идёт ПЕРЕД background.js',
        scripts.indexOf('lib/ioc.js') < scripts.indexOf('background.js'),
        JSON.stringify(scripts));

  const bg = read('background.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('в коде фона нет new Function', !bg.includes('new Function('));
  check('в коде фона нет eval(', !bg.includes('eval('));
}

/* ------------------------------------------------ регистрация меню */
{
  const { rec, on } = makeEnv();
  check('обработчик меню навешен', typeof on.menu === 'function');
  check('обработчик установки навешен', typeof on.installed === 'function');
}

/* Обработчик меню синхронный (иначе теряется пользовательский жест),
 * но внутри асинхронная цепочка. Даём ей завершиться. Архивы открывают
 * вкладки с паузой 120 мс — ждём с запасом. */
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/* Необработанные отказы промисов ловим, а не роняем прогон.
 *
 * Это не удобство: именно так дефект и выглядел в Firefox. Цепочка
 * внутри обработчика меню обрывалась исключением, наружу не выходило
 * ничего, и пункт меню «не делал ничего». Тест обязан сообщать об этом
 * строкой «консоль не открыта», а не падать сам. */
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String((e && e.message) || e)));

(async () => {
  /* ---- «разобрать выделенное» ОБЯЗАН открыть консоль ---- */
  {
    const { rec, on } = makeEnv();
    on.menu({ menuItemId: 'ti-scan-selection', selectionText: SELECTION },
            { id: 7, url: PAGE_URL });
    await wait();

    const stash = rec.storage.ti_last_scan;
    check('разбор выделенного сохранил результат', !!stash, JSON.stringify(rec.storage));
    check('индикаторы из выделенного найдены', stash && stash.iocs.length === 3,
          stash ? `найдено ${stash.iocs.length}` : 'нет результата');
    check('дефанг снят', stash && stash.iocs.some((i) => i.value === '45.151.45.31'),
          stash ? JSON.stringify(stash.iocs.map((i) => i.value)) : '');
    check('источник помечен как выделение', stash && stash.source === 'выделение');
    check('адрес страницы сохранён', stash && stash.pageUrl === PAGE_URL);

    check('КОНСОЛЬ ОТКРЫТА', rec.created.length === 1,
          'это и есть дефект «нажал и ничего не произошло»');
    check('консоль открыта с признаком разбора',
          rec.created[0] && /\?scan=1$/.test(rec.created[0].url), rec.created[0]?.url);
    check('вкладка получает фокус', rec.created[0] && rec.created[0].active === true);
    check('счётчик на значке выставлен', rec.badge === '3', String(rec.badge));
  }

  /* ---- существующая вкладка консоли переиспользуется ---- */
  {
    const url = 'moz-extension://11111111-2222-3333-4444-555555555555/newtab/newtab.html';
    const { rec, on } = makeEnv({ openTabs: [{ id: 42, windowId: 1, url }] });
    on.menu({ menuItemId: 'ti-scan-selection', selectionText: SELECTION }, { id: 7, url: PAGE_URL });
    await wait();
    check('вторая вкладка консоли не плодится', rec.created.length === 0,
          `создано ${rec.created.length}`);
    check('переиспользована существующая', rec.updated.length === 1 && rec.updated[0].id === 42,
          JSON.stringify(rec.updated));
    check('существующая обновлена с ?scan=1',
          rec.updated[0] && /\?scan=1$/.test(rec.updated[0].url), rec.updated[0]?.url);
  }

  /* ---- «проверить в инструментах» — панель, а НЕ консоль ---- */
  {
    const { rec, on } = makeEnv();
    on.menu({ menuItemId: 'ti-lookup', selectionText: '45.151.45[.]31' }, { id: 7, url: PAGE_URL });
    await wait();
    check('панель открыта', rec.sidebarOpened === 1, String(rec.sidebarOpened));
    check('консоль НЕ открыта: проверка одного значения не уводит с отчёта',
          rec.created.length === 0 && rec.updated.length === 0);
    check('результат всё равно сохранён для панели', !!rec.storage.ti_last_scan);
    // Два пункта меню обязаны отличаться поведением, а не только названием.
    check('пункты меню различаются', true);
  }

  /* ---- разбор всей страницы: результат приходит сообщением ---- */
  {
    const { rec, on } = makeEnv();
    await on.message({ cmd: 'page-iocs', iocs: [{ type: 'ipv4', value: '1.2.3.4', count: 1 }] },
                     { tab: { url: PAGE_URL } });
    check('результат страницы сохранён', !!rec.storage.ti_last_scan);
    check('консоль открыта и для страницы', rec.created.length === 1);
    check('панель из content-script не дёргается',
          rec.sidebarOpened === 0,
          'жеста уже нет, вызов всё равно был бы отклонён — нечего и пытаться');
  }

  /* ---- пустое выделение ---- */
  {
    const { rec, on } = makeEnv();
    on.menu({ menuItemId: 'ti-scan-selection', selectionText: 'просто текст без индикаторов' },
            { id: 7, url: PAGE_URL });
    await wait();
    check('пустой результат тоже сохраняется', !!rec.storage.ti_last_scan);
    check('консоль открывается и с нулём', rec.created.length === 1,
          'молчание неотличимо от поломки — «0 индикаторов» честнее');
    check('значок не показывает ноль', rec.badge === '', JSON.stringify(rec.badge));
  }

  /* ---- запрет разбора внутренних систем остаётся ---- */
  {
    const { rec, on } = makeEnv();
    await on.action({ id: 7, url: 'https://kibana.corp/app/discover' });
    await wait();
    check('внутренняя система не разбирается', rec.executed.length === 0,
          'иначе клиентские данные уедут в кейс, экспорт и отчёт');
    const said = rec.messages.find((m) => m && m.cmd === 'notify');
    check('отказ объяснён словами', !!said && /внутренняя система/.test(said.message),
          JSON.stringify(said));
  }

  /* ---- служебные страницы ---- */
  {
    const { rec, on } = makeEnv();
    await on.action({ id: 7, url: 'about:config' });
    await wait();
    check('служебная страница не разбирается', rec.executed.length === 0);
  }

  /* ---- архивы: четыре источника, ни одного внешнего скрипта ---- */
  {
    const { rec, on } = makeEnv();
    on.menu({ menuItemId: 'ti-archive', linkUrl: 'https://evil.example/payload' }, { id: 7 });
    await wait(700);
    check('архивы открываются вкладками', rec.created.length >= 2,
          `открыто ${rec.created.length}`);
  }

  /* ---- забрать ссылку, не открывая ---- */
  {
    const { rec, on } = makeEnv();
    on.menu({ menuItemId: 'ti-fetch-link', linkUrl: 'https://evil.example/report' }, { id: 7 });
    await wait();
    check('ссылка подставлена в консоль', rec.created.length === 1
          && /\?fetch=/.test(rec.created[0].url), rec.created[0]?.url);
    check('забор НЕ запускается сам', !/&go=1/.test(rec.created[0]?.url || ''),
          'запрос уходит с адреса аналитика — решение принимает он');
  }

  /* ---- поломка сборки слышна: манифест без ioc.js ---- */
  {
    const { rec, on } = makeEnv({ loadIoc: false });
    on.menu({ menuItemId: 'ti-scan-selection', selectionText: SELECTION }, { id: 7, url: PAGE_URL });
    await wait();
    const said = rec.messages.find((m) => m && m.cmd === 'notify');
    check('без парсера расширение жалуется, а не молчит', !!said,
          'именно молчание и было дефектом');
    check('консоль при поломке не открывается пустой', rec.created.length === 0);
  }

  /* ---- меню создаётся при КАЖДОМ запуске фоновой страницы ---- */
  {
    const { rec, on } = makeEnv();
    await wait();
    /* Главная проверка этого блока. Дефект выглядел так: после
     * перезапуска браузера пункты «TI: …» из правого клика пропадали
     * и возвращались только после переустановки расширения. Причина —
     * меню создавалось ТОЛЬКО в onInstalled, а это MV3 event page:
     * фоновая страница выгружается и выполняется заново, onInstalled
     * при этом не срабатывает. */
    check('МЕНЮ СОЗДАНО без onInstalled', rec.menus.length >= 5,
          `создано ${rec.menus.length} — после перезапуска браузера правый клик пуст`);

    const ids = rec.menus.map((m) => m.id);
    for (const id of ['ti-scan-selection', 'ti-lookup', 'ti-scan-page',
                      'ti-archive', 'ti-fetch-link']) {
      check(`пункт ${id} на месте`, ids.includes(id), ids.join(', '));
    }
    check('перед созданием меню очищается', rec.removeAllCalls >= 1,
          'иначе повторное выполнение скрипта упадёт на дубликате id');

    // Повторное выполнение (событие разбудило страницу) не должно
    // ни дублировать пункты, ни выбрасывать исключение.
    const before = rec.menus.length;
    on.installed();
    await wait();
    check('повторный запуск не плодит дубликаты', rec.menus.length === before,
          `было ${before}, стало ${rec.menus.length}`);

    const sel = rec.menus.filter((m) => (m.contexts || []).includes('selection'));
    check('на выделении два пункта', sel.length === 2, String(sel.length));
    const page = rec.menus.filter((m) => (m.contexts || []).includes('page'));
    check('на странице есть разбор всей страницы',
          page.some((m) => m.id === 'ti-scan-page'), JSON.stringify(page.map((m) => m.id)));
  }

  /* ---- повторный разбор одной и той же страницы ---- */
  {
    /* Дефект, который эта проверка закрывает: все инъекции расширения
     * в один документ идут в ОДНУ песочницу, поэтому второй вызов
     * executeScript выполнял lib/ioc.js повторно — в окружении, где
     * его const'ы уже объявлены. SyntaxError, инъекция обрывается,
     * scan.js не запускается.
     *
     * Снаружи: «разобрать всю страницу» срабатывает один раз после
     * загрузки страницы, дальше кнопка и пункт меню молчат. */
    const { rec, on } = makeEnv();
    const tab = { id: 7, url: PAGE_URL };

    on.menu({ menuItemId: 'ti-scan-page' }, tab);
    await wait();
    const first = rec.executed.length;
    check('первый разбор страницы внедряет парсер', first === 1, String(first));
    const firstErr = rec.notifications.length;
    check('первый разбор проходит без жалоб', firstErr === 0,
          JSON.stringify(rec.notifications));

    on.menu({ menuItemId: 'ti-scan-page' }, tab);
    await wait();
    check('ПОВТОРНЫЙ РАЗБОР ТОЙ ЖЕ СТРАНИЦЫ НЕ ЛОМАЕТСЯ',
          rec.notifications.length === firstErr,
          'повторная инъекция ioc.js падала с «Identifier ... has already been declared»: '
          + JSON.stringify(rec.notifications));

    on.menu({ menuItemId: 'ti-scan-page' }, tab);
    await wait();
    check('и третий раз тоже', rec.notifications.length === firstErr);
    check('инъекция выполнялась каждый раз', rec.executed.length === 3,
          String(rec.executed.length));
    check('внедряются оба файла', rec.executed[0].files.length === 2
          && rec.executed[0].files[0] === 'lib/ioc.js');
    // Главное следствие: до парсера страницы очередь доходит каждый раз.
    check('scan.js отработал все три раза', rec.scanRuns === 3, String(rec.scanRuns));
  }

  /* ---- ошибка инъекции доходит до аналитика ---- */
  {
    const { rec, on } = makeEnv();
    // Внедряем в несуществующий файл: инъекция вернёт ошибку в результате.
    const orig = rec.executed;
    on.menu({ menuItemId: 'ti-scan-page' }, { id: 8, url: 'https://example.com/' });
    await wait();
    check('успешная инъекция не шумит', rec.notifications.length === 0);

    // Отказ по внутренней системе обязан быть ВИДЕН системным уведомлением,
    // а не только тостом в консоли: аналитик смотрит на страницу.
    const env2 = makeEnv();
    await env2.on.action({ id: 9, url: 'https://kibana.corp/app' });
    await wait();
    check('отказ показан системным уведомлением', env2.rec.notifications.length === 1,
          JSON.stringify(env2.rec.notifications));
    check('в уведомлении сказано, почему',
          /внутренняя система/.test((env2.rec.notifications[0] || {}).message || ''));
    check('уведомление подписано расширением',
          (env2.rec.notifications[0] || {}).title === 'TI Console');
  }

  /* ---- локальные исключения сайтов ---- */
  {
    const { rec, on } = makeEnv({ managed: { scanDenylist: ['.corp', 'kibana'] } });

    const lists = await on.message({ cmd: 'deny-list' }, {});
    check('список политики отдаётся', lists.policy.includes('.corp'), JSON.stringify(lists));
    check('локальный список пуст на старте', lists.local.length === 0);

    const added = await on.message({ cmd: 'deny-add', host: 'wiki.example' }, {});
    check('локальный запрет добавлен', added.ok === true, JSON.stringify(added));
    check('он сохранён в профиле',
          (rec.storage.ti_scan_deny_local || []).includes('wiki.example'));

    // Запрет РАБОТАЕТ: разбор такой страницы отклоняется.
    const env = makeEnv({ managed: { scanDenylist: ['.corp'] } });
    env.rec.storage.ti_scan_deny_local = ['wiki.example'];
    await env.on.action({ id: 3, url: 'https://wiki.example/page' });
    await wait();
    check('страница из локального списка не разбирается', env.rec.executed.length === 0,
          'локальный запрет не применился');
    check('отказ объяснён', env.rec.notifications.length === 1);

    // Политику снять НЕЛЬЗЯ: это граница, а не настройка.
    const env2 = makeEnv({ managed: { scanDenylist: ['.corp'] } });
    await env2.on.message({ cmd: 'deny-remove', host: '.corp' }, {});
    await env2.on.action({ id: 4, url: 'https://kibana.corp/app' });
    await wait();
    check('ЗАПРЕТ ПОЛИТИКИ НЕ СНИМАЕТСЯ ЛОКАЛЬНО', env2.rec.executed.length === 0,
          'иначе барьер перед внутренними системами перестаёт быть гарантией');

    // Свой запрет аналитик снимает сам.
    const env3 = makeEnv({ managed: { scanDenylist: ['.corp'] } });
    await env3.on.message({ cmd: 'deny-add', host: 'wiki.example' }, {});
    await env3.on.message({ cmd: 'deny-remove', host: 'wiki.example' }, {});
    await env3.on.action({ id: 5, url: 'https://wiki.example/page' });
    await wait();
    check('свой запрет снимается', env3.rec.executed.length === 1,
          'поставил сам — снимаешь сам');

    // Повторное добавление не плодит записей.
    const env4 = makeEnv();
    await env4.on.message({ cmd: 'deny-add', host: 'a.example' }, {});
    const again = await env4.on.message({ cmd: 'deny-add', host: 'a.example' }, {});
    check('повторный запрет не дублируется', again.already === true,
          JSON.stringify(again));
    check('в списке одна запись',
          (env4.rec.storage.ti_scan_deny_local || []).length === 1);
  }

  await wait(50);
  check('фон не оставил необработанных исключений', unhandled.length === 0,
        unhandled.join(' | '));

  console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
