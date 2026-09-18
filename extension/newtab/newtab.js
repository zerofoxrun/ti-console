/* =============================================================================
 * newtab.js — логика главной вкладки
 * =============================================================================
 *
 * ЧТО ЗДЕСЬ РЕАЛИЗОВАНО (PoC-уровень, всё работает офлайн, без бэкенда):
 *   - дерево инструментов из data/tools.json с фильтром и TLP-гейтом;
 *   - «Разбор IOC»: разбор текста/файла -> список IOC -> подбор инструментов;
 *   - массовое открытие вкладок с ограничением частоты;
 *   - «Поиск по источникам»: профили источников -> запрос в SearXNG либо прямое
 *     открытие площадок (fallback, когда бэкенда ещё нет);
 *   - кейс: накопление индикаторов, экспорт CSV/JSON/STIX, скелет отчёта.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ (см. концепт, раздел «Архитектура»):
 *   - вызовов API обогащения из браузера. Ключи VT/Shodan/Censys в расширении
 *     хранить нельзя: browser.storage.local читается пользователем и любым
 *     кодом, получившим исполнение в контексте расширения. Обогащение делает
 *     бэкенд, браузер ходит только на /api/v1/* нашего сервиса.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ, ХОТЯ ПРОТИВОРЕЧИТ ПУНКТУ ВЫШЕ — и почему это не ошибка:
 *   - прямой вызов API модели (lib/analyze.js), когда сервера нет вовсе.
 *     Ключ модели при этом лежит на машине и читается так же легко.
 *     Разница в цене утечки: ключ обогащения даёт доступ к чужим данным
 *     и квоте всей организации, ключ модели — только к тратам, и они
 *     ограничиваются лимитом на стороне провайдера. Это осознанный
 *     размен ради работающей функции без сервера, а не забытое правило.
 *     Разбор — в шапке lib/analyze.js.
 *
 * СОВМЕСТИМОСТЬ: работает и как страница расширения, и как одиночный HTML.
 * Отличия изолированы в объекте ENV ниже.
 * ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ ENV --
 * Единственное место, где различаются «расширение» и «демо-стенд».
 * ------------------------------------------------------------------------ */
const ENV = {
  isExtension: typeof browser !== 'undefined' && !!browser.tabs,

  /* Версия сборки. Берётся ИЗ МАНИФЕСТА, а не из константы в коде:
   * константу забывают поднять, и тогда интерфейс уверенно показывает
   * версию, которой не соответствует.
   *
   * Зачем она вообще нужна на экране. Обновление расширения на машине
   * аналитика делается заменой файла, и если оно не применилось —
   * а Firefox ставит XPI при запуске, то есть без перезапуска ничего
   * не произойдёт, — интерфейс выглядит ТОЧНО так же. Разбор даёт
   * прежний результат, и «обновил, ничего не изменилось» неотличимо
   * от «исправление не работает». Разбирались сверкой выгрузок кейса. */
  version() {
    if (this.isExtension) {
      try { return browser.runtime.getManifest().version || ''; } catch (_) { return ''; }
    }
    return globalThis.__tiVersion || '';      // демо-сборка подставляет своё
  },

  /* --------------------------------------------------------------------
   * Конфигурация из корпоративной политики (zero-touch).
   *
   * browser.storage.managed заполняется ключом 3rdparty.Extensions в
   * policies.json. Это единственный способ выдать аналитику полностью
   * настроенный браузер: адреса бэкенда и SearXNG приезжают вместе с
   * политикой, аналитик ничего не вводит и ничего не может сломать.
   * Значения доступны только на чтение — расширение их не перезаписывает.
   *
   * Порядок разрешения: managed -> локальный выбор пользователя -> дефолт.
   * ------------------------------------------------------------------ */
  managed: null,

  async loadManaged() {
    if (this.managed) return this.managed;
    try {
      this.managed = this.isExtension ? (await browser.storage.managed.get()) : {};
    } catch (_) {
      this.managed = {};       // политика не задана — работаем на дефолтах
    }
    return this.managed;
  },

  async loadTools() {
    // В демо-сборке реестр инлайнится сборщиком в globalThis.TOOLS_DATA.
    if (globalThis.TOOLS_DATA) return globalThis.TOOLS_DATA;

    // В проде реестр отдаёт бэкенд: один источник правды на весь SOC,
    // обновление реестра не требует перевыпуска расширения.
    const m = await this.loadManaged();
    if (m.apiUrl) {
      try {
        const r = await fetch(new URL('/api/v1/tools', m.apiUrl), { headers: this.authHeaders(m) });
        if (r.ok) return r.json();
      } catch (_) { /* сервер недоступен — падаем на встроенную копию */ }
    }
    // Встроенная копия реестра — не запасной вариант «на всякий случай»,
    // а гарантия: разбор IOC, дерево и разбор страниц работают, даже когда
    // сервера нет вообще. Браузер должен быть просто программой, которая
    // работает сразу после установки.
    const res = await fetch('../data/tools.json');
    return res.json();
  },

  openTab(url, active = false) {
    if (this.isExtension) return browser.tabs.create({ url, active });
    // Вне расширения (демо-стенд, страница в песочнице просмотрщика) открытие
    // вкладки может быть заблокировано. Молча «ничего не произошло» —
    // худший вариант: пользователь решает, что инструмент сломан.
    const w = window.open(url, '_blank', 'noopener');
    if (!w) {
      toast('Открытие вкладки заблокировано браузером — ссылка скопирована в буфер');
      navigator.clipboard?.writeText(url).catch(() => {});
    }
    return w;
  },

  /* Токен доступа к серверу. Приезжает политикой, аналитик его не вводит.
   * Туннеля между рабочим местом и сервером нет — сервер виден в интернете,
   * поэтому каждый запрос к нему подписывается. */
  authHeaders(managed) {
    const h = { 'Content-Type': 'application/json' };
    if (managed?.apiToken) h['Authorization'] = 'Bearer ' + managed.apiToken;
    return h;
  },

  async storeGet(key, fallback) {
    try {
      if (this.isExtension) {
        const v = await browser.storage.local.get(key);
        return key in v ? v[key] : fallback;
      }
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) { return fallback; }   // приватное окно / очищенное хранилище
  },

  async storeSet(key, value) {
    try {
      if (this.isExtension) return browser.storage.local.set({ [key]: value });
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) { /* хранилище недоступно — работаем в памяти */ }
  },
};

/* ------------------------------------------------- ПРОФИЛИ ИСТОЧНИКОВ --
 * Это и есть «гибкая фильтрация источников» поиска по источникам.
 * В проде список отдаёт бэкенд (GET /api/v1/search/profiles) и он
 * версионируется в Git — чтобы аналитики работали по одинаковым выборкам,
 * а не по личным закладкам.
 * ---------------------------------------------------------------------- */
/* ПОРЯДОК В СПИСКЕ — ЭТО НАСТРОЙКА, А НЕ ОФОРМЛЕНИЕ.
 *
 * В прямом режиме (без SearXNG) в запрос влезает только несколько первых
 * площадок: у поисковых систем есть предел длины строки. Отбор идёт так —
 * сначала площадки с собственным хостом, потом по порядку из этого файла.
 *
 * Поэтому ПЕРВЫМИ В КАЖДОМ ПРОФИЛЕ идут те, что должны попасть в прямой
 * режим, и это осознанная смесь русскоязычных и англоязычных источников.
 * Если просто дописывать новые в конец, прямой режим их не увидит
 * никогда — и это будет незаметно: выдача есть, просто неполная.
 *
 * `site:` понимает только домен, путь отбрасывается. Путь оставлен там,
 * где раздел действительно отличается от остального сайта (об этом
 * предупреждает предпросмотр), и убран у тех, где весь сайт — исследования.
 */
const SEARCH_PROFILES = [
  {
    id: 'vendor-reports',
    label: 'Отчёты вендоров',
    hint: 'Первичные разборы кампаний. Основной профиль для профилирования угрозы.',
    domains: [
      // --- ядро: попадает в прямой режим ---
      'securelist.ru', 'unit42.paloaltonetworks.com', 'rt-solar.ru',
      'thedfirreport.com', 'bi.zone', 'blog.talosintelligence.com',
      'f6.ru', 'research.checkpoint.com',
      // --- русскоязычные ---
      'ptsecurity.com', 'news.drweb.ru', 'kaspersky.ru/blog',
      'angarasecurity.ru', 'jet.su', 'cyberok.ru', 'infowatch.ru',
      'ics-cert.kaspersky.com',
      // --- англоязычные ---
      'securelist.com', 'cloud.google.com/blog/topics/threat-intelligence',
      'crowdstrike.com/blog', 'welivesecurity.com',
      'symantec-enterprise-blogs.security.com', 'elastic.co/security-labs',
      'microsoft.com/en-us/security/blog', 'sentinelone.com/labs',
      'blog.sekoia.io', 'trendmicro.com/en_us/research.html',
      'proofpoint.com/us/blog/threat-insight', 'blog.google/threat-analysis-group',
      'redcanary.com/blog', 'huntress.com/blog', 'volexity.com',
      'blog.lumen.com', 'team-cymru.com/blog', 'recordedfuture.com/research',
      'intel471.com/blog', 'group-ib.com/blog', 'zscaler.com/blogs/security-research',
      'fortinet.com/blog/threat-research', 'securityintelligence.com',
      'bitdefender.com/blog/labs', 'labs.withsecure.com', 'research.nccgroup.com',
      'blog.nviso.eu', 'asec.ahnlab.com', 'harfanglab.io/insidethelab',
      'blog.eclecticiq.com', 'rapid7.com/blog', 'trellix.com/blogs/research',
      'esentire.com/blog', 'cybereason.com/blog', 'malwarebytes.com/blog',
    ],
  },
  {
    id: 'cert-regulator',
    label: 'CERT и регуляторы',
    hint: 'Официальные бюллетени. То, на что можно ссылаться в отчёте клиенту.',
    domains: [
      // --- ядро ---
      'bdu.fstec.ru', 'cisa.gov', 'safe-surf.ru', 'ncsc.gov.uk',
      'cert.gov.ru', 'cert.europa.eu', 'nkcki.ru', 'jpcert.or.jp',
      // --- российские ---
      'fstec.ru', 'cbr.ru', 'fincert.cbr.ru',
      // --- международные ---
      'us-cert.cisa.gov', 'enisa.europa.eu', 'bsi.bund.de', 'cert.ssi.gouv.fr',
      'ncsc.nl', 'cyber.gc.ca', 'cyber.gov.au', 'cert.pl', 'cert.be',
      'ncsc.gov.ie', 'first.org',
    ],
  },
  {
    id: 'vuln-exploit',
    label: 'Уязвимости и эксплойты',
    hint: 'Наличие PoC и признаки эксплуатации.',
    domains: [
      // --- ядро ---
      'bdu.fstec.ru', 'nvd.nist.gov', 'cve.org', 'exploit-db.com',
      'vulners.com', 'attackerkb.com', 'zerodayinitiative.com', 'osv.dev',
      // --- остальное ---
      'packetstormsecurity.com', 'vuldb.com', 'security.snyk.io', 'huntr.com',
      'msrc.microsoft.com/update-guide', 'chromereleases.googleblog.com',
      'mozilla.org/en-US/security/advisories', 'seclists.org/fulldisclosure',
      'github.com/advisories', 'cisa.gov/known-exploited-vulnerabilities-catalog',
      'vulncheck.com/blog', 'cyberok.ru',
    ],
  },
  {
    id: 'code-leaks',
    label: 'Код и утечки',
    hint: 'Упоминания инфраструктуры и артефактов в публичном коде и пастах.',
    domains: [
      // --- ядро ---
      'github.com', 'pastebin.com', 'gitlab.com', 'rentry.co',
      'grep.app', 'gist.github.com', 'controlc.com', 'sourcegraph.com',
      // --- остальное ---
      'bitbucket.org', 'ghostbin.com', 'dpaste.org', 'searchcode.com',
      'gitee.com', 'codeberg.org', 'huggingface.co', 'habr.com/ru/companies',
    ],
  },
  {
    id: 'community',
    label: 'Сообщество и обсуждения',
    hint: 'Ранние сигналы: часто появляются раньше вендорских отчётов.',
    domains: [
      // --- ядро ---
      'habr.com', 'x.com', 'anti-malware.ru', 'bleepingcomputer.com',
      'securitylab.ru', 'infosec.exchange', 'therecord.media', 'xakep.ru',
      // --- русскоязычные ---
      'cisoclub.ru', 'itsec.ru',
      // --- англоязычные ---
      'bsky.app', 'reddit.com/r/blueteamsec', 'reddit.com/r/netsec',
      'news.ycombinator.com', 'securityweek.com', 'thehackernews.com',
      'krebsonsecurity.com', 'darkreading.com', 'risky.biz',
      'isc.sans.edu', 'malware.news', 'cyberscoop.com',
    ],
  },
  {
    id: 'detection',
    label: 'Правила детекта',
    hint: 'Готовые Sigma/EQL/KQL под технику или семейство.',
    domains: [
      /* github.com указан ОДИН раз намеренно: site: понимает только домен,
       * и десять записей вида github.com/SigmaHQ/sigma свернулись бы в него
       * же — в запрос попало бы то же самое, а в списке профиля значилось
       * бы десять площадок. Конкретные репозитории лежат в дереве
       * инструментов, где по ним можно кликнуть. */
      'attack.mitre.org', 'github.com', 'detection.fyi', 'research.splunk.com',
      'car.mitre.org', 'sigconverter.io', 'd3fend.mitre.org',
      'redcanary.com/threat-detection-report', 'attackerkb.com',
      'uncoder.io', 'socprime.com',
    ],
  },
];

/* ----------------------------------------------------------- СОСТОЯНИЕ -- */
const state = {
  registry: null,       // содержимое tools.json
  iocs: [],             // результат последнего разбора
  /* Очередь триажа. Отдельно от iocs: выдача живёт до следующего разбора,
   * очередь его переживает — в этом весь её смысл. */
  triage: { items: [], dismissed: [], truncated: 0 },
  selected: new Set(),  // ключи выбранных IOC
  caseStore: { cases: [], activeId: null },  // все кейсы; активный — источник двух полей ниже
  migratedLegacy: false,                     // старый одиночный кейс был перенесён
  caseItems: [],        // индикаторы АКТИВНОГО кейса
  timeline: [],         // хронология кейса; живёт и очищается вместе с ним
  foxBusy: false,       // идёт разбор — лиса в шапке бежит
  foxError: false,      // последнее действие не выполнилось — лиса спит
  tlp: 'public',        // public | client
  caseStorage: 'local', // local | server — приезжает политикой
  hidePaid: false,      // скрывать инструменты, бесполезные без платного тарифа
  profile: 'vendor-reports',
  analysis: null,       // результат последнего анализа моделью
  modelReady: false,    // доступна ли модель прямо сейчас
  modelExternal: false, // уходит ли текст стороннему провайдеру
  directLlm: null,      // конфиг прямого вызова API, если сервера нет

  /* Откуда взялся текст в поле ввода. Не косметика: метка доезжает до
   * кейса, до CSV и до отчёта. Индикатор, снятый с картинки, и индикатор
   * из отчёта вендора — разного качества данные, и через неделю, глядя
   * на таблицу кейса, отличить их иначе будет нечем. */
  parsed: false,        // разбирали ли хоть раз: пустое поле и «не найдено» — разное
  inputSource: 'вставленный текст',
  sourceUrl: '',        // если текст забран по ссылке — какой именно
  ocr: null,            // { dataUrl, text, unclear } последнего распознавания
  urlFetchAllowed: true, // выключается политикой urlFetch: false
};

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const iocKey = (i) => `${i.type}|${i.value.toLowerCase()}`;

/* --------------------------------------------------------------- ТЕМА --
 * Три состояния: dark | light | system.
 *   dark/light — атрибут data-theme на <html>, он выигрывает у медиазапроса;
 *   system     — атрибут снимается, работает prefers-color-scheme.
 * По умолчанию тёмная: браузер сделан под работу в SOC, где светлый экран
 * ночью — отдельный источник усталости.
 * Политика может зафиксировать тему (3rdparty -> theme + lockTheme).
 * ---------------------------------------------------------------------- */
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode === 'light' ? 'light' : 'dark');
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* --------------------------------------------------------- TLP-ФИЛЬТР --
 * Правило простое и намеренно строгое: в режиме «клиентские данные»
 * инструмент с exposure=public недоступен вообще. Это защищает от
 * ситуации «аналитик по привычке отправил хеш клиента в VirusTotal».
 * ---------------------------------------------------------------------- */
function isToolAllowed(tool) {
  if (state.hidePaid && tool.pricing === 'paid') return false;
  if (state.tlp === 'client') return tool.exposure !== 'public';
  return true;
}

/* Метки стоимости в дереве и в карточках.
 * Смысл: аналитик не должен тратить клик на сервис, за которым его ждёт
 * форма оплаты или форма регистрации, о которых он не знал. */
function pricingTags(tool, compact = false) {
  if (tool.pricing === 'paid') return '<span class="tool-tag tag-paid">платно</span>';
  // В карточке индикатора список сервисов плотный: там показываем только
  // платные, иначе метки забивают выдачу. В дереве места хватает.
  if (!compact && tool.pricing === 'free-account') return '<span class="tool-tag">рег.</span>';
  return '';
}

function toolsForType(type) {
  return state.registry.tools.filter((t) => t.types.includes(type));
}

function buildUrl(tool, value) {
  /* Пустое значение — это клик по инструменту в дереве, когда индикатор
   * ещё не выбран. Подстановка пустой строки давала обрубок вида
   * `https://www.abuseipdb.com/check/` — страницу, которой нет: инструмент
   * «не открылся», хотя вкладка открылась. Поймано сплошным прогоном.
   *
   * Открываем корень сайта: это и есть «голый инструмент», и такая
   * страница существует у всех 86 записей реестра. */
  if (!String(value)) {
    const шаблонный = /\{\{ioc(?:_raw)?\}\}/.test(tool.url);
    if (шаблонный) {
      try { return new URL(tool.url).origin + '/'; } catch { /* см. ниже */ }
    }
  }
  return tool.url
    .replace(/\{\{ioc\}\}/g, encodeURIComponent(value))
    .replace(/\{\{ioc_raw\}\}/g, value);
}

/* ================================================== ДЕРЕВО ИНСТРУМЕНТОВ = */
function renderTree(filterText = '') {
  const tree = $('#tool-tree');
  const q = filterText.trim().toLowerCase();
  tree.textContent = '';
  let shown = 0;

  for (const cat of state.registry.categories) {
    const tools = state.registry.tools.filter(
      (t) => t.category === cat.id &&
             (!q || t.name.toLowerCase().includes(q) ||
                    (t.note || '').toLowerCase().includes(q) ||
                    cat.label.toLowerCase().includes(q))
    );
    if (!tools.length) continue;

    const wrap = document.createElement('div');
    // При фильтре раскрыты все совпавшие; без фильтра — только первая
    // категория, чтобы дерево не выглядело пустым и не занимало весь экран.
    wrap.className = 'cat' + (q || cat.id === state.registry.categories[0].id ? ' is-open' : '');

    const head = document.createElement('button');
    head.className = 'cat-head';
    head.type = 'button';
    head.innerHTML = `<span class="cat-caret">▶</span><span>${cat.label}</span>` +
                     `<span class="cat-count">${tools.length}</span>`;
    head.addEventListener('click', () => wrap.classList.toggle('is-open'));

    const body = document.createElement('div');
    body.className = 'cat-body';

    for (const t of tools) {
      const allowed = isToolAllowed(t);
      const btn = document.createElement('button');
      btn.className = 'tool' + (allowed ? '' : ' is-blocked');
      btn.type = 'button';
      const priceNote = { free: 'без регистрации', 'free-account': 'нужна бесплатная регистрация',
                          paid: 'без платного тарифа бесполезен' }[t.pricing] || '';
      btn.title = `${t.note || ''}\n[${t.exposure}/${t.activity}] ${priceNote}` +
                  (allowed ? '' : '\n\nСкрыт фильтром');
      btn.innerHTML =
        `<i class="dot dot-${t.exposure === 'internal' ? 'internal' : t.exposure === 'limited' ? 'limited' : 'public'}"></i>` +
        `<span class="tool-name">${t.name}</span>` +
        pricingTags(t);
      if (allowed) {
        btn.addEventListener('click', () => {
          // Клик без IOC — открываем «голый» инструмент: подставляем пустую строку.
          ENV.openTab(buildUrl(t, ''), true);
        });
      }
      body.append(btn);
      shown++;
    }

    wrap.append(head, body);
    tree.append(wrap);
  }

  // Счётчик показывает ДОСТУПНЫЕ инструменты, а не отображённые: заблокированные
  // TLP-режимом остаются в дереве зачёркнутыми (аналитик должен видеть, что
  // именно закрыто и почему), но в доступные не входят.
  const usable = state.registry.tools.filter(isToolAllowed).length;
  const filtered = state.tlp === 'client' || state.hidePaid;
  $('#tool-count').textContent =
    `доступно ${filtered ? usable : shown} из ${state.registry.tools.length}` +
    (q ? ` · показано ${shown}` : '');
}

/* ======================================================= РАЗБОР IOC ==== */
function parseInput() {
  const text = $('#smart-input').value;
  if (!text.trim()) { toast('Пусто — вставьте текст, ссылку, файл или картинку'); return; }

  const foxDone = foxBusy();
  state.parsed = true;
  const t0 = performance.now();
  state.iocs = IOC.extractIocs(text, { withContext: true });

  /* Отделяем обвязку страницы от индикаторов.
   *
   * Отчёт вендора ссылается сам на себя десятками способов: соцсети,
   * блог на medium, канал в telegram, адрес для связи. Разбор отчёта
   * BI.ZONE дал одиннадцать «индикаторов», из которых настоящими
   * не были ни одного.
   *
   * Отсеянное НЕ УДАЛЯЕТСЯ: оно показывается отдельной группой, снятой
   * галочкой и с причиной. Молчаливое удаление — это второй способ
   * соврать аналитику, и он хуже первого: шум видно, спрятанное — нет.
   * Домен вендора бывает индикатором ровно тогда, когда взломали
   * вендора, и такой случай нельзя делать невидимым. */
  TINoise.markNoise(state.iocs, { sourceHost: TINoise.sourceHostOf(state.sourceUrl) });
  /* Второй проход — по СТРУКТУРЕ документа: колонтитулы и хвостовой
   * раздел ссылок. Правило по хосту их не видит: у загруженного файла
   * нет хоста-источника, а «Email: soc@example.org» на каждой из
   * пятнадцати страниц — обвязка не по значению, а по месту. */
  TINoise.markDocumentNoise(state.iocs, text, IOC.extractIocs);

  /* По умолчанию выбрано всё, КРОМЕ обвязки и того, что уже лежит
   * в активном кейсе: повторное добавление ничего не меняет, а галочка
   * заставляет каждый раз перечитывать список. */
  state.selected = new Set(state.iocs
    .filter((i) => !i.noise && !inActiveCase(i)).map(iocKey));
  const dt = (performance.now() - t0).toFixed(0);
  const dropped = state.iocs.filter((i) => i.noise).length;

  $('#parse-stat').textContent =
    `${state.iocs.length - dropped} индикаторов`
    + (dropped ? ` · ${dropped} отсеяно как обвязка` : '')
    + ` · ${text.length} символов · ${dt} мс · источник: ${state.inputSource}`;
  renderResults();
  triageAdd(state.iocs.filter((i) => !i.noise), state.inputSource);

  /* Разбор записывается в хронологию ТОЛЬКО если кейс уже начат.
   * Иначе журнал заполнялся бы разборами, которые никуда не привели:
   * аналитик вставил лог, посмотрел, закрыл. Хронология — про кейс,
   * а не про вкладку. */
  if (state.timeline.length) {
    logEvent('source.parsed', {
      source: state.inputSource,
      found: state.iocs.length - dropped,
      noise: dropped,
      url: state.sourceUrl || undefined,
    });
  }
  foxDone(false);
}

/**
 * Подхватывает результат разбора открытой страницы.
 *
 * Индикаторы кладутся в выдачу вкладки «Разбор IOC», а НЕ в кейс: что
 * заслуживает попасть в кейс, решает аналитик. Молча наполнять кейс
 * содержимым случайной страницы — способ засорить расследование.
 */
async function loadLastScan() {
  if (!ENV.isExtension) return;
  let last;
  try {
    last = await browser.runtime.sendMessage({ cmd: 'get-last-scan' });
  } catch (_) { return; }
  if (!last || !Array.isArray(last.iocs)) return;

  state.parsed = true;
  state.iocs = last.iocs;
  state.sourceUrl = last.pageUrl || '';
  state.inputSource = last.pageUrl
    ? `${last.source}: ${shortHost(last.pageUrl)}` : (last.source || 'страница');

  // Тот же отсев обвязки, что и при заборе по ссылке.
  TINoise.markNoise(state.iocs, { sourceHost: TINoise.sourceHostOf(state.sourceUrl) });
  /* Разбора по структуре документа здесь НЕТ намеренно: сюда приходит
   * результат разбора СТРАНИЦЫ, а не текст. Текста под рукой нет, и
   * передавать сюда несуществующую переменную — способ уронить консоль
   * на ровном месте. Колонтитулы ищутся там, где есть документ. */
  state.selected = new Set(state.iocs
    .filter((i) => !i.noise && !inActiveCase(i)).map(iocKey));

  const dropped = state.iocs.filter((i) => i.noise).length;

  /* «со страницы» и «из выделенного» — разные вещи, и путать их нельзя.
   * Разобрав выделенный фрагмент, аналитик получает результат ПО ЭТОМУ
   * фрагменту; надпись «со страницы» заставила бы его думать, что
   * разобрана вся страница, и считать отсутствие остальных индикаторов
   * фактом. */
  const what = last.source === 'выделение' ? 'из выделенного фрагмента' : 'со страницы';
  $('#parse-stat').textContent =
    `${state.iocs.length - dropped} индикаторов ${what}`
    + (dropped ? ` · ${dropped} отсеяно как обвязка` : '')
    + (last.pageUrl ? ` · ${last.pageUrl.slice(0, 90)}` : '');
  $('#parse-stat').className = 'parse-stat';
  renderResults();

  if (state.timeline.length) {
    logEvent('source.parsed', {
      source: state.inputSource,
      found: state.iocs.length - dropped,
      noise: dropped,
      url: state.sourceUrl || undefined,
    });
  }
  syncFox();

  // Историю чистим, чтобы обновление страницы не подтягивало старый разбор.
  history.replaceState(null, '', location.pathname);

  toast(state.iocs.length - dropped
    ? `${last.source === 'выделение' ? 'Из выделенного' : 'Со страницы'}: `
      + `${state.iocs.length - dropped} индикаторов`
    : `${last.source === 'выделение' ? 'В выделенном фрагменте' : 'На странице'} `
      + 'индикаторов не найдено', 3200);
}

/* ------------------------------------------------- ИСТОЧНИК: ССЫЛКА ---- */

/**
 * Забрать страницу по ссылке и разобрать её текст.
 *
 * Разрешение <all_urls> запрашивается ЗДЕСЬ, при первом использовании,
 * а не выдаётся при установке. Расширение, которому при установке выдали
 * доступ ко всем сайтам, ничем не отличается от тех, которые мы блокируем
 * политикой; выдавать его себе молча было бы двойным стандартом.
 */
async function fetchByUrl() {
  const raw = $('#smart-url').value.trim();
  if (!raw) { toast('Вставьте ссылку'); return; }

  const btn = $('#btn-fetch-url');
  const stat = $('#parse-stat');

  // ensurePermission должен быть ПЕРВЫМ await: иначе жест пользователя
  // теряется и Firefox отклоняет запрос без диалога (см. lib/fetchpage.js).
  let allowed;
  try {
    allowed = await TIFetch.ensurePermission();
  } catch (e) {
    allowed = false;
  }
  if (!allowed) {
    stat.textContent = 'без доступа к сайтам забрать страницу нельзя — разрешение не выдано';
    stat.className = 'parse-stat is-warn';
    return;
  }

  btn.disabled = true;
  stat.className = 'parse-stat';
  stat.textContent = 'забираю страницу…';
  // Забор идёт секунды — здесь бегущая лиса действительно показывает,
  // что инструмент занят, а не завис.
  const foxDone = foxBusy();
  try {
    const page = await TIFetch.fetchPageText(raw);
    $('#smart-input').value = page.text;
    state.sourceUrl = page.url;
    state.inputSource = 'страница ' + shortHost(page.url);
    clearOcr();
    parseInput();

    // Редирект показываем отдельной строкой. Уехали на другой домен —
    // это факт об инфраструктуре, а не техническая мелочь.
    const extra = [];
    if (page.redirected) extra.push('после редиректа: ' + page.url);
    if (page.title) extra.push('«' + page.title.slice(0, 80) + '»');
    if (extra.length) $('#parse-stat').textContent += ' · ' + extra.join(' · ');

    /* Оговорки по самому забору — отдельной заметной плашкой.
     *
     * Это не украшение. «0 индикаторов» — утверждение о СТРАНИЦЕ,
     * а если статью мы не прочитали, то утверждать нам нечего.
     * Разница между «на странице их нет» и «мы её не прочитали»
     * решает, пойдёт аналитик дальше или закроет вопрос. */
    renderFetchNotes(page.notes || []);
    foxDone(false);
  } catch (e) {
    stat.textContent = 'не получилось: ' + String(e.message || e).slice(0, 200);
    stat.className = 'parse-stat is-warn';
    foxDone(true);      // лиса засыпает: сбой не должен выглядеть как простой
  } finally {
    btn.disabled = false;
  }
}

/** Плашка с оговорками по забранной странице. */
function renderFetchNotes(notes) {
  const box = $('#fetch-notes');
  if (!box) return;
  box.textContent = '';
  if (!notes.length) { box.hidden = true; return; }
  box.hidden = false;
  for (const n of notes) {
    const p = document.createElement('p');
    p.className = 'fetch-note';
    p.textContent = n;
    box.append(p);
  }
}

function shortHost(u) {
  try { return new URL(u).host; } catch (_) { return u.slice(0, 40); }
}

/* ------------------------------------------------ РИСКИ ЗАБОРА -------- */

/* Хосты, которые аналитик УЖЕ расследует: из текущей выдачи и из активного
 * кейса. Нужны, чтобы отличить «забираю статью вендора» от «забираю панель
 * управления, которую сам же и разбираю». */
function knownHosts() {
  const out = new Set();
  const add = (v) => {
    if (!v) return;
    try {
      if (/^https?:\/\//i.test(v)) out.add(new URL(v).hostname.toLowerCase());
      else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) out.add(v.toLowerCase());
    } catch (_) { /* значение не адрес — не наша забота */ }
  };
  for (const i of state.iocs || []) if (i.type === 'url' || i.type === 'domain') add(i.value);
  for (const i of state.caseItems || []) if (i.type === 'url' || i.type === 'domain') add(i.value);
  return [...out];
}

/* Предупреждения показываются ПОД полем и только когда относятся к тому,
 * что аналитик набрал. Постоянного баннера здесь нет намеренно: он висел
 * всегда и потому не читался — а вместе с ним не читалось бы и это. */
function renderUrlRisks() {
  const box = $('#url-warn');
  if (!box || !state.urlFetchAllowed || !globalThis.TIFetch) return;
  const raw = $('#smart-url').value.trim();
  if (!raw) { box.hidden = true; box.textContent = ''; return; }

  const risks = [];
  /* Внутренний контур — это отказ, а не предупреждение, и сказать о нём
   * надо до нажатия кнопки, а не после. */
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).hostname;
    const внутр = TIFetch.internalHostReason(host);
    if (внутр) risks.push({ stop: true, text: внутр });
  } catch (_) { /* ещё не дописал адрес */ }

  if (!risks.length) {
    for (const t of TIFetch.fetchRisks(raw, knownHosts())) risks.push({ stop: false, text: t });
  }

  box.textContent = '';
  if (!risks.length) { box.hidden = true; return; }
  box.hidden = false;
  box.className = 'src-warn' + (risks.some((r) => r.stop) ? ' is-stop' : '');
  for (const r of risks) {
    const p = document.createElement('p');
    p.className = 'src-warn-line';
    p.textContent = (r.stop ? 'Забрать нельзя: ' : '') + r.text;
    box.append(p);
  }
}

/* ------------------------------------------------ ИСТОЧНИК: ФАЙЛ ------- */

/* Один путь для кнопки «Загрузить файл» и для перетаскивания: раньше
 * это были две копии одного кода, и добавлять в них PDF пришлось бы
 * дважды — то есть однажды забыть.
 *
 * PDF опознаётся по СОДЕРЖИМОМУ (`%PDF-` в начале), а не по расширению:
 * отчёт, сохранённый как `report.pdf.txt`, и `report` без расширения
 * встречаются чаще, чем хотелось бы. */
async function loadFileIntoInput(f) {
  clearOcr();
  state.sourceUrl = '';

  const head = new Uint8Array(await f.slice(0, 5).arrayBuffer());
  const этоPdf = String.fromCharCode(...head) === '%PDF-';

  if (!этоPdf) {
    $('#smart-input').value = await f.text();
    state.inputSource = 'файл ' + f.name;
    renderFetchNotes([]);
    parseInput();
    return;
  }

  if (!globalThis.TIPdf) {
    renderFetchNotes([`${f.name}: разбор PDF недоступен в этой сборке — `
      + 'сохраните текст из PDF и вставьте его в поле.']);
    toast('Разбор PDF недоступен в этой сборке');
    return;
  }

  const stat = $('#parse-stat');
  const foxDone = foxBusy();
  if (stat) { stat.textContent = 'читаю PDF…'; stat.className = 'parse-stat'; }

  let r;
  try {
    r = await TIPdf.extract(await f.arrayBuffer(), {
      /* В расширении путь даёт runtime.getURL. В демо-сборке расширения
       * нет, и база подставляется сборщиком (__tiVendorBase): демо лежит
       * в dist/, а vendor/ — в extension/. */
      getURL: (p) => (ENV.isExtension
        ? browser.runtime.getURL(p)
        : (globalThis.__tiVendorBase || '../') + p),
      onPage: (n, всего) => {
        if (stat) stat.textContent = `читаю PDF: страница ${n} из ${всего}…`;
      },
    });
  } catch (e) {
    r = { error: String(e && e.message || e) };
  } finally {
    foxDone();
  }

  const note = TIPdf.describe(r, f.name);

  /* Пустой результат НИКОГДА не уходит в разбор молча: «0 индикаторов»
   * на скане неотличимо от «их там нет», и разница решает, пойдёт
   * аналитик дальше или закроет вопрос. */
  if (r.error || r.encrypted || r.imagesOnly || !String(r.text || '').trim()) {
    renderFetchNotes([note || `${f.name}: текст из PDF не получен`]);
    if (stat) { stat.textContent = 'из PDF текст не получен'; stat.className = 'parse-stat is-warn'; }
    state.foxError = true;
    syncFox();
    toast(r.imagesOnly ? 'В PDF нет текстового слоя — это скан' : 'Текст из PDF не получен');
    return;
  }

  state.foxError = false;
  $('#smart-input').value = r.text;
  state.inputSource = 'PDF ' + f.name;
  renderFetchNotes([note]);
  parseInput();
}

/* ----------------------------------------------- ИСТОЧНИК: КАРТИНКА ---- */

function clearOcr() {
  state.ocr = null;
  const block = $('#ocr-block');
  if (!block) return;
  block.hidden = true;
  const img = $('#ocr-image');
  if (img.src && img.src.startsWith('data:')) img.removeAttribute('src');
  $('#ocr-unclear').hidden = true;
  $('#ocr-unclear').textContent = '';
  $('#ocr-stat').textContent = '';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('не удалось прочитать файл'));
    r.readAsDataURL(file);
  });
}

/**
 * Распознать текст с картинки и разобрать его на индикаторы.
 *
 * Разделение ответственности здесь принципиальное:
 *   модель отвечает ТОЛЬКО за «что написано на картинке»;
 *   индикаторы из распознанного текста достаёт тот же детерминированный
 *   парсер, что и из любого другого текста.
 * Если бы список индикаторов выдавала модель, проверить его было бы нечем.
 * Так — она может ошибиться в символе, но не может придумать индикатор,
 * который не проходит проверку формы.
 *
 * Картинка уходит стороннему провайдеру целиком. Это тот же размен, что
 * и с текстом, и он под тем же TLP-гейтом — со скриншота инцидента
 * у клиента наружу уедет всё, что на нём видно, включая то, что аналитик
 * не заметил: имена хостов, учётки, фрагменты писем.
 */
async function runImageOcr(file) {
  if (!file) return;
  if (state.tlp === 'client') {
    toast('В режиме клиентских данных распознавание запрещено: картинка уйдёт целиком');
    return;
  }
  if (!state.modelReady) { toast('Модель недоступна — распознавать нечем'); return; }

  const stat = $('#ocr-stat');
  $('#ocr-block').hidden = false;
  stat.className = 'parse-stat';
  stat.textContent = 'распознаю…';

  try {
    const dataUrl = await fileToDataUrl(file);
    $('#ocr-image').src = dataUrl;

    const m = await ENV.loadManaged();
    let res;
    if (state.directLlm) {
      res = await TIAnalyze.runOcr(state.directLlm, dataUrl);
    } else {
      // Через сервер: он же держит ключ и квоту. Тело то же самое.
      const r = await fetch(new URL('/api/v1/analyze/ocr', m.apiUrl), {
        method: 'POST',
        headers: ENV.authHeaders(m),
        body: JSON.stringify({ image: dataUrl, tlp: state.tlp }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail || ('HTTP ' + r.status));
      }
      res = await r.json();
    }

    state.ocr = { dataUrl, text: res.text, unclear: res.unclear || [] };
    $('#smart-input').value = res.text;
    state.inputSource = 'картинка (распознано моделью)';
    state.sourceUrl = '';

    renderOcrUnclear(res.unclear || []);
    stat.textContent = `${(res.elapsed_ms / 1000).toFixed(1)} с · ${res.model}`
      + ` · ${(res.image_bytes / 1024).toFixed(0)} КБ`;

    if (!res.text.trim()) {
      stat.textContent += ' · текста на картинке не найдено';
      stat.className = 'parse-stat is-warn';
      return;
    }
    parseInput();
  } catch (e) {
    stat.textContent = 'ошибка: ' + String(e.message || e).slice(0, 200);
    stat.className = 'parse-stat is-warn';
  }
}

/* Список «в чём модель не уверена» — единственное место, где она сама
 * сообщает, где угадывала. Прятать его под спойлер нельзя: это и есть
 * замена проверке цитат, которой здесь быть не может. */
function renderOcrUnclear(list) {
  const box = $('#ocr-unclear');
  box.textContent = '';
  if (!list.length) {
    box.hidden = false;
    box.className = 'ocr-unclear is-ok';
    box.textContent = 'Модель не отметила сомнительных фрагментов. Это её оценка, а не проверка.';
    return;
  }
  box.hidden = false;
  box.className = 'ocr-unclear is-warn';
  const h = document.createElement('strong');
  h.textContent = `Модель не уверена в ${list.length} фрагмент(ах) — сверьте их с картинкой в первую очередь:`;
  box.append(h);
  const ul = document.createElement('ul');
  for (const frag of list.slice(0, 20)) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = frag;
    li.append(code);
    ul.append(li);
  }
  box.append(ul);
}

/* Есть ли значение в активном кейсе. Возвращает саму запись —
 * вызывающему коду нужен ещё и вердикт из неё. */
function inActiveCase(ioc) {
  const k = iocKey(ioc);
  return state.caseItems.find((i) => iocKey(i) === k) || null;
}

function renderResults() {
  /* Список «уже расследуемых» хостов меняется с каждым разбором, а от него
   * зависит предупреждение под полем ссылки. Пересчитываем здесь, иначе
   * оно показывало бы состояние прошлого разбора. */
  if (typeof renderUrlRisks === 'function') renderUrlRisks();
  const box = $('#smart-results');
  box.textContent = '';
  $('#bulk-bar').hidden = state.iocs.length === 0;

  if (!state.iocs.length) {
    /* Два РАЗНЫХ пустых состояния, и путать их нельзя.
     *
     * «Не найдены» — результат разбора, факт о тексте.
     * «Ещё ничего не разбирали» — отсутствие действия.
     * Раньше и то и другое выглядело одинаково пустым полем. */
    if (state.parsed) {
      box.innerHTML = '<p class="empty">Индикаторы не найдены.</p>';
    } else {
      renderIdleFox(box);
      return;
    }
    return;
  }

  /* Сначала индикаторы, потом обвязка. Порядок не косметический:
   * аналитик читает сверху вниз, и первым он должен увидеть то,
   * ради чего разбирал. */
  const clean = state.iocs.filter((i) => !i.noise);
  const junk = state.iocs.filter((i) => i.noise);

  let lastType = null;
  for (const ioc of clean) {
    if (ioc.type !== lastType) {
      const h = document.createElement('div');
      h.className = 'ioc-group-title';
      h.textContent = ioc.typeLabel;
      box.append(h);
      lastType = ioc.type;
    }

    const key = iocKey(ioc);
    const card = document.createElement('div');
    /* «Уже в кейсе» — про АКТИВНЫЙ кейс, и только про него.
     *
     * Это безопасная часть отложенной идеи «новое против известного»:
     * сравнение идёт с тем, что аналитик сам собрал по этому клиенту,
     * и ничего никуда не накапливается. Накопление по всем кейсам
     * сразу — другой вопрос, и он решается не здесь.
     *
     * Карточка не прячется, а приглушается: спрятать найденное —
     * это второй способ соврать аналитику. */
    const already = inActiveCase(ioc);
    card.className = already ? 'ioc in-case' : 'ioc';

    // --- шапка карточки -------------------------------------------------
    const head = document.createElement('div');
    head.className = 'ioc-head';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = state.selected.has(key);
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      chk.checked ? state.selected.add(key) : state.selected.delete(key);
    });

    const badges = [];
    if (already) {
      const v = VERDICTS[already.verdict] ? VERDICTS[already.verdict].label : 'не проверен';
      badges.push(`<span class="in-case-mark">уже в кейсе: ${v}</span>`);
    }
    if (ioc.count > 1)  badges.push(`<span class="badge badge-count">×${ioc.count}</span>`);
    if (ioc.defanged)   badges.push('<span class="badge badge-defang">defanged</span>');
    for (const f of ioc.flags || []) {
      const warn = f.startsWith('non-routable') || f.startsWith('ambiguous');
      badges.push(`<span class="badge ${warn ? 'badge-warn' : ''}">${f}</span>`);
    }

    head.append(chk);
    head.insertAdjacentHTML('beforeend',
      `<span class="ioc-type">${ioc.type}</span>` +
      `<span class="ioc-value"></span>` +
      `<span class="ioc-badges">${badges.join('')}</span>`);
    head.querySelector('.ioc-value').textContent = ioc.value;   // textContent = защита от XSS
    head.addEventListener('click', () => card.classList.toggle('is-open'));

    // --- тело карточки: подходящие инструменты --------------------------
    const body = document.createElement('div');
    body.className = 'ioc-body';

    if (ioc.context) {
      const ctx = document.createElement('div');
      ctx.className = 'ioc-context';
      ctx.textContent = '…' + ioc.context + '…';
      body.append(ctx);
    }

    /* ДВЕ ФОРМЫ ДЛЯ СКЛЕЕННОГО ЗНАЧЕНИЯ.
     *
     * Пометка `ambiguous:wrap` сама по себе была тупиком: аналитик видит
     * «это догадка» и не может её проверить — исходного PDF под рукой
     * может уже не быть, текст пришёл из буфера. Поэтому здесь показаны
     * обе формы: как было в тексте и что из этого собралось. Решение
     * остаётся за человеком, но теперь оно основано на том, что он видит. */
    if (Array.isArray(ioc.wrapSource) && ioc.wrapSource.length > 1) {
      const box = document.createElement('div');
      box.className = 'wrap-proof';

      const h = document.createElement('div');
      h.className = 'wrap-proof-head';
      h.textContent = 'Склеено из переноса — проверьте, так ли это:';
      box.append(h);

      const src = document.createElement('div');
      src.className = 'wrap-proof-row';
      const srcLabel = document.createElement('span');
      srcLabel.className = 'wrap-proof-label';
      srcLabel.textContent = 'как в исходнике';
      const srcVal = document.createElement('code');
      srcVal.className = 'wrap-proof-val';
      // Каждая исходная строка — своей строкой: в этом весь смысл показа.
      srcVal.textContent = ioc.wrapSource.join('\n');
      src.append(srcLabel, srcVal);

      const got = document.createElement('div');
      got.className = 'wrap-proof-row';
      const gotLabel = document.createElement('span');
      gotLabel.className = 'wrap-proof-label';
      gotLabel.textContent = 'как склеено';
      const gotVal = document.createElement('code');
      gotVal.className = 'wrap-proof-val';
      gotVal.textContent = ioc.value;
      got.append(gotLabel, gotVal);

      box.append(src, got);
      body.append(box);
    }

    const tools = toolsForType(ioc.type).filter(isToolAllowed);
    const chips = document.createElement('div');
    chips.className = 'tool-chips';

    if (!tools.length) {
      chips.innerHTML = '<span class="no-tools">Нет инструментов для этого типа в текущем режиме данных.</span>';
    } else {
      // Внутренние источники всегда первыми: проверка «а не отработано ли уже».
      const order = { internal: 0, limited: 1, public: 2 };
      tools.sort((a, b) => order[a.exposure] - order[b.exposure] || a.name.localeCompare(b.name));
      for (const t of tools) {
        const a = document.createElement('a');
        a.className = 'chip' + (t.activity === 'active' ? ' chip-active-warn' : '');
        a.href = buildUrl(t, ioc.value);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = `${t.note || ''}\n[${t.exposure}/${t.activity}]`;
        a.innerHTML = `<i class="dot dot-${t.exposure === 'internal' ? 'internal' : t.exposure === 'limited' ? 'limited' : 'public'}"></i>`;
        a.append(document.createTextNode(t.name));
        a.insertAdjacentHTML('beforeend', pricingTags(t, true));
        chips.append(a);
      }
    }
    body.append(chips);

    /* Кнопка плейбука в карточке — рядом со списком сервисов, а не вместо
     * него. Список отвечает на вопрос «куда можно сходить», плейбук —
     * «куда обычно ходят в таком случае и в каком порядке». */
    const pbs = playbooksFor(new Set([ioc.type]));
    if (pbs.length) {
      const row = document.createElement('div');
      row.className = 'ioc-playbook';
      const b = document.createElement('button');
      b.className = 'btn btn-mini';
      b.textContent = pbs.length === 1 ? `Плейбук: ${pbs[0].name}` : 'Плейбук…';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pbs.length === 1) runPlaybook(pbs[0].id, ioc.value, ioc.type);
        else showPlaybookMenu(b, ioc.value, ioc.type);
      });
      row.append(b);
      body.append(row);
    }

    card.append(head, body);
    box.append(card);
  }

  if (junk.length) renderNoiseGroup(box, junk);
}

/* Отсеянное. Свёрнуто, но на виду и с причиной по каждой записи.
 *
 * Здесь важны две вещи сразу: не мешать (поэтому свёрнуто и без галочек)
 * и не прятать (поэтому видно число, причины и есть кнопка вернуть).
 * Аналитик, разбирающий взлом самого вендора, должен иметь возможность
 * достать отсюда домен вендора одним щелчком. */
function renderNoiseGroup(box, junk) {
  const det = document.createElement('details');
  det.className = 'noise-group';

  const sum = document.createElement('summary');
  sum.textContent = `Отсеяно как обвязка страницы: ${junk.length}`;
  const hint = document.createElement('span');
  hint.className = 'noise-hint';
  hint.textContent = ' — площадки и адреса источника, колонтитулы, раздел ссылок.'
                   + ' У каждой строки написана причина. Разверните, если нужно';
  sum.append(hint);
  det.append(sum);

  const body = document.createElement('div');
  body.className = 'noise-body';

  for (const i of junk) {
    const row = document.createElement('div');
    row.className = 'noise-row';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = state.selected.has(iocKey(i));
    chk.addEventListener('change', () => {
      chk.checked ? state.selected.add(iocKey(i)) : state.selected.delete(iocKey(i));
    });

    const t = document.createElement('span');
    t.className = 'ioc-type';
    t.textContent = i.type;
    const v = document.createElement('span');
    v.className = 'noise-val';
    v.textContent = i.value;
    const why = document.createElement('span');
    why.className = 'noise-why';
    why.textContent = i.noiseReason || '';

    row.append(chk, t, v, why);
    body.append(row);
  }

  const all = document.createElement('button');
  all.className = 'btn btn-mini';
  all.textContent = 'Вернуть всё в выдачу';
  all.addEventListener('click', () => {
    for (const i of junk) { i.noise = false; delete i.noiseReason; state.selected.add(iocKey(i)); }
    renderResults();
    toast(`Возвращено: ${junk.length}`);
  });
  body.append(all);

  det.append(body);
  box.append(det);
}

/* Массовое открытие: ограничиваем частоту, иначе Firefox схлопнет вкладки
 * как popup-flood, а внешние сервисы отдадут 429. */
async function openSelectedIn(toolId) {
  const tool = state.registry.tools.find((t) => t.id === toolId);
  const targets = state.iocs.filter((i) => state.selected.has(iocKey(i)) && tool.types.includes(i.type));
  if (!targets.length) { toast('Нет выбранных индикаторов подходящего типа'); return; }
  if (targets.length > 15 &&
      !confirm(`Будет открыто ${targets.length} вкладок в «${tool.name}». Продолжить?`)) return;

  for (const [n, i] of targets.entries()) {
    ENV.openTab(buildUrl(tool, i.value), false);
    if (n % 5 === 4) await new Promise((r) => setTimeout(r, 400));
  }
  toast(`Открыто вкладок: ${targets.length}`);
  logEvent('tools.opened', {
    count: targets.length,
    value: targets.length === 1 ? targets[0].value : `${tool.name} (${targets.length} значений)`,
  });
}

function showOpenMenu() {
  const menu = $('#open-menu');
  if (!menu.hidden) { menu.hidden = true; return; }

  const selTypes = new Set(state.iocs.filter((i) => state.selected.has(iocKey(i))).map((i) => i.type));
  const applicable = state.registry.tools
    .filter((t) => isToolAllowed(t) && t.types.some((ty) => selTypes.has(ty)));

  menu.textContent = '';
  if (!applicable.length) { menu.innerHTML = '<button disabled>Нет подходящих инструментов</button>'; }
  for (const t of applicable) {
    const n = state.iocs.filter((i) => state.selected.has(iocKey(i)) && t.types.includes(i.type)).length;
    const b = document.createElement('button');
    b.textContent = `${t.name} — ${n} шт.`;
    b.addEventListener('click', () => { menu.hidden = true; openSelectedIn(t.id); });
    menu.append(b);
  }
  menu.hidden = false;
}

/* Кнопки «предложить инструмент» здесь нет намеренно.
 *
 * Рассматривалась (у Sputnik аналитик добавляет свои сервисы) и отклонена
 * решением SOC: реестр закрыт и меняется только новой сборкой политики.
 *
 * Причина в том, что у записи реестра есть поля exposure и api, на которых
 * держатся TLP-гейт и лицензионная чистота автоматического обогащения.
 * Запись, появившаяся мимо ревью, этих полей не имеет — значит, в режиме
 * клиентских данных она НЕ СКРОЕТСЯ, потому что система не знает, что
 * сервис публичный. Один такой сервис обесценивает весь гейт.
 *
 * Форма-заявка была бы полумерой: она всё равно порождает в интерфейсе
 * путь «я могу добавить». Аналитик, нашедший полезный сервис, сообщает
 * словами; решение принимается вне расширения.
 * ==================================================================== */

/* Маленькая лиса в шапке.
 *
 * Отличие от большой: эта живёт ВСЕГДА. Большая уходит при первом
 * результате — место рядом с индикаторами занимать нельзя, — и после
 * разбора страница становится сплошной таблицей. Шапка видна на всех
 * трёх вкладках консоли, поэтому лиса там не исчезает вместе с пустым
 * состоянием.
 *
 * Масштаб 2 (32 пикселя) подобран под высоту шапки: больше — строка
 * разъезжается, меньше — морда перестаёт читаться.
 *
 * Сдвиг последовательности обязателен. Без него обе лисы моргают
 * одновременно, и это выглядит не как две лисы, а как одна анимация,
 * продублированная по ошибке. */
const BRAND_FOX_OFFSET = 3;
let brandFoxHandle = null;
function startBrandFox() {
  const canvas = $('#brand-fox');
  if (!canvas || !globalThis.TIFox) return;
  if (brandFoxHandle) brandFoxHandle.stop();
  brandFoxHandle = TIFox.startFox(canvas, { scale: 2, offset: BRAND_FOX_OFFSET });
  syncFox();
}

/* ЛИСА В ШАПКЕ КАК ИНДИКАТОР СОСТОЯНИЯ.
 *
 * Самое полезное здесь — намордник: режим «клиентские данные» иначе
 * виден только в выпадающем списке, а перепутать его дорого. Остальные
 * состояния честнее назвать приятными: «бежит» при разборе и «спит»
 * после сбоя.
 *
 * Лиса — ВТОРОЙ индикатор, а не единственный: у неё есть подпись
 * в title, список режима никуда не девается, а решение «можно ли
 * отправить наружу» принимает TLP-гейт. Значок, смысл которого надо
 * помнить наизусть, — это украшение.
 *
 * MIN_BUSY_MS: разбор вставленного текста занимает миллисекунды, и без
 * удержания «бег» превратился бы в мигание на один кадр — то есть
 * в дефект, который каждый видит и никто не может описать. */
const MIN_BUSY_MS = 700;
let busyUntil = 0;
let busyTimer = null;

function syncFox() {
  if (!brandFoxHandle || !globalThis.TIFox) return;
  const name = TIFox.foxStateFor({
    error: state.foxError,
    busy: state.foxBusy || Date.now() < busyUntil,
    tlp: state.tlp,
    found: state.iocs.filter((i) => !i.noise).length,
  });
  brandFoxHandle.setState(name);
  const canvas = $('#brand-fox');
  if (canvas) canvas.title = 'TI Console: ' + brandFoxHandle.label();
}

/** Разбор начался. Возвращает функцию «разбор закончился». */
function foxBusy() {
  state.foxBusy = true;
  state.foxError = false;
  busyUntil = Date.now() + MIN_BUSY_MS;
  syncFox();
  return (failed) => {
    state.foxBusy = false;
    state.foxError = !!failed;
    clearTimeout(busyTimer);
    // Досидеть минимальное время бега, иначе кадр мелькнёт и исчезнет.
    busyTimer = setTimeout(syncFox, Math.max(0, busyUntil - Date.now()) + 20);
    syncFox();
  };
}

/* Заставка пустого состояния.
 *
 * Показывается, пока ничего не разбирали, и исчезает при первом же
 * результате: место рядом с индикаторами занимать нельзя.
 * Разбор кадров и причины такой реализации — в newtab/fox.js. */
let foxHandle = null;
function renderIdleFox(box) {
  box.textContent = '';
  if (foxHandle) { foxHandle.stop(); foxHandle = null; }

  const wrap = document.createElement('div');
  wrap.className = 'idle-fox';

  const canvas = document.createElement('canvas');
  canvas.className = 'fox-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  wrap.append(canvas);

  const hint = document.createElement('p');
  hint.className = 'idle-hint';
  hint.textContent = 'Вставьте отчёт, лог или выгрузку — или заберите страницу по ссылке.';
  const keys = document.createElement('p');
  keys.className = 'idle-keys';
  keys.textContent = 'Ctrl+K — инструменты, плейбуки и действия · Ctrl+Enter — разобрать';
  wrap.append(hint, keys);

  box.append(wrap);
  if (globalThis.TIFox) foxHandle = TIFox.startFox(canvas, { scale: 5 });
}

/* ================================================ ИНСТРУМЕНТЫ ТЕКСТА ===
 *
 * Зачем это здесь, а не в CyberChef: там аналитик вставляет содержимое
 * расследования в чужой сайт. Для отчёта вендора безразлично, для
 * командной строки из инцидента клиента — нет.
 *
 * Все операции — чистые вычисления в lib/textools.js, без сети.
 * Здесь только интерфейс: взять поле ввода, применить, сказать что
 * сделано и дать откатить.
 *
 * ВАЖНОЕ РЕШЕНИЕ: результат КЛАДЁТСЯ В ПОЛЕ ВВОДА и сразу разбирается
 * на индикаторы. Смысл раскодированной команды не в самой строке,
 * а в адресах внутри неё, и дополнительный клик здесь был бы лишним.
 * Поэтому же обязателен откат: замена содержимого поля без возврата —
 * потеря данных аналитика.
 * ==================================================================== */

let textToolsUndo = null;

function ttNote(text, warn) {
  const el = $('#tt-note');
  if (!el) return;
  el.textContent = text;
  el.className = warn ? 'textools-note is-warn' : 'textools-note';
  el.hidden = !text;
}

function ttOut(rows) {
  const box = $('#tt-out');
  if (!box) return;
  box.textContent = '';
  if (!rows || !rows.length) { box.hidden = true; return; }
  const table = document.createElement('table');
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = k;
    const td2 = document.createElement('td');
    td2.textContent = v;          // никакого innerHTML: здесь чужой текст
    tr.append(td1, td2);
    table.append(tr);
  }
  box.append(table);
  box.hidden = false;
}

/** Заменить содержимое поля с возможностью вернуть. */
function ttReplace(text, note) {
  const input = $('#smart-input');
  textToolsUndo = input.value;
  $('#tt-undo').hidden = false;
  input.value = text;
  ttNote(note);
  ttOut(null);
  parseInput();
}

function ttUndo() {
  if (textToolsUndo === null) return;
  $('#smart-input').value = textToolsUndo;
  textToolsUndo = null;
  $('#tt-undo').hidden = true;
  ttNote('Содержимое поля возвращено.');
  ttOut(null);
}

function ttBase64() {
  const src = $('#smart-input').value;
  if (!src.trim()) { ttNote('Поле пустое.', true); return; }

  /* Сначала ищем закодированные куски ВНУТРИ текста: в отчёте base64
   * почти всегда стоит внутри командной строки, а не один в поле. */
  const found = TIText.findBase64(src);
  if (found.length) {
    let out = src;
    const notes = [];
    for (const f of found.slice(0, 20)) {
      const d = TIText.decodeBase64(f.value);
      if (!d.ok) continue;
      // Раскодированное ДОБАВЛЯЕТСЯ к тексту, а не затирает его:
      // исходная команда нужна для отчёта в том виде, как была.
      out += `\n\n[раскодировано, ${d.encoding}, ${d.bytes} байт, ${f.from}]\n${d.chosen}`;
      notes.push(`${f.from}: ${d.encoding}` + (d.note ? ` — ${d.note}` : ''));
    }
    if (!notes.length) { ttNote('Похожие на base64 строки есть, но ни одна не раскодировалась.', true); return; }
    ttReplace(out, `Раскодировано вставок: ${notes.length}. ${notes[0]}`);
    return;
  }

  // Иначе пробуем всё поле как одну строку base64.
  const d = TIText.decodeBase64(src.trim());
  if (!d.ok) {
    ttNote('В поле не найдено ни строки base64. Хеши из отчёта base64 не являются, '
         + 'хотя и подходят по алфавиту — поэтому они здесь не предлагаются.', true);
    return;
  }
  ttReplace(d.chosen, `Раскодировано как ${d.encoding}, ${d.bytes} байт.`
    + (d.note ? ' ' + d.note : ''));
}

function ttUrlDecode() {
  const r = TIText.decodeUrl($('#smart-input').value);
  if (!r.ok) { ttNote(r.error, true); return; }
  if (r.value === $('#smart-input').value) { ttNote('Кодирования не обнаружено — текст не изменился.'); return; }
  ttReplace(r.value, 'URL-кодирование снято.');
}

function ttHex() {
  const r = TIText.hexToText($('#smart-input').value);
  if (!r.ok) { ttNote(r.error, true); return; }
  ttReplace(r.value, `Раскодировано из hex, ${r.bytes} байт.`);
}

function ttDedupe() {
  const d = TIText.dedupeList($('#smart-input').value);
  if (!d.unique) { ttNote('В поле нет значений для дедупликации.', true); return; }
  const byType = Object.entries(d.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}: ${n}`).join(', ');
  ttReplace(d.items.map((i) => i.value).join('\n'),
    `Было ${d.total}, осталось ${d.unique} (повторов ${d.duplicates}). По типам — ${byType}.`);
}

/* Сравнение двух списков: «что добавилось в обновлённом отчёте».
 *
 * Результат кладётся в вывод, а НЕ в поле ввода: в отличие от
 * раскодирования, здесь исходный список нужен целиком и портить его
 * нечем. Ничего не сохраняется — оба списка вставил человек. */
function ttDiff() {
  const older = $('#tt-diff-input').value;
  const newer = $('#smart-input').value;
  if (!older.trim()) { ttNote('Вставьте список для сравнения.', true); return; }
  const d = TIText.diffLists(older, newer, IOC);
  ttNote(`Было ${d.countA}, стало ${d.countB}. `
       + `Добавилось ${d.added}, исчезло ${d.removed}, общих ${d.common}. `
       + 'Сравнение по канонической форме: evil[.]com и evil.com — одно значение.');
  const cut = (a) => a.slice(0, 40).join('\n') + (a.length > 40 ? `\n…и ещё ${a.length - 40}` : '');
  ttOut([
    [`добавилось (${d.added})`, d.added ? cut(d.onlyB) : '—'],
    [`исчезло (${d.removed})`, d.removed ? cut(d.onlyA) : '—'],
    [`общих (${d.common})`, d.common ? cut(d.both) : '—'],
  ]);
}

async function ttHash() {
  const src = $('#smart-input').value;
  if (!src.length) { ttNote('Поле пустое.', true); return; }
  const h = await TIText.hashText(src);
  ttNote(`Хеши СОДЕРЖИМОГО ПОЛЯ (${h.bytes} байт). Это не хеш файла: `
       + 'чтобы посчитать файл, загрузите его кнопкой «Загрузить файл».'
       + (h.error ? ' ' + h.error : ''));
  ttOut([
    ['MD5', h.md5],
    ['SHA-1', h.sha1 || '—'],
    ['SHA-256', h.sha256 || '—'],
    ['SHA-512', h.sha512 || '—'],
  ]);
}

/* ================================================ КОМАНДНАЯ ПАЛИТРА ====
 *
 * 86 инструментов — это больше, чем можно найти глазами в дереве.
 * Фильтр в боковой панели есть, но до него надо дотянуться мышью,
 * а поиск инструмента случается десятки раз за смену.
 *
 * Палитра ищет по инструментам, плейбукам и действиям одновременно —
 * то есть отвечает на вопрос «я хочу сделать X», а не «где лежит X».
 * ==================================================================== */

/* Ранжирование намеренно простое и предсказуемое. Нечёткий поиск
 * в инструменте, где ошибка стоит открытой не той вкладки, вреден:
 * аналитик должен понимать, почему выдача такая. */
function paletteScore(text, q) {
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const word = t.split(/[\s\-/(]+/).some((w) => w.startsWith(q));
  if (word) return 60;
  if (t.includes(q)) return 40;
  return 0;
}

/** Переключение вкладки по имени. Клик по самой вкладке, чтобы не
 *  дублировать логику подсветки в двух местах. */
function switchTab(name) {
  const tab = $(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

function paletteItems() {
  const items = [];
  for (const t of state.registry.tools) {
    if (!isToolAllowed(t)) continue;      // TLP-гейт действует и здесь
    items.push({
      kind: 'инструмент', label: t.name,
      hint: (t.note || '').slice(0, 70),
      types: t.types,
      run: () => openToolWithPrompt(t),
    });
  }
  for (const pb of state.registry.playbooks || []) {
    items.push({
      kind: 'плейбук', label: pb.name, hint: `${pb.steps.length} шагов · ${pb.note || ''}`,
      types: pb.types,
      run: () => {
        const sel = state.iocs.filter((i) => state.selected.has(iocKey(i)));
        if (!sel.length) { toast('Сначала выберите индикаторы'); return; }
        runPlaybookOnSelected(pb.id);
      },
    });
  }
  const acts = [
    ['Разобрать поле ввода', () => parseInput()],
    ['Очистить поле ввода', () => $('#btn-clear').click()],
    ['Добавить выбранное в кейс', () => addSelectedToCase()],
    ['Экспорт CSV', () => $('#btn-export-csv').click()],
    ['Экспорт STIX 2.1', () => $('#btn-export-stix').click()],
    ['Скелет отчёта', () => $('#btn-report').click()],
    ['Кейс и отчёт', () => switchTab('case')],
    ['Разбор IOC', () => switchTab('smart')],
    ['Поиск по источникам', () => switchTab('global')],
  ];
  for (const [label, run] of acts) items.push({ kind: 'действие', label, hint: '', run });
  return items;
}

/** Инструмент из палитры запускается по значению, которое надо спросить. */
function openToolWithPrompt(tool) {
  const sel = state.iocs.filter((i) => state.selected.has(iocKey(i)) && tool.types.includes(i.type));
  if (sel.length) { openSelectedIn(tool.id); return; }
  // Ни одного подходящего выбранного — открываем сам сервис, без подстановки.
  // Спрашивать значение диалогом здесь хуже: аналитик уже в поиске,
  // и ещё одно модальное окно ломает темп.
  const bare = tool.url.replace(/\{\{ioc(_raw)?\}\}.*$/, '');
  ENV.openTab(bare, true);
  toast(`${tool.name} открыт без подстановки — не было выбранных индикаторов подходящего типа`, 3600);
}

let paletteIndex = 0;
let paletteVisible = [];

function openPalette() {
  $('#palette').hidden = false;
  const input = $('#palette-input');
  input.value = '';
  renderPalette('');
  input.focus();
}

function closePalette() {
  $('#palette').hidden = true;
  paletteVisible = [];
}

function renderPalette(q) {
  const box = $('#palette-list');
  box.textContent = '';
  const query = q.trim().toLowerCase();

  const all = paletteItems();
  paletteVisible = (query
    ? all.map((it) => ({ it, s: Math.max(paletteScore(it.label, query), paletteScore(it.kind, query) - 20) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.it.label.localeCompare(b.it.label))
        .map((x) => x.it)
    : all.filter((it) => it.kind !== 'инструмент')   // без запроса — только действия и плейбуки
  ).slice(0, 40);

  paletteIndex = 0;
  if (!paletteVisible.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Ничего не нашлось';
    box.append(p);
    return;
  }
  paletteVisible.forEach((it, n) => {
    const row = document.createElement('button');
    row.className = 'palette-row' + (n === 0 ? ' is-active' : '');
    const kind = document.createElement('span');
    kind.className = 'palette-kind';
    kind.textContent = it.kind;
    const label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = it.label;
    const hint = document.createElement('span');
    hint.className = 'palette-hint';
    hint.textContent = it.hint || '';
    row.append(kind, label, hint);
    row.addEventListener('click', () => { closePalette(); it.run(); });
    box.append(row);
  });
}

function movePalette(delta) {
  const rows = $$('.palette-row');
  if (!rows.length) return;
  rows[paletteIndex]?.classList.remove('is-active');
  paletteIndex = (paletteIndex + delta + rows.length) % rows.length;
  rows[paletteIndex].classList.add('is-active');
  rows[paletteIndex].scrollIntoView({ block: 'nearest' });
}

/* ======================================================= ПЛЕЙБУКИ ======
 *
 * Плейбук — именованная последовательность проверок под тип задачи.
 *
 * Смысл не в экономии кликов. «Проверка домена из фишинга» — это каждый
 * раз одна и та же последовательность, которую L1 держит в голове
 * или в личных заметках. На третьем пункте он отвлекается, и пропуск
 * НЕ ВИДЕН В ОТЧЁТЕ: отчёт выглядит одинаково независимо от того,
 * проверили crt.sh или нет.
 *
 * Плейбук делает порядок проверок одинаковым у всех и воспроизводимым.
 * Он лежит в реестре, то есть версионируется в Git и ревьюится, —
 * в отличие от личных заметок аналитика.
 *
 * ЧТО ПЛЕЙБУК НЕ ДЕЛАЕТ: он не принимает решений. Он открывает вкладки
 * в заданном порядке. Вердикт ставит аналитик — иначе это был бы
 * автоматический сканер, а к нему другие требования и другая цена ошибки.
 * ==================================================================== */

/* Планирование вынесено в lib/playbook.js и покрыто тестами: там
 * решается, какие шаги отбросит TLP-гейт, а ошибка в этом месте
 * означает отправку клиентского индикатора в публичный сервис. */
function playbooksFor(types) {
  return TIPlaybook.playbooksFor(state.registry && state.registry.playbooks, types);
}

function planPlaybook(pb, value, type) {
  return TIPlaybook.planPlaybook(pb, state.registry.tools, type, state.tlp);
}

async function runPlaybook(pbId, value, type) {
  const pb = (state.registry.playbooks || []).find((p) => p.id === pbId);
  if (!pb) { toast('Плейбук не найден'); return; }

  const { steps, skipped } = planPlaybook(pb, value, type);
  if (!steps.length) {
    toast(`«${pb.name}»: ни одного доступного шага${
      state.tlp === 'client' ? ' — все скрыты режимом клиентских данных' : ''}`);
    return;
  }

  if (steps.length > 8 &&
      !confirm(`«${pb.name}» откроет ${steps.length} вкладок по ${value}. Продолжить?`)) return;

  for (const [n, tool] of steps.entries()) {
    ENV.openTab(buildUrl(tool, value), false);
    // Тот же ограничитель, что у массового открытия: без паузы Firefox
    // считает это popup-flood и схлопывает вкладки.
    if (n % 5 === 4) await new Promise((r) => setTimeout(r, 400));
  }

  /* Пропущенные шаги называются вслух. Молчаливый пропуск хуже отсутствия
   * плейбука: аналитик считает, что проверка выполнена целиком, и в отчёте
   * это будет выглядеть именно так. */
  let msg = `«${pb.name}»: открыто ${steps.length}`;
  if (skipped.length) {
    const byTlp = skipped.filter((s) => s.why === 'скрыт режимом данных').length;
    msg += ` · пропущено ${skipped.length}`;
    if (byTlp) msg += ` (из них ${byTlp} — режим данных)`;
  }
  toast(msg, 4200);

  /* В хронологию идёт и число пропущенных шагов. Плейбук, у которого
   * половина шагов скрыта режимом данных, и плейбук, отработавший
   * целиком, — разная глубина проверки, и при передаче смены это
   * ровно тот факт, который иначе теряется. */
  logEvent('playbook.run', {
    playbook: pb.name, value,
    opened: steps.length, skipped: skipped.length,
  });
}

/** Меню плейбуков для одного индикатора или для выделенных. */
function showPlaybookMenu(anchorBtn, value, type) {
  const menu = $('#playbook-menu');
  if (!menu.hidden && menu.dataset.for === (value || '*')) { menu.hidden = true; return; }
  menu.dataset.for = value || '*';
  menu.textContent = '';

  const types = value ? new Set([type])
    : new Set(state.iocs.filter((i) => state.selected.has(iocKey(i))).map((i) => i.type));
  const list = playbooksFor(types);

  if (!list.length) {
    const b = document.createElement('button');
    b.disabled = true;
    b.textContent = 'Нет плейбуков для этих типов';
    menu.append(b);
  }

  for (const pb of list) {
    const b = document.createElement('button');
    // Показываем, сколько шагов реально выполнится, а не сколько объявлено:
    // в режиме клиентских данных это разные числа, и знать надо ДО нажатия.
    const probe = value ? planPlaybook(pb, value, type) : null;
    const count = probe ? `${probe.steps.length} из ${pb.steps.length}` : `${pb.steps.length} шагов`;
    b.textContent = `${pb.name} — ${count}`;
    b.title = pb.note || '';

    /* Плейбук, у которого в текущем режиме не осталось ни одного шага,
     * недоступен и объясняет почему. Дать нажать и ничего не сделать —
     * худший вариант: аналитик решит, что проверка выполнена. */
    if (probe && !probe.steps.length) {
      b.disabled = true;
      b.textContent = `${pb.name} — недоступен`;
      b.title = state.tlp === 'client'
        ? 'Все шаги — публичные сервисы. В режиме клиентских данных '
          + 'отправлять туда индикатор клиента нельзя.'
        : 'Ни один шаг не подходит к этому типу индикатора';
      menu.append(b);
      continue;
    }

    b.addEventListener('click', () => {
      menu.hidden = true;
      if (value) return runPlaybook(pb.id, value, type);
      runPlaybookOnSelected(pb.id);
    });
    menu.append(b);
  }

  // Меню позиционируется у кнопки, а не в фиксированном углу: карточек
  // индикаторов на странице может быть сотня.
  placeFloatingMenu(menu, anchorBtn);
}

/* Разместить всплывающее меню у кнопки — вниз, а если не помещается, вверх.
 *
 * ПОЧЕМУ НЕ ПРОСТО «ПОД КНОПКОЙ». Панель выбранных индикаторов липкая
 * и стоит у нижней кромки окна. Меню, открытое под её кнопкой, уезжало
 * за пределы видимой области целиком: аналитик нажимал «Плейбук…»,
 * не видел НИЧЕГО, а меню при этом было открыто — следующий клик его
 * просто закрывал. Молчаливый отказ: кнопка «работает», результата нет.
 *
 * Поймано при пересъёмке скриншотов для руководства: снимок меню выходил
 * полоской в шесть пикселей. Проверка на видимость добавлена в аудит
 * интерфейса (tools/ui-audit/clicks.mjs).
 */
function placeFloatingMenu(menu, anchorBtn) {
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 320)) + 'px';
  menu.style.top = '0px';
  menu.hidden = false;           // высоту можно измерить только у видимого
  const h = menu.offsetHeight;
  const местоСнизу = window.innerHeight - r.bottom - 8;
  const вверх = местоСнизу < h && r.top > h + 8;
  menu.style.top = (вверх ? r.top + window.scrollY - h - 4
                          : r.bottom + window.scrollY + 4) + 'px';
}

async function runPlaybookOnSelected(pbId) {
  const targets = state.iocs.filter((i) => state.selected.has(iocKey(i)));
  const pb = (state.registry.playbooks || []).find((p) => p.id === pbId);
  const fit = targets.filter((i) => pb.types.includes(i.type));
  if (!fit.length) { toast('Среди выбранных нет индикаторов подходящего типа'); return; }

  const total = fit.reduce((n, i) => n + planPlaybook(pb, i.value, i.type).steps.length, 0);
  if (total > 12 &&
      !confirm(`«${pb.name}» по ${fit.length} индикаторам — это ${total} вкладок. Продолжить?`)) return;

  for (const i of fit) await runPlaybook(pbId, i.value, i.type);
}

/* =========================================================== КЕЙС ======
 *
 * КЕЙСОВ НЕСКОЛЬКО, И У КАЖДОГО ЕСТЬ КЛИЕНТ. Раньше кейс был один
 * на профиль: `ti_case_items` — плоский массив. Аналитик разобрал фишинг
 * клиента А, не очистил кейс, вечером разобрал отчёт по клиенту Б
 * и выгрузил CSV. В файле оба.
 *
 * Разделение хранения — в lib/cases.js, там же разобрано, почему пустая
 * метка клиента не блокирует экспорт. Здесь — только состояние страницы:
 * `state.caseItems` и `state.timeline` это ВСЕГДА содержимое АКТИВНОГО
 * кейса, и записываются они обратно в него.
 * ==================================================================== */

async function loadCase() {
  const raw = await ENV.storeGet(TICases.STORE_KEY, null);
  let store = TICases.normalizeStore(raw);

  /* Перенос старого одиночного кейса. Старые ключи НЕ удаляются:
   * если перенос ошибётся, единственная копия работы аналитика
   * не должна исчезнуть вместе с ошибкой. */
  if (!store.cases.length) {
    const legacyItems = await ENV.storeGet('ti_case_items', []);
    const legacyTl = await ENV.storeGet('ti_case_timeline', []);
    const mig = TICases.migrateLegacy({ items: legacyItems, timeline: legacyTl });
    if (mig.migrated) {
      store = mig.store;
      await ENV.storeSet(TICases.STORE_KEY, store);
      state.migratedLegacy = true;
    }
  }
  state.caseStore = store;
  syncFromActiveCase();
}

/** Перечитать хранилище кейсов: его мог изменить не этот документ.
 *
 * Пишет в `ti_cases` не только эта вкладка, но и боковая панель
 * (кнопка «В кейс»). Без перечитывания вкладка работала бы с устаревшим
 * снимком и первым же сохранением затёрла бы чужую запись. */
async function reloadCaseStore() {
  state.caseStore = TICases.normalizeStore(await ENV.storeGet(TICases.STORE_KEY, null));
  syncFromActiveCase();
}

/** Выложить активный кейс в состояние страницы и отрисовать. */
function syncFromActiveCase() {
  const act = TICases.activeCase(state.caseStore);
  state.caseItems = act ? act.items : [];
  state.timeline = act ? act.timeline : [];
  renderCaseBar();
  renderCase();
  renderTimeline();
  renderGraph();
  syncFox();
}

/** Записать состояние страницы обратно в активный кейс. */
async function saveCase() {
  const act = TICases.activeCase(state.caseStore);
  if (!act) {
    // Кейса нет — создаём при первом же добавлении, иначе индикаторы
    // складывать некуда, а молча их терять нельзя.
    const r = TICases.addCase(state.caseStore, { title: 'Без названия' });
    state.caseStore = r.store;
  }
  state.caseStore = TICases.updateCase(state.caseStore, state.caseStore.activeId, {
    items: state.caseItems,
    timeline: state.timeline,
  });
  await ENV.storeSet(TICases.STORE_KEY, state.caseStore);
  renderCaseBar();
  renderCase();
}

/* Панель кейсов: выбор активного, название, TLP.
 *
 * Отдельного поля «клиент» здесь нет — убрано решением заказчика.
 * Чьё расследование, пишется в названии кейса свободным текстом
 * и остаётся ровно там, где его написал аналитик: ни в отдельном
 * поле профиля, ни в файлах выгрузки имени заказчика не появляется. */
function renderCaseBar() {
  const sel = $('#case-select');
  if (!sel || !globalThis.TICases) return;
  const store = state.caseStore;
  const act = TICases.activeCase(store);

  sel.textContent = '';
  for (const c of store.cases) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = TICases.caseLabel(c);
    if (act && c.id === act.id) o.selected = true;
    sel.append(o);
  }
  if (!store.cases.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'кейсов нет — создайте';
    sel.append(o);
  }

  $('#case-title').value = act ? act.title : '';
  $('#case-tlp').value = act ? act.tlp : 'TLP:AMBER';

  // Название активного кейса в шапке: на вкладке «Разбор IOC» списка
  // кейсов не видно, а складывать индикаторы не в тот — дорого.
  const badge = $('#case-name-badge');
  if (badge) {
    /* Кейса нет — подписи нет. Раньше здесь висел прочерк в рамке:
     * элемент интерфейса, который ничего не сообщает и выглядит как
     * недогрузившийся. Видно только на пустом профиле, поэтому и
     * дожило до сплошного прогона. */
    badge.hidden = !act;
    if (act) {
      badge.textContent = act.title || 'без названия';
      badge.className = act.title ? 'case-name' : 'case-name is-empty';
      badge.title = `Активный кейс: ${TICases.caseLabel(act)}`;
    }
  }

  const warn = $('#case-warn');
  if (warn) {
    const problems = TICases.storeProblems(store);
    warn.textContent = problems.join('. ');
    warn.hidden = !problems.length;
  }
  const mig = $('#case-migrated');
  if (mig) mig.hidden = !state.migratedLegacy;
}

/* ====================================================== ХРОНОЛОГИЯ =====
 *
 * Кейс отвечает «что известно», хронология — «как мы к этому пришли».
 * Правила записи, склейки и границы (почему хронология не создаёт нового
 * места хранения клиентских данных) — в lib/timeline.js.
 *
 * logEvent НИКОГДА не должен ронять действие, внутри которого вызван:
 * хронология — вспомогательная вещь, и потерять из-за неё добавление
 * индикатора в кейс было бы обменом наоборот. Отсюда try/catch. */
function logEvent(kind, data = {}) {
  try {
    if (!globalThis.TITimeline) return;
    state.timeline = TITimeline.addEvent(state.timeline, { kind, ...data });
    ENV.storeSet('ti_case_timeline', state.timeline);
    renderTimeline();
    renderGraph();
  renderGraph();
  } catch (e) {
    console.warn('хронология: событие не записано', kind, e);
  }
}

/* Первое событие кейса. Ставится в момент первого добавления, а не при
 * загрузке консоли: открытая и закрытая вкладка — не начало работы. */
function ensureCaseStarted() {
  if (state.timeline.length) return;
  logEvent('case.started', { title: ($('#case-title')?.value || '').trim() });
}

function addSelectedToCase() {
  const now = new Date().toISOString();
  const existing = new Set(state.caseItems.map(iocKey));
  let added = 0;
  for (const i of state.iocs) {
    if (!state.selected.has(iocKey(i)) || existing.has(iocKey(i))) continue;
    state.caseItems.push({
      ...i, addedAt: now,
      source: state.inputSource,
      // Индикатор, снятый с картинки, программно не проверен ничем,
      // кроме формы. Метка едет с ним дальше — в кейс, в CSV, в отчёт.
      needsVisualCheck: state.inputSource.startsWith('картинка'),
      sourceUrl: state.sourceUrl || undefined,
    });
    added++;
  }
  saveCase();
  if (added) {
    ensureCaseStarted();
    logEvent('ioc.added', { count: added, source: state.inputSource });
  }
  toast(added ? `Добавлено в кейс: ${added}` : 'Все выбранные уже в кейсе');
}

/* ================== ВЕРДИКТЫ, ЗАМЕТКИ И ТЕГИ =========================
 *
 * До этого кейс отвечал на вопрос «какие индикаторы нашлись». Он не
 * отвечал на вопрос «что аналитик про них выяснил», а это и есть
 * содержание работы: индикатор без вердикта — строка, которую придётся
 * проверять заново. При передаче смены или при возврате к кейсу через
 * неделю плоский список бесполезен.
 *
 * Поле «чем проверен» не менее важно, чем сам вердикт. «Вредоносный»
 * без указания источника — это мнение; «вредоносный, VT 43/70» —
 * проверяемое утверждение, и именно оно попадает в отчёт клиенту.
 * ==================================================================== */

const VERDICTS = {
  unknown:    { label: 'не проверен', cls: 'v-unknown' },
  malicious:  { label: 'вредоносный', cls: 'v-mal' },
  suspicious: { label: 'подозрительный', cls: 'v-sus' },
  clean:      { label: 'чистый', cls: 'v-clean' },
  irrelevant: { label: 'не относится', cls: 'v-none' },
};

/* Записи, добавленные до появления этих полей, лежат в storage без них.
 * Дополняем при чтении, а не при записи: иначе старый кейс, открытый
 * и не тронутый, остался бы без полей и сломал бы экспорт. */
function migrateCaseItem(i) {
  if (!i.verdict) i.verdict = 'unknown';
  if (typeof i.verdictSource !== 'string') i.verdictSource = '';
  if (typeof i.note !== 'string') i.note = '';
  if (!Array.isArray(i.tags)) i.tags = [];
  return i;
}

function parseTags(text) {
  // Теги — данные, а не текст: нормализуем, чтобы «C2», «c2 » и «c2»
  // не стали тремя разными тегами и не развалили фильтрацию.
  return String(text || '')
    .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    .filter((t, n, all) => all.indexOf(t) === n)
    .slice(0, 12);
}

function renderCase() {
  const tbody = $('#case-body');
  tbody.textContent = '';
  $('#case-count').textContent = state.caseItems.length;
  $('#case-empty').hidden = state.caseItems.length > 0;
  updateVerdictStats();

  state.caseItems.forEach((i, idx) => {
    migrateCaseItem(i);
    const tr = document.createElement('tr');
    tr.className = VERDICTS[i.verdict] ? VERDICTS[i.verdict].cls : 'v-unknown';
    const flags = [...(i.flags || [])];
    if (i.defanged) flags.push('defanged');
    if (i.needsVisualCheck) flags.push('сверить с картинкой');

    /* Ни одна ячейка не собирается через innerHTML.
     *
     * Это не стилистика. Сюда попадают имя файла, хост из ссылки
     * и заметка — строки, которые выбирает не аналитик, а тот, чей файл
     * он открыл. Файл с именем «<img src=x onerror=...>.txt», собранный
     * в шаблон для innerHTML, дал бы исполнение кода в контексте
     * расширения — с доступом к storage и вкладкам. В эту таблицу
     * разметка не попадает, потому что разметки здесь не бывает. */
    const tdType = document.createElement('td');
    tdType.textContent = i.typeLabel;
    const tdVal = document.createElement('td');
    tdVal.className = 'case-val';
    tdVal.textContent = i.value;
    tr.append(tdType, tdVal);

    // --- вердикт: выпадающий список --------------------------------
    const tdVerdict = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'case-verdict';
    for (const [key, v] of Object.entries(VERDICTS)) {
      const opt = document.createElement('option');
      opt.value = key; opt.textContent = v.label;
      if (i.verdict === key) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', () => {
      const from = i.verdict;
      i.verdict = sel.value;
      saveCase();
      logEvent('verdict.set', { value: i.value, from, to: i.verdict });
    });
    tdVerdict.append(sel);

    // --- чем проверен ------------------------------------------------
    const tdSrc = document.createElement('td');
    const src = document.createElement('input');
    src.type = 'text';
    src.className = 'case-input';
    src.placeholder = 'VT 43/70';
    src.value = i.verdictSource;
    // Сохраняем по change, а не по input: иначе каждое нажатие клавиши
    // пишет в storage, а кейс может быть на сотни строк.
    src.addEventListener('change', () => {
      i.verdictSource = src.value.trim();
      saveCase();
      // Записываем сам источник: «чем проверен» — это факт работы,
      // и в отчёте он стоит рядом с вердиктом. В отличие от заметки,
      // это не свободный текст про клиента, а название сервиса.
      if (i.verdictSource) logEvent('verdict.source', { value: i.value, source: i.verdictSource });
    });
    tdSrc.append(src);

    // --- заметка и теги ----------------------------------------------
    const tdNote = document.createElement('td');
    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'case-input';
    note.placeholder = 'заметка';
    note.value = i.note;
    note.addEventListener('change', () => {
      i.note = note.value.trim();
      saveCase();
      // Текст заметки в хронологию НЕ попадает: он уже есть в кейсе,
      // а второй экземпляр тех же клиентских данных пришлось бы
      // отдельно чистить и отдельно выгружать.
      logEvent('note.set', { value: i.value });
    });
    const tags = document.createElement('input');
    tags.type = 'text';
    tags.className = 'case-input case-tags';
    tags.placeholder = 'теги через запятую';
    tags.value = i.tags.join(', ');
    tags.addEventListener('change', () => { i.tags = parseTags(tags.value); saveCase(); });
    tdNote.append(note, tags);

    const tdFlags = document.createElement('td');
    tdFlags.textContent = flags.join(', ') || '—';
    const tdSource = document.createElement('td');
    tdSource.textContent = i.source || '—';
    const tdDel = document.createElement('td');

    tr.append(tdVerdict, tdSrc, tdNote, tdFlags, tdSource, tdDel);

    const del = document.createElement('button');
    del.className = 'btn btn-mini btn-ghost';
    del.textContent = 'убрать';
    del.addEventListener('click', () => {
      state.caseItems.splice(idx, 1);
      saveCase();
      logEvent('ioc.removed', { value: i.value });
    });
    tdDel.append(del);
    tbody.append(tr);
  });
}

/* Отрисовка хронологии.
 *
 * Ни одна строка не собирается через innerHTML: в событиях лежат значения
 * индикаторов и адреса источников, то есть текст со страницы, которую
 * разбирал аналитик. Имя файла вида <img src=x onerror=…> уже один раз
 * доезжало до таблицы кейса — второй раз этой ошибке места нет. */
/* ================================================ ВХОДЯЩИЕ НА ТРИАЖ ===== */

/* Очередь живёт в том же профиле, что и кейс, и читается при запуске.
 * Хранится отдельно от кейса намеренно: попасть в кейс — это решение,
 * а очередь его только откладывает. */
async function loadTriage() {
  if (!globalThis.TITriage) return;
  state.triage = TITriage.normalize(await ENV.storeGet(TITriage.STORE_KEY, null));
  renderTriage();
}

async function saveTriage() {
  if (!globalThis.TITriage) return;
  await ENV.storeSet(TITriage.STORE_KEY, state.triage);
  renderTriage();
}

/** Пополнить очередь результатом разбора. */
async function triageAdd(found, source) {
  if (!globalThis.TITriage) return;
  const r = TITriage.addMany(state.triage, found, {
    source: source || state.inputSource || '',
    inCase: (state.caseItems || []).map(iocKey),
  });
  state.triage = r.store;
  await saveTriage();
  if (r.added) {
    const хвост = [];
    if (r.вКейсе) хвост.push(`${r.вКейсе} уже в кейсе`);
    if (r.отклонено) хвост.push(`${r.отклонено} в отбое`);
    toast(`Во входящих +${r.added}` + (хвост.length ? ` · ${хвост.join(', ')}` : ''));
  }
}

function renderTriage() {
  const box = $('#triage-box');
  if (!box || !globalThis.TITriage) return;
  const s = TITriage.summary(state.triage);
  box.hidden = s.всего === 0 && s.отклонено === 0;
  $('#triage-count').textContent = s.всего;

  const sub = $('#triage-sub');
  const части = [];
  if (s.отклонено) части.push(`в отбое ${s.отклонено}`);
  if (s.обрезано) части.push(`обрезано ${s.обрезано}`);
  sub.textContent = части.length ? ' — ' + части.join(' · ') : '';

  const list = $('#triage-list');
  list.textContent = '';
  const порядок = IOC.EXTRACTION_ORDER || [];
  const items = (state.triage.items || []).slice().sort((a, b) =>
    (порядок.indexOf(a.type) - порядок.indexOf(b.type)) || a.value.localeCompare(b.value));

  for (const i of items) {
    const row = document.createElement('div');
    row.className = 'triage-row';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.dataset.k = TITriage.key(i);

    const type = document.createElement('span');
    type.className = 'ioc-type';
    type.textContent = i.type;

    const val = document.createElement('span');
    val.className = 'triage-val';
    val.textContent = i.value + (i.count > 1 ? `  ×${i.count}` : '');

    const src = document.createElement('span');
    src.className = 'triage-src';
    src.textContent = i.source || '';

    row.append(chk, type, val, src);
    for (const f of (i.flags || [])) {
      const b = document.createElement('span');
      b.className = 'badge' + (/^(ambiguous|non-routable)/.test(f) ? ' badge-warn' : '');
      b.textContent = f;
      row.append(b);
    }
    list.append(row);
  }

  const note = $('#triage-note');
  note.textContent = s.всего
    ? 'Очередь переживает следующий разбор. Отсюда — либо в кейс, либо в отбой; '
      + 'отклонённое не всплывает снова.'
    : (s.отклонено ? 'Очередь пуста. Отклонённое помнится и повторно не предлагается.' : '');
}

function triageSelected() {
  return [...document.querySelectorAll('#triage-list input[type=checkbox]:checked')]
    .map((c) => c.dataset.k);
}

/* ==================================================== СХЕМА КЕЙСА ======= */

/* Раскладка ДВУДОЛЬНАЯ и детерминированная, без физической симуляции.
 *
 * Симуляция сил даёт каждый раз новую картинку: аналитик, вернувшийся
 * к кейсу через день, видит другую схему тех же данных и не может
 * сослаться на неё в отчёте. Здесь узлы стоят на местах, вычисляемых
 * из данных, — та же схема при том же кейсе.
 *
 * Слева источники, справа индикаторы, сгруппированные по источнику.
 * «Встретились в одном источнике» читается как два ребра в один
 * прямоугольник, а не как линия между индикаторами: линий между
 * индикаторами было бы n², и в них потерялось бы единственное, что
 * действительно что-то значит, — «часть целого».
 */
const GRAPH_ROW = 26;              // высота строки индикатора
const GRAPH_MAX_ROWS = 60;         // выше этого схема нечитаема — скажем прямо

function renderGraph() {
  const box = $('#graph-box');
  const body = $('#graph-body');
  const count = $('#graph-count');
  if (!box || !body || !globalThis.TIGraph) return;

  const g = TIGraph.buildGraph(state.caseItems);
  count.textContent = g.total;
  body.textContent = '';
  const detail = $('#graph-detail');
  if (detail) detail.textContent = 'Нажмите на линию или узел — здесь появится, что это значит.';

  if (!g.enough) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = TIGraph.whyNotShown(g);
    body.append(p);
    return;
  }

  /* Порядок строк: по источникам, внутри источника — по типу.
   * Индикаторы без источника идут последними отдельной группой. */
  const порядок = (IOC.EXTRACTION_ORDER || []);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const groups = [];
  for (const s of g.sources) {
    const свои = g.edges
      .filter((e) => e.kind === 'from-source' && e.to === s.id)
      .map((e) => byId.get(e.from))
      .filter(Boolean)
      .sort((a, b) => (порядок.indexOf(a.type) - порядок.indexOf(b.type))
                   || a.label.localeCompare(b.label));
    if (свои.length) groups.push({ source: s, items: свои });
  }
  const вГруппах = new Set(groups.flatMap((gr) => gr.items.map((n) => n.id)));
  const сироты = g.nodes.filter((n) => n.kind === 'ioc' && !вГруппах.has(n.id));
  if (сироты.length) groups.push({ source: null, items: сироты });

  /* Обрезка называется вслух: молча показать половину схемы — то же
   * самое, что молча показать половину выдачи. */
  let строк = 0;
  const видимые = [];
  let обрезано = 0;
  for (const gr of groups) {
    const место = GRAPH_MAX_ROWS - строк;
    if (место <= 0) { обрезано += gr.items.length; continue; }
    const взять = gr.items.slice(0, место);
    обрезано += gr.items.length - взять.length;
    строк += взять.length;
    видимые.push({ source: gr.source, items: взять });
  }

  const X_SRC = 150, X_IOC = 300, PAD = 14;
  const height = строк * GRAPH_ROW + PAD * 2;
  const width = 940;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'case-graph');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Схема кейса: ${g.total} индикаторов, ${g.sources.length} источников`);

  const pos = new Map();           // id узла -> {x, y}
  let row = 0;
  const слои = { edges: mk('g'), nodes: mk('g') };
  function mk(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

  function say(text) { if (detail) detail.textContent = text; }

  /* --- узлы --- */
  for (const gr of видимые) {
    const y0 = PAD + row * GRAPH_ROW;
    for (const n of gr.items) {
      const y = PAD + row * GRAPH_ROW + GRAPH_ROW / 2;
      pos.set(n.id, { x: X_IOC, y });
      const t = mk('text');
      t.setAttribute('x', X_IOC + 8);
      t.setAttribute('y', y + 4);
      t.setAttribute('class', 'gn gn-ioc v-' + (n.verdict || 'unknown'));
      t.textContent = (n.typeLabel ? n.typeLabel + '  ' : '') + n.label;
      t.addEventListener('click', () => say(`${n.typeLabel || n.type}: ${n.label}`
        + (n.source ? ` · источник: ${n.source}` : '')));
      слои.nodes.append(t);
      row++;
    }
    const y1 = PAD + (row - 1) * GRAPH_ROW + GRAPH_ROW / 2;
    const yc = (y0 + GRAPH_ROW / 2 + y1) / 2;
    if (gr.source) {
      pos.set(gr.source.id, { x: X_SRC, y: yc });
      const t = mk('text');
      t.setAttribute('x', X_SRC - 8);
      t.setAttribute('y', yc + 4);
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('class', 'gn gn-src');
      const подпись = gr.source.label.length > 30
        ? gr.source.label.slice(0, 29) + '…' : gr.source.label;
      t.textContent = подпись;
      t.addEventListener('click', () => say(`Источник: ${gr.source.label} · индикаторов: ${gr.source.count}`));
      слои.nodes.append(t);
    }
  }

  /* --- рёбра ---
   * У каждого ребра ДВА пути: видимый в 1,2 пикселя и прозрачный
   * в десять. По линии толщиной в пиксель попасть мышью нельзя —
   * клик «по ребру» просто не срабатывал бы, и объяснение, ради
   * которого схема и делалась, осталось бы недоступным. */
  for (const e of g.edges) {
    const a = pos.get(e.from); const b = pos.get(e.to);
    if (!a || !b) continue;        // конец не попал в видимую часть
    let d;
    if (e.kind === 'from-source') {
      const mx = (a.x + b.x) / 2;
      d = `M${a.x} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`;
    } else {
      // «Часть целого» рисуется дугой СЛЕВА от колонки индикаторов,
      // чтобы не путаться с линиями к источникам.
      const bulge = 26 + Math.min(70, Math.abs(a.y - b.y) / 3);
      const x = X_IOC - 6;
      d = `M${x} ${a.y} C${x - bulge} ${a.y} ${x - bulge} ${b.y} ${x} ${b.y}`;
    }
    const подпись = `${e.label}: ${e.why}`;

    const line = mk('path');
    line.setAttribute('d', d);
    line.setAttribute('class', 'ge ge-' + e.kind);
    слои.edges.append(line);

    const hit = mk('path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'ge-hit');
    hit.addEventListener('click', () => say(подпись));
    const title = mk('title');
    title.textContent = подпись;
    hit.append(title);
    слои.edges.append(hit);
  }

  svg.append(слои.edges, слои.nodes);
  body.append(svg);

  const legend = document.createElement('p');
  legend.className = 'graph-legend';
  legend.innerHTML = '<span class="ge-key ge-key-src"></span> из источника'
                   + ' <span class="ge-key ge-key-part"></span> часть целого';
  body.append(legend);

  if (обрезано) {
    const p = document.createElement('p');
    p.className = 'graph-cut';
    p.textContent = `Показано ${строк} индикаторов из ${g.total}: выше схема нечитаема. `
                  + 'Полный состав — в таблице кейса.';
    body.append(p);
  }
}

function renderTimeline() {
  const box = $('#timeline-body');
  if (!box || !globalThis.TITimeline) return;
  box.textContent = '';
  $('#timeline-count').textContent = state.timeline.length;

  if (!state.timeline.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Пока пусто. Хронология начинается с первого добавления в кейс.';
    box.append(p);
    return;
  }

  // Новые события сверху: при возврате к кейсу интересно последнее,
  // а не первое. В отчёт и в сводку хронология идёт в прямом порядке —
  // там читают историю, а не сводку последних действий.
  for (const day of TITimeline.groupByDay(state.timeline).reverse()) {
    const h = document.createElement('div');
    h.className = 'timeline-day';
    h.textContent = day.day;
    box.append(h);

    const ul = document.createElement('ul');
    ul.className = 'timeline-list';
    for (const ev of [...day.events].reverse()) {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 'timeline-time';
      t.textContent = TITimeline.fmtTime(ev.t);
      const txt = document.createElement('span');
      txt.className = 'timeline-text';
      txt.textContent = TITimeline.formatEvent(ev);
      li.append(t, txt);
      ul.append(li);
    }
    box.append(ul);
  }
}

/* Счётчик непроверенных — единственное, что действительно надо видеть
 * не разворачивая таблицу. Кейс на сорок индикаторов, из которых
 * тридцать восемь не проверены, выглядит как работа, но ею не является. */
function updateVerdictStats() {
  const el = $('#case-stats');
  if (!el) return;
  const items = state.caseItems;
  if (!items.length) { el.textContent = ''; return; }
  const n = (v) => items.filter((i) => (i.verdict || 'unknown') === v).length;
  const parts = [];
  if (n('malicious'))  parts.push(`вредоносных ${n('malicious')}`);
  if (n('suspicious')) parts.push(`подозрительных ${n('suspicious')}`);
  if (n('clean'))      parts.push(`чистых ${n('clean')}`);
  const unknown = n('unknown');
  if (unknown) parts.push(`НЕ ПРОВЕРЕНО ${unknown}`);
  el.textContent = parts.join(' · ');
  el.className = unknown ? 'parse-stat is-warn' : 'parse-stat';
}

function download(name, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Скелет отчёта. Намеренно только каркас и публично проверяемые факты:
 * выводы и клиентский контекст пишет аналитик — это зона его ответственности. */
function buildReportSkeleton() {
  const title = $('#case-title').value.trim() || 'Без названия';
  const tlp = $('#case-tlp').value;
  const date = new Date().toISOString().slice(0, 10);
  const byType = {};
  for (const i of state.caseItems) (byType[i.typeLabel] ||= []).push(migrateCaseItem(i));

  /* Столбцы «Вердикт» и «Чем проверен» больше не пустые: они заполняются
   * тем, что аналитик проставил в кейсе. Труба, в которой работа терялась
   * на выходе, была главным недостатком этого скелета. */
  const mdCell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const tables = Object.entries(byType).map(([label, items]) =>
    `### ${label} (${items.length})\n\n| Значение | Вердикт | Чем проверен | Заметка | Действие |\n` +
    `|---|---|---|---|---|\n` +
    items.map((i) => {
      const v = VERDICTS[i.verdict] ? VERDICTS[i.verdict].label : 'не проверен';
      const tags = i.tags.length ? ` _(${i.tags.join(', ')})_` : '';
      return `| \`${i.value}\` | ${v} | ${mdCell(i.verdictSource) || '—'} | `
           + `${mdCell(i.note) || '—'}${tags} |  |`;
    }).join('\n')
  ).join('\n\n');

  const unchecked = state.caseItems.filter((i) => (i.verdict || 'unknown') === 'unknown').length;
  /* Непроверенные индикаторы называются в отчёте прямо. Отчёт, в котором
   * половина строк не проверена, и отчёт, в котором проверены все, —
   * разные документы, и получатель имеет право знать, какой перед ним. */
  const uncheckedNote = unchecked
    ? `\n> **Не проверено: ${unchecked} из ${state.caseItems.length}.** `
      + 'Эти индикаторы извлечены из источника, но их вердикт не устанавливался.\n'
    : '';

  return `# ${title}

**TLP:** ${tlp}
**Дата:** ${date}
**Аналитик:** _заполнить_
**Статус:** черновик

---

## 1. Краткая сводка

_2–4 предложения: что произошло, кого касается, что требуется от получателя._

## 2. Источник информации

| Источник | Ссылка | Дата публикации | Достоверность |
|---|---|---|---|
|  |  |  |  |

## 3. Описание угрозы

_Кто, что, как. Без атрибуции, если она не подтверждена — указывать
«по данным <вендор>», а не как установленный факт._
${analysisReportBlock()}
## 4. Индикаторы компрометации

> Всего индикаторов: ${state.caseItems.length}.
> Столбцы «Вердикт» и «Чем проверен» перенесены из кейса. Столбец
> «Действие» заполняет аналитик — что именно делать с индикатором,
> зависит от инфраструктуры получателя, а она отсюда не видна.
${uncheckedNote}
${tables || '_Индикаторы не добавлены._'}

## 5. Хронология работы

_Как получены факты раздела 4: порядок появления индикаторов, что
проверялось и чем. Раздел нужен получателю, чтобы отличить проверенное
от извлечённого, — и он же снимает вопрос «откуда это у вас»._

${TITimeline.buildTimelineMarkdown(state.timeline)}

## 6. Техники MITRE ATT&CK

| Тактика | Техника | ID | Наблюдение |
|---|---|---|---|
|  |  |  |  |

## 7. Покрытие детектом

| Правило | Платформа | Статус | Комментарий |
|---|---|---|---|
|  | Elastic Security |  |  |

## 8. Рекомендации

1. _Приоритет 1 — что сделать сейчас._
2. _Приоритет 2 — что сделать в течение недели._

## 9. Ограничения

_Что не проверялось и почему. Обязательный раздел: без него получатель
считает отчёт исчерпывающим._

---

_Скелет сгенерирован TI Console. Проверка фактов и выводы — за аналитиком._
`;
}

/* ==================================== ВТОРОЙ ЭТАП: АНАЛИЗ МОДЕЛЬЮ =====
 *
 * Почему это отдельный шаг, а не продолжение разбора:
 *   - разбор на индикаторы детерминирован и занимает миллисекунды,
 *     работает без сети и без сервера;
 *   - анализ моделью занимает десятки секунд, требует поднятого GPU-хоста
 *     и по своей природе НЕ детерминирован.
 * Соединять их в одну кнопку значит заставлять аналитика ждать модель там,
 * где ему нужен был список адресов.
 *
 * Ключевой элемент интерфейса — отметка «подтверждено цитатой». Она не
 * украшение: неподтверждённое утверждение показывается, но помечается
 * и НЕ переносится в отчёт. Скрывать такие утверждения было бы хуже —
 * аналитик должен видеть, что модель попыталась выдумать.
 * ---------------------------------------------------------------------- */

const ANALYSIS_TASKS = {
  summary: { key: 'claims',     label: 'Выжимка' },
  iocs:    { key: 'indicators', label: 'Роли индикаторов' },
  attack:  { key: 'techniques', label: 'Техники ATT&CK' },
  report:  { key: null,         label: 'Черновик рекомендаций' },
};

const ROLE_LABELS = {
  'c2': 'сервер управления',
  'payload-delivery': 'раздача нагрузки',
  'phishing': 'фишинг',
  'exfiltration': 'вывод данных',
  'scanning': 'сканирование',
  'victim': 'пострадавший',
  'unknown': 'роль не ясна',
};

async function checkModel() {
  const badge = $('#model-state');
  if (!badge) return;

  // Демо-сборка (признак тот же, что у loadTools) управляет блоком сама:
  // бэкенда там нет, а показать интерфейс второго этапа нужно.
  if (globalThis.TOOLS_DATA) return;

  const m = await ENV.loadManaged();

  /* Два способа добраться до модели, и выбор между ними — не настройка
   * удобства, а разные модели доверия.
   *
   *   apiUrl      -> через свой сервер. Ключ у сервера, есть квота,
   *                  кеш, журнал аудита и серверный TLP-гейт.
   *   llmProvider -> напрямую из браузера. Ключ лежит на машине
   *                  аналитика, кеша и журнала нет, гейт только
   *                  клиентский. Разбор размена — в шапке lib/analyze.js.
   *
   * Сервер приоритетнее: если настроены оба, идём через него. */
  if (!m.apiUrl) {
    const cfg = globalThis.TIAnalyze && TIAnalyze.configFromManaged(m);
    if (!cfg) {
      // Ни сервера, ни ключа — анализа не будет. Блок не показываем:
      // неработающая кнопка хуже её отсутствия.
      $('#analysis-block').hidden = true;
      return;
    }
    state.directLlm = cfg;
    state.modelReady = true;
    state.modelExternal = true;
    $('#analysis-block').hidden = false;
    badge.textContent = 'внешний API';
    badge.className = 'model-state is-external';
    badge.title = `Запрос идёт напрямую к ${cfg.provider} (${cfg.model}), `
                + 'без нашего сервера. Ключ лежит в политике на этой машине.';
    renderExternalNotice({ external: true, provider: cfg.provider, model: cfg.model,
                           allowlist_enforced: true, direct: true });
    updateAnalysisGate();
    return;
  }
  state.directLlm = null;
  $('#analysis-block').hidden = false;

  try {
    const r = await fetch(new URL('/api/v1/analyze/health', m.apiUrl),
                          { headers: ENV.authHeaders(m) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    state.modelReady = !!d.available;
    state.modelExternal = !!d.external;
    if (d.available) {
      // Два режима не имеют права выглядеть одинаково. Аналитик должен
      // видеть, остаётся документ внутри периметра или уходит стороннему
      // провайдеру, — до того как нажмёт «Проанализировать», а не после.
      badge.textContent = d.external ? 'внешний API' : 'своя модель';
      badge.className = 'model-state ' + (d.external ? 'is-external' : 'is-ok');
      badge.title = d.external
        ? `Текст уходит стороннему провайдеру (${d.provider}, ${d.model}). `
          + 'Клиентские данные заблокированы на сервере.'
          + (d.allowlist_enforced ? '' : ' Список разрешённых моделей не задан.')
        : `Локальная модель: ${d.model}. Наружу ничего не уходит.`;
      renderExternalNotice(d);
    } else {
      badge.textContent = 'модель выключена';
      badge.className = 'model-state is-off';
      // Выключенная модель — штатное состояние: GPU-хост может быть
      // заморожен ради экономии. Это не ошибка, и говорить о ней
      // надо соответственно.
      badge.title = d.reason || 'GPU-хост недоступен';
    }
  } catch (e) {
    state.modelReady = false;
    badge.textContent = 'модель недоступна';
    badge.className = 'model-state is-off';
    badge.title = String(e.message || e);
  }
  $('#btn-analyze').disabled = !state.modelReady || state.tlp === 'client';
  updateAnalysisGate();
}

/* Постоянная плашка при внешнем провайдере. Не всплывающее уведомление,
 * которое закрывают не читая, а строка, висящая рядом с кнопкой всё время:
 * условие работы, а не разовое предупреждение. */
function renderExternalNotice(d) {
  const box = $('#analysis-block');
  let el = $('#external-notice');
  if (!d.external) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'external-notice';
    el.className = 'notice notice-inline';
    box.insertBefore(el, $('#analysis-out'));
  }
  el.textContent = '';
  const b = document.createElement('strong');
  b.textContent = 'Текст уходит стороннему провайдеру. ';
  el.appendChild(b);
  el.appendChild(document.createTextNode(
    `Модель ${d.model} работает у ${d.provider}, а не на нашем сервере. `
    + 'Отправляйте только публичные документы — отчёты вендоров, статьи, бюллетени.'
    + (d.direct
        ? ' Сервера в этой конфигурации нет, поэтому запрет на клиентские данные '
          + 'держится только этим интерфейсом — серверной проверки, которую нельзя '
          + 'обойти, здесь негде разместить.'
        : ' Режим «клиентские данные» заблокирован на сервере, но это последний '
          + 'рубеж, а не разрешение вставлять сюда что угодно.')
    + (d.allowlist_enforced ? '' : ' Список разрешённых моделей не задан.')
  ));
}

function updateAnalysisGate() {
  const btn = $('#btn-analyze');
  if (!btn) return;
  const blocked = state.tlp === 'client';
  btn.disabled = !state.modelReady || blocked;

  /* Распознавание картинки живёт под тем же гейтом, и это не перестраховка.
   * Со скриншота инцидента у клиента наружу уедет ВСЁ, что на нём видно, —
   * включая то, чего аналитик на картинке не заметил: имена хостов в углу
   * окна, учётку в заголовке, кусок переписки. Текст перед вставкой хотя бы
   * читают глазами, картинку — нет. */
  const lbl = $('#lbl-image');
  if (lbl) {
    lbl.hidden = !state.modelReady || blocked;
    lbl.title = blocked
      ? 'В режиме клиентских данных картинка наружу не уходит'
      : 'Картинка целиком уходит провайдеру модели';
  }
  const stat = $('#analysis-stat');
  if (blocked) {
    stat.textContent = 'В режиме клиентских данных анализ на арендованном хосте запрещён';
    stat.className = 'parse-stat is-warn';
  } else if (stat.className === 'parse-stat is-warn') {
    stat.textContent = '';
    stat.className = 'parse-stat';
  }
}

async function runAnalysis() {
  const text = $('#smart-input').value.trim();
  if (text.length < 200) {
    toast('Для анализа нужен связный текст — вставьте отчёт или статью целиком');
    return;
  }
  if (state.tlp === 'client') {
    toast('В режиме клиентских данных анализ запрещён');
    return;
  }

  const task = $('#analysis-task').value;
  const btn = $('#btn-analyze');
  const stat = $('#analysis-stat');
  btn.disabled = true;
  stat.className = 'parse-stat';
  stat.textContent = 'модель работает, это занимает до полутора минут…';

  const m = await ENV.loadManaged();
  try {
    if (state.directLlm) {
      // Прямой вызов: проверка цитат и сверка с каталогом ATT&CK
      // выполняются здесь же, тем же алгоритмом, что на сервере.
      // Совпадение вердиктов проверяется паритетным тестом.
      state.analysis = await TIAnalyze.run(state.directLlm, task, text, state.sourceUrl);
      renderAnalysis();
      const a = state.analysis;
      stat.textContent = a.generated
        ? `черновик готов за ${(a.elapsed_ms / 1000).toFixed(1)} с`
        : `подтверждено ${a.verified_count}, отброшено ${a.unverified_count}, `
          + `${(a.elapsed_ms / 1000).toFixed(1)} с`;
      return;
    }

    const r = await fetch(new URL('/api/v1/analyze', m.apiUrl), {
      method: 'POST',
      headers: ENV.authHeaders(m),
      body: JSON.stringify({ task, text, tlp: state.tlp }),
    });
    if (r.status === 503) {
      stat.textContent = 'очередь к модели заполнена — повторите через минуту';
      stat.className = 'parse-stat is-warn';
      return;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || ('HTTP ' + r.status));
    }
    state.analysis = await r.json();
    renderAnalysis();
    const s = state.analysis;
    stat.textContent = s.generated
      ? `черновик готов за ${(s.elapsed_ms / 1000).toFixed(1)} с`
      : `подтверждено ${s.verified_count}, отброшено ${s.unverified_count}, ` +
        `${(s.elapsed_ms / 1000).toFixed(1)} с`;
  } catch (e) {
    stat.textContent = 'ошибка: ' + String(e.message || e).slice(0, 160);
    stat.className = 'parse-stat is-warn';
  } finally {
    btn.disabled = !state.modelReady || state.tlp === 'client';
  }
}

function renderAnalysis() {
  const box = $('#analysis-out');
  box.textContent = '';
  const a = state.analysis;
  if (!a) return;

  if (a.truncated) {
    const w = document.createElement('div');
    w.className = 'notice notice-inline';
    w.textContent = a.truncated_note;
    box.appendChild(w);
  }

  if (a.generated) {
    const note = document.createElement('div');
    note.className = 'notice notice-inline';
    note.textContent = a.note;
    box.appendChild(note);

    if (a.context) {
      const c = document.createElement('p');
      c.className = 'analysis-context';
      c.textContent = a.context;
      box.appendChild(c);
    }
    for (const rec of a.recommendations || []) {
      const el = document.createElement('div');
      el.className = 'claim claim-gen';
      const p = document.createElement('span');
      p.className = 'prio prio-' + rec.priority;
      p.textContent = { high: 'высокий', medium: 'средний', low: 'низкий' }[rec.priority] || rec.priority;
      const t = document.createElement('div');
      t.className = 'claim-text';
      t.textContent = rec.action;
      const r = document.createElement('div');
      r.className = 'claim-quote';
      r.textContent = rec.rationale;
      el.append(p, t, r);
      box.appendChild(el);
    }
    updateReportToggle();
    return;
  }

  const key = ANALYSIS_TASKS[a.task].key;
  const items = a[key] || [];
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Модель не нашла в тексте ничего, что относится к этой задаче.';
    box.appendChild(p);
    updateReportToggle();
    return;
  }

  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'claim ' + (it.verified ? 'claim-ok' : 'claim-bad');

    const mark = document.createElement('span');
    mark.className = 'claim-mark';
    mark.textContent = it.verified ? '✓' : '✗';
    mark.title = it.verified
      ? 'Цитата найдена в исходном тексте дословно'
      : ('Не подтверждено: ' + (it.reason || 'причина не указана'));

    const head = document.createElement('div');
    head.className = 'claim-text';
    if (a.task === 'attack') {
      const id = document.createElement('code');
      id.textContent = it.technique_id;
      head.append(id, document.createTextNode(' — ' + (it.name || '')));
    } else if (a.task === 'iocs') {
      const v = document.createElement('code');
      v.textContent = it.value;
      const role = document.createElement('span');
      role.className = 'role-tag';
      role.textContent = ROLE_LABELS[it.role] || it.role;
      head.append(v, document.createTextNode(' '), role);
    } else {
      head.textContent = it.claim || '';
    }

    const sub = document.createElement('div');
    sub.className = 'claim-sub';
    if (a.task !== 'summary' && it.claim) sub.textContent = it.claim;

    const q = document.createElement('div');
    q.className = 'claim-quote';
    q.textContent = it.verified
      ? '« ' + (it.quote || '') + ' »'
      : (it.reason || 'не подтверждено');

    el.append(mark, head);
    if (sub.textContent) el.appendChild(sub);
    el.appendChild(q);
    box.appendChild(el);
  }
  updateReportToggle();
}

/* Переключатель «включить выжимку в отчёт» виден только когда есть что
 * включать, и честно сообщает, сколько утверждений реально пойдёт
 * в документ — а не сколько модель выдала. */
function updateReportToggle() {
  const wrap = $('#include-analysis-wrap');
  const note = $('#include-analysis-note');
  const a = state.analysis;
  if (!a || a.generated || !a.verified_count) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  note.textContent = `(${a.verified_count} подтверждённых, ${ANALYSIS_TASKS[a.task].label.toLowerCase()})`;
}

/* Блок для отчёта. Только подтверждённые утверждения — это правило,
 * а не настройка: непроверенный вывод в документе за подписью SOC
 * стоит дороже, чем отсутствующий раздел. */
function analysisReportBlock() {
  const a = state.analysis;
  if (!a || a.generated || !$('#include-analysis')?.checked) return '';
  const key = ANALYSIS_TASKS[a.task].key;
  const ok = (a[key] || []).filter((x) => x.verified);
  if (!ok.length) return '';

  const lines = ok.map((x) => {
    if (a.task === 'attack') return `| ${x.technique_id} | ${x.name || ''} | ${x.claim || ''} |`;
    if (a.task === 'iocs')   return `| \`${x.value}\` | ${ROLE_LABELS[x.role] || x.role} | ${x.claim || ''} |`;
    return `- ${x.claim}\n  > ${x.quote}`;
  });

  const header = a.task === 'attack'
    ? '| ID | Техника | Наблюдение |\n|---|---|---|\n'
    : a.task === 'iocs'
      ? '| Индикатор | Роль | Основание |\n|---|---|---|\n'
      : '';

  return `\n### Разбор модели: ${ANALYSIS_TASKS[a.task].label}\n\n` +
    `> Сгенерировано локальной моделью \`${a.model}\`. ` +
    `В отчёт включены только утверждения, подтверждённые дословной цитатой ` +
    `из источника (${a.verified_count} из ${a.verified_count + a.unverified_count}). ` +
    `Отброшено как неподтверждённое: ${a.unverified_count}.\n` +
    `> Проверка фактов остаётся за аналитиком: подтверждённая цитата ` +
    `доказывает, что фраза есть в источнике, а не что источник прав.\n\n` +
    header + lines.join('\n') + '\n';
}

/* Точка входа для демо-сборки и автотестов вёрстки: подставить готовый
 * результат анализа, не обращаясь к серверу. Объявлена как function,
 * а не const, — только так она попадает в globalThis из обычного скрипта.
 * В расширении не вызывается. */
function __setAnalysis(result) {
  state.analysis = result;
  renderAnalysis();
}

/* ================================================ ПОИСК ПО ИСТОЧНИКАМ =====
 *
 * ШАБЛОНЫ ЗАПРОСОВ
 * ----------------
 * Дорки выписаны своими словами, а не скопированы из OSINT Google Dork
 * Scanner: тот под GPL-3.0, и копирование его кода обязало бы открыть
 * весь наш проект под GPL-3.0. Список операторов — это не код, но чище
 * было составить свой, тем более что общий OSINT-набор для TI
 * наполовину нерелевантен.
 *
 * Отобраны те, что отвечают на вопросы TI, а не на вопросы пентеста:
 * где ещё лежит этот файл, кто ещё писал про эту группировку, нет ли
 * утёкшего конфига — а не «найди мне админки».
 */
const DORKS = [
  { id: 'exact',    label: 'Точная фраза',      tpl: '"{{q}}"',
    hint: 'Без вариаций и синонимов. Для названий кампаний и уникальных строк' },
  { id: 'filetype', label: 'PDF-отчёты',        tpl: '{{q}} filetype:pdf',
    hint: 'Отчёты вендоров почти всегда PDF' },
  { id: 'ioc-list', label: 'Выгрузки IOC',      tpl: '{{q}} (filetype:csv OR filetype:txt OR filetype:json)',
    hint: 'Готовые списки индикаторов, а не статьи о них' },
  { id: 'title',    label: 'В заголовке',       tpl: 'intitle:"{{q}}"',
    hint: 'Отсекает упоминания вскользь: в заголовке — значит статья про это' },
  { id: 'url',      label: 'В адресе',          tpl: 'inurl:{{q}}',
    hint: 'Ищет по структуре адреса — полезно для поддоменов и путей' },
  { id: 'github',   label: 'Код на GitHub',     tpl: 'site:github.com {{q}}',
    hint: 'Правила детекта, парсеры, PoC-эксплойты' },
  { id: 'paste',    label: 'Пасты и дампы',     tpl: '(site:pastebin.com OR site:ghostbin.com OR site:rentry.co) {{q}}',
    hint: 'Утёкшие конфиги, списки жертв, переписка' },
  { id: 'recent',   label: 'Свежие обсуждения', tpl: '{{q}} (site:x.com OR site:infosec.exchange OR site:reddit.com)',
    hint: 'Исследователи пишут в соцсети раньше, чем выходит отчёт' },
  { id: 'no-noise', label: 'Без агрегаторов',   tpl: '{{q}} -site:virustotal.com -site:abuseipdb.com -site:pulsedive.com',
    hint: 'Убирает страницы самих сервисов — их и так видно в дереве' },
];

function renderDorks() {
  const box = $('#dork-chips');
  if (!box) return;
  box.textContent = '';
  for (const d of DORKS) {
    const b = document.createElement('button');
    b.className = 'chip chip-btn';
    b.type = 'button';
    b.textContent = d.label;
    b.title = `${d.hint}\n\n${d.tpl}`;
    b.addEventListener('click', () => applyDork(d));
    box.append(b);
  }
}

/* Шаблон применяется к тому, что уже введено, и НЕ накапливается:
 * дважды нажатый «PDF-отчёты» не должен давать filetype:pdf filetype:pdf.
 * Поэтому храним исходный запрос отдельно от оформленного. */
let dorkBase = '';
function applyDork(d) {
  const input = $('#global-query');
  const current = input.value.trim();
  // Если аналитик правил поле руками после применения шаблона —
  // за основу берём то, что в поле, а не старую основу.
  if (!dorkBase || !current.includes(dorkBase)) dorkBase = current;
  if (!dorkBase) { toast('Сначала введите запрос'); input.focus(); return; }
  input.value = d.tpl.replace('{{q}}', dorkBase);
  input.focus();
  renderQueryPreview();
}

/* Предпросмотр итогового запроса.
 *
 * Появился после того, как эксплуатация наткнулась на пустую выдачу:
 * шаблон «Свежие обсуждения» задавал свои площадки, профиль добавлял
 * свои, и два набора site: через И не могли совпасть никогда.
 * Диагностировать это по выдаче нельзя — «ничего не найдено» выглядит
 * одинаково и при противоречивом запросе, и при честном отсутствии данных.
 *
 * Поэтому запрос показывается ДО отправки, вместе с тем, что с ним
 * сделали: какие площадки применены, какие отброшены и почему. */
function renderQueryPreview() {
  const box = $('#query-preview');
  if (!box) return;
  const raw = $('#global-query').value.trim();
  if (!raw) { box.hidden = true; return; }

  const plan = planQuery();
  box.hidden = false;
  box.textContent = '';

  const q = document.createElement('code');
  q.className = 'qp-query';
  q.textContent = plan.q;
  box.append(q);

  for (const w of plan.warnings) {
    const p = document.createElement('p');
    p.className = 'qp-warn';
    p.textContent = w;
    box.append(p);
  }
}

/** Единая точка сборки запроса — и для предпросмотра, и для отправки. */
function planQuery() {
  const raw = $('#global-query').value.trim();
  const profile = SEARCH_PROFILES.find((p) => p.id === state.profile);
  const scoped = TIQuery.dorkSetsScope(raw);
  const direct = !$('#searx-url').value.trim();
  return TIQuery.buildQuery({
    query: raw,
    domains: profile ? profile.domains : [],
    scoped,
    // Через SearXNG площадки не усекаем: предел длины запроса —
    // ограничение публичных поисковиков, а не своего инстанса.
    limit: direct ? TIQuery.MAX_DIRECT_SITES : 0,
  });
}
function renderProfiles() {
  const box = $('#source-profiles');
  box.textContent = '';
  for (const p of SEARCH_PROFILES) {
    const b = document.createElement('button');
    b.className = 'chip' + (p.id === state.profile ? ' is-selected' : '');
    b.type = 'button';
    b.textContent = p.label;
    b.title = p.hint;
    b.addEventListener('click', () => { state.profile = p.id; renderProfiles(); renderQueryPreview(); });
    box.append(b);
  }
  const p = SEARCH_PROFILES.find((x) => x.id === state.profile);
  $('#domain-list').textContent = p.domains.join('  ·  ');
  $('#domain-count').textContent = `— ${p.domains.length} шт.`;
}

/* Запрос в SearXNG. Формат: /search?q=...&time_range=...&language=...
 * Ограничение по площадкам передаётся операторами site: — SearXNG проксирует
 * их в подлежащие движки. Точность зависит от движка: Google/Bing site:
 * поддерживают, часть специализированных — нет. Это ограничение, а не баг. */

async function doGlobalSearch(direct = false) {
  const raw = $('#global-query').value.trim();
  if (!raw) { toast('Введите запрос'); return; }
  const profile = SEARCH_PROFILES.find((p) => p.id === state.profile);
  const time = $('#global-time').value;
  const lang = $('#global-lang').value;
  const base = $('#searx-url').value.trim();
  const useSearx = !direct && base;

  /* Сборка ОДНА на оба режима. Раньше их было две, и логика в них
   * разошлась — отсюда и взялись дефекты с пустой выдачей. */
  const plan = TIQuery.buildQuery({
    query: raw,
    domains: profile ? profile.domains : [],
    scoped: TIQuery.dorkSetsScope(raw),
    limit: useSearx ? 0 : TIQuery.MAX_DIRECT_SITES,
  });

  const stat = $('#global-stat');
  if (useSearx) {
    try {
      ENV.openTab(TIQuery.searxUrl(base, plan.q, time, lang), true);
      stat.textContent = `SearXNG · профиль «${profile.label}» · площадок ${plan.used.length}`;
      stat.className = 'parse-stat';
      await ENV.storeSet('ti_searx_url', base);
      return;
    } catch (e) {
      toast('Некорректный адрес SearXNG — используйте прямое открытие');
      return;
    }
  }

  ENV.openTab(TIQuery.directUrl(plan.q, time), true);
  stat.textContent = plan.warnings.length
    ? `Прямой режим · площадок ${plan.used.length} · есть оговорки, см. предпросмотр`
    : `Прямой режим · площадок ${plan.used.length}`;
  stat.className = plan.warnings.length ? 'parse-stat is-warn' : 'parse-stat';
}

/* ============================================================ ЗАПУСК === */
async function init() {
  state.registry = await ENV.loadTools();
  // Это версия РЕЕСТРА инструментов, а не расширения: реестр обновляется
  // с сервера отдельно и живёт своим циклом. Без подписи цифру читают
  // как версию продукта и потом не могут сойтись в разговоре о том,
  // «какая у тебя стоит».

  startBrandFox();

  const managed = await ENV.loadManaged();

  // Тема применяется первой, до отрисовки дерева и результатов.
  const themeMode = managed.theme || await ENV.storeGet('ti_theme', 'dark');
  applyTheme(themeMode);
  $('#theme-mode').value = themeMode;
  if (managed.lockTheme) {
    $('#theme-mode').disabled = true;
    $('#theme-mode').title = 'Тема зафиксирована политикой SOC';
  }

  // Политика может ЗАФИКСИРОВАТЬ режим данных (lockTlpMode) — например,
  // для команды, работающей только с данными клиентов.
  state.tlp = managed.defaultTlpMode || await ENV.storeGet('ti_tlp_mode', 'public');
  $('#tlp-mode').value = state.tlp;
  if (managed.lockTlpMode) {
    $('#tlp-mode').disabled = true;
    $('#tlp-mode').title = 'Режим зафиксирован политикой SOC';
  }

  const ver = ENV.version();
  const verEl = $('#build-ver');
  if (verEl) {
    verEl.textContent = ver ? 'v' + ver : 'версия неизвестна';
    verEl.title = ver
      ? `Версия расширения ${ver}. Сверяйте её с той, которую прислал SOC:\n`
        + 'если файл заменили, а версия прежняя — обновление не применилось,\n'
        + 'браузер надо перезапустить.'
      : 'Версия недоступна: страница открыта не как расширение';
  }

  /* Забор страниц по ссылке можно выключить политикой целиком.
   * Это нужно там, где обращение к инфраструктуре злоумышленника с адреса
   * компании неприемлемо в принципе, — решение такого уровня принимает
   * не аналитик галочкой, а SOC политикой. */
  state.urlFetchAllowed = managed.urlFetch !== false;
  if (!state.urlFetchAllowed) {
    $('.src-row').hidden = true;
    /* Единственный случай, когда этот абзац вообще показывается: без него
     * поле ввода просто исчезает, и аналитик ищет пропавшую функцию. */
    $('#url-warn').textContent = 'Забор страниц по ссылке выключен политикой SOC.';
    $('#url-warn').className = 'src-warn is-off';
    $('#url-warn').hidden = false;
  }

  // Режим хранения кейса. local — кейс не покидает профиль браузера.
  // Это не настройка удобства, а следствие того, что сервер арендованный.
  state.caseStorage = managed.caseStorage || 'local';
  $('#local-storage-notice').hidden = state.caseStorage !== 'local';

  // Адрес SearXNG приезжает политикой: аналитику вводить нечего.
  $('#searx-url').value = managed.searxUrl || await ENV.storeGet('ti_searx_url', '');
  if (managed.searxUrl) {
    $('#searx-url').readOnly = true;
    $('#searx-url').title = 'Задано политикой SOC';
  }

  renderTree();
  renderProfiles();
  renderDorks();
  renderResults();          // пустое состояние с заставкой
  await loadCase();
  await loadTriage();

  // --- вкладки ---
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + tab.dataset.tab));
  }));
  $('#btn-open-case').addEventListener('click', () => $('.tab[data-tab="case"]').click());

  // --- дерево ---
  $('#tool-filter').addEventListener('input', (e) => renderTree(e.target.value));
  $('#btn-collapse-all').addEventListener('click', () =>
    $$('.cat').forEach((c) => c.classList.remove('is-open')));

  state.hidePaid = await ENV.storeGet('ti_hide_paid', false);
  $('#hide-paid').checked = state.hidePaid;
  $('#hide-paid').addEventListener('change', async (e) => {
    state.hidePaid = e.target.checked;
    await ENV.storeSet('ti_hide_paid', state.hidePaid);
    renderTree($('#tool-filter').value);
    renderResults();
  });

  // --- тема ---
  $('#theme-mode').addEventListener('change', async (e) => {
    applyTheme(e.target.value);
    await ENV.storeSet('ti_theme', e.target.value);
  });

  // --- TLP ---
  $('#tlp-mode').addEventListener('change', async (e) => {
    state.tlp = e.target.value;
    await ENV.storeSet('ti_tlp_mode', state.tlp);
    renderTree($('#tool-filter').value);
    renderResults();
    updateAnalysisGate();
    syncFox();          // намордник появляется в тот же момент, что и режим
    toast(state.tlp === 'client'
      ? 'Режим «клиентские данные»: публичные сервисы и анализ моделью отключены'
      : 'Режим «публичные данные»: доступны все источники');
  });

  // --- разбор IOC ---
  $('#btn-parse').addEventListener('click', parseInput);
  $('#btn-clear').addEventListener('click', () => {
    $('#smart-input').value = '';
    $('#smart-url').value = '';
    state.iocs = []; state.selected.clear();
    state.parsed = false;
    state.analysis = null;
    state.inputSource = 'вставленный текст';
    state.sourceUrl = '';
    clearOcr();
    renderFetchNotes([]);
    $('#parse-stat').textContent = '';
    $('#parse-stat').className = 'parse-stat';
    $('#analysis-stat').textContent = '';
    $('#analysis-out').textContent = '';
    updateReportToggle();
    renderResults();
    /* Лису тоже возвращаем в простой. Без этой строки она оставалась
     * в состоянии «найдено» после очистки — то есть индикатор врал
     * о состоянии, а это хуже отсутствия индикатора. Нашёл дымовой
     * прогон в браузере, не тест модуля: сам по себе foxStateFor
     * отрабатывал верно, забыт был вызов. */
    state.foxError = false;
    syncFox();
    // Заметку и вывод инструментов текста тоже убираем: они описывают
    // содержимое, которого больше нет.
    ttNote('');
    ttOut(null);
    textToolsUndo = null;
    $('#tt-undo').hidden = true;
  });

  /* --- кейсы -------------------------------------------------------
   *
   * Переключение кейса — операция с данными, а не с интерфейсом:
   * после неё индикаторы, хронология, отчёт и сводка относятся
   * к ДРУГОМУ клиенту. Поэтому оно проходит через общий путь
   * syncFromActiveCase, а не правит поля по месту. */
  $('#case-select').addEventListener('change', async (e) => {
    state.caseStore = TICases.setActive(state.caseStore, e.target.value);
    await ENV.storeSet(TICases.STORE_KEY, state.caseStore);
    syncFromActiveCase();
    const act = TICases.activeCase(state.caseStore);
    toast(act ? `Активный кейс: ${TICases.caseLabel(act)}` : 'Кейс не выбран');
  });

  const saveCaseFields = async () => {
    if (!TICases.activeCase(state.caseStore)) return;
    state.caseStore = TICases.updateCase(state.caseStore, state.caseStore.activeId, {
      title: $('#case-title').value,
      tlp: $('#case-tlp').value,
    });
    await ENV.storeSet(TICases.STORE_KEY, state.caseStore);
    renderCaseBar();
  };
  $('#case-title').addEventListener('change', saveCaseFields);
  $('#case-tlp').addEventListener('change', saveCaseFields);

  $('#btn-case-new').addEventListener('click', async () => {
    const r = TICases.addCase(state.caseStore, { title: '' });
    state.caseStore = r.store;
    await ENV.storeSet(TICases.STORE_KEY, state.caseStore);
    syncFromActiveCase();
    $('#case-title').focus();
    toast('Кейс создан. Дайте ему название — оно видно в шапке');
  });

  $('#btn-case-delete').addEventListener('click', async () => {
    const act = TICases.activeCase(state.caseStore);
    if (!act) return;
    /* В вопросе названы НАЗВАНИЕ кейса и оба числа. Удаление кейса — это
     * удаление проделанной работы, а «Удалить кейс?» без названия и без
     * счёта слишком легко подтвердить не глядя. */
    if (!confirm(`Удалить кейс «${TICases.caseLabel(act)}»?\n`
               + `Удалятся ${act.items.length} индикаторов и ${act.timeline.length} событий хронологии.`)) return;
    state.caseStore = TICases.removeCase(state.caseStore, act.id);
    await ENV.storeSet(TICases.STORE_KEY, state.caseStore);
    syncFromActiveCase();
    toast('Кейс удалён');
  });

  $('#case-import').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = TICases.importCase(state.caseStore, data);
      if (!r.ok) { toast('Импорт не выполнен: ' + r.error, 5000); return; }
      state.caseStore = r.store;
      await ENV.storeSet(TICases.STORE_KEY, state.caseStore);
      syncFromActiveCase();
      toast(`Импортирован отдельный кейс: ${TICases.caseLabel(r.added)}`
        + (r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''), 6000);
    } catch (err) {
      toast('Файл не разбирается как JSON: ' + String(err.message || err).slice(0, 120), 5000);
    } finally {
      e.target.value = '';
    }
  });

  /* --- копирование выбранного ------------------------------------
   *
   * Две кнопки, и разница между ними существенная. «Дефангом» —
   * для тикета, письма и чата, где по ссылке кликают не глядя.
   * «Как есть» — для машинной обработки. Их легко перепутать,
   * поэтому в тосте всегда сказано, что именно скопировано. */
  const selectedValues = () => state.iocs
    .filter((i) => state.selected.has(iocKey(i)))
    .map((i) => i.value);

  $('#btn-copy-defanged').addEventListener('click', async () => {
    const vals = selectedValues();
    if (!vals.length) { toast('Ничего не выбрано'); return; }
    await navigator.clipboard.writeText(vals.map((v) => IOC.defang(v)).join('\n'));
    toast(`Скопировано ДЕФАНГОМ: ${vals.length} — по ним не кликнут`);
  });
  $('#btn-copy-plain').addEventListener('click', async () => {
    const vals = selectedValues();
    if (!vals.length) { toast('Ничего не выбрано'); return; }
    await navigator.clipboard.writeText(vals.join('\n'));
    toast(`Скопировано КАК ЕСТЬ: ${vals.length} — ссылки кликабельны`);
  });

  // --- инструменты текста ---
  $('#tt-diff').addEventListener('click', () => {
    const box = $('#tt-diff-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('#tt-diff-input').focus();
  });
  $('#tt-diff-close').addEventListener('click', () => { $('#tt-diff-box').hidden = true; });
  $('#tt-diff-run').addEventListener('click', ttDiff);
  $('#tt-b64').addEventListener('click', ttBase64);
  $('#tt-url').addEventListener('click', ttUrlDecode);
  $('#tt-hex').addEventListener('click', ttHex);
  $('#tt-dedupe').addEventListener('click', ttDedupe);
  $('#tt-hash').addEventListener('click', ttHash);
  $('#tt-undo').addEventListener('click', ttUndo);

  // --- источник: ссылка ---
  $('#btn-fetch-url').addEventListener('click', fetchByUrl);

  /* Результат разбора открытой страницы. Консоль открыта фоновым
   * скриптом сразу после нажатия кнопки TI — показываем найденное
   * здесь, а не оставляем аналитика с подсвеченным текстом и цифрой
   * на значке. */
  if (new URLSearchParams(location.search).get('scan')) loadLastScan();

  /* Ссылка из контекстного меню («забрать, не открывая»). Подставляем
   * в поле, но НЕ забираем автоматически: запрос уходит с адреса
   * аналитика, и решение об этом принимает он, а не пункт меню.
   * Кроме того, запрос разрешения <all_urls> всё равно требует жеста. */
  const wanted = new URLSearchParams(location.search).get('fetch');
  if (wanted && state.urlFetchAllowed) {
    $('#smart-url').value = wanted;
    $('#smart-url').focus();
    $('#parse-stat').textContent = 'ссылка подставлена — нажмите «Забрать и разобрать»';
  }
  $('#smart-url').addEventListener('keydown', (e) => {
    // Enter в поле ссылки — это тот же жест пользователя, что и клик,
    // поэтому запрос разрешения из него тоже сработает.
    if (e.key === 'Enter') { e.preventDefault(); fetchByUrl(); }
  });
  // Проверяем разрешение заранее, вне обработчика клика: сам вызов
  // contains() асинхронный и внутри обработчика съел бы жест.
  if (globalThis.TIFetch) TIFetch.warmPermission();

  // Печатая в поле ссылки, аналитик уже не имеет в виду текст из textarea.
  $('#smart-url').addEventListener('input', () => {
    if ($('#smart-url').value.trim()) $('#parse-stat').className = 'parse-stat';
    renderUrlRisks();
  });

  // --- источник: картинка ---
  $('#smart-image').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';           // иначе тот же файл второй раз не выберется
    runImageOcr(f);
  });
  $('#btn-ocr-close').addEventListener('click', clearOcr);

  // Вставка картинки из буфера — основной способ: аналитик делает скриншот
  // и жмёт Ctrl+V, не сохраняя файл. Слушаем на всём документе, потому что
  // фокус в этот момент может быть где угодно на вкладке.
  document.addEventListener('paste', (e) => {
    if (!$('#panel-smart').classList.contains('is-active')) return;
    const items = Array.from(e.clipboardData?.items || []);
    const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!img) return;              // обычная вставка текста — не мешаем
    e.preventDefault();
    runImageOcr(img.getAsFile());
  });

  // --- анализ моделью ---
  $('#btn-analyze').addEventListener('click', runAnalysis);
  // Состояние модели проверяется в фоне: она может быть выключена, и это
  // не должно задерживать отрисовку всего остального.
  checkModel();
  $('#smart-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') parseInput();
  });

  $('#smart-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await loadFileIntoInput(f);
  });

  const dz = $('#drop-zone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('is-drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('is-drag')));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) {
      // Перетащили не файл, а ссылку из адресной строки или со страницы.
      const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (uri && /^https?:\/\//i.test(uri.trim())) {
        $('#smart-url').value = uri.trim().split('\n')[0];
        toast('Ссылка подставлена — нажмите «Забрать и разобрать»');
      }
      return;
    }
    if (f.type.startsWith('image/')) { runImageOcr(f); return; }
    await loadFileIntoInput(f);
  });

  $('#chk-all').addEventListener('change', (e) => {
    // «Выбрать все» — это все ИНДИКАТОРЫ, а не вся выдача вместе
    // с обвязкой: иначе одна галочка отменяет весь отсев.
    state.selected = e.target.checked
      ? new Set(state.iocs.filter((i) => !i.noise).map(iocKey)) : new Set();
    renderResults();
  });
  $('#btn-add-case').addEventListener('click', addSelectedToCase);

  // --- входящие на триаж ---
  $('#tr-all').addEventListener('click', () => {
    const boxes = [...document.querySelectorAll('#triage-list input[type=checkbox]')];
    const все = boxes.every((c) => c.checked);
    boxes.forEach((c) => { c.checked = !все; });
  });
  $('#tr-to-case').addEventListener('click', async () => {
    const keys = triageSelected();
    if (!keys.length) { toast('Ничего не выбрано'); return; }
    const set = new Set(keys);
    const берём = (state.triage.items || []).filter((i) => set.has(TITriage.key(i)));
    const есть = new Set(state.caseItems.map(iocKey));
    let added = 0;
    for (const i of берём) {
      if (есть.has(iocKey(i))) continue;
      state.caseItems.push({ ...i, addedAt: new Date().toISOString() });
      added++;
    }
    state.triage = TITriage.take(state.triage, keys);
    await saveTriage();
    await saveCase();
    logEvent('ioc.added', { count: added });
    renderCase();
    syncFox();
    toast(`В кейс добавлено: ${added}`);
  });
  $('#tr-dismiss').addEventListener('click', async () => {
    const keys = triageSelected();
    if (!keys.length) { toast('Ничего не выбрано'); return; }
    state.triage = TITriage.dismiss(state.triage, keys);
    await saveTriage();
    toast(`В отбой: ${keys.length}. Повторно предлагаться не будут`);
  });
  $('#tr-forget').addEventListener('click', async () => {
    const было = (state.triage.dismissed || []).length;
    if (!было) { toast('Отбой пуст'); return; }
    state.triage = TITriage.forgetDismissed(state.triage);
    await saveTriage();
    toast(`Отбой очищен: ${было} значений снова будут предлагаться`);
  });
  // --- командная палитра ---
  $('#palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = paletteVisible[paletteIndex];
      if (it) { closePalette(); it.run(); }
    } else if (e.key === 'Escape') { closePalette(); }
  });
  $('#palette').addEventListener('click', (e) => {
    if (e.target.id === 'palette') closePalette();
  });
  document.addEventListener('keydown', (e) => {
    // Ctrl+K — общепринятое сочетание для палитры. Firefox по умолчанию
    // отдаёт его строке поиска, поэтому preventDefault обязателен.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#palette').hidden ? openPalette() : closePalette();
    } else if (e.key === 'Escape') {
      if (!$('#palette').hidden) closePalette();
      $('#playbook-menu').hidden = true;
    }
  });

  $('#btn-open-selected').addEventListener('click', showOpenMenu);
  $('#btn-playbook-selected').addEventListener('click', (e) =>
    showPlaybookMenu(e.currentTarget, null, null));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#open-menu') && !e.target.closest('#btn-open-selected')) $('#open-menu').hidden = true;
    if (!e.target.closest('#playbook-menu') && !e.target.closest('.ioc-playbook')
        && !e.target.closest('#btn-playbook-selected')) $('#playbook-menu').hidden = true;
  });

  // --- поиск по источникам ---
  $('#btn-global-search').addEventListener('click', () => doGlobalSearch(false));
  $('#btn-global-direct').addEventListener('click', () => doGlobalSearch(true));
  $('#global-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doGlobalSearch(false); });
  // Предпросмотр обновляется от всего, что меняет запрос: текста,
  // профиля источников и наличия адреса SearXNG (от него зависит,
  // усекается ли список площадок).
  $('#global-query').addEventListener('input', renderQueryPreview);
  $('#searx-url').addEventListener('input', renderQueryPreview);

  // --- кейс ---
  $('#btn-export-csv').addEventListener('click', () => {
    download('ioc.csv', '﻿' + IOC.toCsv(state.caseItems), 'text/csv;charset=utf-8');
    logEvent('export.done', { format: 'CSV' });
  });
  $('#btn-export-json').addEventListener('click', () => {
    /* Хронология едет в JSON-выгрузку вместе с кейсом. Это единственный
     * формат, где ей есть место: CSV — таблица индикаторов, STIX —
     * машинный обмен, а JSON и задуман как полный снимок работы. */
      /* Версия сборки едет в выгрузку. Выгрузка — артефакт, который
       * живёт дольше вкладки: по нему разбираются, почему результат
       * такой. Без версии по файлу нельзя сказать, каким кодом он
       * получен, и спор сводится к «у меня работает». */
      download('case.json', JSON.stringify({
        title: $('#case-title').value, tlp: $('#case-tlp').value,
        extension: ENV.version() || 'неизвестна',
        exported: new Date().toISOString(), items: state.caseItems,
        timeline: state.timeline,
      }, null, 2), 'application/json');
    logEvent('export.done', { format: 'JSON' });
  });
  $('#btn-export-stix').addEventListener('click', () => {
    const bundle = IOC.toStixBundle(state.caseItems, { labels: ['ti-console', $('#case-tlp').value] });
    const skipped = bundle._skipped || [];
    if (!bundle.objects.length) {
      toast(skipped.length
        ? `Все ${skipped.length} индикаторов признаны чистыми — выгружать в STIX нечего`
        : 'Нет индикаторов, представимых в STIX');
      return;
    }
    download('bundle.json', JSON.stringify(bundle, null, 2), 'application/json');
    // Про исключённые говорим прямо: иначе расхождение между числом строк
    // в кейсе и числом объектов в файле выглядит как потеря данных.
    toast(`STIX-бандл: ${bundle.objects.length} индикаторов`
      + (skipped.length ? ` · ${skipped.length} не выгружено (вердикт «чистый»)` : ''));
    logEvent('export.done', { format: 'STIX 2.1', skipped: skipped.length });
  });
  $('#btn-report').addEventListener('click', () => {
    const md = buildReportSkeleton();
    const out = $('#report-out');
    out.textContent = md;
    out.hidden = false;
    download('report-skeleton.md', md, 'text/markdown;charset=utf-8');
    logEvent('export.done', { format: 'скелет отчёта' });
  });

  /* Сводка для передачи смены. Отдельная кнопка, а не раздел отчёта:
   * у них разные читатели. Отчёт читает получатель и ему нужны факты
   * об угрозе; сводку читает сменщик, и ему нужно, что осталось
   * недоделанным. Смешать их — значит отдать клиенту список
   * собственных недоработок. */
  $('#btn-handover').addEventListener('click', () => {
    const text = TITimeline.buildHandover({
      version: ENV.version(),
      title: $('#case-title').value,
      tlp: $('#case-tlp').value,
      items: state.caseItems.map(migrateCaseItem),
      timeline: state.timeline,
    });
    const out = $('#report-out');
    out.textContent = text;
    out.hidden = false;
    // Сводку чаще вставляют в сообщение, чем прикладывают файлом,
    // поэтому сначала буфер, файл — по желанию.
    navigator.clipboard?.writeText(text)
      .then(() => toast('Сводка скопирована в буфер'))
      .catch(() => toast('Сводка готова — скопируйте из поля ниже'));
  });
  $('#btn-handover-file').addEventListener('click', () => {
    download('handover.txt', TITimeline.buildHandover({
      version: ENV.version(),
      title: $('#case-title').value,
      tlp: $('#case-tlp').value,
      items: state.caseItems.map(migrateCaseItem),
      timeline: state.timeline,
    }), 'text/plain;charset=utf-8');
  });
  $('#btn-case-clear').addEventListener('click', async () => {
    if (!state.caseItems.length) return;
    /* Хронология очищается ВМЕСТЕ с кейсом, и об этом сказано в вопросе.
     *
     * Иначе получилось бы тихое враньё: аналитик нажал «очистить»,
     * индикаторы из таблицы исчезли, а в профиле осталась запись
     * «добавлен 45.151.45.31». Хронология содержит те же значения,
     * что и кейс, и жить дольше кейса она не имеет права. */
    const act = TICases.activeCase(state.caseStore);
    const n = state.caseItems.length;
    if (!confirm(`Очистить кейс «${act ? TICases.caseLabel(act) : ''}»? `
               + `Удалятся ${n} индикаторов и хронология (${state.timeline.length} событий). `
               + 'Сам кейс останется.')) return;
    state.caseItems = [];
    state.timeline = [];
    await saveCase();
    renderTimeline();
    renderGraph();
  renderGraph();
  });

  // Приём индикаторов от расширения-парсера страниц (см. content/scan.js).
  if (ENV.isExtension && browser.runtime?.onMessage) {
    browser.runtime.onMessage.addListener((msg) => {
      // Разбор страницы теперь открывает консоль и показывает найденное
      // в выдаче (loadLastScan). Прямое добавление в кейс осталось только
      // для явного действия из боковой панели: наполнять кейс молча —
      // способ засорить расследование.
      if (msg?.cmd === 'iocs-from-page' && Array.isArray(msg.iocs)) {
        const existing = new Set(state.caseItems.map(iocKey));
        for (const i of msg.iocs) {
          if (!existing.has(iocKey(i))) {
            state.caseItems.push({ ...i, addedAt: new Date().toISOString(), source: msg.pageUrl || 'страница' });
          }
        }
        saveCase();
        toast(`Из страницы добавлено: ${msg.iocs.length}`);
      }
      /* Боковая панель положила индикаторы в активный кейс напрямую
       * в хранилище. Без перечитывания вкладка показывала бы прежний
       * состав кейса до перезагрузки — и следующее сохранение с неё
       * затёрло бы добавленное панелью. */
      if (msg?.cmd === 'cases-changed') reloadCaseStore();
    });
  }

  // Признак завершённой инициализации. Нужен демо-сборке и автотестам
  // вёрстки: init асинхронный, и обработчики навешиваются в самом конце —
  // подменять узлы раньше этого момента бессмысленно.
  globalThis.__tiReady = true;
  document.dispatchEvent(new CustomEvent('ti-ready'));
}

document.addEventListener('DOMContentLoaded', init);
