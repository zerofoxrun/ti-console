/* =============================================================================
 * newtab.js — логика главной вкладки
 * =============================================================================
 *
 * ЧТО ЗДЕСЬ РЕАЛИЗОВАНО (всё считается локально, в браузере):
 *   - дерево инструментов из data/tools.json с фильтром и TLP-гейтом;
 *   - «Разбор IOC»: разбор текста/файла -> список IOC -> подбор инструментов;
 *   - массовое открытие вкладок с ограничением частоты;
 *   - «Поиск по источникам»: профиль источников -> строка запроса ->
 *     открытие выбранных площадок;
 *   - кейс: накопление индикаторов, экспорт CSV/JSON/STIX, скелет отчёта.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
 *   - вызовов API обогащения из браузера. Ключи VirusTotal, Shodan,
 *     Censys в расширении хранить нельзя: browser.storage.local читается
 *     пользователем и любым кодом, получившим исполнение в контексте
 *     расширения. Поэтому расширение ОТКРЫВАЕТ сервис в браузере,
 *     а не обращается к нему за человека.
 *   - отправки индикаторов, содержимого страниц и контекста куда-либо.
 *     Единственный сетевой запрос расширения — забор страницы по адресу,
 *     который человек ввёл сам; разбор — в шапке lib/fetchpage.js.
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
   * настроенный браузер: настройки приезжают вместе с
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

    /* Участок «только со своим сервером» вырезан: --store.
 * Публичная сборка своего сервера не предполагает. */
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
      toast(T('Открытие вкладки заблокировано браузером — ссылка скопирована в буфер'));
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
 * Список зашит в расширение: он должен быть одинаковым у всех
 * и меняться выпуском, а не личными закладками.
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
    label: T('Отчёты вендоров'),
    hint: T('Первичные разборы кампаний. Основной профиль для профилирования угрозы.'),
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
      // --- добавлено в 0.63.0: международные площадки ---
      'akamai.com/blog/security-research', 'blog.reversinglabs.com',
      'domaintools.com/resources/blog', 'lab52.io', 'nao-sec.org', 'censys.com/blog',
      'hunt.io/blog', 'silentpush.com/blog', 'blog.virustotal.com', 'yoroi.company/research',
      // --- добавлено в 1.0.0 ---
      'blog.sucuri.net', 'securityscorecard.com/research', 'blog.phylum.io',
      'socradar.io/blog', 'cyble.com/blog', 'resecurity.com/blog',
      'inquest.net/blog', 'blog.aquasec.com', 'sysdig.com/blog', 'wiz.io/blog',
      'orca.security/resources/blog', 'cadosecurity.com/blog', 'darktrace.com/blog',
      'blog.barracuda.com', 'abnormal.ai/blog', 'blog.cloudflare.com',
      'aws.amazon.com/blogs/security', 'kroll.com/en/insights', 'secureworks.com/research',
      'arcticwolf.com/resources/blog', 'binarydefense.com/resources',
      'deepinstinct.com/blog', 'perception-point.io/blog', 'gdatasoftware.com/blog',
      'cert.pl/en/posts',
    ],
    /* Русскоязычные площадки этого профиля. Нужны не для
     * фильтрации, а для порядка: см. площадкиПрофиля(). */
    ru: [
      'securelist.ru', 'rt-solar.ru', 'bi.zone', 'f6.ru', 'ptsecurity.com',
      'news.drweb.ru', 'kaspersky.ru/blog', 'angarasecurity.ru', 'jet.su',
      'cyberok.ru', 'infowatch.ru',
    ],
  },
  {
    id: 'cert-regulator',
    label: T('CERT и регуляторы'),
    hint: T('Официальные бюллетени. То, на что можно ссылаться в отчёте клиенту.'),
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
      // --- добавлено в 0.63.0: международные площадки ---
      'govcert.ch', 'ncsc.govt.nz', 'cert.br', 'cert-in.org.in', 'krcert.or.kr',
      'csa.gov.sg', 'cert.at', 'cert.gov.il',
      // --- добавлено в 1.0.0 ---
      'ncsc.gov.pl', 'cert.lv', 'cert.ee', 'circl.lu', 'cert.hu', 'cert.sk',
      'cert.si', 'nist.gov/cyberframework',
      'europol.europa.eu', 'ic3.gov', 'justice.gov/criminal/cybercrime',
      'treasury.gov/ofac', 'sanctionssearch.ofac.treas.gov',
    ],
    /* Русскоязычные площадки этого профиля. Нужны не для
     * фильтрации, а для порядка: см. площадкиПрофиля(). */
    ru: [
      'bdu.fstec.ru', 'safe-surf.ru', 'cert.gov.ru', 'nkcki.ru', 'fstec.ru',
      'cbr.ru', 'fincert.cbr.ru',
    ],
  },
  {
    id: 'vuln-exploit',
    label: T('Уязвимости и эксплойты'),
    hint: T('Наличие PoC и признаки эксплуатации.'),
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
      // --- добавлено в 0.63.0: международные площадки ---
      'cvedetails.com', 'opencve.io', 'vulmon.com', 'security-tracker.debian.org',
      'access.redhat.com/security', 'ubuntu.com/security/notices', 'security.paloaltonetworks.com',
      // --- добавлено в 1.0.0 ---
      'poc-in-github.motikan2010.net', 'rapid7.com/db',
      'tenable.com/plugins', 'qualys.com/research',
      'wpscan.com/vulnerabilities', 'kb.cert.org/vuls',
    ],
    /* Русскоязычные площадки этого профиля. Нужны не для
     * фильтрации, а для порядка: см. площадкиПрофиля(). */
    ru: [
      'bdu.fstec.ru', 'cyberok.ru',
    ],
  },
  {
    id: 'code-leaks',
    label: T('Код и утечки'),
    hint: T('Упоминания инфраструктуры и артефактов в публичном коде и пастах.'),
    domains: [
      // --- ядро ---
      'github.com', 'pastebin.com', 'gitlab.com', 'rentry.co',
      'grep.app', 'gist.github.com', 'controlc.com', 'sourcegraph.com',
      // --- остальное ---
      'bitbucket.org', 'ghostbin.com', 'dpaste.org', 'searchcode.com',
      'gitee.com', 'codeberg.org', 'huggingface.co', 'habr.com/ru/companies',
      // --- добавлено в 0.63.0: международные площадки ---
      'paste.ee', 'justpaste.it', 'telegra.ph', 'codepen.io',
      // --- добавлено в 1.0.0 ---
      'npmjs.com', 'pypi.org', 'crates.io', 'hub.docker.com', 'publicwww.com',
      'urlscan.io/search', 'shodan.io/search', 'binaryedge.io',
    ],
    /* Русскоязычные площадки этого профиля. Нужны не для
     * фильтрации, а для порядка: см. площадкиПрофиля(). */
    ru: [
      'habr.com/ru/companies',
    ],
  },
  {
    id: 'community',
    label: T('Сообщество и обсуждения'),
    hint: T('Ранние сигналы: часто появляются раньше вендорских отчётов.'),
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
      // --- добавлено в 0.63.0: международные площадки ---
      'theregister.com', 'helpnetsecurity.com', 'securityaffairs.com',
      'databreaches.net', 'vx-underground.org', 'lobste.rs', 'cybersecuritydive.com',
      // --- добавлено в 1.0.0 ---
      'infosecwriteups.com', 'ransomwatch.telemetry.ltd', 'ransomware.live',
      'malware-traffic-analysis.net', 'any.run/malware-trends', 'tria.ge/reports/public',
      'abuse.ch', 'youtube.com/@MalwareAnalysisForHedgehogs',
    ],
    /* Русскоязычные площадки этого профиля. Нужны не для
     * фильтрации, а для порядка: см. площадкиПрофиля(). */
    ru: [
      'habr.com', 'anti-malware.ru', 'securitylab.ru', 'xakep.ru', 'cisoclub.ru',
      'itsec.ru',
    ],
  },
  {
    id: 'detection',
    label: T('Правила детекта'),
    hint: T('Готовые Sigma/EQL/KQL под технику или семейство.'),
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
      // --- добавлено в 0.63.0: международные площадки ---
      'sigmahq.io', 'atomicredteam.io', 'hijacklibs.net', 'lots-project.com',
      'filesec.io', 'malapi.io', 'loldrivers.io',
      // --- добавлено в 1.0.0 ---
      'elastic.co/guide/en/security/current/prebuilt-rules.html',
      'docs.splunk.com', 'learn.microsoft.com/en-us/defender-xdr', 'wazuh.com/blog',
      'panther.com/blog', 'detectionengineering.net', 'blog.cyberalerts.io',
      'threathunterplaybook.com', 'ossec.net',
    ],
    ru: [],
  },
];

/* ПОРЯДОК ПЛОЩАДОК ЗАВИСИТ ОТ ЯЗЫКА ИНТЕРФЕЙСА.
 *
 * В прямом режиме в запрос влезает восемь площадок — первые по порядку.
 * Порядок в файле составлен под русскоязычного аналитика, и в ядре трёх
 * профилей из шести больше половины занимают русские источники. Для
 * английского интерфейса это означает поиск преимущественно по рунету,
 * причём незаметно: выдача есть, просто не та.
 *
 * Дописать международные площадки в конец списка было бы не решением,
 * а имитацией: до прямого режима они не доходят никогда.
 *
 * Поэтому список один, а порядок два. Состав не меняется: площадки
 * другого языка уходят во вторую группу, а не исчезают — при SearXNG
 * и при лимите 0 в запрос идут все, как и раньше. Внутри каждой группы
 * порядок из файла сохраняется, он там осмысленный.
 */
function площадкиПрофиля(профиль) {
  if (!профиль) return [];
  const все = профиль.domains || [];
  /* Язык читается у i18n, а не из настроек напрямую: там он уже
   * приведён к 'ru' | 'en' и переживает отсутствие значения. */
  const русский = !(globalThis.TII18n && TII18n.язык
                    && TII18n.язык() !== 'ru');
  /* Правило НЕСИММЕТРИЧНО, и это не упущение.
   *
   * Русскому аналитику англоязычные источники нужны: первичные разборы
   * выходят в основном на английском. Поэтому для русского интерфейса
   * порядок остаётся файловым — там ядро собрано осознанной смесью,
   * и трогать её нечем улучшить.
   *
   * Англоязычному аналитику русскоязычный блог бесполезен: он его
   * не прочитает. Поэтому для английского интерфейса русские площадки
   * уходят из ядра во вторую группу — но остаются в списке и попадают
   * в запрос через SearXNG, где лимита нет. */
  if (русский) return все.slice();
  const рус = new Set(профиль.ru || []);
  return все.filter((d) => !рус.has(d)).concat(все.filter((d) => рус.has(d)));
}

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
  foxCelebrateUntil: 0, // до какого момента лиса прыгает: кейс создан
  lastActionAt: 0,      // отметка последнего действия аналитика; 0 = не знаем
  tlp: 'public',        // public | client
  caseStorage: 'local', // local | server — приезжает политикой
  hidePaid: false,      // скрывать инструменты, бесполезные без платного тарифа
  profile: 'vendor-reports',
  analysis: null,       // результат последнего анализа моделью
  /* Накладка своих наборов проверок поверх встроенных: правки, новые
   * наборы и список скрытых. Встроенные лежат в реестре и здесь не
   * дублируются — см. lib/myplaybooks.js. */
  наборыПравки: null,
  наборыЗамечания: [],
  /* Состав рабочего места: что показывать, что спрятать. Разбор,
   * пресеты и учёт — в lib/settings.js; здесь только текущее значение. */
  settings: null,
  настройкиЗамечания: [],
  modelReady: false,    // доступна ли модель прямо сейчас
  modelExternal: false, // уходит ли текст стороннему провайдеру
  directLlm: null,      // конфиг прямого вызова API, если сервера нет

  /* Откуда взялся текст в поле ввода. Не косметика: метка доезжает до
   * кейса, до CSV и до отчёта. Индикатор, снятый с картинки, и индикатор
   * из отчёта вендора — разного качества данные, и через неделю, глядя
   * на таблицу кейса, отличить их иначе будет нечем. */
  parsed: false,        // разбирали ли хоть раз: пустое поле и «не найдено» — разное
  inputSource: T('вставленный текст'),
  sourceUrl: '',        // если текст забран по ссылке — какой именно
  ocr: null,            // { dataUrl, text, unclear } последнего распознавания
  /* Разбор последнего письма. Живёт до следующего файла и никуда
   * не сохраняется: письмо клиентское, и держать его в профиле
   * браузера незачем — ровно как с OCR. */
  eml: null,
  /* Разбор последнего HAR. Сырой текст держится в памяти ради одной
   * вещи: переключение галочки «тела ответов» ПЕРЕРАЗБИРАЕТ файл.
   * Иначе пришлось бы читать тела заранее и прятать их — то есть
   * держать секреты клиента в памяти на случай, если попросят. */
  har: null,
  harСырой: '',
  harИмя: '',
  /* Последняя сборка черновиков правил. Кеша между открытиями вкладки
   * нет намеренно: кейс меняется, а правило из прежнего состава
   * выглядит так же, как свежее. */
  rules: null,
  urlFetchAllowed: true, // выключается политикой urlFetch: false
  onlyNew: false,       // показывать только то, чего ещё нет в активном кейсе

  /* Фильтры матрицы ATT&CK — по кейсу. Читается один раз при загрузке:
   * storage.local асинхронен, а списки выставляются синхронно при
   * открытии вкладки. Формат и вытеснение старых записей — в lib/matrix.js. */
  mxStore: { v: 1, кейсы: {} },
  mxПотеряно: '',       // что из сохранённого фильтра не нашлось в каталоге

  /* Свои и клиентские диапазоны из политики (ownRanges / ownDomains).
   * Разбирается один раз при загрузке: политика доступна только
   * на чтение и в течение сеанса не меняется. */
  own: { диапазоны: [], домены: [], ошибки: [], задан: false },
};

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
/* Разметка собирается узлами (lib/dom.js). В консоль попадают значения
 * с чужих страниц — тип, флаги разбора, метка диапазона из политики, —
 * а у страницы расширения есть доступ к browser.*. */
const эл = TIDom.эл;
/* Цвет точки у сервиса. Та же функция есть в панели: выражение
 * повторялось в трёх местах, и разойтись им ничего не мешало. */
const точкаДоступа = (exposure) =>
  (exposure === 'internal' ? 'internal' : exposure === 'limited' ? 'limited' : 'public');
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
 * форма оплаты или форма регистрации, о которых он не знал.
 *
 * Возвращает МАССИВ УЗЛОВ, а не строку разметки: вызывающие стороны
 * вставляли результат через insertAdjacentHTML и конкатенацию в
 * innerHTML — оба места значились в отчёте AMO. */
function pricingTags(tool, compact = false) {
  if (tool.pricing === 'paid') {
    return [эл('span', { класс: 'tool-tag tag-paid', текст: T('платно') })];
  }
  // В карточке индикатора список сервисов плотный: там показываем только
  // платные, иначе метки забивают выдачу. В дереве места хватает.
  if (!compact && tool.pricing === 'free-account') {
    return [эл('span', { класс: 'tool-tag', текст: T('рег.') })];
  }
  return [];
}

function toolsForType(type) {
  return state.registry.tools.filter((t) => t.types.includes(type));
}

/* ============================================ СВОИ ДИАПАЗОНЫ (0.49.0) ===
 *
 * Разбор и проверка живут в lib/ownranges.js и там же проверяются.
 * Здесь — три вещи, которые делает интерфейс: пометить, показать
 * состояние списка и НЕ ПУСТИТЬ значение в публичный сервис.
 *
 * Почему гейт стоит на отправке, а не на галочке. Галочка выбора
 * управляет ДВУМЯ действиями сразу: «добавить в кейс» и «открыть
 * в сервисе». Снять её со своих адресов значило бы выкинуть из кейса
 * адрес заражённой рабочей станции — то есть главный факт инцидента.
 * Поэтому выбор остаётся, а наружу такие значения не уходят.
 * ======================================================================= */

/* escapeHtml/escapeAttr удалены в 0.60.0 вместе с последним местом,
 * где разметка собиралась строкой. Оставлять их «на всякий случай»
 * нельзя: наличие экранирующей функции — это приглашение собрать
 * строку разметки ещё раз, а проверка в lib/dom.test.js такую правку
 * завернёт. Нужен узел — TIDom.эл. */

/** Пометить список индикаторов своими диапазонами. */
function пометитьСвои(список) {
  if (!globalThis.TIOwnRanges || !Array.isArray(список)) return 0;
  return TIOwnRanges.пометить(список, state.own);
}

/** Чей это адрес — или null. */
function чейАдрес(ioc) {
  return (globalThis.TIOwnRanges && TIOwnRanges.чей(ioc, state.own)) || null;
}

/** Можно ли открыть значение в этом сервисе. */
function можноВСервис(ioc, tool) {
  if (!globalThis.TIOwnRanges) return true;
  return TIOwnRanges.можноОтправить(ioc, state.own, tool.exposure);
}

/** Состояние списка диапазонов под полем ввода. */
function отрисоватьСостояниеДиапазонов() {
  const el = $('#own-notice');
  if (!el) return;
  const o = state.own || {};
  if (o.ошибки && o.ошибки.length) {
    /* Опечатка в CIDR превращает защиту в её отсутствие. Показывается
     * ВСЕГДА и на видном месте — это ошибка конфигурации, её чинит
     * SOC, и до починки аналитик обязан знать, что список неполон. */
    el.className = 'own-notice is-bad';
    el.textContent = T`Список своих диапазонов принят не целиком: `
      + T`${o.диапазоны.length} подсетей, ${o.домены.length} доменов; `
      + T`отвергнуто записей: ${o.ошибки.length}. `
      + o.ошибки.slice(0, 3).join(' · ')
      + (o.ошибки.length > 3 ? T` · …и ещё ${o.ошибки.length - 3}` : '')
      + T(' — исправляется в политике SOC.');
    el.hidden = false;
    return;
  }
  if (!o.задан) { el.hidden = true; return; }
  el.className = 'own-notice';
  el.textContent = T`Свои и клиентские: ${o.диапазоны.length} подсетей, `
    + T`${o.домены.length} доменов. Такие значения помечаются и не уходят `
    + T('в публичные сервисы.');
  el.hidden = false;
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
             (!q || T(t.name).toLowerCase().includes(q) ||
                    T(t.note || '').toLowerCase().includes(q) ||
                    T(cat.label).toLowerCase().includes(q))
    );
    if (!tools.length) continue;

    const wrap = document.createElement('div');
    // При фильтре раскрыты все совпавшие; без фильтра — только первая
    // категория, чтобы дерево не выглядело пустым и не занимало весь экран.
    wrap.className = 'cat' + (q || cat.id === state.registry.categories[0].id ? ' is-open' : '');

    const head = document.createElement('button');
    head.className = 'cat-head';
    head.type = 'button';
    head.append(
      эл('span', { класс: 'cat-caret', текст: '▶' }),
      эл('span', { текст: T(cat.label) }),
      эл('span', { класс: 'cat-count', текст: tools.length }),
    );
    head.addEventListener('click', () => wrap.classList.toggle('is-open'));

    const body = document.createElement('div');
    body.className = 'cat-body';

    for (const t of tools) {
      const allowed = isToolAllowed(t);
      const btn = document.createElement('button');
      btn.className = 'tool' + (allowed ? '' : ' is-blocked');
      btn.type = 'button';
      const priceNote = { free: T('без регистрации'), 'free-account': T('нужна бесплатная регистрация'),
                          paid: T('без платного тарифа бесполезен') }[t.pricing] || '';
      btn.title = `${T(t.note || '')}\n[${t.exposure}/${t.activity}] ${priceNote}` +
                  (allowed ? '' : T('\n\nСкрыт фильтром'));
      btn.append(
        эл('i', { класс: `dot dot-${точкаДоступа(t.exposure)}` }),
        эл('span', { класс: 'tool-name', текст: T(t.name) }),
        ...pricingTags(t),
      );
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
    T`доступно ${filtered ? usable : shown} из ${state.registry.tools.length}` +
    (q ? T` · показано ${shown}` : '');
}

/* ======================================================= РАЗБОР IOC ==== */
/**
 * Разобрать содержимое поля на индикаторы.
 *
 * @param {string} [основание]  что разбирать вместо содержимого поля.
 *   Нужно ровно одному вызову — разбору письма: в поле лежит весь .eml
 *   вместе с base64-телами вложений, а индикаторы извлекаются только
 *   из заголовков, текстов частей и имён вложений. Показывать при этом
 *   аналитику урезанный текст нельзя: он должен видеть письмо целиком.
 */
function parseInput(основание) {
  /* Строка — и только строка. Защита не от вызывающего, а от способа
   * вызова: `addEventListener('click', parseInput)` передаёт сюда
   * MouseEvent, и разбор молча уходит в пустую выдачу. Один такой
   * вызов уже был, и снаружи он выглядел как «ничего не нашлось». */
  const text = typeof основание === 'string' ? основание : $('#smart-input').value;
  if (!text.trim()) { toast(T('Пусто — вставьте текст, ссылку, файл или картинку')); return; }

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
  /* Третий проход — свои и клиентские диапазоны. Не отсев: такое
   * значение остаётся в выдаче и может попасть в кейс. Меняется
   * только одно — наружу оно не уходит. */
  const своих = пометитьСвои(state.iocs);

  /* По умолчанию выбрано всё, КРОМЕ обвязки и того, что уже лежит
   * в активном кейсе: повторное добавление ничего не меняет, а галочка
   * заставляет каждый раз перечитывать список. */
  state.selected = new Set(state.iocs
    .filter((i) => !i.noise && !inActiveCase(i)).map(iocKey));
  const dt = (performance.now() - t0).toFixed(0);
  const dropped = state.iocs.filter((i) => i.noise).length;

  $('#parse-stat').textContent =
    T`${state.iocs.length - dropped} индикаторов`
    + (dropped ? T` · ${dropped} отсеяно как обвязка` : '')
    + (своих ? T` · ${своих} свои/клиентские` : '')
    + T` · ${text.length} символов · ${dt} мс · источник: ${state.inputSource}`;
  renderResults();
  /* Бинарники ищем ПО ИСХОДНОМУ ТЕКСТУ, а не по списку индикаторов:
   * `certutil -urlcache` индикатором не становится ни одним типом,
   * и по выдаче его искать бесполезно. */
  renderPacksFound(text);
  renderNovelty();
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
    ? `${last.source}: ${shortHost(last.pageUrl)}` : (last.source || T('страница'));

  // Тот же отсев обвязки, что и при заборе по ссылке.
  TINoise.markNoise(state.iocs, { sourceHost: TINoise.sourceHostOf(state.sourceUrl) });
  /* Разбора по структуре документа здесь НЕТ намеренно: сюда приходит
   * результат разбора СТРАНИЦЫ, а не текст. Текста под рукой нет, и
   * передавать сюда несуществующую переменную — способ уронить консоль
   * на ровном месте. Колонтитулы ищутся там, где есть документ. */
  пометитьСвои(state.iocs);
  state.selected = new Set(state.iocs
    .filter((i) => !i.noise && !inActiveCase(i)).map(iocKey));

  const dropped = state.iocs.filter((i) => i.noise).length;

  /* «со страницы» и «из выделенного» — разные вещи, и путать их нельзя.
   * Разобрав выделенный фрагмент, аналитик получает результат ПО ЭТОМУ
   * фрагменту; надпись «со страницы» заставила бы его думать, что
   * разобрана вся страница, и считать отсутствие остальных индикаторов
   * фактом. */
  const what = last.source === 'выделение' ? T('из выделенного фрагмента') : T('со страницы');
  $('#parse-stat').textContent =
    T`${state.iocs.length - dropped} индикаторов ${what}`
    + (dropped ? T` · ${dropped} отсеяно как обвязка` : '')
    + (last.pageUrl ? ` · ${last.pageUrl.slice(0, 90)}` : '');
  $('#parse-stat').className = 'parse-stat';
  renderResults();

  /* Разбор, запрошенный кнопкой «Разобрать в кейс».
   *
   * Флаг ставит фон, а добавляет консоль: хранилище кейсов пишется
   * ИЗ ОДНОГО МЕСТА. Два писателя разошлись бы молча — например,
   * на дедупликации или на формате записи.
   *
   * Обвязка (колонтитулы, раздел ссылок) в кейс не едет: это то же
   * правило, что и при добавлении галочками. Уже лежащее в кейсе
   * не дублируется и считается отдельно — «добавлено 4, уже было 11»
   * отвечает на вопрос, который иначе задают вслух.
   *
   * Если активного кейса нет, ничего не добавляется и об этом
   * говорится прямо: молча создать кейс за человека нельзя — кейс
   * это утверждение о расследовании, а не папка. */
  if (last.вКейс === true) {
    await добавитьРазборВКейс();
  } else if (state.timeline.length) {
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
      + T`${state.iocs.length - dropped} индикаторов`
    : `${last.source === 'выделение' ? 'В выделенном фрагменте' : 'На странице'} `
      + T('индикаторов не найдено'), 3200);
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
  if (!raw) { toast(T('Вставьте ссылку')); return; }

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
    stat.textContent = T('без доступа к сайтам забрать страницу нельзя — разрешение не выдано');
    stat.className = 'parse-stat is-warn';
    return;
  }

  btn.disabled = true;
  stat.className = 'parse-stat';
  stat.textContent = T('забираю страницу…');
  // Забор идёт секунды — здесь бегущая лиса действительно показывает,
  // что инструмент занят, а не завис.
  const foxDone = foxBusy();
  try {
    const page = await TIFetch.fetchPageText(raw);
    $('#smart-input').value = page.text;
    state.sourceUrl = page.url;
    state.inputSource = T('страница ') + shortHost(page.url);
    clearOcr();
    parseInput();

    // Редирект показываем отдельной строкой. Уехали на другой домен —
    // это факт об инфраструктуре, а не техническая мелочь.
    const extra = [];
    if (page.redirected) extra.push(T('после редиректа: ') + page.url);
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
    stat.textContent = T('не получилось: ') + String(e.message || e).slice(0, 200);
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
    p.textContent = (r.stop ? T('Забрать нельзя: ') : '') + r.text;
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
  clearEml();
  clearHar();
  state.sourceUrl = '';

  /* ЧТО ЭТО ЗА ФАЙЛ — РЕШАЕТСЯ ДО ЧТЕНИЯ, ПО БАЙТАМ.
   *
   * Разбор читает файл как текст. Для картинки, архива и документа
   * Office это даёт мусор, и мусор не остаётся мусором: он попадает
   * в поле ввода, разбирается обычным парсером, и в выдаче появляются
   * «индикаторы» из случайных байтов. На скриншоте 900×520 это дало
   * 149 записей в триаже и один «индикатор».
   *
   * Проверка стоит ЗДЕСЬ, а не у кнопки, потому что входов несколько:
   * «Загрузить файл», перетаскивание и всё, что появится потом.
   * Перетаскивание картинку узнавало (по `f.type`), а кнопка — нет,
   * и эта асимметрия и была дефектом. Одна проверка на общем пути
   * закрывает все входы разом.
   *
   * Атрибут accept на кнопке не спасает: человек выбирает «все файлы»
   * в диалоге и берёт что хочет — так это и воспроизвелось. */
  const нюх = new Uint8Array(
    await f.slice(0, (globalThis.TIFileKind ? TIFileKind.НЮХ_БАЙТ : 512)).arrayBuffer());
  const опознано = globalThis.TIFileKind
    ? TIFileKind.вид(нюх, f.name)
    : { вид: String.fromCharCode(...нюх.slice(0, 5)) === '%PDF-' ? 'pdf' : 'text' };

  if (опознано.вид === 'image') {
    /* Картинку отдаём распознаванию — тем же путём, что перетаскивание.
     * Если распознавать нечем, runImageOcr скажет об этом сам. */
    $('#parse-stat').textContent = T`${f.name}: картинка ${опознано.формат}`;
    $('#parse-stat').className = 'parse-stat';
    runImageOcr(f);
    return;
  }
  if (опознано.вид === 'archive' || опознано.вид === 'binary') {
    /* ОТКАЗ С НАЗВАННОЙ ПРИЧИНОЙ, а не пустой экран и не мусор.
     * Поле ввода НЕ трогаем: то, что аналитик разбирал до этого,
     * не должно пропасть из-за промаха в диалоге выбора файла. */
    renderFetchNotes([опознано.причина]);
    $('#parse-stat').textContent = T`${f.name} не прочитан: ${опознано.формат}`;
    $('#parse-stat').className = 'parse-stat is-warn';
    toast(опознано.причина, 6000);
    return;
  }
  const этоPdf = опознано.вид === 'pdf';

  /* ОГРОМНЫЙ HAR ОТВЕРГАЕТСЯ ДО ЧТЕНИЯ.
   *
   * Проверять размер после `f.text()` бесполезно: к этому моменту
   * 60 МБ уже в памяти и уже в поле ввода, а следом за ними идёт
   * разборщик индикаторов, который на таком объёме вешает вкладку
   * на минуты. Отказ по размеру обязан случиться раньше чтения —
   * иначе он не спасает ни от чего.
   *
   * Нюхаем первые 64 КБ: этого хватает, чтобы отличить HAR
   * от текстового файла, и не хватает, чтобы что-то уронить. */
  if (!этоPdf && globalThis.TIHar && f.size > TIHar.ПРЕДЕЛ_БАЙТ) {
    const нюх = await f.slice(0, 65536).text();
    if (/^\s*\{/.test(нюх) && /"log"/.test(нюх) && /"entries"/.test(нюх)) {
      const отказ = TIHar.отказПоРазмеру(f.size, TIHar.ПРЕДЕЛ_БАЙТ);
      state.har = отказ;
      state.harСырой = '';
      state.harИмя = f.name;
      state.inputSource = 'HAR ' + f.name;
      renderHar(отказ, f.name);
      renderFetchNotes([`${f.name}: ${отказ.отказ}`]);
      $('#parse-stat').textContent = T('файл не прочитан: слишком большой');
      $('#parse-stat').className = 'parse-stat is-warn';
      return;
    }
  }

  if (!этоPdf) {
    const текст = await f.text();
    $('#smart-input').value = текст;
    state.inputSource = T('файл ') + f.name;
    renderFetchNotes([]);

    /* ПИСЬМО ОПОЗНАЁТСЯ ПО СОДЕРЖИМОМУ, А НЕ ПО РАСШИРЕНИЮ.
     *
     * Аналитик сохраняет письмо из Outlook как .txt, из веб-почты —
     * «показать оригинал» и Ctrl+S с именем `message.html.txt`,
     * а из тикета оно приезжает вовсе без расширения. Проверка
     * по `.eml` промахнулась бы мимо большинства настоящих случаев.
     *
     * Обратная сторона названа в lib/eml.js: `разобрать` возвращает
     * null на тексте, который письмом не является, и проверка на это
     * строгая — один настоящий заголовок в первом блоке. */
    /* HAR ПРОВЕРЯЕТСЯ ПЕРВЫМ, И ТОЖЕ ПО СОДЕРЖИМОМУ.
     *
     * DevTools сохраняет файл как `.har`, но из тикета он приезжает
     * как `.json` или вовсе без расширения. Проверка одна: это JSON
     * с объектом `log` и массивом `log.entries`.
     *
     * Первым — потому что HAR не может оказаться письмом, а вот
     * попытка разобрать 40 МБ JSON как письмо стоила бы времени. */
    if (globalThis.TIHar) {
      let har = null;
      try { har = TIHar.разобрать(текст, { тела: false }); } catch (_) { har = null; }
      /* Функция выключена в настройках — файл НЕ пропадает: он уже
       * в поле ввода и будет разобран на индикаторы как текст.
       * Пропадает только структурный разбор, и об этом сказано словами:
       * «ничего не произошло» после выбора файла читается как поломка. */
      if (har && !функцияВкл('har')) {
        renderFetchNotes([T`${f.name}: это HAR, но разбор HAR выключен в настройках. `
          + T('Файл разобран как обычный текст — включите функцию, если нужен ')
          + T('разбор по запросам и адресам узлов.')]);
        har = null;
      }
      if (har) {
        state.har = har;
        state.harСырой = текст;
        state.harИмя = f.name;
        state.inputSource = 'HAR ' + f.name;
        if (har.отказ) {
          /* Отказ по размеру — это не «ничего не вышло»: файл в поле
           * лежит, и разобрать его на индикаторы как текст всё равно
           * можно. Но сказать, что структурного разбора не было, надо. */
          renderHar(har, f.name);
          renderFetchNotes([har.отказ]);
          parseInput();
          return;
        }
        parseInput(TIHar.текстДляРазбора(har));
        renderHar(har, f.name);
        return;
      }
    }

    let разбор = null;
    try {
      разбор = globalThis.TIEml ? TIEml.разобрать(текст) : null;
      /* Разбор один: звать TIEml.разобрать второй раз ради проверки
       * настройки значило бы дважды перемолоть письмо на десять мегабайт. */
      if (разбор && !функцияВкл('письма')) {
        renderFetchNotes([T`${f.name}: это письмо, но разбор писем выключен `
          + T('в настройках. Текст разобран на индикаторы как есть — без пути ')
          + T('письма, расхождений заголовков и списка вложений.')]);
        разбор = null;
      }
    } catch (e) {
      разбор = null;
      renderFetchNotes([T`${f.name}: письмо не разобралось (${e && e.message || e}) — `
        + T('текст всё равно разобран на индикаторы')]);
    }

    if (разбор) {
      state.eml = разбор;
      state.inputSource = T('письмо ') + f.name;
      /* Индикаторы берутся из ОТФИЛЬТРОВАННОГО текста: заголовки,
       * тексты частей и имена вложений. base64-тела не входят —
       * индикаторов там нет, а мегабайт основания даёт выдачу
       * из случайных совпадений. */
      parseInput(TIEml.текстДляРазбора(разбор));
      renderEml(разбор, f.name);
      /* Хеши считаются после отрисовки: WebCrypto асинхронен, и ждать
       * его до появления цепочки на экране незачем. */
      TIEml.сХешами(разбор, TIText.hashBytes)
        .then(() => renderEml(разбор, f.name))
        .catch(() => { /* в блоке останется «считаю хеши…» */ });
      return;
    }

    parseInput();
    return;
  }

  if (!globalThis.TIPdf) {
    renderFetchNotes([T`${f.name}: разбор PDF недоступен в этой сборке — `
      + T('сохраните текст из PDF и вставьте его в поле.')]);
    toast(T('Разбор PDF недоступен в этой сборке'));
    return;
  }

  const stat = $('#parse-stat');
  const foxDone = foxBusy();
  if (stat) { stat.textContent = T('читаю PDF…'); stat.className = 'parse-stat'; }

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
        if (stat) stat.textContent = T`читаю PDF: страница ${n} из ${всего}…`;
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
    renderFetchNotes([note || T`${f.name}: текст из PDF не получен`]);
    if (stat) { stat.textContent = T('из PDF текст не получен'); stat.className = 'parse-stat is-warn'; }
    state.foxError = true;
    syncFox();
    toast(r.imagesOnly ? T('В PDF нет текстового слоя — это скан') : T('Текст из PDF не получен'));
    return;
  }

  state.foxError = false;
  $('#smart-input').value = r.text;
  state.inputSource = 'PDF ' + f.name;
  renderFetchNotes([note]);
  parseInput();
}

/* ----------------------------------------------- ИСТОЧНИК: КАРТИНКА ---- */

/* ================================================ ЧЕРНОВИКИ ПРАВИЛ ======
 *
 * Генераторы живут в lib/rules.js и там же проверяются; здесь только
 * отрисовка и выгрузка.
 *
 * ЭТО ОТМЕНЯЕТ РАНЕЕ ПРИНЯТОЕ РЕШЕНИЕ. В СОСТОЯНИЕ.md, раздел 8,
 * было записано «Экспорт в Elastic/Sigma — Стоп. Браузер не смыкается
 * с детектом». Решение SOC изменено, и строка в разделе 8 переписана
 * в том же выпуске: два документа, утверждающие противоположное,
 * хуже любого из них.
 *
 * ЧТО ЗДЕСЬ РЕШЕНО
 * ----------------
 * 1. Правила ПЕРЕСОБИРАЮТСЯ при каждом открытии вкладки. Кеша нет:
 *    кейс меняется, а правило, собранное из прежнего состава,
 *    выглядит так же, как свежее.
 * 2. Ни кнопки «отправить», ни поля адреса SIEM. Текст и «скопировать» —
 *    это и есть вся интеграция.
 * 3. Название кейса в клиентском режиме вырезает генератор, а не эта
 *    отрисовка: гейт, размазанный по коду интерфейса, нельзя проверить
 *    тестом.
 * ======================================================================= */

/** Пересобрать правила и показать выбранный формат. */
function renderRules() {
  const поле = $('#rl-text');
  if (!поле || !globalThis.TIRules) return;

  const формат = ($('#rl-format') && $('#rl-format').value) || 'sigma';
  const sidПоле = $('#rl-sid');
  const sidОт = sidПоле ? Number(sidПоле.value) || TIRules.SID_ОТ : TIRules.SID_ОТ;

  const t0 = performance.now();
  const собрано = TIRules.собрать(state.caseItems, {
    название: $('#case-title') ? $('#case-title').value.trim() : '',
    tlp: $('#case-tlp') ? $('#case-tlp').value : 'AMBER',
    режим: state.tlp === 'client' ? 'client' : 'public',
    дата: new Date().toISOString().slice(0, 10),
    свои: state.own,
    апи: { ipv4Class: IOC.ipv4Class,
           чей: globalThis.TIOwnRanges ? TIOwnRanges.чей : null },
    sidОт,
  });
  const мс = performance.now() - t0;
  state.rules = собрано;

  const текст = собрано[формат] || '';
  поле.textContent = текст || T('— под этот формат из кейса нечего собрать —');

  const ч = [T`индикаторов в кейсе: ${state.caseItems.length}`];
  if (собрано.подготовка && собрано.подготовка.всего) {
    ч.push(T`в правила взято: ${собрано.подготовка.всего - собрано.подготовка.заменено.length
      - [...собрано.подготовка.пропущеноТипов.values()].reduce((a, b) => a + b, 0)}`);
  }
  ч.push(T`${(текст.split('\n').length)} строк`);
  ч.push(T`${мс.toFixed(0)} мс`);
  if (state.tlp === 'client') ч.push(T('режим клиентских данных: название кейса вырезано'));
  $('#rl-stat').textContent = ч.join(' · ');

  /* Оговорки показываются ВСЕГДА, когда они есть. Молча пропущенный
   * индикатор в правиле — это проверка, которой аналитик считает себя
   * защищённым, а её нет. */
  const заметки = $('#rl-notes');
  if (заметки) {
    заметки.textContent = '';
    if (собрано.заметки.length) {
      for (const з of собрано.заметки) {
        const p = document.createElement('div');
        p.className = 'rules-note';
        p.textContent = з;
        заметки.append(p);
      }
      заметки.hidden = false;
    } else {
      заметки.hidden = true;
    }
  }

  /* Поле SID имеет смысл только для Suricata. Прятать его нельзя —
   * исчезнувшее поле читается как поломка, — а вот приглушить стоит. */
  const меткаSid = sidПоле && sidПоле.closest('.field');
  if (меткаSid) меткаSid.classList.toggle('is-off', формат !== 'suricata');
}

function правилаТекст() {
  const формат = ($('#rl-format') && $('#rl-format').value) || 'sigma';
  return (state.rules && state.rules[формат]) || '';
}

/* ======================================================== РАЗБОР HAR ====
 *
 * Разбор живёт в lib/har.js и там же проверяется; здесь отрисовка
 * и галочка тел.
 *
 * ЧТО ЗДЕСЬ РЕШЕНО
 * ----------------
 * 1. Галочка «разобрать и тела ответов» ВЫКЛЮЧЕНА по умолчанию
 *    и НЕДОСТУПНА в режиме клиентских данных. Это тот же TLP-гейт,
 *    что у инструментов: в телах лежат токены и персональные данные.
 * 2. Переключение галочки ПЕРЕРАЗБИРАЕТ файл. Держать сырой HAR
 *    в памяти ради этого приходится — зато тела не читаются, пока
 *    аналитик их не попросил, а не читаются-и-прячутся.
 * 3. Ничего не сохраняется: разбор живёт до следующего файла.
 * ======================================================================= */

function clearHar() {
  state.har = null;
  state.harСырой = '';
  const b = $('#har-block');
  if (!b) return;
  b.hidden = true;
  $('#har-body').textContent = '';
  $('#har-stat').textContent = '';
}

/** Доступность галочки тел — по режиму данных. */
function harСинхроГалочку() {
  const вход = $('#har-bodies');
  const метка = $('#har-bodies-label');
  if (!вход || !метка) return;
  const клиентский = state.tlp === 'client';
  вход.disabled = клиентский;
  if (клиентский) вход.checked = false;
  метка.classList.toggle('is-off', клиентский);
  метка.title = клиентский
    ? T('Недоступно в режиме клиентских данных: в телах ответов лежат ')
      + T('токены и персональные данные')
    : T('В телах ответов бывают адреса, которых нет в заголовках — ')
      + T('и там же бывают токены');
}

/** Отрисовать разбор HAR. */
function renderHar(разбор, имяФайла) {
  const блок = $('#har-block');
  const тело = $('#har-body');
  if (!блок || !тело) return;
  if (!разбор) { clearHar(); return; }

  тело.textContent = '';
  $('#har-stat').textContent = (имяФайла ? имяФайла + ' · ' : '')
    + TIHar.сводкаСтрокой(разбор);
  $('#har-stat').className = разбор.отказ ? 'parse-stat is-warn' : 'parse-stat';
  harСинхроГалочку();

  if (разбор.отказ) {
    const p = document.createElement('p');
    p.className = 'har-refuse';
    p.textContent = разбор.отказ;
    тело.append(p);
    блок.hidden = false;
    return;
  }

  const блокРаздел = (заголовок) => {
    const d = document.createElement('div');
    d.className = 'har-sect';
    const h = document.createElement('div');
    h.className = 'har-sect-head';
    h.textContent = заголовок;
    d.append(h);
    return d;
  };

  /* --- АДРЕСА СЕРВЕРОВ. Первыми: это главное, ради чего HAR и разбирают.
   *     Имя в CDN общее у тысячи сайтов, а адрес — тот, до которого
   *     реально дошёл браузер. --- */
  if (разбор.адреса.length) {
    const a = блокРаздел(T`Адреса серверов — ${разбор.адреса.length}`);
    for (const ад of разбор.адреса) {
      const r = document.createElement('div');
      r.className = 'har-row';
      const ip = document.createElement('span');
      ip.className = 'har-ip';
      ip.textContent = ад.ip;
      const хн = document.createElement('span');
      хн.className = 'har-hosts';
      хн.textContent = ад.хосты.join(', ');
      const n = document.createElement('span');
      n.className = 'har-n';
      n.textContent = '×' + ад.запросов;
      r.append(ip, хн, n);
      a.append(r);
    }
    тело.append(a);
  }

  /* --- ЦЕПОЧКИ РЕДИРЕКТОВ. Порядок значим так же, как у Received
   *     в письме: читается только от начала. --- */
  for (const ц of разбор.цепочки) {
    const c = блокРаздел(T`Перенаправления — ${ц.length} шагов, от первой ссылки вниз`);
    for (const [i, ш] of ц.entries()) {
      const s = document.createElement('div');
      s.className = 'har-hop' + (i === 0 ? ' is-first' : '');
      const n = document.createElement('span');
      n.className = 'har-hop-n';
      n.textContent = String(i + 1);
      const осн = document.createElement('div');
      осн.className = 'har-hop-main';
      const u = document.createElement('div');
      u.className = 'har-hop-url';
      u.textContent = ш.url;
      const м = document.createElement('div');
      м.className = 'har-hop-meta';
      м.textContent = [
        ш.вФайлеНет ? T('в записи этого шага нет') : (ш.статус || '—'),
        ш.ip,
      ].filter(Boolean).join(' · ');
      осн.append(u, м);
      s.append(n, осн);
      c.append(s);
    }
    тело.append(c);
  }

  /* --- ХОСТЫ --- */
  if (разбор.хосты.length) {
    const h = блокРаздел(T`Хосты — ${разбор.хосты.length}`);
    for (const х of разбор.хосты) {
      const r = document.createElement('div');
      r.className = 'har-row' + (х.шум ? ' is-noise' : '');
      const имя = document.createElement('span');
      имя.className = 'har-host';
      имя.textContent = х.хост;
      const мета = document.createElement('span');
      мета.className = 'har-hosts';
      const статусы = Object.entries(х.статусы)
        .sort((a, b) => b[1] - a[1])
        .map(([с, n]) => `${с}×${n}`).join(' ');
      мета.textContent = [х.адреса.join(', '), статусы].filter(Boolean).join(' · ')
        + (х.шум ? T(' · только обвязка') : '');
      const n = document.createElement('span');
      n.className = 'har-n';
      n.textContent = '×' + х.запросов;
      r.append(имя, мета, n);
      h.append(r);
    }
    тело.append(h);
  }

  /* --- ОГОВОРКИ РАЗБОРА --- */
  if (разбор.проблемы.length) {
    const пр = блокРаздел(T('Что надо знать про этот файл'));
    for (const п of разбор.проблемы) {
      const r = document.createElement('div');
      r.className = 'har-row is-note';
      r.textContent = п;
      пр.append(r);
    }
    тело.append(пр);
  }

  блок.hidden = false;
}

/** Перечитать текущий HAR с другой настройкой тел. */
function harПереразобрать() {
  if (!state.harСырой || !globalThis.TIHar) return;
  const тела = !!($('#har-bodies') && $('#har-bodies').checked) && state.tlp !== 'client';
  const разбор = TIHar.разобрать(state.harСырой, { тела });
  state.har = разбор;
  renderHar(разбор, state.harИмя);
  if (разбор && !разбор.отказ) {
    parseInput(TIHar.текстДляРазбора(разбор));
    пометитьСвои(state.iocs);
    renderResults();
  }
}

/* ====================================================== РАЗБОР ПИСЬМА ====
 *
 * Разбор живёт в lib/eml.js и там же проверяется; здесь только
 * отрисовка и связка с выдачей индикаторов.
 *
 * ЧТО ЗДЕСЬ РЕШЕНО
 * ----------------
 * 1. Рядом с каждым шагом цепочки лежит СЫРАЯ СТРОКА. Разбор Received
 *    эвристический; сырая строка делает его ошибку видимой, а не
 *    незаметной. То же решение, что картинка рядом с OCR.
 * 2. Ничего не сохраняется. Разбор живёт до следующего файла, как OCR:
 *    письмо клиентское, и держать его в профиле браузера незачем.
 * 3. Хеши вложений считаются отдельным асинхронным шагом, и до его
 *    окончания в интерфейсе написано «считаю», а не пустая ячейка.
 * ======================================================================= */

function clearEml() {
  state.eml = null;
  const b = $('#eml-block');
  if (!b) return;
  b.hidden = true;
  $('#eml-body').textContent = '';
  $('#eml-stat').textContent = '';
}

/** Строка «ключ — значение» для блока письма. */
function emlСтрока(ключ, значение, опции = {}) {
  const r = document.createElement('div');
  r.className = 'eml-row' + (опции.важно ? ' is-warn' : '');
  const k = document.createElement('span');
  k.className = 'eml-key';
  k.textContent = ключ;
  const v = document.createElement('span');
  v.className = 'eml-val' + (опции.моно ? ' is-mono' : '');
  v.textContent = значение;
  r.append(k, v);
  return r;
}

function emlБлок(заголовок) {
  const d = document.createElement('div');
  d.className = 'eml-sect';
  const h = document.createElement('div');
  h.className = 'eml-sect-head';
  h.textContent = заголовок;
  d.append(h);
  return d;
}

/** Отрисовать разбор письма. */
function renderEml(разбор, имяФайла) {
  const блок = $('#eml-block');
  const тело = $('#eml-body');
  if (!блок || !тело) return;
  if (!разбор) { clearEml(); return; }

  тело.textContent = '';
  $('#eml-stat').textContent = (имяФайла ? имяФайла + ' · ' : '')
    + TIEml.сводка(разбор);

  /* --- отправитель и адресаты --- */
  const шапка = emlБлок(T('Письмо'));
  if (разбор.тема) шапка.append(emlСтрока(T('тема'), разбор.тема));
  if (разбор.дата) шапка.append(emlСтрока(T('дата'), разбор.дата));
  const от = разбор.от;
  if (от.адрес || от.display) {
    шапка.append(emlСтрока(T('от'),
      (от.display ? от.display + ' ' : '') + (от.адрес ? `<${от.адрес}>` : ''), { моно: true }));
  }
  for (const к of разбор.кому) {
    if (к.адрес) шапка.append(emlСтрока(T('кому'), к.адрес, { моно: true }));
  }
  if (разбор.returnPath.адрес) шапка.append(emlСтрока('return-path', разбор.returnPath.адрес, { моно: true }));
  if (разбор.replyTo.адрес) шапка.append(emlСтрока('reply-to', разбор.replyTo.адрес, { моно: true }));
  if (разбор.messageId.id) шапка.append(emlСтрока('message-id', разбор.messageId.id, { моно: true }));
  if (разбор.xMailer) шапка.append(emlСтрока('x-mailer', разбор.xMailer));
  тело.append(шапка);

  /* --- что сказал принимающий сервер --- */
  if (разбор.аутентификация.length) {
    const a = emlБлок(T('Проверки принимающего сервера'));
    for (const строка of разбор.аутентификация) {
      /* «fail» выделяется, но словом «провалено», а не «подделка»:
       * это результат проверки, а не вердикт о письме. */
      const плохо = /^(fail|softfail|permerror|temperror|none)$/.test(строка.результат);
      a.append(emlСтрока(строка.метод,
        строка.результат + (строка.деталь ? ' — ' + строка.деталь : ''),
        { важно: плохо }));
    }
    тело.append(a);
  }

  /* --- расхождения --- */
  if (разбор.расхождения.length) {
    const р = emlБлок(T('Расхождения'));
    for (const x of разбор.расхождения) {
      const строка = emlСтрока(x.что,
        [x.a, x.b].filter(Boolean).join('  ≠  ') || '—', { важно: true, моно: true });
      if (x.пояснение) {
        const п = document.createElement('span');
        п.className = 'eml-why';
        п.textContent = x.пояснение;
        строка.append(п);
      }
      р.append(строка);
    }
    тело.append(р);
  }

  /* --- ПУТЬ ПИСЬМА --- */
  const путь = emlБлок(T`Путь письма — ${разбор.цепочка.length} узлов, от отправителя вниз`);
  if (!разбор.цепочка.length) {
    путь.append(emlСтрока('', T('в письме нет ни одного Received')));
  }
  for (const шаг of разбор.цепочка) {
    const s = document.createElement('div');
    s.className = 'eml-hop' + (шаг.шаг === 1 ? ' is-first' : '');
    const n = document.createElement('span');
    n.className = 'eml-hop-n';
    n.textContent = String(шаг.шаг);
    const осн = document.createElement('div');
    осн.className = 'eml-hop-main';

    const линия = document.createElement('div');
    линия.className = 'eml-hop-line';
    const куски = [];
    if (шаг.from) куски.push(T('от ') + шаг.from);
    if (шаг.ip) куски.push(шаг.ip);
    if (шаг.by) куски.push('→ ' + шаг.by);
    линия.textContent = куски.join('  ');
    осн.append(линия);

    const мелко = document.createElement('div');
    мелко.className = 'eml-hop-meta';
    const м = [];
    if (шаг.with) м.push(шаг.with);
    if (шаг.датаТекст) м.push(шаг.датаТекст);
    if (typeof шаг.задержкаСек === 'number') {
      м.push(шаг.задержкаСек >= 0 ? T`+${шаг.задержкаСек} с` : T`${шаг.задержкаСек} с`);
    }
    мелко.textContent = м.join(' · ');
    осн.append(мелко);

    /* СЫРАЯ СТРОКА — всегда и рядом. Не в подсказке и не по клику:
     * разбор эвристический, и сверять его надо не отдельным действием. */
    const сырое = document.createElement('div');
    сырое.className = 'eml-hop-raw';
    сырое.textContent = шаг.сырое;
    осн.append(сырое);

    s.append(n, осн);
    путь.append(s);
  }
  тело.append(путь);

  /* --- вложения --- */
  if (разбор.вложения.length) {
    const v = emlБлок(T('Вложения'));
    for (const вл of разбор.вложения) {
      const r = document.createElement('div');
      r.className = 'eml-att';
      const и = document.createElement('div');
      и.className = 'eml-att-name';
      и.textContent = вл.имя;
      const м = document.createElement('div');
      м.className = 'eml-att-meta';
      м.textContent = [вл.тип, вл.байт ? T`${вл.байт} Б` : '']
        .filter(Boolean).join(' · ');
      r.append(и, м);
      const h = document.createElement('div');
      h.className = 'eml-att-hash';
      h.textContent = вл.великовато
        ? T('больше 8 МБ — хеши не считались')
        : (вл.ошибка || (вл.sha256 ? 'sha256 ' + вл.sha256 : T('считаю хеши…')));
      r.append(h);
      v.append(r);
    }
    тело.append(v);
  }

  /* --- вложенные письма --- */
  for (const внутр of разбор.вложенныеПисьма) {
    const w = emlБлок(T('Вложенное письмо'));
    if (внутр.тема) w.append(emlСтрока(T('тема'), внутр.тема));
    if (внутр.от.адрес) w.append(emlСтрока(T('от'), внутр.от.адрес, { моно: true }));
    for (const шаг of внутр.цепочка) {
      w.append(emlСтрока(T`узел ${шаг.шаг}`,
        [шаг.from, шаг.ip, шаг.by && '→ ' + шаг.by].filter(Boolean).join('  '),
        { моно: true }));
    }
    for (const вл of внутр.вложения) {
      w.append(emlСтрока(T('вложение'), T`${вл.имя} · ${вл.байт || 0} Б`, { моно: true }));
    }
    тело.append(w);
  }

  /* --- оговорки разбора --- */
  if (разбор.проблемы.length) {
    const пр = emlБлок(T('Что не разобралось'));
    for (const п of разбор.проблемы) пр.append(emlСтрока('', п, { важно: true }));
    тело.append(пр);
  }

  блок.hidden = false;
}

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
    r.onerror = () => reject(new Error(T('не удалось прочитать файл')));
    r.readAsDataURL(file);
  });
}

/* Участок «только со своим сервером» вырезан: --store.
 * Публичная сборка своего сервера не предполагает. */
async function runImageOcr() {}
function renderOcrUnclear() {}

/* Есть ли значение в активном кейсе. Возвращает саму запись —
 * вызывающему коду нужен ещё и вердикт из неё. */
function inActiveCase(ioc) {
  const k = iocKey(ioc);
  return state.caseItems.find((i) => iocKey(i) === k) || null;
}

/* Метка вердикта в свёрнутой строке. Обновляется на месте, чтобы
 * простановка вердикта не схлопывала раскрытую карточку. */
function обновитьМеткуВердикта(head, ioc) {
  const box = head.querySelector('.ioc-badges');
  if (!box) return;
  const старая = box.querySelector('.pre-verdict');
  if (старая) старая.remove();
  const v = VERDICTS[ioc.verdict];
  if (!v || ioc.verdict === 'unknown') return;
  const b = document.createElement('span');
  b.className = 'badge pre-verdict ' + v.cls;
  b.textContent = v.label;
  box.prepend(b);
}

/* ==================================================== МАТРИЦА ATT&CK ====
 *
 * Локальная матрица по образцу Navigator. Модель считается
 * в lib/matrix.js и там же проверяется; здесь — только отрисовка.
 *
 * ПОЧЕМУ ОТРИСОВКА УСТРОЕНА ИМЕННО ТАК
 * ------------------------------------
 * 1. ОДИН DocumentFragment на всю матрицу. Вставка узла в живой DOM
 *    заставляет браузер пересчитывать раскладку; тысяча вставок —
 *    тысяча пересчётов. Фрагмент собирается вне документа и попадает
 *    в него одним движением.
 *
 * 2. НИ ОДНОГО обработчика на ячейке. Тысяча ячеек — тысяча замыканий,
 *    каждое держит ссылку на данные. Вместо этого один обработчик
 *    на контейнере, а ячейка несёт идентификатор в data-id.
 *
 * 3. Подтехники лежат в разметке сразу, но скрыты CSS. Дорисовывать
 *    их по клику значило бы держать модель рядом с DOM и следить
 *    за согласованностью двух представлений.
 *
 * Время отрисовки замеряется и выводится в строке состояния — не ради
 * красоты: «подвисает» и «кажется, что подвисает» различает только
 * число, и оно же не даст будущей правке тихо испортить скорость.
 * ======================================================================= */

const MX_ЦВЕТ = {
  malicious:  'v-mal',
  suspicious: 'v-sus',
  clean:      'v-clean',
  irrelevant: 'v-none',
};

/** Текущие фильтры матрицы. Живут в state, чтобы переживать вкладки. */
function mxФильтры() {
  return {
    матрица: $('#mx-matrix').value,
    режим: $('#mx-mode').value,
    тактика: $('#mx-tactic').value,
    вердикт: $('#mx-verdict').value,
    платформа: $('#mx-platform').value,
    проверено: $('#mx-checked').value,
  };
}

/** Заполнить выпадающие списки из каталога. Делается один раз. */
function mxЗаполнитьСписки() {
  const A = globalThis.TIAttack;
  const кат = A && A.каталог && A.каталог();
  if (!кат) return;

  const тактики = $('#mx-tactic');
  if (тактики && тактики.options.length <= 1) {
    for (const т of кат.tactics) {
      const o = document.createElement('option');
      o.value = т; o.textContent = т;
      тактики.append(o);
    }
  }
  const платформы = $('#mx-platform');
  if (платформы && платформы.options.length <= 1) {
    for (const п of кат.platforms || []) {
      /* «None» в каталоге означает «платформа не указана» — у техник ICS
       * это норма. В фильтре такой пункт бесполезен и только путает. */
      if (п === 'None') continue;
      const o = document.createElement('option');
      o.value = п; o.textContent = п;
      платформы.append(o);
    }
  }
}

/** Отрисовать матрицу. */
function renderMatrix() {
  const grid = $('#mx-grid');
  if (!grid) return;
  const A = globalThis.TIAttack;
  const M = globalThis.TIMatrix;
  if (!A || !M) return;

  const кат = A.каталог && A.каталог();
  if (!кат) {
    grid.textContent = '';
    $('#mx-stat').textContent = T('Каталог ATT&CK не загружен — матрицу строить не из чего.');
    return;
  }

  const t0 = performance.now();
  const модель = M.построить(кат, state.caseItems, mxФильтры());
  const tМодель = performance.now() - t0;

  const t1 = performance.now();
  const фрагмент = document.createDocumentFragment();
  let ячеек = 0;

  for (const колонка of модель.колонки) {
    const col = document.createElement('div');
    col.className = 'mx-col';

    const head = document.createElement('div');
    head.className = 'mx-col-head';
    head.innerHTML = '';
    const имя = document.createElement('span');
    имя.className = 'mx-col-name';
    имя.textContent = колонка.тактика;
    const счёт = document.createElement('span');
    счёт.className = 'mx-col-count';
    счёт.textContent = String(колонка.ячейки.length);
    head.append(имя, счёт);
    col.append(head);

    for (const я of колонка.ячейки) {
      ячеек++;
      const cell = document.createElement('div');
      cell.className = 'mx-cell'
        + (я.вердикт && MX_ЦВЕТ[я.вердикт] ? ' ' + MX_ЦВЕТ[я.вердикт] : '')
        + (я.вКейсе ? ' is-case' : '')
        + (я.приглушена ? ' is-dim' : '');
      cell.dataset.id = я.id;

      const назв = document.createElement('span');
      назв.className = 'mx-cell-name';
      назв.textContent = я.название;
      cell.append(назв);

      if (я.подтехники.length) {
        const badge = document.createElement('span');
        badge.className = 'mx-cell-subs-count';
        badge.textContent = String(я.подтехники.length);
        badge.title = T('подтехник — раскрыть');
        cell.append(badge);

        const subs = document.createElement('div');
        subs.className = 'mx-subs';
        for (const п of я.подтехники) {
          const s = document.createElement('div');
          s.className = 'mx-sub'
            + (п.вердикт && MX_ЦВЕТ[п.вердикт] ? ' ' + MX_ЦВЕТ[п.вердикт] : '')
            + (п.вКейсе ? ' is-case' : '');
          s.dataset.id = п.id;
          s.textContent = п.название;
          subs.append(s);
        }
        cell.append(subs);
      }
      col.append(cell);
    }
    фрагмент.append(col);
  }

  grid.textContent = '';
  grid.append(фрагмент);
  const tРендер = performance.now() - t1;

  /* Счётчик и оговорки. Заметки выводятся всегда: «показано 214
   * из 203» без объяснения выглядит ошибкой, хотя техника с двумя
   * тактиками стоит в двух колонках по устройству самой матрицы. */
  const части = [
    T`${модель.показано} техник из ${модель.всего}`,
    T`${ячеек} ячеек в ${модель.колонки.length} колонках`,
    T`в кейсе отмечено: ${модель.вКейсе}`,
    T`модель ${tМодель.toFixed(0)} мс · отрисовка ${tРендер.toFixed(0)} мс`,
  ];
  $('#mx-stat').textContent = части.join(' · ')
    + (модель.заметки.length ? ' · ' + модель.заметки.join(' · ') : '')
    + (state.mxПотеряно ? ' · ' + state.mxПотеряно : '');
  $('#mx-stat').className = state.mxПотеряно ? 'matrix-stat is-warn' : 'matrix-stat';

  if (!модель.колонки.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = T('Под эти фильтры ничего не попало.');
    grid.append(p);
  }
}

/**
 * Карточка техники.
 *
 * TLP-ГЕЙТ. В режиме клиентских данных прячется то, что пришло
 * из расследования: название кейса, заметка аналитика и источник
 * («страница acme-client.ru» — это имя заказчика открытым текстом).
 * Остаются идентификатор, название, тактики, платформы, ссылка
 * на MITRE и сам вердикт: всё это либо публично, либо не раскрывает,
 * ЧЕЙ это инцидент.
 */
function mxКарточка(id) {
  const box = $('#mx-card');
  const A = globalThis.TIAttack;
  const т = A && A.техника(id);
  if (!box || !т) return;

  const клиентский = state.tlp === 'client';
  const св = (globalThis.TIMatrix && TIMatrix.изКейса(state.caseItems).get(TIMatrix.норм(id))) || null;

  box.textContent = '';

  const шапка = document.createElement('div');
  шапка.className = 'mx-card-head';
  const код = document.createElement('span');
  код.className = 'mx-card-id';
  код.textContent = т.id;
  const имя = document.createElement('strong');
  имя.className = 'mx-card-name';
  имя.textContent = т.название;
  const закрыть = document.createElement('button');
  закрыть.className = 'btn btn-mini btn-ghost mx-card-close';
  закрыть.type = 'button';
  закрыть.textContent = '✕';
  закрыть.addEventListener('click', () => { box.hidden = true; });
  шапка.append(код, имя, закрыть);
  box.append(шапка);

  const строка = (ключ, значение) => {
    const r = document.createElement('div');
    r.className = 'mx-card-row';
    const k = document.createElement('span');
    k.className = 'mx-card-key';
    k.textContent = ключ;
    const v = document.createElement('span');
    v.className = 'mx-card-val';
    v.textContent = значение;
    r.append(k, v);
    box.append(r);
    return r;
  };

  if (т.тактики.length) строка(T('тактики'), т.тактики.join(', '));
  const площадки = A.площадки ? A.площадки(id) : [];
  if (площадки.length && площадки.join() !== 'None') строка(T('платформы'), площадки.join(', '));

  if (св) {
    строка('вердикт', (VERDICTS[св.вердикт] || {}).label || св.вердикт);
    if (!клиентский) {
      if (св.чемПроверен) строка(T('чем проверен'), св.чемПроверен);
      if (св.заметка) строка(T('заметка'), св.заметка);
      if (св.источник) строка(T('где встретилась'), св.источник);
    } else {
      const r = строка(T('контекст'), T('скрыт: режим клиентских данных'));
      r.classList.add('is-muted');
    }
  } else {
    строка(T('в кейсе'), 'нет');
  }

  /* Ссылка на MITRE — по клику человека, и никак иначе. */
  const a = document.createElement('a');
  a.className = 'mx-card-link';
  a.href = т.url;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = T('открыть на attack.mitre.org ↗');
  box.append(a);

  box.hidden = false;
}

/* ============================================ МАТРИЦА → PNG (0.48.0) ====
 *
 * Матрица — это картина покрытия, и её место в приложении к отчёту,
 * а не только на экране аналитика.
 *
 * ПОЧЕМУ CANVAS, А НЕ СНИМОК ЭКРАНА И НЕ SVG
 * ------------------------------------------
 * Снимок экрана отдаёт то, что видно в окне: матрица шире окна, и в PNG
 * уедут первые семь колонок из пятнадцати — молча, без обрезки по краю,
 * которую было бы видно. SVG отдал бы всё, но SVG — это текст: название
 * кейса, заметка, адрес источника остаются внутри файла СТРОКАМИ, их
 * находит grep и индексирует почтовый шлюз. Забытая в клиентском режиме
 * строка уедет заказчику и никто этого не заметит. Canvas → PNG — растр:
 * чего нет на картинке, нет нигде.
 *
 * ГДЕ ЗДЕСЬ TLP-ГЕЙТ
 * ------------------
 * Весь — в lib/matrixpng.js, в раскладке. Здесь рисование по готовым
 * числам, и ни одно поле кейса сюда не попадает иначе как через неё.
 * Это не стиль, а условие проверяемости: гейт, размазанный по коду
 * отрисовки, нельзя проверить тестом, потому что тест не видит пикселей.
 * ======================================================================= */

/** Мерка текста настоящим шрифтом браузера. Холст 1×1, живёт один вызов. */
function mxМерка() {
  const ctx = document.createElement('canvas').getContext('2d');
  return (текст, шрифт) => { ctx.font = шрифт; return ctx.measureText(текст).width; };
}

/** Прямоугольник со скруглением. roundRect есть не везде — отсюда запасной путь. */
function mxПрямоугольник(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Нарисовать раскладку. Возвращает готовый canvas. */
function mxНарисовать(раскладка) {
  const P = globalThis.TIMatrixPng;
  const П = раскладка.палитра, Р = раскладка.разметка;
  const м = раскладка.масштаб;
  const сем = раскладка.семейство;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(раскладка.ширина * м);
  canvas.height = Math.ceil(раскладка.высота * м);
  const ctx = canvas.getContext('2d');
  ctx.scale(м, м);
  ctx.textBaseline = 'top';

  ctx.fillStyle = П.фон;
  ctx.fillRect(0, 0, раскладка.ширина, раскладка.высота);

  /* ---- шапка ---- */
  ctx.fillStyle = П.текст;
  ctx.font = P.шрифт(Р.шрифтЗаголовка, true, сем);
  ctx.fillText(раскладка.заголовок, Р.поля, Р.поля);
  ctx.fillStyle = П.текстТусклый;
  ctx.font = P.шрифт(Р.шрифтПодзаголовка, false, сем);
  ctx.fillText(раскладка.подзаголовок, Р.поля, Р.поля + Р.шрифтЗаголовка + 9);

  /* ---- колонки ---- */
  for (const к of раскладка.колонки) {
    ctx.fillStyle = П.фонКолонки;
    mxПрямоугольник(ctx, к.x, к.y, Р.колонка, к.высотаШапки, 4);
    ctx.fill();
    ctx.strokeStyle = П.линия;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = П.текст;
    ctx.font = P.шрифт(Р.шрифтШапкиКолонки, true, сем);
    let y = к.y + Р.ячейкаОтступ;
    for (const строка of к.строкиШапки) {
      ctx.fillText(строка, к.x + Р.ячейкаОтступ, y);
      y += Р.строкаТекста;
    }
    ctx.fillStyle = П.текстТусклый;
    ctx.font = P.шрифт(Р.шрифтШапкиКолонки, false, сем);
    const счёт = String(к.счёт);
    ctx.fillText(счёт, к.x + Р.колонка - Р.ячейкаОтступ - ctx.measureText(счёт).width,
                 к.y + Р.ячейкаОтступ);

    for (const я of к.ячейки) {
      const стиль = я.вердикт && П.вердикт[я.вердикт] ? П.вердикт[я.вердикт] : П.непроверено;
      ctx.fillStyle = стиль.заливка;
      mxПрямоугольник(ctx, я.x, я.y, я.ширина, я.высота, 3);
      ctx.fill();
      ctx.strokeStyle = стиль.рамка;
      ctx.lineWidth = я.вКейсе ? 1.4 : 1;
      ctx.stroke();

      ctx.fillStyle = П.текст;
      ctx.globalAlpha = я.приглушена ? 0.55 : 1;
      ctx.font = P.шрифт(Р.шрифт, false, сем);
      let ty = я.y + Р.ячейкаОтступ;
      for (const строка of я.строки) {
        ctx.fillText(строка, я.x + Р.ячейкаОтступ, ty);
        ty += Р.строкаТекста;
      }
      ctx.globalAlpha = 1;

      /* Подтехника — такая же цветная плашка, как ячейка, а не точка
       * рядом с текстом. Ровно она и есть факт отчёта: «видели
       * PowerShell», а родитель T1059 в кейсе может вообще не стоять. */
      for (const п of я.подтехники) {
        const с = п.вердикт && П.вердикт[п.вердикт] ? П.вердикт[п.вердикт] : П.непроверено;
        const px = я.x + Р.ячейкаОтступ + 6;
        const pw = я.ширина - Р.ячейкаОтступ * 2 - 6;
        ctx.fillStyle = с.заливка;
        mxПрямоугольник(ctx, px, ty - 1, pw, Р.подтехника - 1, 2);
        ctx.fill();
        ctx.strokeStyle = с.рамка;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = П.текст;
        ctx.font = P.шрифт(Р.шрифт - 1, false, сем);
        ctx.fillText(п.текст, px + 3, ty + 1);
        ty += Р.подтехника;
      }
      if (я.свёрнуто) {
        ctx.fillStyle = П.текстТусклый;
        ctx.font = P.шрифт(Р.шрифт - 1, false, сем);
        ctx.fillText(`+${я.свёрнуто}`, я.x + Р.ячейкаОтступ, ty);
      }
    }
  }

  /* ---- легенда и подвал ---- */
  const yПодвал = раскладка.высота - Р.высотаПодвала - Р.поля + 6;
  ctx.strokeStyle = П.линия;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Р.поля, yПодвал - 8);
  ctx.lineTo(раскладка.ширина - Р.поля, yПодвал - 8);
  ctx.stroke();

  let lx = Р.поля;
  ctx.font = P.шрифт(Р.шрифт, false, сем);
  for (const л of раскладка.легенда) {
    const стиль = П.вердикт[л.вердикт] || П.непроверено;
    ctx.fillStyle = стиль.заливка;
    mxПрямоугольник(ctx, lx, yПодвал, 11, 11, 2);
    ctx.fill();
    ctx.strokeStyle = стиль.рамка;
    ctx.stroke();
    const подпись = `${л.подпись} — ${л.счёт}`;
    ctx.fillStyle = П.текстТусклый;
    ctx.fillText(подпись, lx + 16, yПодвал);
    lx += 16 + ctx.measureText(подпись).width + 18;
  }

  ctx.fillStyle = П.текстТусклый;
  ctx.font = P.шрифт(Р.шрифт - 1, false, сем);
  let py = yПодвал + 17;
  for (const строка of раскладка.подвал) {
    ctx.fillText(строка, Р.поля, py);
    py += 12;
  }
  return canvas;
}

/** Выгрузить готовый Blob файлом. */
function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Кнопка «Сохранить как PNG». */
async function mxЭкспортPNG() {
  const A = globalThis.TIAttack;
  const M = globalThis.TIMatrix;
  const P = globalThis.TIMatrixPng;
  const кат = A && A.каталог && A.каталог();
  if (!кат || !M || !P) { toast(T('Каталог ATT&CK не загружен — сохранять нечего')); return; }

  const фильтры = mxФильтры();
  const модель = M.построить(кат, state.caseItems, фильтры);
  if (!модель.колонки.length) {
    toast(T('Под эти фильтры ничего не попало — картинка была бы пустой'));
    return;
  }

  const дата = new Date().toISOString().slice(0, 10);
  const раскладка = P.разложить(модель, {
    название: $('#case-title') ? $('#case-title').value.trim() : '',
    дата,
    выпуск: (A.сводка && A.сводка().версия) || '',
    фильтры,
    режим: state.tlp === 'client' ? 'client' : 'public',
    измерить: mxМерка(),
  });

  /* Отказ НАШ и с объяснением. Chrome на слишком большом холсте отдаёт
   * пустой чёрный PNG без единой ошибки в консоли — такой файл уедет
   * в отчёт, и обнаружит это получатель. */
  if (!раскладка.годится) {
    toast(раскладка.заметки.find((z) => /не помещается/.test(z)) || T('Матрица слишком велика'));
    return;
  }

  const t0 = performance.now();
  const canvas = mxНарисовать(раскладка);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const мс = performance.now() - t0;

  if (!blob) { toast(T('Браузер не смог собрать PNG — сузьте выборку фильтром')); return; }

  const имя = P.имяФайла(дата);
  downloadBlob(имя, blob);

  /* Имя файла запоминается на кейс: скелет отчёта поставит на него
   * ссылку. Без этого раздел «Покрытие ATT&CK» ссылался бы на файл,
   * которого может и не быть. */
  await mxЗапомнитьPNG(имя);

  logEvent('export.done', { format: T('матрица ATT&CK (PNG)') });
  toast(`${имя} — ${Math.round(canvas.width)}×${Math.round(canvas.height)} px, `
    + T`${(blob.size / 1024).toFixed(0)} КБ, ${мс.toFixed(0)} мс`
    + (state.tlp === 'client' ? T(' · без названия кейса и заметок') : ''));
}

/* --------------------------------------- СОСТОЯНИЕ ФИЛЬТРОВ ------------
 *
 * Фильтры сохраняются ПО КЕЙСУ. Один набор на всё расширение означал бы,
 * что настройка под фишинговый кейс применяется к кейсу с АСУ ТП: ничего
 * не сломано, просто матрица отвечает на чужой вопрос.
 *
 * Формат хранения и вытеснение старых записей — в lib/matrix.js,
 * там же и проверяются.
 * --------------------------------------------------------------------- */

/** Идентификатор активного кейса — ключ состояния. */
function mxКлючКейса() {
  const act = globalThis.TICases && TICases.activeCase(state.caseStore);
  return act ? act.id : '';
}

/** Прочитать хранилище фильтров один раз при загрузке страницы. */
async function mxЗагрузитьСостояние() {
  const M = globalThis.TIMatrix;
  if (!M) return;
  state.mxStore = await ENV.storeGet(M.КЛЮЧ_ФИЛЬТРОВ, M.пустоеХранилище());
}

/** Выложить сохранённые фильтры в выпадающие списки. */
function mxПрименитьСостояние() {
  const M = globalThis.TIMatrix;
  const A = globalThis.TIAttack;
  if (!M || !$('#mx-matrix')) return '';

  const сохранён = M.фильтрКейса(state.mxStore, mxКлючКейса());
  const кат = A && A.каталог && A.каталог();
  const { фильтр, потеряно } = M.сверитьФильтр(сохранён, кат);

  const выставить = (сел, знач) => {
    const el = $(сел);
    if (!el) return;
    /* Значения, которого нет среди option, браузер молча заменяет
     * пустым. Поэтому проверяем наличие ЯВНО. */
    const есть = [...el.options].some((o) => o.value === знач);
    el.value = есть ? знач : '';
  };
  выставить('#mx-matrix', фильтр.матрица);
  выставить('#mx-mode', фильтр.режим);
  выставить('#mx-tactic', фильтр.тактика);
  выставить('#mx-verdict', фильтр.вердикт);
  выставить('#mx-platform', фильтр.платформа);
  выставить('#mx-checked', фильтр.проверено);

  /* Потерянное значение НАЗЫВАЕТСЯ. Молча сброшенный фильтр выглядит
   * ровно как фильтр, который стоит: список показывает «все», аналитик
   * уверен, что сузил выборку. */
  return потеряно.length
    ? T('сохранённый фильтр частично сброшен: ') + потеряно.join('; ')
    : '';
}

/** Записать текущие фильтры активного кейса. */
async function mxСохранитьСостояние(доп = null) {
  const M = globalThis.TIMatrix;
  const id = mxКлючКейса();
  if (!M || !id) return;
  state.mxStore = M.записатьФильтр(state.mxStore, id, mxФильтры(), доп);
  await ENV.storeSet(M.КЛЮЧ_ФИЛЬТРОВ, state.mxStore);
}

/** Запомнить имя выгруженной картинки для активного кейса. */
async function mxЗапомнитьPNG(имя) {
  await mxСохранитьСостояние({ png: имя });
}

/** Имя последней выгруженной картинки активного кейса ('' — не было). */
function mxИмяPNG() {
  const M = globalThis.TIMatrix;
  return M ? M.pngКейса(state.mxStore, mxКлючКейса()) : '';
}

/* ===================================================== СПРАВОЧНИКИ ======
 * LOLBAS и GTFOBins на экране.
 *
 * Самих данных здесь нет и не будет — почему именно, написано в шапке
 * lib/packs.js, и это решение про лицензию, а не про объём пакета.
 * Здесь только интерфейс: одна свёрнутая строка «загрузить заранее»
 * и строка в карточке индикатора.
 *
 * ПОЧЕМУ НЕ ОТДЕЛЬНЫЙ РАЗДЕЛ. У конкурента под это заведён целый экран
 * с плитками и кнопками «Install». Загружают справочник один раз за всё
 * время работы — экран под однократное действие занимает место каждый
 * день. Поэтому: строка рядом с инструментами текста плюс кнопка ровно
 * там, где справочник понадобился.
 *
 * ПОЧЕМУ ХРАНИМ ПРОЧИТАННОЕ В ПАМЯТИ. Карточки отрисовываются синхронно,
 * а storage.local асинхронен. Читать его при отрисовке каждой строки —
 * это тридцать чтений на разбор и мерцание блока, появляющегося после
 * отрисовки. Читаем один раз при загрузке страницы и после каждого
 * изменения справочников.
 * ======================================================================= */

/** Прочитанное содержимое справочников. Пустой объект — ничего не загружено. */
let справочники = {};

/* Типы индикаторов, для которых в справочниках есть что искать.
 * winpath — единственный: имя файла из пути Windows. Отдельного типа
 * «путь Unix» в разборе нет, поэтому GTFOBins доступен через палитру
 * (Ctrl+K), где аналитик набирает имя бинарника руками. */
const ПАКЕТНЫЕ_ТИПЫ = new Set(['winpath']);

async function перечитатьСправочники() {
  справочники = (globalThis.TIPacks && await TIPacks.прочитать()) || {};
}

/** Строка «загрузить / обновить / забыть» по каждому справочнику. */
async function renderPacks() {
  const box = $('#packs-list');
  if (!box || !globalThis.TIPacks) return;

  const сост = await TIPacks.состояние();
  box.textContent = '';
  let загружено = 0, всего = 0;

  /* ATT&CK — ПЕРВОЙ СТРОКОЙ, и у неё нет кнопки.
   *
   * Она лежит в пакете и читается сама: у конкурента ради этого заведена
   * плитка с кнопкой «Install», которая ничего не скачивает. Кнопки
   * здесь нет и не будет. Но строка нужна, и вот зачем: до 0.45.0
   * на вопрос «есть ли у меня каталог и насколько он старый» ответить
   * было нечем. Каталог, отставший на два выпуска, выглядит в точности
   * как свежий — техника из свежего отчёта не находится, и это
   * неотличимо от опечатки в отчёте. Строка отвечает выпуском и датой.
   */
  const A = globalThis.TIAttack;
  const св = A && A.сводка();
  if (св) {
    const row = document.createElement('div');
    row.className = 'pack-row';

    const имя = document.createElement('span');
    имя.className = 'pack-name';
    имя.textContent = 'MITRE ATT&CK';

    const что = document.createElement('span');
    что.className = 'pack-what';
    что.textContent = св.матрицы
      ? T`техники и тактики: enterprise ${св.матрицы.enterprise}, `
        + `ICS ${св.матрицы.ics}, mobile ${св.матрицы.mobile}`
      : T('техники и тактики');

    const сост_ = document.createElement('span');
    сост_.className = 'pack-state is-on';
    сост_.textContent = `${св.записей} ${склонениеЗаписей(св.записей)}`
      + (св.версия ? T`, выпуск ${св.версия}` : '')
      + (св.собрано ? T`, от ${новаяДата(св.собрано)}` : '');

    const вПакете = document.createElement('span');
    вПакете.className = 'pack-builtin';
    вПакете.textContent = T('в пакете');
    вПакете.title = T('Загружать нечего: каталог едет вместе с расширением');

    const лиц = document.createElement('a');
    лиц.className = 'pack-lic';
    лиц.href = 'https://attack.mitre.org/resources/legal-and-branding/terms-of-use/';
    лиц.target = '_blank';
    лиц.rel = 'noreferrer noopener';
    лиц.textContent = '© The MITRE Corporation · ATT&CK Terms of Use';

    row.append(имя, что, сост_, вПакете, лиц);
    box.append(row);
  }

  for (const id of Object.keys(сост)) {
    const s = сост[id];
    всего++;
    if (s.загружен) загружено++;

    const row = document.createElement('div');
    row.className = 'pack-row';

    const имя = document.createElement('span');
    имя.className = 'pack-name';
    имя.textContent = s.имя;

    const что = document.createElement('span');
    что.className = 'pack-what';
    что.textContent = s.что;

    const сост_ = document.createElement('span');
    сост_.className = 'pack-state' + (s.загружен ? ' is-on' : '');
    сост_.textContent = s.загружен
      ? `${s.записей} ${склонениеЗаписей(s.записей)}, ${новаяДата(s.когда)}`
      : T('не загружен');

    const кнопка = document.createElement('button');
    кнопка.type = 'button';
    кнопка.className = 'btn btn-mini' + (s.загружен ? '' : ' btn-primary');
    кнопка.textContent = s.загружен ? T('Обновить') : T('Загрузить');
    кнопка.addEventListener('click', () => запуститьЗагрузку(id, кнопка));

    row.append(имя, что, сост_, кнопка);

    if (s.загружен) {
      const забыть = document.createElement('button');
      забыть.type = 'button';
      забыть.className = 'btn btn-mini btn-ghost';
      забыть.textContent = T('Забыть');
      забыть.title = T('Удалить справочник и снять разрешение на его адрес');
      забыть.addEventListener('click', async () => {
        await TIPacks.удалить(id);
        await перечитатьСправочники();
        await renderPacks();
        renderResults();
        renderPacksFound($('#smart-input').value);
        renderPacksSearch($('#packs-query') ? $('#packs-query').value : '');
        toast(T`${s.имя} удалён, разрешение на его адрес снято`);
      });
      row.append(забыть);
    }

    /* Атрибуция стоит рядом со справочником, а не в отдельном файле.
     * Лицензия, под которой лежат чужие данные, должна быть видна тому,
     * кто на них смотрит, — иначе ссылка на ИСТОЧНИКИ.md не работает. */
    const лиц = document.createElement('a');
    лиц.className = 'pack-lic';
    лиц.href = s.страница;
    лиц.target = '_blank';
    лиц.rel = 'noreferrer noopener';
    лиц.textContent = s.лицензия;
    row.append(лиц);

    box.append(row);
  }

  const sub = $('#packs-sub');
  if (sub) {
    sub.textContent = загружено
      ? T`— загружено ${загружено} из ${всего}`
      : T('— загружает аналитик, к нам данные не попадают');
  }
}

function склонениеЗаписей(n) {
  const д = n % 10, дд = n % 100;
  if (д === 1 && дд !== 11) return T('запись');
  if (д >= 2 && д <= 4 && (дд < 12 || дд > 14)) return T('записи');
  return T('записей');
}

function новаяДата(iso) {
  try { return new Date(iso).toLocaleDateString('ru-RU'); } catch (_) { return '—'; }
}

/**
 * Запустить загрузку справочника.
 *
 * ПЕРВОЙ СТРОКОЙ — вызов TIPacks.загрузить(), и это не стиль.
 * permissions.request() разрешён только внутри пользовательского жеста,
 * а первый же await жест теряет. Любая строка перед вызовом — например
 * невинное «покажем, что идёт загрузка» с await — сломает запрос
 * разрешения так, что в консоли будет «may only be called from
 * a user input handler», а на экране ничего.
 */
function запуститьЗагрузку(id, кнопка) {
  const работа = globalThis.TIPacks.загрузить(id);

  const было = кнопка.textContent;
  кнопка.disabled = true;
  кнопка.textContent = T('загрузка…');

  работа.then(async (r) => {
    await перечитатьСправочники();
    await renderPacks();
    renderResults();        // загруженный справочник сразу виден в карточках
    /* И по уже разобранному тексту тоже. Без этого аналитик, загрузивший
     * справочник посреди разбора, увидел бы результат только после
     * повторного нажатия «Разобрать» — то есть решил бы, что не сработало. */
    renderPacksFound($('#smart-input').value);
    renderPacksSearch($('#packs-query') ? $('#packs-query').value : '');
    toast(T`Загружено: ${r.записей} ${склонениеЗаписей(r.записей)}`);
  }).catch((e) => {
    кнопка.disabled = false;
    кнопка.textContent = было;
    /* Отказ в разрешении и поломка источника — разные события,
     * и путать их нельзя: первое человек сделал сам, второе надо чинить. */
    toast(e && e.отказ
      ? T('Без разрешения на адрес справочника загрузить нечего')
      : T('Не загрузилось: ') + (e && e.message || T('неизвестная причина')), 4200);
  });
}

/**
 * Блок справочников в карточке индикатора.
 * Возвращает элемент либо null, если этому типу сказать нечего.
 */
function блокСправочников(ioc) {
  const P = globalThis.TIPacks;
  if (!P || !ПАКЕТНЫЕ_ТИПЫ.has(ioc.type)) return null;

  const найдено = P.найтиВ(справочники, ioc.value);
  const box = document.createElement('div');
  box.className = 'ioc-facts ioc-packs';

  const h = document.createElement('div');
  h.className = 'ioc-facts-head';
  h.textContent = T('Справочники');
  box.append(h);

  if (найдено.length) {
    for (const r of найдено) {
      const row = document.createElement('div');
      row.className = 'ioc-fact';

      const k = document.createElement('span');
      k.className = 'ioc-fact-key';
      k.textContent = r.пакет;

      const v = document.createElement('span');
      v.className = 'ioc-fact-val';
      v.textContent = r.категории.length ? r.категории.join(', ') : T('есть в справочнике');

      const a = document.createElement('a');
      a.className = 'ioc-fact-why';
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = T('страница ↗');
      a.addEventListener('click', (e) => e.stopPropagation());

      row.append(k, v, a);
      box.append(row);

      /* ATT&CK рядом с бинарником. Связь есть в самом справочнике
       * (поле MitreID), названия техник лежат у нас в пакете — две
       * вещи, которые до сих пор лежали рядом и не были соединены. */
      const A = globalThis.TIAttack;
      if (r.техники.length && A && A.загружен()) {
        const имена = r.техники
          .map((t) => { const x = A.техника(t); return x ? `${t} — ${x.название}` : t; });
        const tr = document.createElement('div');
        tr.className = 'ioc-fact';
        const tk = document.createElement('span');
        tk.className = 'ioc-fact-key';
        tk.textContent = T('техники');
        const tv = document.createElement('span');
        tv.className = 'ioc-fact-val';
        tv.textContent = имена.join('; ');
        tr.append(tk, tv);
        box.append(tr);
      }
    }
    return box;
  }

  /* Промаха и незагруженного справочника аналитик не должен путать.
   *
   * Пустое место означало бы и «этого файла в LOLBAS нет», и «LOLBAS
   * не загружен» — а это противоположные вещи: в первом случае вопрос
   * закрыт, во втором не начат. Поэтому обе ситуации проговариваются. */
  let сказано = false;
  for (const id of Object.keys(P.ИСТОЧНИКИ)) {
    if (id !== 'lolbas') continue;        // для пути Windows смотрим только LOLBAS
    const загружен = !!(справочники[id] && справочники[id].bins);
    const row = document.createElement('div');
    row.className = 'ioc-fact';
    const k = document.createElement('span');
    k.className = 'ioc-fact-key';
    k.textContent = P.ИСТОЧНИКИ[id].имя;
    const v = document.createElement('span');
    v.className = 'ioc-fact-val';
    if (загружен) {
      v.textContent = T('не значится');
    } else {
      v.textContent = T('не загружен');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-mini';
      b.textContent = T('Загрузить');
      b.title = T('Один запрос к ') + P.ИСТОЧНИКИ[id].страница + T(' — без индикатора и без контекста');
      b.addEventListener('click', (e) => { e.stopPropagation(); запуститьЗагрузку(id, b); });
      row.append(k, v, b);
      box.append(row);
      сказано = true;
      continue;
    }
    row.append(k, v);
    box.append(row);
    сказано = true;
  }
  return сказано ? box : null;
}

/**
 * Поиск по справочникам — поле рядом с самими справочниками.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНОЕ ПОЛЕ, А НЕ ТОЛЬКО ПАЛИТРА. Палитра Ctrl+K умеет
 * то же самое и быстрее, но узнать о ней можно только из документации.
 * Владелец, читая про «поиск по возможности», искала поле там, где
 * перечислены справочники, — и не нашла ничего. Функция, которую нельзя
 * обнаружить глазами, ничем не отличается от отсутствующей. Палитра
 * осталась: она быстрый путь для того, кто про неё знает.
 *
 * Одно поле на все три справочника: аналитик не обязан знать заранее,
 * его вопрос про LOLBAS или про матрицу ATT&CK.
 */
function renderPacksSearch(запрос) {
  const box = $('#packs-results');
  if (!box) return;
  box.textContent = '';
  const q = String(запрос || '').trim();
  if (q.length < 2) { box.hidden = true; return; }

  const строки = [];
  const видели = new Set();
  const добавить = (r, пометка) => {
    const ключ = r.пакет + '|' + r.имя;
    if (видели.has(ключ)) return;
    видели.add(ключ);
    строки.push({ где: r.пакет, имя: r.имя, url: r.url,
                  что: r.категории.join(', '),
                  ещё: [r.техники.join(' '), пометка].filter(Boolean).join(' · ') });
  };

  const P = globalThis.TIPacks;
  if (P) {
    /* ЗАПРОСОМ МОЖЕТ БЫТЬ ЦЕЛАЯ КОМАНДНАЯ СТРОКА, и это не злоупотребление
     * полем, а самый частый случай: у аналитика на руках строка из лога,
     * а не имя бинарника. Первая версия искала только по имени,
     * возможности и тактике — и на `certutil.exe -urlcache -split -f …`
     * честно отвечала «ничего не нашлось», хотя certutil в справочнике
     * есть. Разбор команды у нас уже был, он просто не был подключён
     * к этому полю: сюда ходил только разбор вкладки «Разбор IOC».
     *
     * Порядок: сначала точное совпадение по имени и возможности —
     * короткий запрос не должен тонуть в разборе; потом разбор строки. */
    for (const r of P.искать(справочники, q, 10)) добавить(r, '');

    /* Разбираем как команду только если в запросе есть на что смотреть:
     * пробел, слэш, конвейер или флаг. Для однословного запроса разбор
     * ничего не добавит — имя уже искали выше. */
    if (/[\s\\/|;]/.test(q)) {
      for (const r of P.найтиВТексте(справочники, q)) добавить(r, T('из команды'));
    }
  }

  const A = globalThis.TIAttack;
  if (A && A.загружен()) {
    let техники = A.найти(q, 6);
    if (!техники.length) техники = A.поТактике(q, 6);
    for (const t of техники) {
      добавить({ пакет: 'ATT&CK', имя: t.id + ' — ' + t.название, url: t.url,
                 категории: t.тактики, техники: [] }, '');
    }
  }

  if (!строки.length) {
    /* Пустая выдача проговаривается, и по-разному.
     *
     * «Ничего не нашлось» при незагруженных справочниках — неправда:
     * мы не искали. Это тот же случай, что «0 индикаторов» на скане
     * PDF без текстового слоя, и путать их нельзя. */
    const нет = document.createElement('p');
    нет.className = 'packs-empty';
    const загружено = Object.keys(справочники).length;
    нет.textContent = загружено
      ? T('Ничего не нашлось')
      : T('Справочники LOLBAS и GTFOBins не загружены — искать пока не в чем; ')
        + T('каталог ATT&CK при этом в пакете и ищется всегда');
    box.append(нет);
    box.hidden = false;
    return;
  }

  for (const s of строки) {
    const row = document.createElement('div');
    row.className = 'packs-result';

    const где = document.createElement('span');
    где.className = 'packs-result-src';
    где.textContent = s.где;

    const a = document.createElement('a');
    a.className = 'packs-result-name';
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = s.имя;

    const что = document.createElement('span');
    что.className = 'packs-result-what';
    что.textContent = [s.что, s.ещё].filter(Boolean).join(' · ');

    row.append(где, a, что);
    box.append(row);
  }
  box.hidden = false;
}

/**
 * Строка «в тексте найдены штатные бинарники».
 *
 * ОДНА СТРОКА, и только когда есть что сказать. Это и есть недостающий
 * вход в справочники: до неё LOLBAS срабатывал лишь на полном пути
 * `C:\Windows\System32\certutil.exe`, а GTFOBins — вообще ни на чём,
 * потому что типа индикатора «путь Unix» в разборе нет. В логе же
 * бинарник стоит голым именем в командной строке, и справочник,
 * уже загруженный аналитиком, срабатывать было не на чем.
 *
 * Блока нет вовсе, если справочники не загружены: уговаривать загрузить
 * их на каждом разборе — это баннер, который перестают читать.
 */
function renderPacksFound(текст) {
  const box = $('#packs-found');
  if (!box) return;
  box.textContent = '';
  box.hidden = true;

  const P = globalThis.TIPacks;
  if (!P) return;
  const найдено = P.найтиВТексте(справочники, текст);
  if (!найдено.length) return;

  const head = document.createElement('span');
  head.className = 'packs-found-head';
  head.textContent = T('Штатные бинарники из справочников:');
  box.append(head);

  for (const r of найдено.slice(0, 12)) {
    const a = document.createElement('a');
    a.className = 'packs-found-item';
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = r.имя;
    const что = r.категории.slice(0, 3).join(', ');
    a.title = T`${r.пакет}${что ? ' · ' + что : ''} — открыть страницу проекта`;
    box.append(a);

    if (что) {
      const k = document.createElement('span');
      k.className = 'packs-found-cat';
      k.textContent = что;
      box.append(k);
    }
  }
  if (найдено.length > 12) {
    const ещё = document.createElement('span');
    ещё.className = 'packs-found-cat';
    ещё.textContent = T`и ещё ${найдено.length - 12}`;
    box.append(ещё);
  }
  box.hidden = false;
}

/**
 * Справочники в палитре.
 *
 * Ищет и по имени, и ПО ВОЗМОЖНОСТИ. Первая версия искала только точное
 * имя — то есть отвечала лишь на вопрос «что умеет certutil», для
 * которого имя надо уже знать. Вопрос «а чем штатным вообще можно
 * скачать файл», ради которого к LOLBAS и ходят, задать было нечем:
 * справочник загружен, а спросить его нельзя.
 */
function бинарникиДляПалитры(query) {
  const P = globalThis.TIPacks;
  if (!P || !query || query.length < 2) return [];
  return P.искать(справочники, query, 8).map((r) => ({
    kind: r.пакет,
    label: `${r.имя} — ${r.категории.slice(0, 5).join(', ') || 'есть в справочнике'}`,
    hint: r.техники.join(' '),
    run: () => ENV.openTab(r.url, true),
  }));
}

/**
 * Строка «новых / уже в кейсе» над выдачей.
 *
 * ЗАЧЕМ. Первый вопрос при очередном отчёте — не «какие тут индикаторы»,
 * а «что из этого мы ещё не видели». Метки «уже в кейсе» на карточках
 * были и раньше, но чтобы ответить, их приходилось пересчитывать
 * глазами по всему списку.
 *
 * ГРАНИЦА. Сравнение идёт ТОЛЬКО с активным кейсом. Поля «клиент»
 * у кейса нет с 0.29.0 — имя заказчика живёт в названии свободным
 * текстом, — и единственное, что не даёт вердикту одного заказчика
 * всплыть в кейсе другого, это область сравнения. Сравнение по всем
 * кейсам сразу («видели раньше») — другая функция, и ей поле «клиент»
 * необходимо.
 */
function renderNovelty() {
  const box = $('#novelty');
  if (!box) return;

  /* Без активного кейса сравнивать не с чем, и строки быть не должно.
   * «Новых: 12 · уже в кейсе: 0» при отсутствующем кейсе — утверждение
   * о кейсе, которого нет. */
  const естьКейс = !!(state.caseStore && state.caseStore.activeId);
  if (!state.parsed || !state.iocs.length || !естьКейс) {
    box.hidden = true;
    return;
  }

  const r = (globalThis.TICases && TICases.новизна(state.iocs, state.caseItems))
    || { новых: 0, известных: 0 };
  $('#novelty-new').textContent = T`Новых: ${r.новых}`;
  $('#novelty-known').textContent = T`уже в кейсе: ${r.известных}`;
  /* Фильтр бесполезен, пока известных нет: скрывать нечего. */
  const чек = $('#only-new');
  if (чек) фильтрДоступен(чек, r.известных > 0);
  box.hidden = false;
}

function фильтрДоступен(чек, доступен) {
  чек.disabled = !доступен;
  чек.closest('label').classList.toggle('is-off', !доступен);
  if (!доступен && чек.checked) { чек.checked = false; state.onlyNew = false; }
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
      box.append(эл('p', { класс: 'empty', текст: T('Индикаторы не найдены.') }));
    } else {
      renderIdleFox(box);
      return;
    }
    return;
  }

  /* Сначала индикаторы, потом обвязка. Порядок не косметический:
   * аналитик читает сверху вниз, и первым он должен увидеть то,
   * ради чего разбирал. */
  let clean = state.iocs.filter((i) => !i.noise);
  const junk = state.iocs.filter((i) => i.noise);

  /* Фильтр «только новые». Прячет то, что УЖЕ в активном кейсе —
   * то есть то, по чему решение принято. Обвязка сюда не относится:
   * она и так отдельной группой. */
  if (state.onlyNew) {
    const было = clean.length;
    clean = clean.filter((i) => !inActiveCase(i));
    if (было && !clean.length) {
      box.append(эл('p', {
        класс: 'empty',
        текст: T('Новых индикаторов нет — всё уже в кейсе.'),
      }));
      $('#bulk-bar').hidden = true;
      renderNovelty();
      return;
    }
  }

  let lastType = null;
  for (const ioc of clean) {
    if (ioc.type !== lastType) {
      const h = document.createElement('div');
      h.className = 'ioc-group-title';
      h.textContent = T(ioc.typeLabel);
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

    /* Метки — УЗЛЫ, а не строки разметки.
     *
     * Здесь стояло escapeHtml/escapeAttr на двух значениях из четырёх,
     * и ровно это место линтер AMO называл `Unsafe assignment`. Флаг
     * разбора `f` приходит из ioc.js по содержимому чужой страницы
     * и не экранировался вовсе. */
    const badges = [];
    if (already) {
      const v = VERDICTS[already.verdict] ? VERDICTS[already.verdict].label : T('не проверен');
      badges.push(эл('span', { класс: 'in-case-mark', текст: T`уже в кейсе: ${v}` }));
    }
    if (ioc.count > 1) {
      badges.push(эл('span', { класс: 'badge badge-count', текст: `×${ioc.count}` }));
    }
    if (ioc.defanged) {
      badges.push(эл('span', { класс: 'badge badge-defang', текст: 'defanged' }));
    }
    for (const f of ioc.flags || []) {
      /* Флаг «свой:…» рисуется отдельной меткой ниже — здесь он
       * пропускается, чтобы не дублировать одно и то же дважды. */
      if (String(f).startsWith(T('свой:'))) continue;
      const warn = f.startsWith('non-routable') || f.startsWith('ambiguous');
      badges.push(эл('span', { класс: warn ? 'badge badge-warn' : 'badge', текст: f }));
    }
    /* Свой или клиентский адрес. Метка идёт ПЕРВОЙ и своим цветом:
     * это единственное, что отличает внешний шлюз заказчика от адреса
     * атакующего, и решение «отправлять ли в VirusTotal» принимается
     * по ней. Прочитать её аналитик должен не раскрывая карточку.
     *
     * Только для попаданий В ПОЛИТИКУ. Нероутируемый адрес уже описан
     * меткой `non-routable:…`, которая стоит здесь с первых версий,
     * и вторая метка о том же рядом с ней — не информация, а шум. */
    const чьё = чейАдрес(ioc);
    if (чьё && чьё.вид === 'политика') {
      const подпись = TIOwnRanges.подпись(чьё);
      badges.unshift(эл('span', {
        класс: 'badge badge-own',
        титул: чьё.почему,
        текст: T`наш: ${подпись}`,
      }));
    }

    /* Вердикт, выставленный ДО кейса, виден в свёрнутой строке.
     *
     * В этом весь смысл ранней разметки: аналитик проходит список
     * сверху вниз, ставит вердикты по ходу чтения и видит, докуда
     * дошёл, не раскрывая карточки. Без этой метки ранняя разметка
     * превращается в работу, результата которой не видно. */
    if (ioc.verdict && ioc.verdict !== 'unknown') {
      const v = VERDICTS[ioc.verdict];
      if (v) badges.unshift(эл('span', { класс: `badge pre-verdict ${v.cls}`, текст: v.label }));
    }

    head.append(
      chk,
      эл('span', { класс: 'ioc-type', текст: ioc.type }),
      эл('span', { класс: 'ioc-value', текст: ioc.value }),
      эл('span', { класс: 'ioc-badges' }, badges),
    );

    /* Кнопка копирования — ОДНА, и это решение, а не экономия.
     *
     * Соблазн поставить рядом вторую, «копировать дефангом», большой:
     * обе формы нужны. Но две кнопки на каждой из тридцати строк —
     * это ровно та перегруженность, из-за которой список перестаёт
     * читаться. Массовое копирование в обеих формах уже есть внизу,
     * а здесь — то, что видит глаз: значение как есть.
     *
     * stopPropagation обязателен: клик по шапке раскрывает карточку,
     * и без него копирование заодно дёргало бы её. */
    const copy = document.createElement('button');
    copy.className = 'ioc-copy';
    copy.type = 'button';
    copy.title = T('Скопировать значение');
    copy.setAttribute('aria-label', T('Скопировать ') + ioc.value);
    copy.textContent = '⧉';
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(ioc.value)
        .then(() => {
          // Подтверждение в самой кнопке, а не тостом: тост на каждое
          // копирование при разборе тридцати значений — это тридцать
          // всплывающих сообщений подряд.
          copy.classList.add('is-done');
          copy.textContent = '✓';
          setTimeout(() => { copy.classList.remove('is-done'); copy.textContent = '⧉'; }, 900);
        })
        .catch(() => toast(T('Буфер обмена недоступен')));
    });
    head.append(copy);

    head.addEventListener('click', () => card.classList.toggle('is-open'));

    // --- тело карточки: подходящие инструменты --------------------------
    const body = document.createElement('div');
    body.className = 'ioc-body';

    /* ЧТО ИЗВЕСТНО БЕЗ СЕТИ.
     *
     * Первым блоком, до списка инструментов: половину решения «с чего
     * начинать» можно принять, ничего не спрашивая у интернета.
     * 10.0.0.1 — адрес внутри сети, 203.0.113.7 — адрес из диапазона
     * для примеров, T1059.001 — это PowerShell. Раньше это аналитик
     * держал в голове либо шёл смотреть в браузер.
     *
     * Блока нет вовсе, если сказать нечего: пустой заголовок «локальные
     * факты» с прочерком — это шум, а не интерфейс. */
    const факты = (globalThis.TIFacts && TIFacts.факты(ioc.type, ioc.value)) || [];
    /* Свой диапазон — тоже локальный факт, и самый дорогой из них:
     * он отвечает не на «что это», а на «можно ли это отправить».
     * Идёт первым, с пояснением, какая именно запись политики сработала:
     * «наш» без причины аналитик проверить не может и вынужден верить. */
    const чьёКарт = чейАдрес(ioc);
    if (чьёКарт && чьёКарт.вид === 'политика') {
      факты.unshift({
        имя: 'внимание',
        значение: T`свой или клиентский: ${TIOwnRanges.подпись(чьёКарт)}`,
        пояснение: чьёКарт.почему + T('. В публичные сервисы не отправляется'),
      });
    }
    if (факты.length) {
      const fbox = document.createElement('div');
      fbox.className = 'ioc-facts';
      const fh = document.createElement('div');
      fh.className = 'ioc-facts-head';
      fh.textContent = T('Известно без сети');
      fbox.append(fh);
      for (const f of факты) {
        const row = document.createElement('div');
        row.className = 'ioc-fact' + (f.имя === 'внимание' ? ' is-warn' : '');
        const k = document.createElement('span');
        k.className = 'ioc-fact-key';
        /* Имя факта — данные: по нему идёт сравнение выше. Перевод
         * делается здесь, при отрисовке, чтобы не трогать значение. */
        k.textContent = T(f.имя);
        const v = document.createElement('span');
        v.className = 'ioc-fact-val';
        v.textContent = f.значение;
        row.append(k, v);
        if (f.пояснение) {
          const p = document.createElement('span');
          p.className = 'ioc-fact-why';
          p.textContent = f.пояснение;
          row.append(p);
        }
        fbox.append(row);
      }
      body.append(fbox);
    }

    /* Справочники — сразу после фактов и до инструментов.
     * Тот же вопрос, что и у фактов: что известно, никуда не отправляя.
     * Разница только в источнике данных, и он назван в блоке. */
    const pbox = блокСправочников(ioc);
    if (pbox) body.append(pbox);

    /* РАЗМЕТКА ДО КЕЙСА.
     *
     * Те же три поля, что в таблице кейса: вердикт, чем проверен,
     * заметка. Ничего нового по смыслу — новое только ВРЕМЯ: раньше
     * их можно было заполнить лишь после добавления в кейс, то есть
     * аналитик сначала складывал всё подряд, а разбирался потом.
     * Теперь он размечает по ходу чтения, а в кейс кладёт уже
     * разобранное.
     *
     * Граница не сдвинулась: в кейс по-прежнему попадает только то,
     * что человек отметил галочкой и добавил. Разметка сама по себе
     * в кейс ничего не кладёт.
     *
     * Хранится разметка на самом объекте выдачи, поэтому уезжает
     * в кейс вместе с ним (addSelectedToCase копирует объект целиком)
     * и живёт до следующего разбора. Переживать разбор она не должна:
     * это разметка ЭТОГО списка, а не накопление.
     */
    const mark = document.createElement('div');
    mark.className = 'ioc-mark';

    const mh = document.createElement('div');
    mh.className = 'ioc-mark-head';
    mh.textContent = already ? T('Разметка (значение уже в кейсе)') : T('Разметка — поедет в кейс вместе со значением');
    mark.append(mh);

    const chipsV = document.createElement('div');
    chipsV.className = 'verdict-chips';
    for (const [key, v] of Object.entries(VERDICTS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vchip ' + v.cls + ((ioc.verdict || 'unknown') === key ? ' is-on' : '');
      b.textContent = v.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        // Повторный клик по активному снимает вердикт: поставить
        // случайно легче, чем найти, как отменить.
        ioc.verdict = (ioc.verdict || 'unknown') === key ? 'unknown' : key;
        /* Перерисовываем ТОЧЕЧНО, а не renderResults().
         *
         * Полная перерисовка схлопнула бы раскрытую карточку — то есть
         * поставив вердикт, аналитик терял бы место, на котором читал.
         * Это тот случай, когда «просто перерисовать всё» ломает ровно
         * ту работу, ради которой функция добавлена. */
        for (const ч of chipsV.children) ч.classList.remove('is-on');
        if (ioc.verdict !== 'unknown') b.classList.add('is-on');
        обновитьМеткуВердикта(head, ioc);
      });
      chipsV.append(b);
    }
    mark.append(chipsV);

    const row2 = document.createElement('div');
    row2.className = 'ioc-mark-row';
    const src = document.createElement('input');
    src.type = 'text';
    src.className = 'case-input';
    src.placeholder = T('чем проверен — VT 43/70');
    src.value = ioc.verdictSource || '';
    src.addEventListener('click', (e) => e.stopPropagation());
    src.addEventListener('change', () => { ioc.verdictSource = src.value.trim(); });

    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'case-input';
    note.placeholder = T('заметка');
    note.value = ioc.note || '';
    note.addEventListener('click', (e) => e.stopPropagation());
    note.addEventListener('change', () => { ioc.note = note.value.trim(); });

    row2.append(src, note);
    mark.append(row2);
    body.append(mark);

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
      h.textContent = T('Склеено из переноса — проверьте, так ли это:');
      box.append(h);

      const src = document.createElement('div');
      src.className = 'wrap-proof-row';
      const srcLabel = document.createElement('span');
      srcLabel.className = 'wrap-proof-label';
      srcLabel.textContent = T('как в исходнике');
      const srcVal = document.createElement('code');
      srcVal.className = 'wrap-proof-val';
      // Каждая исходная строка — своей строкой: в этом весь смысл показа.
      srcVal.textContent = ioc.wrapSource.join('\n');
      src.append(srcLabel, srcVal);

      const got = document.createElement('div');
      got.className = 'wrap-proof-row';
      const gotLabel = document.createElement('span');
      gotLabel.className = 'wrap-proof-label';
      gotLabel.textContent = T('как склеено');
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
      chips.append(эл('span', {
        класс: 'no-tools',
        текст: T('Нет инструментов для этого типа в текущем режиме данных.'),
      }));
    } else {
      // Внутренние источники всегда первыми: проверка «а не отработано ли уже».
      const order = { internal: 0, limited: 1, public: 2 };
      tools.sort((a, b) => order[a.exposure] - order[b.exposure] || a.name.localeCompare(b.name));
      /* ГЕЙТ СВОИХ ДИАПАЗОНОВ.
       *
       * Публичный сервис по своему адресу не открывается молча.
       * Не прячем ссылку: спрятанный сервис неотличим от несуществующего,
       * и аналитик решит, что инструмент сломан. Ссылка остаётся, но
       * её приходится подтвердить, и в вопросе названа причина —
       * бывает, что отправить всё-таки надо, и запрещать это
       * расширению не по чину. */
      const чьёЧип = чейАдрес(ioc);
      for (const t of tools) {
        const наружу = !!чьёЧип && t.exposure === 'public';
        const a = document.createElement('a');
        a.className = 'chip' + (t.activity === 'active' ? ' chip-active-warn' : '')
          + (наружу ? ' chip-own' : '');
        a.href = buildUrl(t, ioc.value);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = наружу
          ? T`${ioc.value} — ${чьёЧип.почему}. Отправка в публичный сервис `
            + T('требует подтверждения.')
          : `${T(t.note || '')}\n[${t.exposure}/${t.activity}]`;
        if (наружу) {
          a.addEventListener('click', (e) => {
            if (confirm(`${ioc.value} — ${чьёЧип.почему}.\n\n`
              + T`«${t.name}» — публичный сервис: значение уйдёт наружу `
              + T('и станет известно, чья инфраструктура расследуется.\n\n')
              + T('Всё равно открыть?'))) return;
            e.preventDefault();
          });
        }
        /* Имя сервиса переводится: в реестре оно по-русски
         * («Пасты (через Google)»), и без T() оно оставалось
         * русским в раскрытой карточке — в дереве слева при этом
         * было переведено, что выглядит как наполовину переведённый
         * интерфейс. */
        a.append(эл('i', { класс: `dot dot-${точкаДоступа(t.exposure)}` }),
                 document.createTextNode(T(t.name)),
                 ...pricingTags(t, true));
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
      /* Имя плейбука переводится ОТДЕЛЬНО, вторым T().
       * Подстановка в шаблон вставляет значение как есть: ключ
       * `Плейбук: {0}` переводится, а имя внутри оставалось русским,
       * и это было видно на скриншоте для магазина. */
      b.textContent = pbs.length === 1 ? T`Плейбук: ${T(pbs[0].name)}` : T('Плейбук…');
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
  sum.textContent = T`Отсеяно как обвязка страницы: ${junk.length}`;
  const hint = document.createElement('span');
  hint.className = 'noise-hint';
  hint.textContent = T(' — площадки и адреса источника, колонтитулы, раздел ссылок.')
                   + T(' У каждой строки написана причина. Разверните, если нужно');
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
  all.textContent = T('Вернуть всё в выдачу');
  all.addEventListener('click', () => {
    for (const i of junk) { i.noise = false; delete i.noiseReason; state.selected.add(iocKey(i)); }
    renderResults();
    toast(T`Возвращено: ${junk.length}`);
  });
  body.append(all);

  det.append(body);
  box.append(det);
}

/* Массовое открытие: ограничиваем частоту, иначе Firefox схлопнет вкладки
 * как popup-flood, а внешние сервисы отдадут 429. */
async function openSelectedIn(toolId) {
  const tool = state.registry.tools.find((t) => t.id === toolId);
  const выбрано = state.iocs.filter((i) => state.selected.has(iocKey(i)) && tool.types.includes(i.type));
  if (!выбрано.length) { toast(T('Нет выбранных индикаторов подходящего типа')); return; }

  /* СВОИ АДРЕСА НЕ УХОДЯТ ПАЧКОЙ.
   *
   * Здесь, в отличие от одиночной ссылки в карточке, подтверждения нет
   * и быть не может: вопрос «открыть 30 вкладок, из них 4 с адресами
   * заказчика?» человек читает как «открыть 30 вкладок?». Поэтому свои
   * просто не открываются — а то, что их не открыли, говорится вслух
   * и с количеством. Одиночная отправка, если она нужна, осталась
   * в карточке индикатора. */
  const свои = выбрано.filter((i) => !можноВСервис(i, tool));
  const targets = выбрано.filter((i) => можноВСервис(i, tool));

  if (!targets.length) {
    toast(T`Все ${свои.length} выбранных значений — свои или клиентские: `
      + T`«${tool.name}» публичный, наружу они не отправляются`, 4600);
    return;
  }
  if (targets.length > 15 &&
      !confirm(T`Будет открыто ${targets.length} вкладок в «${tool.name}». Продолжить?`)) return;

  for (const [n, i] of targets.entries()) {
    ENV.openTab(buildUrl(tool, i.value), false);
    if (n % 5 === 4) await new Promise((r) => setTimeout(r, 400));
  }
  toast(T`Открыто вкладок: ${targets.length}`
    + (свои.length ? T` · пропущено своих и клиентских: ${свои.length}` : ''),
    свои.length ? 4600 : 2600);
  logEvent('tools.opened', {
    count: targets.length,
    value: targets.length === 1 ? targets[0].value : T`${tool.name} (${targets.length} значений)`,
    /* Число пропущенных идёт в хронологию: «проверено 26 из 30» и
     * «проверено 30 из 30» — разная глубина проверки, и при передаче
     * смены разница видна только если она записана. */
    skippedOwn: свои.length || undefined,
  });
}

function showOpenMenu() {
  const menu = $('#open-menu');
  if (!menu.hidden) { menu.hidden = true; return; }

  const selTypes = new Set(state.iocs.filter((i) => state.selected.has(iocKey(i))).map((i) => i.type));
  const applicable = state.registry.tools
    .filter((t) => isToolAllowed(t) && t.types.some((ty) => selTypes.has(ty)));

  menu.textContent = '';
  if (!applicable.length) {
    menu.append(эл('button', {
      текст: T('Нет подходящих инструментов'),
      атр: { disabled: true },
    }));
  }
  for (const t of applicable) {
    const n = state.iocs.filter((i) => state.selected.has(iocKey(i)) && t.types.includes(i.type)).length;
    const b = document.createElement('button');
    b.textContent = T`${t.name} — ${n} шт.`;
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
  const now = Date.now();
  const name = TIFox.foxStateFor({
    error: state.foxError,
    busy: state.foxBusy || now < busyUntil,
    tlp: state.tlp,
    celebrate: now < state.foxCelebrateUntil,
    found: state.iocs.filter((i) => !i.noise).length,
    /* Порог передаётся ЯВНО, хотя у foxIdleLong есть такое же значение
     * по умолчанию. Причина: будильник ниже читает его из TIFox, и если
     * оставить здесь умолчание, два места начнут считать по разным
     * числам, как только порог кто-нибудь поменяет. Одно значение —
     * один источник. */
    idleLong: TIFox.foxIdleLong(state.lastActionAt, now, TIFox.FOX_ATTENTION_MS),
  });
  brandFoxHandle.setState(name);
  const canvas = $('#brand-fox');
  if (canvas) canvas.title = 'TI Console: ' + brandFoxHandle.label();
  planFoxWake(now);
}

/* ПРАЗДНОВАНИЕ И МАХАНИЕ ЛАПОЙ.
 *
 * Обе анимации кончаются не по событию, а по времени, и без будильника
 * лиса замерла бы в последнем состоянии до следующего клика: прыгала бы
 * минутами после создания кейса, а махать начинала бы только тогда,
 * когда аналитик и так что-то нажал, то есть никогда.
 *
 * Будильник ОДИН и всегда переустанавливается на ближайший из двух
 * сроков. Отдельные таймеры на каждое состояние копятся во вкладке,
 * которую держат открытой неделю. */
let foxWakeTimer = null;
function planFoxWake(now = Date.now()) {
  clearTimeout(foxWakeTimer);
  foxWakeTimer = null;
  if (!globalThis.TIFox) return;
  const сроки = [];
  if (now < state.foxCelebrateUntil) сроки.push(state.foxCelebrateUntil - now);
  if (state.lastActionAt > 0) {
    const до = state.lastActionAt + TIFox.FOX_ATTENTION_MS - now;
    if (до > 0) сроки.push(до);
  }
  if (!сроки.length) return;
  // +30 мс: просыпаться ровно в срок — значит иногда просыпаться на
  // миллисекунду раньше и не менять ничего.
  foxWakeTimer = setTimeout(syncFox, Math.max(0, Math.min(...сроки)) + 30);
}

/* Отметка действия аналитика. Сбрасывает махание и заводит будильник
 * заново. Вызывается из одного места — глобального слушателя ниже. */
function noteAction() {
  const было = state.lastActionAt;
  state.lastActionAt = Date.now();
  if (!globalThis.TIFox) return;
  /* Пересинхронизация нужна только когда что-то могло измениться:
   * лиса махала или вообще не знала времени. Без этого условия каждое
   * нажатие клавиши в поле ввода дёргало бы setState и пересчёт
   * находок. */
  if (!было || TIFox.foxIdleLong(было, state.lastActionAt, TIFox.FOX_ATTENTION_MS)) syncFox();
  else planFoxWake();
}

/* Празднование: кейс создан. Длительность — в fox.js, чтобы удержание
 * и последовательность кадров не разъехались. */
function foxCelebrate() {
  if (!globalThis.TIFox) return;
  state.foxCelebrateUntil = Date.now() + TIFox.FOX_CELEBRATE_MS;
  syncFox();
}

/* Наблюдение за действиями аналитика.
 *
 * Слушатели вешаются на document в фазе ПЕРЕХВАТА (capture) и пассивно:
 * так они видят событие независимо от того, остановит ли его обработчик
 * кнопки, и ничего не задерживают.
 *
 * Вкладку в фоне действиями не считаем: скрытая вкладка сама по себе
 * простой, и лиса в ней всё равно не рисуется (см. fox.js). Зато возврат
 * на вкладку — действие: аналитик пришёл, махать ему не за что. */
function startActionWatch() {
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'paste', 'focusin']) {
    document.addEventListener(ev, noteAction, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) noteAction();
  });
  noteAction();   // холодный старт: открытие вкладки — тоже действие
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
  hint.textContent = T('Вставьте отчёт, лог или выгрузку — или заберите страницу по ссылке.');
  const keys = document.createElement('p');
  keys.className = 'idle-keys';
  keys.textContent = T('Ctrl+K — инструменты, плейбуки и действия · Ctrl+Enter — разобрать');
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
  ttNote(T('Содержимое поля возвращено.'));
  ttOut(null);
}

function ttBase64() {
  const src = $('#smart-input').value;
  if (!src.trim()) { ttNote(T('Поле пустое.'), true); return; }

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
      out += T`\n\n[раскодировано, ${d.encoding}, ${d.bytes} байт, ${f.from}]\n${d.chosen}`;
      notes.push(`${f.from}: ${d.encoding}` + (d.note ? ` — ${d.note}` : ''));
    }
    if (!notes.length) { ttNote(T('Похожие на base64 строки есть, но ни одна не раскодировалась.'), true); return; }
    ttReplace(out, T`Раскодировано вставок: ${notes.length}. ${notes[0]}`);
    return;
  }

  // Иначе пробуем всё поле как одну строку base64.
  const d = TIText.decodeBase64(src.trim());
  if (!d.ok) {
    ttNote(T('В поле не найдено ни строки base64. Хеши из отчёта base64 не являются, ')
         + T('хотя и подходят по алфавиту — поэтому они здесь не предлагаются.'), true);
    return;
  }
  ttReplace(d.chosen, T`Раскодировано как ${d.encoding}, ${d.bytes} байт.`
    + (d.note ? ' ' + d.note : ''));
}

function ttUrlDecode() {
  const r = TIText.decodeUrl($('#smart-input').value);
  if (!r.ok) { ttNote(r.error, true); return; }
  if (r.value === $('#smart-input').value) { ttNote(T('Кодирования не обнаружено — текст не изменился.')); return; }
  ttReplace(r.value, T('URL-кодирование снято.'));
}

function ttHex() {
  const r = TIText.hexToText($('#smart-input').value);
  if (!r.ok) { ttNote(r.error, true); return; }
  ttReplace(r.value, T`Раскодировано из hex, ${r.bytes} байт.`);
}

function ttDedupe() {
  const d = TIText.dedupeList($('#smart-input').value);
  if (!d.unique) { ttNote(T('В поле нет значений для дедупликации.'), true); return; }
  const byType = Object.entries(d.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}: ${n}`).join(', ');
  ttReplace(d.items.map((i) => i.value).join('\n'),
    T`Было ${d.total}, осталось ${d.unique} (повторов ${d.duplicates}). По типам — ${byType}.`);
}

/* Сравнение двух списков: «что добавилось в обновлённом отчёте».
 *
 * Результат кладётся в вывод, а НЕ в поле ввода: в отличие от
 * раскодирования, здесь исходный список нужен целиком и портить его
 * нечем. Ничего не сохраняется — оба списка вставил человек. */
function ttDiff() {
  const older = $('#tt-diff-input').value;
  const newer = $('#smart-input').value;
  if (!older.trim()) { ttNote(T('Вставьте список для сравнения.'), true); return; }
  const d = TIText.diffLists(older, newer, IOC);
  ttNote(T`Было ${d.countA}, стало ${d.countB}. `
       + T`Добавилось ${d.added}, исчезло ${d.removed}, общих ${d.common}. `
       + T('Сравнение по канонической форме: evil[.]com и evil.com — одно значение.'));
  const cut = (a) => a.slice(0, 40).join('\n') + (a.length > 40 ? T`\n…и ещё ${a.length - 40}` : '');
  ttOut([
    [T`добавилось (${d.added})`, d.added ? cut(d.onlyB) : '—'],
    [T`исчезло (${d.removed})`, d.removed ? cut(d.onlyA) : '—'],
    [T`общих (${d.common})`, d.common ? cut(d.both) : '—'],
  ]);
}

async function ttHash() {
  const src = $('#smart-input').value;
  if (!src.length) { ttNote(T('Поле пустое.'), true); return; }
  const h = await TIText.hashText(src);
  ttNote(T`Хеши СОДЕРЖИМОГО ПОЛЯ (${h.bytes} байт). Это не хеш файла: `
       + T('чтобы посчитать файл, загрузите его кнопкой «Загрузить файл».')
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
      hint: T(t.note || '').slice(0, 70),
      types: t.types,
      run: () => openToolWithPrompt(t),
    });
  }
  for (const pb of наборыВсе()) {
    items.push({
      kind: T('плейбук'), label: T(pb.name), hint: T`${pb.steps.length} шагов · ${T(pb.note || '')}`,
      types: pb.types,
      run: () => {
        const sel = state.iocs.filter((i) => state.selected.has(iocKey(i)));
        if (!sel.length) { toast(T('Сначала выберите индикаторы')); return; }
        runPlaybookOnSelected(pb.id);
      },
    });
  }
  const acts = [
    [T('Разобрать поле ввода'), () => parseInput()],
    [T('Очистить поле ввода'), () => $('#btn-clear').click()],
    [T('Добавить выбранное в кейс'), () => addSelectedToCase()],
    [T('Экспорт CSV'), () => $('#btn-export-csv').click()],
    [T('Экспорт STIX 2.1'), () => $('#btn-export-stix').click()],
    [T('Скелет отчёта'), () => $('#btn-report').click()],
    [T('Кейс и отчёт'), () => switchTab('case')],
    [T('Разбор IOC'), () => switchTab('smart')],
    [T('Поиск по источникам'), () => switchTab('global')],
  ];
  for (const [label, run] of acts) items.push({ kind: T('действие'), label, hint: '', run });

  /* ВЫКЛЮЧЕННЫЕ ФУНКЦИИ ИЩУТСЯ ЗДЕСЬ — и это главный ответ на «скрытая
   * функция забывается». Аналитик, который помнит слово «HAR», найдёт
   * его в палитре, даже если блока на экране нет, и включит одним
   * нажатием. Без этого выключение равносильно удалению: узнать, что
   * функция существует, было бы неоткуда. */
  if (globalThis.TISettings) {
    for (const ф of TISettings.выключенные(state.settings)) {
      items.push({
        kind: T('выключено'), label: ф.имя,
        hint: ф.зачем ? T`${ф.зачем} — включить` : T('включить в настройках'),
        run: () => включитьФункцию(ф.id),
      });
    }
  }
  return items;
}

/* Техники ATT&CK в палитре.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ ОТДЕЛЬНОЙ СТРАНИЦЕЙ. У конкурента для справочников
 * заведён раздел «Offline packs» с кнопкой «Install» у каждого. Кнопка
 * эта ничего не скачивает — данные уже в пакете, — но занимает экран
 * и требует действия там, где действия не нужно. У нас каталог лежит
 * в пакете и читается сам; значит ему нужен не раздел, а СТРОКА ПОИСКА,
 * и она уже есть — палитра.
 *
 * Каталог сюда попадает только по запросу: 918 техник в общем списке
 * утопили бы инструменты и плейбуки, ради которых палитру открывают.
 * Порог в два символа — чтобы «T» не выдавало половину матрицы.
 */
function техникиДляПалитры(query) {
  const A = globalThis.TIAttack;
  if (!A || !A.загружен() || !query || query.length < 2) return [];

  const строка = (t, откуда) => ({
    kind: 'ATT&CK',
    label: `${t.id} — ${t.название}`,
    hint: t.тактики.join(', ') + (откуда ? ' · ' + откуда : ''),
    run: () => ENV.openTab(t.url, true),
  });

  const найдено = A.найти(query, 8).map((t) => строка(t, ''));
  if (найдено.length) return найдено;

  /* Поиск по ТАКТИКЕ — когда по идентификатору и названию ничего нет.
   *
   * «Execution» не находилось вовсе: найти() сверяет запрос с номером
   * и названием техники, а тактика в них не входит. То есть каталог
   * лежал в пакете, а спросить его «что относится к Execution» было
   * нечем — при том, что с этим вопросом к матрице и приходят, когда
   * разбирают поведение, а не готовый отчёт с проставленными кодами. */
  return A.поТактике(query, 8).map((t) => строка(t, T('тактика')));
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
  toast(T`${tool.name} открыт без подстановки — не было выбранных индикаторов подходящего типа`, 3600);
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

  /* Справочники ищут САМИ и отбору по тексту строки НЕ подлежат.
   *
   * Раньше их выдача складывалась с остальным и просеивалась общим
   * правилом «запрос обязан встретиться в подписи». Для поиска по имени
   * это совпадало случайно, а для поиска по возможности — ломало всё:
   * запрос «execution» не встречается в подписи «T1059.001 — PowerShell»,
   * и найденное самим каталогом тут же выбрасывалось. Двойной отбор
   * по двум разным правилам — это способ потерять результат молча. */
  const свои = paletteItems();
  const справочные = query
    ? техникиДляПалитры(query).concat(бинарникиДляПалитры(query))
    : [];

  const отобрано = query
    ? свои.map((it) => ({ it, s: Math.max(paletteScore(it.label, query), paletteScore(it.kind, query) - 20) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.it.label.localeCompare(b.it.label))
        .map((x) => x.it)
    : свои.filter((it) => it.kind !== 'инструмент');  // без запроса — только действия и плейбуки

  paletteVisible = отобрано.concat(справочные).slice(0, 40);

  paletteIndex = 0;
  if (!paletteVisible.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = T('Ничего не нашлось');
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

/* ------------------------------------------------- МОИ ПРОВЕРКИ ---------
 *
 * Набор один и лежит в storage.local (lib/myplaybooks.js). Встроенные
 * последовательности остались в реестре, но больше не предлагаются
 * как отдельные наборы: они служат заготовкой, которую можно подставить
 * в «Мои проверки» одной кнопкой. Весь интерфейс ниже спрашивает состав
 * у одной функции — иначе правка видна в одном месте (в меню) и не
 * видна в другом (в палитре), и человек считает, что не сохранилось.
 * ------------------------------------------------------------------------ */
function наборыВсе() {
  if (!globalThis.TIMyPlaybooks) return [];
  return TIMyPlaybooks.список(state.наборыПравки,
                              (state.registry && state.registry.tools) || []);
}

async function загрузитьНаборы() {
  if (!globalThis.TIMyPlaybooks) return;
  const сырое = await ENV.storeGet(TIMyPlaybooks.КЛЮЧ, null);
  const { хранилище, замечания } = TIMyPlaybooks.нормализовать(сырое);
  state.наборыПравки = хранилище;
  state.наборыЗамечания = замечания;
  /* Починенное состояние записывается обратно сразу — иначе замечание
   * про отброшенные записи показывалось бы при каждом запуске, а файл
   * так и оставался бы битым. */
  if (замечания.length) await сохранитьНаборы();
}

async function сохранитьНаборы() {
  if (!globalThis.TIMyPlaybooks) return;
  await ENV.storeSet(TIMyPlaybooks.КЛЮЧ, state.наборыПравки);
}

/* Планирование вынесено в lib/playbook.js и покрыто тестами: там
 * решается, какие шаги отбросит TLP-гейт, а ошибка в этом месте
 * означает отправку клиентского индикатора в публичный сервис.
 * Свой набор идёт через ту же функцию: гейт для него не мягче. */
function playbooksFor(types) {
  return TIPlaybook.playbooksFor(наборыВсе(), types);
}

function planPlaybook(pb, value, type) {
  const свой = !!чейАдрес({ type, value });
  return TIPlaybook.planPlaybook(pb, state.registry.tools, type, state.tlp, свой);
}

async function runPlaybook(pbId, value, type) {
  const pb = наборыВсе().find((p) => p.id === pbId);
  if (!pb) { toast(T('Плейбук не найден')); return; }

  const план = planPlaybook(pb, value, type);
  const steps = план.steps;
  /* Пропуск по типу — само устройство набора, а не потеря: список один
   * на все типы, и при разборе адреса сервисы по хешам не открываются
   * по замыслу. В отчёт о выполнении такие шаги не идут, иначе строка
   * «пропущено 14» звучала бы при каждой исправной работе и перестала
   * бы читаться там, где она важна, — на пропусках по режиму данных
   * и по своим диапазонам. */
  const skipped = план.skipped.filter((s) => s.why !== TIPlaybook.PB_SKIP.TYPE);
  if (!steps.length) {
    const своих = skipped.filter((s) => s.why === TIPlaybook.PB_SKIP.OWN).length;
    toast(T`«${pb.name}»: ни одного доступного шага${
      своих ? ' — публичные пропущены: это свой или клиентский адрес'
        : state.tlp === 'client' ? ' — все скрыты режимом клиентских данных' : ''}`,
      4200);
    return;
  }

  if (steps.length > 8 &&
      !confirm(T`«${pb.name}» откроет ${steps.length} вкладок по ${value}. Продолжить?`)) return;

  for (const [n, tool] of steps.entries()) {
    ENV.openTab(buildUrl(tool, value), false);
    // Тот же ограничитель, что у массового открытия: без паузы Firefox
    // считает это popup-flood и схлопывает вкладки.
    if (n % 5 === 4) await new Promise((r) => setTimeout(r, 400));
  }

  /* Пропущенные шаги называются вслух. Молчаливый пропуск хуже отсутствия
   * плейбука: аналитик считает, что проверка выполнена целиком, и в отчёте
   * это будет выглядеть именно так. */
  let msg = T`«${pb.name}»: открыто ${steps.length}`;
  if (skipped.length) {
    const byTlp = skipped.filter((s) => s.why === TIPlaybook.PB_SKIP.TLP).length;
    const byOwn = skipped.filter((s) => s.why === TIPlaybook.PB_SKIP.OWN).length;
    msg += T` · пропущено ${skipped.length}`;
    const почему = [];
    if (byTlp) почему.push(T`${byTlp} — режим данных`);
    if (byOwn) почему.push(T`${byOwn} — свой или клиентский адрес`);
    if (почему.length) msg += ` (${почему.join(', ')})`;
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
    b.textContent = T('Нет плейбуков для этих типов');
    menu.append(b);
  }

  for (const pb of list) {
    const b = document.createElement('button');
    // Показываем, сколько шагов реально выполнится, а не сколько объявлено:
    // в режиме клиентских данных это разные числа, и знать надо ДО нажатия.
    const probe = value ? planPlaybook(pb, value, type) : null;
    const count = probe ? T`${probe.steps.length} из ${pb.steps.length}` : T`${pb.steps.length} шагов`;
    b.textContent = `${T(pb.name)} — ${count}`;
    b.title = T(pb.note || '');

    /* Плейбук, у которого в текущем режиме не осталось ни одного шага,
     * недоступен и объясняет почему. Дать нажать и ничего не сделать —
     * худший вариант: аналитик решит, что проверка выполнена. */
    if (probe && !probe.steps.length) {
      b.disabled = true;
      b.textContent = T`${pb.name} — недоступен`;
      b.title = state.tlp === 'client'
        ? T('Все шаги — публичные сервисы. В режиме клиентских данных ')
          + T('отправлять туда индикатор клиента нельзя.')
        : T('Ни один шаг не подходит к этому типу индикатора');
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
  const pb = наборыВсе().find((p) => p.id === pbId);
  const fit = targets.filter((i) => pb.types.includes(i.type));
  if (!fit.length) { toast(T('Среди выбранных нет индикаторов подходящего типа')); return; }

  const total = fit.reduce((n, i) => n + planPlaybook(pb, i.value, i.type).steps.length, 0);
  if (total > 12 &&
      !confirm(T`«${pb.name}» по ${fit.length} индикаторам — это ${total} вкладок. Продолжить?`)) return;

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

  /* Матрица привязана к кейсу: у каждого свои фильтры и своя выгруженная
   * картинка. Перерисовываем только если вкладка открыта — строить тысячу
   * узлов при каждом переключении кейса незачем. */
  const вкладкаМатрицы = $('#panel-matrix');
  if (вкладкаМатрицы && вкладкаМатрицы.classList.contains('is-active')) {
    state.mxПотеряно = mxПрименитьСостояние();
    renderMatrix();
    const карточка = $('#mx-card');
    if (карточка) карточка.hidden = true;   // карточка была про прежний кейс
  }
}

/** Записать состояние страницы обратно в активный кейс. */
async function saveCase() {
  const act = TICases.activeCase(state.caseStore);
  if (!act) {
    // Кейса нет — создаём при первом же добавлении, иначе индикаторы
    // складывать некуда, а молча их терять нельзя.
    const r = TICases.addCase(state.caseStore, { title: T('Без названия') });
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
    o.textContent = T('кейсов нет — создайте');
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
      badge.textContent = act.title || T('без названия');
      badge.className = act.title ? 'case-name' : 'case-name is-empty';
      badge.title = T`Активный кейс: ${TICases.caseLabel(act)}`;
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
    console.warn(T('хронология: событие не записано'), kind, e);
  }
}

/* Первое событие кейса. Ставится в момент первого добавления, а не при
 * загрузке консоли: открытая и закрытая вкладка — не начало работы. */
function ensureCaseStarted() {
  if (state.timeline.length) return;
  logEvent('case.started', { title: ($('#case-title')?.value || '').trim() });
}

/**
 * Положить весь разбор открытой вкладки в активный кейс.
 *
 * Вызывается только из loadLastScan по флагу, который поставила кнопка
 * «Разобрать в кейс». Своей кнопки в консоли нет намеренно: там уже
 * есть «Добавить выбранное в кейс», и вторая кнопка рядом означала бы
 * два способа сделать одно и то же с разным результатом.
 */
async function добавитьРазборВКейс() {
  const активный = TICases.activeCase(state.caseStore);
  if (!активный) {
    toast(T('Активного кейса нет — создайте его во вкладке «Кейс и отчёт». ')
        + T('Разбор остался в выдаче, ничего не потеряно'), 5200);
    return;
  }

  const now = new Date().toISOString();
  const было = new Set(state.caseItems.map(iocKey));
  let добавлено = 0, повтор = 0;

  for (const i of state.iocs) {
    if (i.noise) continue;                    // обвязка в кейс не едет
    if (было.has(iocKey(i))) { повтор++; continue; }
    было.add(iocKey(i));
    state.caseItems.push({
      ...i, addedAt: now,
      source: state.inputSource,
      sourceUrl: state.sourceUrl || undefined,
    });
    добавлено++;
  }

  saveCase();
  ensureCaseStarted();
  /* Адрес страницы — главное в этой записи. Через день, разобрав пять
   * отчётов, аналитик не помнит, откуда в кейсе взялся конкретный адрес;
   * хронология отвечает на это без него. */
  logEvent('tab.captured', {
    count: добавлено,
    skipped: повтор,
    url: state.sourceUrl || undefined,
  });
  renderCase();
  renderResults();

  toast(добавлено
    ? T`В кейс «${TICases.caseLabel(активный)}»: добавлено ${добавлено}`
      + (повтор ? T`, уже было ${повтор}` : '')
    : (повтор ? T`Все ${повтор} индикаторов уже в кейсе` : T('На странице индикаторов не найдено')),
    4200);
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
    /* Пересчитать «новых / уже в кейсе» ЗДЕСЬ.
     *
     * Без этого строка оставалась бы от прошлого разбора: аналитик
     * добавил значения в кейс, а над списком по-прежнему «новых: 12».
     * Тот же класс отказа, что «загруженный справочник не виден
     * до повторного разбора» — поймано прогоном на живой странице. */
    renderNovelty();
    renderResults();
  }
  toast(added ? T`Добавлено в кейс: ${added}` : T('Все выбранные уже в кейсе'));
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
  unknown:    { label: T('не проверен'), cls: 'v-unknown' },
  malicious:  { label: T('вредоносный'), cls: 'v-mal' },
  suspicious: { label: T('подозрительный'), cls: 'v-sus' },
  clean:      { label: T('чистый'), cls: 'v-clean' },
  irrelevant: { label: T('не относится'), cls: 'v-none' },
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
  renderUnsaved();

  state.caseItems.forEach((i, idx) => {
    migrateCaseItem(i);
    const tr = document.createElement('tr');
    tr.className = VERDICTS[i.verdict] ? VERDICTS[i.verdict].cls : 'v-unknown';
    const flags = [...(i.flags || [])];
    if (i.defanged) flags.push('defanged');
    if (i.needsVisualCheck) flags.push(T('сверить с картинкой'));

    /* Ни одна ячейка не собирается через innerHTML.
     *
     * Это не стилистика. Сюда попадают имя файла, хост из ссылки
     * и заметка — строки, которые выбирает не аналитик, а тот, чей файл
     * он открыл. Файл с именем «<img src=x onerror=...>.txt», собранный
     * в шаблон для innerHTML, дал бы исполнение кода в контексте
     * расширения — с доступом к storage и вкладкам. В эту таблицу
     * разметка не попадает, потому что разметки здесь не бывает. */
    const tdType = document.createElement('td');
    tdType.textContent = T(i.typeLabel);
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
    note.placeholder = T('заметка');
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
    tags.placeholder = T('теги через запятую');
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
    del.textContent = T('убрать');
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
    if (r.вКейсе) хвост.push(T`${r.вКейсе} уже в кейсе`);
    if (r.отклонено) хвост.push(T`${r.отклонено} в отбое`);
    toast(T`Во входящих +${r.added}` + (хвост.length ? ` · ${хвост.join(', ')}` : ''));
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
  if (s.отклонено) части.push(T`в отбое ${s.отклонено}`);
  if (s.обрезано) части.push(T`обрезано ${s.обрезано}`);
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
    ? T('Очередь переживает следующий разбор. Отсюда — либо в кейс, либо в отбой; ')
      + T('отклонённое не всплывает снова.')
    : (s.отклонено ? T('Очередь пуста. Отклонённое помнится и повторно не предлагается.') : '');
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
  if (detail) detail.textContent = T('Нажмите на линию или узел — здесь появится, что это значит.');

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
  svg.setAttribute('aria-label', T`Схема кейса: ${g.total} индикаторов, ${g.sources.length} источников`);

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
      t.textContent = (n.typeLabel ? T(n.typeLabel) + '  ' : '') + n.label;
      t.addEventListener('click', () => say(`${n.typeLabel || n.type}: ${n.label}`
        + (n.source ? T` · источник: ${n.source}` : '')));
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
      t.addEventListener('click', () => say(T`Источник: ${gr.source.label} · индикаторов: ${gr.source.count}`));
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
  legend.append(
    эл('span', { класс: 'ge-key ge-key-src' }),
    ` ${T('из источника')} `,
    эл('span', { класс: 'ge-key ge-key-part' }),
    ` ${T('часть целого')}`,
  );
  body.append(legend);

  if (обрезано) {
    const p = document.createElement('p');
    p.className = 'graph-cut';
    p.textContent = T`Показано ${строк} индикаторов из ${g.total}: выше схема нечитаема. `
                  + T('Полный состав — в таблице кейса.');
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
    p.textContent = T('Пока пусто. Хронология начинается с первого добавления в кейс.');
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

/* КЕЙС ИЗМЕНЁН И НЕ ВЫГРУЖЕН.
 *
 * Кейс живёт в профиле браузера: сброс профиля уничтожает расследование.
 * Состояние считается по хронологии (lib/unsaved.js), а не по отдельному
 * флагу: флаг надо выставлять в каждом месте, где кейс меняется, и одно
 * забытое место даёт молчаливый дефект — предупреждения нет, человек
 * считает, что выгрузил.
 */
function renderUnsaved() {
  const el = $('#case-unsaved');
  if (!el || !globalThis.TIUnsaved) return;
  if (!state.caseItems.length) { el.hidden = true; el.textContent = ''; return; }
  const н = TIUnsaved.напоминание(state.timeline || []);
  el.hidden = !н.показывать;
  el.textContent = н.показывать ? н.текст : '';
  el.classList.toggle('is-urgent', !!н.срочно);
}

/* Закрытие вкладки с невыгруженным кейсом.
 *
 * Порог здесь НИЖЕ, чем у строки-напоминания: строка — это «пора бы»,
 * а закрытие вкладки необратимо, и спросить стоит при любом
 * невыгруженном изменении. Браузер покажет своё стандартное окно;
 * текст подставить нельзя, это ограничение платформы. */
function следитьЗаЗакрытием() {
  window.addEventListener('beforeunload', (e) => {
    if (!globalThis.TIUnsaved) return;
    if (!state.caseItems.length) return;
    const с = TIUnsaved.состояние(state.timeline || []);
    if (!с.изменён) return;
    e.preventDefault();
    e.returnValue = '';
  });
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
  if (n('malicious'))  parts.push(T`вредоносных ${n('malicious')}`);
  if (n('suspicious')) parts.push(T`подозрительных ${n('suspicious')}`);
  if (n('clean'))      parts.push(T`чистых ${n('clean')}`);
  const unknown = n('unknown');
  if (unknown) parts.push(T`НЕ ПРОВЕРЕНО ${unknown}`);
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
  const title = $('#case-title').value.trim() || T('Без названия');
  const tlp = $('#case-tlp').value;
  const date = new Date().toISOString().slice(0, 10);
  const byType = {};
  for (const i of state.caseItems) (byType[i.typeLabel] ||= []).push(migrateCaseItem(i));

  /* TLP-ГЕЙТ СКЕЛЕТА (0.48.0).
   *
   * Раньше гейт стоял только на выгрузках (слой Navigator, картинка
   * матрицы), а скелет отчёта уезжал как есть — с названием кейса
   * в заголовке и заметками аналитика в таблицах. Это была дыра ровно
   * в том файле, который чаще всего и отправляют: имя заказчика живёт
   * в названии кейса свободным текстом, поля «клиент» у кейса нет.
   *
   * В клиентском режиме убираются три вещи: заголовок с названием
   * кейса, столбцы заметок и хронология работы (в ней лежат адреса
   * источников — нередко инфраструктура самого заказчика).
   *
   * Убранное НАЗЫВАЕТСЯ прямо в файле. Молча вырезанный раздел
   * неотличим от раздела, который забыли заполнить, и аналитик
   * не узнает, что именно ему нужно дописать руками. */
  const клиентский = state.tlp === 'client';
  const шапкаГейта = клиентский
    ? T('> **Режим клиентских данных.** Из этого скелета убраны: название ')
      + T('кейса (в заголовке стоит дата), столбцы заметок аналитика ')
      + T('и раздел «Хронология работы». Если что-то из этого нужно ')
      + T('получателю — впишите вручную, проверив, что там нет чужих имён.\n\n')
    : '';

  /* Столбцы «Вердикт» и «Чем проверен» больше не пустые: они заполняются
   * тем, что аналитик проставил в кейсе. Труба, в которой работа терялась
   * на выходе, была главным недостатком этого скелета. */
  const mdCell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const tables = Object.entries(byType).map(([label, items]) =>
    `### ${label} (${items.length})\n\n`
    + (клиентский
        ? T('| Значение | Вердикт | Действие |\n|---|---|---|\n')
        : T('| Значение | Вердикт | Чем проверен | Заметка | Действие |\n|---|---|---|---|---|\n'))
    + items.map((i) => {
      const v = VERDICTS[i.verdict] ? VERDICTS[i.verdict].label : T('не проверен');
      const tags = i.tags.length ? ` _(${i.tags.join(', ')})_` : '';
      if (клиентский) return `| \`${i.value}\` | ${v} |  |`;
      return `| \`${i.value}\` | ${v} | ${mdCell(i.verdictSource) || '—'} | `
           + `${mdCell(i.note) || '—'}${tags} |  |`;
    }).join('\n')
  ).join('\n\n');

  /* Раздел «Техники ATT&CK» перестал быть пустой таблицей.
   *
   * Техники уже лежат в кейсе — парсер извлекает тип attack из отчёта.
   * Раньше аналитик переписывал их названия и тактики руками, глядя
   * в сайт ATT&CK: это единственный раздел скелета, который можно
   * заполнить целиком из того, что у нас есть, и он единственный
   * оставался пустым.
   *
   * Если каталог не загрузился, строки всё равно будут — с одним
   * идентификатором и прочерками. Пустая таблица хуже неполной:
   * по неполной видно, что техники в кейсе есть. */
  const техники = state.caseItems
    .filter((i) => i.type === 'attack')
    .map((i) => migrateCaseItem(i));
  const attackRows = техники.length
    ? техники.map((i) => {
        const t = (globalThis.TIAttack && TIAttack.техника(i.value)) || null;
        const тактика = t && t.тактики.length ? t.тактики.join(', ') : '—';
        const имя = t ? `[${t.название}](${t.url})` : '—';
        const хвост = клиентский ? '' : ` ${mdCell(i.note) || ''} |`;
        return `| ${тактика} | ${имя} | \`${TIAttack ? TIAttack.нормализовать(i.value) : i.value}\` `
             + `|${хвост}`;
      }).join('\n')
    : (клиентский ? '|  |  |  |' : '|  |  |  |  |');

  /* Раздел «Покрытие ATT&CK». Строится в lib/matrix.js и там же
   * проверяется — включая то, что в клиентском режиме из него уходят
   * столбцы «Чем проверен» и «Наблюдение» целиком.
   *
   * ПОЧЕМУ ОН НЕ ДУБЛИРУЕТ РАЗДЕЛ 6. Раздел 6 — список техник кейса
   * подряд. Этот — картина покрытия: по тактикам, со счётчиками
   * и со ссылкой на выгруженную картинку. Первое отвечает на «что
   * нашли», второе — на «докуда дошли», и в отчёте нужны оба. */
  const покрытиеMd = globalThis.TIMatrix && globalThis.TIAttack
    ? TIMatrix.markdownПокрытия(
        TIMatrix.покрытие(TIAttack.каталог ? TIAttack.каталог() : null, state.caseItems),
        { режим: state.tlp === 'client' ? 'client' : 'public', png: mxИмяPNG() })
    : T('_Каталог ATT&CK недоступен._');

  const unchecked = state.caseItems.filter((i) => (i.verdict || 'unknown') === 'unknown').length;
  /* Непроверенные индикаторы называются в отчёте прямо. Отчёт, в котором
   * половина строк не проверена, и отчёт, в котором проверены все, —
   * разные документы, и получатель имеет право знать, какой перед ним. */
  const uncheckedNote = unchecked
    ? T`\n> **Не проверено: ${unchecked} из ${state.caseItems.length}.** `
      + T('Эти индикаторы извлечены из источника, но их вердикт не устанавливался.\n')
    : '';

  return T`# ${клиентский ? 'Отчёт от ' + date : title}

**TLP:** ${tlp}
**Дата:** ${date}
**Аналитик:** _заполнить_
**Статус:** черновик

${шапкаГейта}---

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

${клиентский
  ? '_Раздел убран режимом клиентских данных: в хронологии лежат адреса '
    + 'источников и действия аналитика. Если получателю нужен порядок '
    + 'появления фактов — впишите его вручную._'
  : TITimeline.buildTimelineMarkdown(state.timeline)}

## 6. Техники MITRE ATT&CK

${клиентский ? '| Тактика | Техника | ID |\n|---|---|---|'
             : '| Тактика | Техника | ID | Наблюдение |\n|---|---|---|---|'}
${attackRows}

## 7. Покрытие ATT&CK

${покрытиеMd}

## 8. Покрытие детектом

| Правило | Платформа | Статус | Комментарий |
|---|---|---|---|
|  | Elastic Security |  |  |

## 9. Рекомендации

1. _Приоритет 1 — что сделать сейчас._
2. _Приоритет 2 — что сделать в течение недели._

## 10. Ограничения

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
  summary: { key: 'claims',     label: T('Выжимка') },
  iocs:    { key: 'indicators', label: T('Роли индикаторов') },
  attack:  { key: 'techniques', label: T('Техники ATT&CK') },
  report:  { key: null,         label: T('Черновик рекомендаций') },
};

const ROLE_LABELS = {
  'c2': T('сервер управления'),
  'payload-delivery': T('раздача нагрузки'),
  'phishing': T('фишинг'),
  'exfiltration': T('вывод данных'),
  'scanning': T('сканирование'),
  'victim': T('пострадавший'),
  'unknown': T('роль не ясна'),
};

/* Участок «только со своим сервером» вырезан: --store.
 * Публичная сборка своего сервера не предполагает. */
async function checkModel() {}
function renderExternalNotice() {}
function updateAnalysisGate() {}
async function runAnalysis() {}
function renderAnalysis() {}

/* Переключатель «включить выжимку в отчёт» виден только когда есть что
 * включать, и честно сообщает, сколько утверждений реально пойдёт
 * в документ — а не сколько модель выдала. */
function updateReportToggle() {
  const wrap = $('#include-analysis-wrap');
  const note = $('#include-analysis-note');
  if (!wrap) return;          // блока второго этапа нет — см. --store
  const a = state.analysis;
  if (!a || a.generated || !a.verified_count) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  note.textContent = T`(${a.verified_count} подтверждённых, ${ANALYSIS_TASKS[a.task].label.toLowerCase()})`;
}

/* Блок для отчёта. Только подтверждённые утверждения — это правило,
 * а не настройка: непроверенный вывод в документе за подписью SOC
 * стоит дороже, чем отсутствующий раздел. */
function analysisReportBlock() {
  const a = state.analysis;
  if (!a || a.generated || !$('#include-analysis')?.checked) return '';
  /* Разбор состоит из дословных цитат источника — то есть из текста,
   * который аналитик вставил. В клиентском режиме он в отчёт не идёт.
   * Кнопка разбора в этом режиме и так заблокирована, но результат
   * прошлого разбора живёт в state и пережил бы переключение. */
  if (state.tlp === 'client') return '';
  const key = ANALYSIS_TASKS[a.task].key;
  const ok = (a[key] || []).filter((x) => x.verified);
  if (!ok.length) return '';

  const lines = ok.map((x) => {
    if (a.task === 'attack') return `| ${x.technique_id} | ${x.name || ''} | ${x.claim || ''} |`;
    if (a.task === 'iocs')   return `| \`${x.value}\` | ${ROLE_LABELS[x.role] || x.role} | ${x.claim || ''} |`;
    return `- ${x.claim}\n  > ${x.quote}`;
  });

  const header = a.task === 'attack'
    ? T('| ID | Техника | Наблюдение |\n|---|---|---|\n')
    : a.task === 'iocs'
      ? T('| Индикатор | Роль | Основание |\n|---|---|---|\n')
      : '';

  return T`\n### Разбор модели: ${ANALYSIS_TASKS[a.task].label}\n\n` +
    T`> Сгенерировано локальной моделью \`${a.model}\`. ` +
    T`В отчёт включены только утверждения, подтверждённые дословной цитатой ` +
    T`из источника (${a.verified_count} из ${a.verified_count + a.unverified_count}). ` +
    T`Отброшено как неподтверждённое: ${a.unverified_count}.\n` +
    T`> Проверка фактов остаётся за аналитиком: подтверждённая цитата ` +
    T`доказывает, что фраза есть в источнике, а не что источник прав.\n\n` +
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
  { id: 'exact',    label: T('Точная фраза'),      tpl: '"{{q}}"',
    hint: T('Без вариаций и синонимов. Для названий кампаний и уникальных строк') },
  { id: 'filetype', label: T('PDF-отчёты'),        tpl: '{{q}} filetype:pdf',
    hint: T('Отчёты вендоров почти всегда PDF') },
  { id: 'ioc-list', label: T('Выгрузки IOC'),      tpl: '{{q}} (filetype:csv OR filetype:txt OR filetype:json)',
    hint: T('Готовые списки индикаторов, а не статьи о них') },
  { id: 'title',    label: T('В заголовке'),       tpl: 'intitle:"{{q}}"',
    hint: T('Отсекает упоминания вскользь: в заголовке — значит статья про это') },
  { id: 'url',      label: T('В адресе'),          tpl: 'inurl:{{q}}',
    hint: T('Ищет по структуре адреса — полезно для поддоменов и путей') },
  { id: 'github',   label: T('Код на GitHub'),     tpl: 'site:github.com {{q}}',
    hint: T('Правила детекта, парсеры, PoC-эксплойты') },
  { id: 'paste',    label: T('Пасты и дампы'),     tpl: '(site:pastebin.com OR site:ghostbin.com OR site:rentry.co) {{q}}',
    hint: T('Утёкшие конфиги, списки жертв, переписка') },
  { id: 'recent',   label: T('Свежие обсуждения'), tpl: '{{q}} (site:x.com OR site:infosec.exchange OR site:reddit.com)',
    hint: T('Исследователи пишут в соцсети раньше, чем выходит отчёт') },
  { id: 'no-noise', label: T('Без агрегаторов'),   tpl: '{{q}} -site:virustotal.com -site:abuseipdb.com -site:pulsedive.com',
    hint: T('Убирает страницы самих сервисов — их и так видно в дереве') },
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
  if (!dorkBase) { toast(T('Сначала введите запрос')); input.focus(); return; }
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

/* Адрес SearXNG: поля может не быть в разметке.
 *
 * В сборке для магазинов расширений блок с этим полем вырезается
 * (tools_build_ext.py --store): метапоиск живёт на своём сервере,
 * а публичная сборка серверную часть не предполагает вовсе.
 * Прямое обращение $('#searx-url').value тогда падает на null,
 * и падает оно в planQuery — то есть ломает весь глобальный поиск,
 * а не одно поле. Поэтому доступ ровно один и через эту функцию. */
function searxBase() {
  const el = $('#searx-url');
  return el ? el.value.trim() : '';
}

/** Единая точка сборки запроса — и для предпросмотра, и для отправки. */
function planQuery() {
  const raw = $('#global-query').value.trim();
  const profile = SEARCH_PROFILES.find((p) => p.id === state.profile);
  const scoped = TIQuery.dorkSetsScope(raw);
  const direct = !searxBase();
  return TIQuery.buildQuery({
    query: raw,
    domains: площадкиПрофиля(profile),
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
  const площадки = площадкиПрофиля(p);
  $('#domain-list').textContent = площадки.join('  ·  ');
  $('#domain-count').textContent = T`— ${площадки.length} шт.`;
}

/* Запрос в SearXNG. Формат: /search?q=...&time_range=...&language=...
 * Ограничение по площадкам передаётся операторами site: — SearXNG проксирует
 * их в подлежащие движки. Точность зависит от движка: Google/Bing site:
 * поддерживают, часть специализированных — нет. Это ограничение, а не баг. */

async function doGlobalSearch(direct = false) {
  const raw = $('#global-query').value.trim();
  if (!raw) { toast(T('Введите запрос')); return; }
  const profile = SEARCH_PROFILES.find((p) => p.id === state.profile);
  const time = $('#global-time').value;
  const lang = $('#global-lang').value;
  const base = searxBase();
  const useSearx = !direct && base;

  /* Сборка ОДНА на оба режима. Раньше их было две, и логика в них
   * разошлась — отсюда и взялись дефекты с пустой выдачей. */
  const plan = TIQuery.buildQuery({
    query: raw,
    domains: площадкиПрофиля(profile),
    scoped: TIQuery.dorkSetsScope(raw),
    limit: useSearx ? 0 : TIQuery.MAX_DIRECT_SITES,
  });

  const stat = $('#global-stat');
  if (useSearx) {
    try {
      ENV.openTab(TIQuery.searxUrl(base, plan.q, time, lang), true);
      stat.textContent = T`SearXNG · профиль «${profile.label}» · площадок ${plan.used.length}`;
      stat.className = 'parse-stat';
      await ENV.storeSet('ti_searx_url', base);
      return;
    } catch (e) {
      toast(T('Некорректный адрес SearXNG — используйте прямое открытие'));
      return;
    }
  }

  ENV.openTab(TIQuery.directUrl(plan.q, time), true);
  stat.textContent = plan.warnings.length
    ? T`Прямой режим · площадок ${plan.used.length} · есть оговорки, см. предпросмотр`
    : T`Прямой режим · площадок ${plan.used.length}`;
  stat.className = plan.warnings.length ? 'parse-stat is-warn' : 'parse-stat';
}

/* --------------------------------------------- состояние сбора с вкладки -
 *
 * Сбор идёт в фоне и без участия человека. Единственное, что отличает
 * его от слежки, — что человек про него знает. Поэтому строка висит
 * в консоли всё время сеанса, а не показывается один раз тостом. */
function показатьСбор(сеанс) {
  const эл = $('#capture-note');
  if (!эл) return;
  if (!сеанс) { эл.hidden = true; return; }
  эл.hidden = false;
  эл.textContent = (globalThis.TICapture ? TICapture.подпись(сеанс) : T('идёт сбор'))
    + T` · сайт ${сеанс.источник} · найденное уходит в очередь триажа`;
}

async function спроситьСбор() {
  if (!ENV.isExtension) return;
  try {
    const r = await browser.runtime.sendMessage({ cmd: 'capture-state' });
    показатьСбор(r && r.сеанс);
  } catch (_) { /* фон не отвечает — строку не показываем */ }
}

/* ================================================ СОСТАВ РАБОЧЕГО МЕСТА ==
 *
 * Здесь только интерфейс. Все решения — что относится к ядру, что от чего
 * зависит, что попадает в файл настроек — в lib/settings.js, и проверяются
 * они там же, без браузера.
 *
 * ПОЧЕМУ СКРЫТИЕ — КЛАССОМ, А НЕ АТРИБУТОМ hidden.
 * У половины блоков hidden уже занят собственной жизнью: #har-block
 * скрыт, пока не разобран HAR, #packs-found — пока ничего не нашлось.
 * Выставив hidden из настроек, мы бы показали пустой блок HAR при
 * включённой галочке и потеряли бы разницу между «выключено» и «пока
 * нечего показывать». Класс не спорит с атрибутом: скрыто, если верно
 * хотя бы одно.
 * ======================================================================== */
const КЛАСС_СКРЫТО = 'is-off-by-settings';

/** Включена ли функция. Без модуля настроек не прячем ничего: отсутствие
 *  настроек не повод превращать рабочее место в урезанное. */
function функцияВкл(id) {
  if (!globalThis.TISettings) return true;
  return TISettings.включено(state.settings, id);
}

async function сохранитьНастройки() {
  await ENV.storeSet(TISettings.КЛЮЧ, state.settings);
}

async function загрузитьНастройки() {
  if (!globalThis.TISettings) return;
  const сырое = await ENV.storeGet(TISettings.КЛЮЧ, null);
  const { настройки, замечания } = TISettings.нормализовать(сырое);
  state.settings = настройки;
  state.настройкиЗамечания = замечания;
  /* Починенное состояние записывается обратно сразу. Иначе замечание
   * («ядро оставлено включённым») будет показываться при каждом запуске,
   * а исправление так и не сохранится. */
  if (сырое === null || замечания.length) await сохранитьНастройки();
}

/** Применить состав к странице. Вызывается после каждой правки. */
function применитьНастройки() {
  if (!globalThis.TISettings) return;
  const в = TISettings.видимость(state.settings);

  for (const [имя, видна] of Object.entries(в.вкладки)) {
    const кнопка = $(`.tab[data-tab="${имя}"]`);
    const панель = $('#panel-' + имя);
    if (кнопка) кнопка.classList.toggle(КЛАСС_СКРЫТО, !видна);
    if (панель) панель.classList.toggle(КЛАСС_СКРЫТО, !видна);
  }
  for (const [селектор, видно] of Object.entries(в.узлы)) {
    for (const эл of $$(селектор)) эл.classList.toggle(КЛАСС_СКРЫТО, !видно);
  }

  /* Спрятали вкладку, на которой стоял человек, — уводим на разбор.
   * Иначе экран пустой: панель скрыта, а другая не активна. */
  const активная = $('.panel.is-active');
  if (!активная || активная.classList.contains(КЛАСС_СКРЫТО)) switchTab('smart');
}

/* --------------------------------------------------------- УЧЁТ ---------
 * Запись в хранилище отложенная: аналитик щёлкает часто, а storage.local
 * — это диск. Пишем не чаще раза в пять секунд и обязательно при уходе
 * со страницы, иначе последняя минута работы пропадёт. */
let учётТаймер = 0;
function отметитьИспользование(id) {
  if (!globalThis.TISettings) return;
  const было = state.settings;
  state.settings = TISettings.отметить(state.settings, id);
  if (state.settings === было) return;
  if (учётТаймер) return;
  учётТаймер = setTimeout(() => { учётТаймер = 0; сохранитьНастройки(); }, 5000);
}

/* Одна точка учёта на все функции: те же узлы, что решают видимость,
 * считают и применение. Отдельные вызовы в каждом обработчике разошлись
 * бы с каталогом через два выпуска — здесь разойтись нечему. */
function включитьУчётЩелчков() {
  if (!globalThis.TISettings) return;
  document.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest) return;
    for (const ф of TISettings.ФУНКЦИИ) {
      if (ф.ядро || !ф.узлы) continue;
      if (ф.узлы.some((с) => e.target.closest(с))) отметитьИспользование(ф.id);
    }
  }, true);
  window.addEventListener('pagehide', () => {
    if (учётТаймер) { clearTimeout(учётТаймер); учётТаймер = 0; сохранитьНастройки(); }
  });
}

/* ------------------------------------------------------- ОТРИСОВКА ------ */
function renderSettings() {
  if (!globalThis.TISettings) return;
  const S = TISettings;
  const наст = state.settings;

  // --- пресеты ---
  const ряд = $('#preset-row');
  ряд.textContent = '';
  for (const п of S.ПРЕСЕТЫ) {
    const кн = document.createElement('button');
    кн.type = 'button';
    кн.className = 'preset';
    кн.dataset.preset = п.id;
    const имя = document.createElement('span');
    имя.className = 'preset-name'; имя.textContent = п.имя;
    const кому = document.createElement('span');
    кому.className = 'preset-who'; кому.textContent = п.кому;
    кн.append(имя, кому);
    ряд.append(кн);
  }
  // --- галочки по категориям ---
  const кат = $('#settings-cats');
  кат.textContent = '';
  for (const к of S.КАТЕГОРИИ) {
    const свои = S.ФУНКЦИИ.filter((ф) => !ф.ядро && ф.кат === к.id);
    if (!свои.length) continue;
    const блок = document.createElement('div');
    блок.className = 'settings-cat';
    const шапка = document.createElement('p');
    шапка.className = 'settings-cat-name'; шапка.textContent = к.имя;
    блок.append(шапка);
    for (const ф of свои) {
      const строка = document.createElement('div');
      строка.className = 'settings-item';
      const метка = document.createElement('label');
      метка.className = 'chk';
      const бокс = document.createElement('input');
      бокс.type = 'checkbox';
      бокс.dataset.feature = ф.id;
      бокс.checked = !!наст.функции[ф.id];
      метка.append(бокс, document.createTextNode(' ' + ф.имя));
      строка.append(метка);
      /* Пояснение — всегда один и тот же узел, текст в нём меняет
       * синхронизация. Перерисовывать строку целиком нельзя: после
       * щелчка по галочке узел заменился бы новым, и фокус клавиатуры
       * уехал бы в никуда. Поймано браузерным прогоном: второй щелчок
       * подряд попадал в узел, которого на странице уже нет. */
      const почему = document.createElement('span');
      почему.className = 'settings-item-why';
      почему.dataset.why = ф.id;
      строка.append(почему);
      блок.append(строка);
    }
    кат.append(блок);
  }

  // --- ядро ---
  const ядро = $('#core-list');
  ядро.textContent = '';
  for (const id of S.ЯДРО) {
    const li = document.createElement('li');
    li.textContent = S.функция(id).имя;
    ядро.append(li);
  }

  синхронизироватьНастройки();
}

/* Обновление БЕЗ перестроения узлов: значения галочек, подсветка
 * пресета, пояснения, списки. Вызывается после каждой правки. */
function синхронизироватьНастройки() {
  if (!globalThis.TISettings) return;
  const S = TISettings;
  const наст = state.settings;

  for (const кн of $$('#preset-row [data-preset]')) {
    кн.classList.toggle('is-active', кн.dataset.preset === наст.пресет);
  }
  const вкл = S.НАСТРАИВАЕМЫЕ.filter((id) => S.включено(наст, id)).length;
  /* Строка собирается из кусков, потому что внутри неё есть <b>,
   * а разметку в эту страницу мы больше не вставляем строкой.
   * Цена — перевод кусками, то есть порядок слов задан русским
   * оригиналом; для пары ru/en он совпадает. Если когда-нибудь
   * добавится язык с другим порядком, эти четыре ключа придётся
   * объединить обратно в один и размечать позицию числа. */
  const всего = S.НАСТРАИВАЕМЫЕ.length;
  const узелНабора = $('#preset-now');
  if (наст.пресет === S.СВОЙ) {
    TIDom.наполнить(узелНабора, [
      T('Набор собран вручную: включено '),
      эл('b', { текст: вкл }),
      T` из ${всего} функций.`,
    ]);
  } else {
    TIDom.наполнить(узелНабора, [
      T('Набор: '),
      эл('b', { текст: (S.пресет(наст.пресет) || {}).имя || наст.пресет }),
      T(' — включено '),
      эл('b', { текст: вкл }),
      T` из ${всего} функций.`,
    ]);
  }

  for (const бокс of $$('#settings-cats [data-feature]')) {
    const ф = S.функция(бокс.dataset.feature);
    if (!ф) continue;
    бокс.checked = !!наст.функции[ф.id];
    const строка = бокс.closest('.settings-item');
    const почему = строка && строка.querySelector(`[data-why="${ф.id}"]`);
    const перекрыта = !!(ф.зависит && !S.включено(наст, ф.зависит));
    if (строка) строка.classList.toggle('is-blocked', перекрыта);
    if (почему) {
      /* Зависимость НАЗЫВАЕТСЯ. Галочка стоит, а функции на экране нет —
       * ровно тот случай, когда человек решает, что интерфейс врёт. */
      почему.textContent = перекрыта
        ? T`не показывается: выключено «${S.функция(ф.зависит).имя}»`
        : (ф.зачем || '');
    }
  }

  renderForgotten();
  renderUsage();
  рисоватьНаборы();
}

function renderForgotten() {
  const S = TISettings;
  const список = S.забытые(state.settings);
  const блок = $('#forgot-box');
  const тело = $('#forgot-list');
  тело.textContent = '';
  блок.hidden = список.length === 0;
  for (const з of список) {
    const строка = document.createElement('div');
    строка.className = 'forgot-row';
    const имя = document.createElement('strong');
    имя.textContent = з.имя;
    const почему = document.createElement('span');
    почему.className = 'forgot-why';
    почему.textContent = з.состояние === 'включена'
      ? T`включена, не использовалась ${з.дней} дн. — ${з.совет}`
      : T`выключена ${з.дней} дн. — ${з.совет}`;
    const кн = document.createElement('button');
    кн.type = 'button';
    кн.className = 'btn btn-mini';
    кн.dataset.feature = з.id;
    кн.dataset.set = з.состояние === 'включена' ? 'off' : 'on';
    кн.textContent = з.состояние === 'включена' ? T('Выключить') : T('Включить');
    строка.append(имя, почему, кн);
    тело.append(строка);
  }
}

function renderUsage() {
  const S = TISettings;
  $('#usage-on').checked = state.settings.учёт !== false;
  const т = $('#usage-table');
  т.textContent = '';
  const ячейка = (текст, классы = '') => {
    const d = document.createElement('div');
    d.className = 'usage-cell' + (классы ? ' ' + классы : '');
    d.textContent = текст;
    return d;
  };
  т.append(ячейка(T('Функция'), 'is-head'), ячейка(T('Раз'), 'is-head is-num'),
           ячейка(T('Дней без дела'), 'is-head is-num'), ячейка(T('Состояние'), 'is-head'));
  for (const с of S.отчётОбИспользовании(state.settings)) {
    т.append(
      ячейка(с.имя, с.включена ? '' : 'is-off'),
      ячейка(String(с.раз), 'is-num'),
      ячейка(с.раз ? String(с.днейБезДела) : '—', 'is-num'),
      /* Значение остаётся русским в данных (по нему идёт сравнение
       * в соседнем блоке), переводится только подпись. */
      ячейка(с.включена ? T('включена') : T('выключена'), с.включена ? '' : 'is-off'));
  }
}

function настройкиЗаметка(текст, вид = '') {
  const эл = $('#st-note');
  эл.textContent = '';
  if (!текст || (Array.isArray(текст) && !текст.length)) { эл.hidden = true; return; }
  эл.hidden = false;
  эл.className = 'settings-note' + (вид ? ' ' + вид : '');
  if (Array.isArray(текст)) {
    const ul = document.createElement('ul');
    for (const с of текст) {
      const li = document.createElement('li');
      li.textContent = с;
      ul.append(li);
    }
    эл.append(ul);
  } else {
    эл.textContent = текст;
  }
}

/* --------------------------------------------------------- ДЕЙСТВИЯ ----- */
async function поставитьНастройки(новые, заметка = '', вид = '') {
  state.settings = новые;
  await сохранитьНастройки();
  применитьНастройки();
  синхронизироватьНастройки();
  if (заметка) настройкиЗаметка(заметка, вид);
}

async function включитьФункцию(id) {
  const ф = TISettings.функция(id);
  if (!ф) return;
  let новые = TISettings.переключить(state.settings, id, true);
  /* Включаем и то, от чего функция зависит: иначе «включил, а её нет».
   * Человек просил функцию, а не её предысторию. */
  if (ф.зависит) новые = TISettings.переключить(новые, ф.зависит, true);
  await поставитьНастройки(новые);
  toast(T`«${ф.имя}» включена`);
}

/* ================================================= РЕДАКТОР «МОИ ПРОВЕРКИ» ==
 *
 * Здесь только интерфейс. Разбор хранилища, проверка состава и вывод
 * типов — в lib/myplaybooks.js и покрыты модульными проверками: решение
 * «что попадёт в набор и к какому типу он применим» не должно жить
 * в обработчике клика, иначе его нельзя прогнать без браузера.
 *
 * Набор один, поэтому ни списка наборов, ни кнопки «создать», ни выбора
 * типов на экране нет. Правки держатся в памяти до «Сохранить»: экран
 * настроек, который пишет в хранилище на каждое нажатие, не даёт
 * передумать.
 * ========================================================================= */

/** Состав, который правят прямо сейчас. Записывается только по кнопке. */
let редНабор = null;

function подписьТипа(t) {
  const м = (globalThis.IOC && IOC.TYPE_LABELS) || {};
  return м[t] ? T(м[t]) : t;
}

function инструментПоId(id) {
  return ((state.registry && state.registry.tools) || []).find((t) => t.id === id) || null;
}

/** Поднять в редактор то, что лежит в хранилище. */
function рисоватьНаборы() {
  if (!globalThis.TIMyPlaybooks || !$('#pb-steps')) return;
  if (!редНабор) {
    const х = TIMyPlaybooks.нормализовать(state.наборыПравки).хранилище;
    редНабор = { name: х.набор.name, steps: х.набор.steps.slice() };
  }
  $('#pb-name').value = редНабор.name;
  рисоватьШагиНабора();
}

function рисоватьШагиНабора() {
  const ш = $('#pb-steps');
  ш.textContent = '';
  редНабор.steps.forEach((id, i) => {
    const li = document.createElement('li');
    li.className = 'pb-step';
    li.dataset.tool = id;
    const tool = инструментПоId(id);
    const подпись = document.createElement('span');
    if (tool) {
      const d = document.createElement('i');
      d.className = 'dot dot-' + (tool.exposure === 'public' ? 'public' : 'limited');
      подпись.append(d, document.createTextNode(' ' + tool.name));
      /* У каждой строки написано, для чего она сработает. Список один
       * на все типы, и без этого непонятно, почему при разборе адреса
       * открылось шесть сервисов из двадцати. */
      const т = document.createElement('span');
      т.className = 'muted';
      т.textContent = ' — ' + (tool.types || []).map(подписьТипа).join(', ');
      подпись.append(т);
    } else {
      /* Шаг, которого нет в реестре, НЕ прячется: молча укоротить
       * чужой набор — значит сделать проверку короче, не сказав. */
      подпись.className = 'pb-missing';
      подпись.textContent = T`${id} — в реестре такого сервиса нет`;
    }
    li.append(подпись);

    const акт = document.createElement('span');
    акт.className = 'pb-step-act';
    const кн = (текст, титул, вкл, действие) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-mini btn-ghost';
      b.textContent = текст;
      b.title = титул;
      b.disabled = !вкл;
      b.addEventListener('click', действие);
      акт.append(b);
    };
    кн('↑', T('Выше'), i > 0, () => {
      const s = редНабор.steps;
      [s[i - 1], s[i]] = [s[i], s[i - 1]];
      рисоватьШагиНабора();
    });
    кн('↓', T('Ниже'), i < редНабор.steps.length - 1, () => {
      const s = редНабор.steps;
      [s[i + 1], s[i]] = [s[i], s[i + 1]];
      рисоватьШагиНабора();
    });
    кн('×', T('Убрать из набора'), true, () => {
      редНабор.steps = редНабор.steps.filter((_, j) => j !== i);
      рисоватьШагиНабора();
    });
    li.append(акт);
    ш.append(li);
  });
  if (!редНабор.steps.length) {
    const li = document.createElement('li');
    li.className = 'pb-step muted';
    li.textContent = T('Пока пусто — выберите сервисы ниже.');
    ш.append(li);
  }

  рисоватьВыборСервиса();
  const очистить = $('#pb-reset');
  if (очистить) очистить.hidden = !TIMyPlaybooks.настроен(state.наборыПравки);
  const заготовка = $('#pb-seed');
  if (заготовка) заготовка.hidden = редНабор.steps.length > 0;
}

function рисоватьВыборСервиса() {
  const sel = $('#pb-add-tool');
  sel.textContent = '';
  /* Фильтра по типам нет: набор на все типы. Список НЕ фильтруется и
   * по текущему режиму данных — набор это настройка, а не запуск;
   * собранный в публичном режиме не должен разваливаться оттого,
   * что его правили в клиентском. */
  const доступные = ((state.registry && state.registry.tools) || [])
    .filter((t) => !редНабор.steps.includes(t.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (!доступные.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = T('Все сервисы реестра уже в наборе');
    sel.append(o);
  }
  const подпись = (t) => t.name + ' · '
    + (t.types || []).map(подписьТипа).join(', ') + ' · '
    + (t.exposure === 'public' ? T('публичный') : T('ограниченный'));
  /* Сто с лишним сервисов плоским списком глазами не просматриваются.
   * Группы — те же, что в дереве инструментов: второй порядок для
   * одного реестра разошёлся бы с первым через пару выпусков. */
  for (const кат of ((state.registry && state.registry.categories) || [])) {
    const свои = доступные.filter((t) => t.category === кат.id);
    if (!свои.length) continue;
    const g = document.createElement('optgroup');
    g.label = T(кат.label || кат.id);
    for (const t of свои) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = подпись(t);
      g.append(o);
    }
    sel.append(g);
  }
  $('#pb-add').disabled = !доступные.length;
}

function показатьПроблемы(ошибки, предупреждения) {
  const эл = $('#pb-problems');
  эл.textContent = '';
  if (!ошибки.length && !предупреждения.length) { эл.hidden = true; return; }
  эл.hidden = false;
  эл.className = 'pb-problems' + (ошибки.length ? ' is-bad' : ' is-warn');
  const ul = document.createElement('ul');
  for (const с of [...ошибки, ...предупреждения]) {
    const li = document.createElement('li');
    li.textContent = с;
    ul.append(li);
  }
  эл.append(ul);
}

async function сохранитьНаборИзРедактора() {
  if (!редНабор) return;
  const что = { name: $('#pb-name').value.trim(), steps: редНабор.steps.slice() };
  const { ошибки, предупреждения } = TIMyPlaybooks.проверить(
    что, (state.registry && state.registry.tools) || []);
  показатьПроблемы(ошибки, предупреждения);
  /* Ошибки запрещают сохранение, предупреждения — нет: «в клиентском
   * режиме не останется шагов» бывает осознанным решением, а вот набор
   * без сервисов не бывает. */
  if (ошибки.length) { toast(T('Не сохранено: есть ошибки')); return; }

  state.наборыПравки = TIMyPlaybooks.сохранить(state.наборыПравки, что);
  await сохранитьНаборы();
  редНабор = { name: что.name, steps: что.steps.slice() };
  рисоватьШагиНабора();
  toast(T`«${что.name}»: сохранено, сервисов ${что.steps.length}`);
}

function bindНаборы() {
  if (!globalThis.TIMyPlaybooks || !$('#pb-steps')) return;
  $('#pb-save').addEventListener('click', сохранитьНаборИзРедактора);
  $('#pb-add').addEventListener('click', () => {
    const id = $('#pb-add-tool').value;
    if (!id || !редНабор || редНабор.steps.includes(id)) return;
    редНабор.steps.push(id);
    рисоватьШагиНабора();
  });
  $('#pb-seed').addEventListener('click', () => {
    if (!редНабор) return;
    редНабор.steps = TIMyPlaybooks.поВстроенным(
      (state.registry && state.registry.playbooks) || []);
    if (!$('#pb-name').value.trim()) {
      $('#pb-name').value = T(TIMyPlaybooks.ИМЯ_ПО_УМОЛЧАНИЮ);
    }
    рисоватьШагиНабора();
    /* Заготовка подставлена, но НЕ сохранена: человек должен сначала
     * увидеть, что получилось, и убрать лишнее. */
    toast(T`Подставлено сервисов: ${редНабор.steps.length}. `
        + T('Уберите лишние и нажмите «Сохранить».'), 5000);
  });
  $('#pb-reset').addEventListener('click', async () => {
    if (!confirm(T('Очистить список проверок? Кейсы, хронология и остальные '
                 + 'настройки не тронутся.'))) return;
    state.наборыПравки = TIMyPlaybooks.очистить();
    await сохранитьНаборы();
    редНабор = { name: '', steps: [] };
    $('#pb-name').value = '';
    показатьПроблемы([], []);
    рисоватьШагиНабора();
    toast(T('Список очищен'));
  });
}

function bindSettings() {
  if (!globalThis.TISettings) return;
  const S = TISettings;
  bindНаборы();

  $('#preset-row').addEventListener('click', async (e) => {
    const кн = e.target.closest('[data-preset]');
    if (!кн) return;
    const п = S.пресет(кн.dataset.preset);
    await поставитьНастройки(S.применитьПресет(state.settings, кн.dataset.preset),
      T`Набор «${п.имя}». Кейсы, хронология и матрица не тронуты — `
      + T('настройки к ним не прикасаются.'), 'is-ok');
  });

  $('#settings-cats').addEventListener('change', async (e) => {
    const бокс = e.target.closest('[data-feature]');
    if (!бокс) return;
    await поставитьНастройки(
      S.переключить(state.settings, бокс.dataset.feature, бокс.checked));
  });

  $('#forgot-list').addEventListener('click', async (e) => {
    const кн = e.target.closest('[data-feature]');
    if (!кн) return;
    await поставитьНастройки(
      S.переключить(state.settings, кн.dataset.feature, кн.dataset.set === 'on'));
  });

  $('#usage-on').addEventListener('change', async (e) => {
    await поставитьНастройки({ ...state.settings, учёт: e.target.checked },
      e.target.checked ? '' : T('Учёт выключен. Прежние счётчики остались — ')
        + T('сотрите их кнопкой рядом, если они не нужны.'));
  });

  $('#usage-clear').addEventListener('click', async () => {
    await поставитьНастройки({ ...state.settings, счётчики: {}, создано: Date.now() },
      T('Счётчики стёрты.'));
  });

  $('#st-export').addEventListener('click', () => {
    const файл = S.вФайл(state.settings, ENV.version() || '');
    download(T('ti-console-настройки.json'), JSON.stringify(файл, null, 2),
             'application/json;charset=utf-8');
    настройкиЗаметка(T('Выгружен состав рабочего места. Счётчиков использования ')
      + T('в файле нет: чем вы пользуетесь — ваше дело, а не содержимое файла ')
      + T('для коллеги.'), 'is-ok');
  });

  $('#st-import').addEventListener('click', () => $('#st-file').click());

  $('#st-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';                  // тот же файл можно выбрать снова
    if (!f) return;
    const текст = await f.text();
    const r = S.изФайла(текст, state.settings);
    if (r.ошибка) { настройкиЗаметка(r.ошибка, 'is-bad'); return; }
    await поставитьНастройки(r.настройки);
    настройкиЗаметка([T('Настройки загружены из файла.'), ...(r.замечания || [])],
                     r.замечания && r.замечания.length ? '' : 'is-ok');
  });

  $('#st-reset').addEventListener('click', async () => {
    await поставитьНастройки(S.применитьПресет(state.settings, S.ПРЕСЕТ_ПО_УМОЛЧАНИЮ),
      T('Возвращён базовый набор. Кейсы, хронология и матрица не тронуты.'), 'is-ok');
  });

  // --- первый запуск ---
  const строка = $('#first-run');
  строка.hidden = !(state.settings.первыйЗапуск && !state.settings.подсказкаПоказана);
  const закрыть = async () => {
    строка.hidden = true;
    await поставитьНастройки({ ...state.settings, первыйЗапуск: false, подсказкаПоказана: true });
  };
  $('#first-run-open').addEventListener('click', async () => {
    switchTab('settings');
    await закрыть();
  });
  $('#first-run-hide').addEventListener('click', закрыть);
}

/* ============================================================ ЗАПУСК === */
async function init() {
  /* ЛОКАЛИЗАЦИЯ — САМЫМ ПЕРВЫМ ДЕЙСТВИЕМ.
   * Словарь нужен до того, как что-либо нарисовано: подписи вкладок,
   * дерево инструментов и тосты строятся через T(), а статическая
   * разметка переводится обходом DOM. Пока это не сделано, тело скрыто
   * классом i18n-pending — иначе английский пользователь видит вспышку
   * русского текста. */
  await TII18n.инициализация();
  настроитьПереключательЯзыка();
  document.documentElement.classList.add('i18n-ready');

  /* Состав рабочего места читается ПЕРВЫМ и применяется до отрисовки.
   * Если применить его позже, аналитик увидит сначала полный набор
   * вкладок, а через миг — свой; мигание интерфейса читается как сбой. */
  await загрузитьНастройки();
  применитьНастройки();

  state.registry = await ENV.loadTools();
  await загрузитьНаборы();
  // Это версия РЕЕСТРА инструментов, а не расширения: реестр обновляется
  // с сервера отдельно и живёт своим циклом. Без подписи цифру читают
  // как версию продукта и потом не могут сойтись в разговоре о том,
  // «какая у тебя стоит».

  startBrandFox();
  startActionWatch();

  const managed = await ENV.loadManaged();

  // Тема применяется первой, до отрисовки дерева и результатов.
  const themeMode = managed.theme || await ENV.storeGet('ti_theme', 'dark');
  applyTheme(themeMode);
  $('#theme-mode').value = themeMode;
  if (managed.lockTheme) {
    $('#theme-mode').disabled = true;
    $('#theme-mode').title = T('Тема зафиксирована политикой SOC');
  }

  // Политика может ЗАФИКСИРОВАТЬ режим данных (lockTlpMode) — например,
  // для команды, работающей только с данными клиентов.
  state.tlp = managed.defaultTlpMode || await ENV.storeGet('ti_tlp_mode', 'public');
  $('#tlp-mode').value = state.tlp;
  if (managed.lockTlpMode) {
    $('#tlp-mode').disabled = true;
    $('#tlp-mode').title = T('Режим зафиксирован политикой SOC');
  }

  const ver = ENV.version();
  const verEl = $('#build-ver');
  if (verEl) {
    verEl.textContent = ver ? 'v' + ver : T('версия неизвестна');
    verEl.title = ver
      ? T`Версия расширения ${ver}. Сверяйте её с той, которую прислал SOC:\n`
        + T('если файл заменили, а версия прежняя — обновление не применилось,\n')
        + T('браузер надо перезапустить.')
      : T('Версия недоступна: страница открыта не как расширение');
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
    $('#url-warn').textContent = T('Забор страниц по ссылке выключен политикой SOC.');
    $('#url-warn').className = 'src-warn is-off';
    $('#url-warn').hidden = false;
  }

  // Режим хранения кейса. local — кейс не покидает профиль браузера.
  // Своего сервера у расширения нет вовсе, так что вариант один.
  state.caseStorage = managed.caseStorage || 'local';
  $('#local-storage-notice').hidden = state.caseStorage !== 'local';

  /* СВОИ И КЛИЕНТСКИЕ ДИАПАЗОНЫ.
   *
   * Список ведёт SOC в политике; аналитик его не правит и не видит
   * иначе как через пометки. Разбор один раз: политика доступна
   * только на чтение и в течение сеанса не меняется. */
  if (globalThis.TIOwnRanges) {
    state.own = TIOwnRanges.разобрать(managed.ownRanges, managed.ownDomains);
    отрисоватьСостояниеДиапазонов();
  }

  // Адрес SearXNG приезжает политикой: аналитику вводить нечего.
  // Поля может не быть — см. searxBase().
  const полеSearx = $('#searx-url');
  if (полеSearx) {
    полеSearx.value = managed.searxUrl || await ENV.storeGet('ti_searx_url', '');
    if (managed.searxUrl) {
      полеSearx.readOnly = true;
      полеSearx.title = T('Задано политикой SOC');
    }
  }

  /* Каталог ATT&CK грузится в фоне и молча.
   *
   * Он нужен двум местам: фактам в карточке индикатора и поиску
   * в палитре. Оба переживают его отсутствие — факт просто не появится,
   * палитра не предложит техник, — поэтому ошибка здесь не должна
   * ломать загрузку консоли. Но и глотать её нельзя: без каталога
   * половина разбора техник молча перестаёт работать. */
  if (globalThis.TIAttack) {
    TIAttack.загрузить()
      /* Перерисовать строку справочников ПОСЛЕ загрузки каталога.
       * Она показывает его выпуск и объём, а к моменту первой отрисовки
       * файл ещё читается — без этого строка про ATT&CK молча
       * не появлялась бы вовсе. */
      .then(() => { renderPacks(); mxЗаполнитьСписки(); })
      .catch((e) => {
        console.warn(T('каталог ATT&CK не загрузился:'), e && e.message);
      });
  }

  /* Справочники читаются с диска, без сети. Если их не загружали —
   * будет пустой объект, и это нормальное состояние, а не ошибка. */
  await перечитатьСправочники();
  await renderPacks();
  const полеСпр = $('#packs-query');
  if (полеСпр) полеСпр.addEventListener('input', (e) => renderPacksSearch(e.target.value));

  /* --- матрица ATT&CK ---
   *
   * Списки заполняются после загрузки каталога, поэтому и здесь,
   * и в .then() загрузки: на момент init каталог ещё читается. */
  mxЗаполнитьСписки();
  await mxЗагрузитьСостояние();
  for (const id of ['#mx-matrix', '#mx-mode', '#mx-tactic',
                    '#mx-verdict', '#mx-platform', '#mx-checked']) {
    const el = $(id);
    if (el) {
      el.addEventListener('change', () => {
        /* Аналитик сам поменял фильтр — значит прежняя жалоба
         * на сброшенное значение больше не о чём. */
        state.mxПотеряно = '';
        renderMatrix();
        mxСохранитьСостояние();
      });
    }
  }
  const сброс = $('#mx-reset');
  if (сброс) {
    сброс.addEventListener('click', () => {
      $('#mx-mode').value = 'все';
      for (const id of ['#mx-tactic', '#mx-verdict', '#mx-platform', '#mx-checked']) {
        if ($(id)) $(id).value = '';
      }
      $('#mx-card').hidden = true;
      state.mxПотеряно = '';
      renderMatrix();
      mxСохранитьСостояние();
    });
  }
  const кнопкаPNG = $('#mx-png');
  if (кнопкаPNG) {
    кнопкаPNG.addEventListener('click', () => {
      кнопкаPNG.disabled = true;
      mxЭкспортPNG()
        .catch((e) => toast(T('Не удалось собрать PNG: ') + (e && e.message ? e.message : e)))
        .finally(() => { кнопкаPNG.disabled = false; });
    });
  }
  /* ОДИН обработчик на всю матрицу вместо тысячи на ячейках.
   * Тысяча замыканий — это тысяча ссылок на данные, которые живут,
   * пока жива страница. */
  const сетка = $('#mx-grid');
  if (сетка) {
    сетка.addEventListener('click', (e) => {
      const счёт = e.target.closest('.mx-cell-subs-count');
      if (счёт) {
        счёт.closest('.mx-cell').classList.toggle('is-open');
        return;
      }
      const узел = e.target.closest('[data-id]');
      if (узел) mxКарточка(узел.dataset.id);
    });
  }

  renderTree();
  renderProfiles();
  renderDorks();
  renderResults();          // пустое состояние с заставкой
  await loadCase();
  await loadTriage();

  /* Записи о фильтрах удалённых кейсов убираются один раз при загрузке.
   * Без этого карта растёт вечно: кейс удалили, запись о нём осталась,
   * и упрётся она в квоту storage.local не здесь, а на сохранении кейса. */
  if (globalThis.TIMatrix) {
    const живые = (state.caseStore.cases || []).map((c) => c.id);
    const было = Object.keys(state.mxStore.кейсы || {}).length;
    state.mxStore = TIMatrix.подчистить(state.mxStore, живые);
    if (Object.keys(state.mxStore.кейсы).length !== было) {
      await ENV.storeSet(TIMatrix.КЛЮЧ_ФИЛЬТРОВ, state.mxStore);
    }
  }

  // --- вкладки ---
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + tab.dataset.tab));
    /* Матрица строится ЛЕНИВО — при открытии вкладки, а не при загрузке
     * страницы. Тысяча узлов, которые никто не смотрит, задерживали бы
     * открытие консоли каждый раз. */
    /* Правила ПЕРЕСОБИРАЮТСЯ при каждом открытии вкладки — по той же
     * причине, по которой матрица строится лениво: состав кейса
     * меняется, и показывать прежнюю сборку нельзя. */
    if (tab.dataset.tab === 'rules') renderRules();
    if (tab.dataset.tab === 'matrix') {
      mxЗаполнитьСписки();
      /* Сохранённые фильтры выкладываются ПЕРЕД отрисовкой: иначе
       * аналитик увидит матрицу без фильтра, потом она перерисуется
       * с фильтром, и это мигание читается как сбой. */
      state.mxПотеряно = mxПрименитьСостояние();
      renderMatrix();
    }
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
    /* Галочка тел HAR подчиняется тому же гейту. И если тела уже были
     * прочитаны, а режим переключили на клиентский, файл ПЕРЕРАЗБИРАЕТСЯ
     * без них: оставить прочитанное значило бы, что гейт закрывает
     * дверь после того, как через неё прошли. */
    harСинхроГалочку();
    if (state.har && state.har.телаЧитались && state.tlp === 'client') {
      harПереразобрать();
    }
    /* Правила пересобираются: в клиентском режиме из них уходит
     * название кейса, а переключение режима при открытой вкладке
     * оставило бы на экране прежний текст с именем заказчика. */
    const панельПравил = $('#panel-rules');
    if (панельПравил && панельПравил.classList.contains('is-active')) renderRules();
    syncFox();          // намордник появляется в тот же момент, что и режим
    toast(state.tlp === 'client'
      ? T('Режим «клиентские данные»: публичные сервисы отключены')
      : T('Режим «публичные данные»: доступны все источники'));
  });

  // --- разбор IOC ---
  /* Стрелка, а не сама функция: parseInput принимает необязательное
   * основание, и addEventListener передал бы туда объект события.
   * Поймано аудитом — выдача стала пустой на любом тексте. */
  $('#btn-parse').addEventListener('click', () => parseInput());
  $('#btn-clear').addEventListener('click', () => {
    $('#smart-input').value = '';
    $('#smart-url').value = '';
    state.iocs = []; state.selected.clear();
    state.parsed = false;
    state.analysis = null;
    state.inputSource = T('вставленный текст');
    state.sourceUrl = '';
    clearOcr();
    clearEml();
    clearHar();
    renderFetchNotes([]);
    renderPacksFound('');        // иначе строка бинарников пережила бы очистку
    state.onlyNew = false;
    if ($('#only-new')) $('#only-new').checked = false;
    renderNovelty();
    $('#parse-stat').textContent = '';
    $('#parse-stat').className = 'parse-stat';
    /* Блока второго этапа может не быть в разметке: в сборке для
     * магазинов он вырезан целиком (tools_build_ext.py --store).
     * Анализ моделью требует своего сервера или ключа в политике,
     * а публичная сборка ни того, ни другого не предполагает. */
    if ($('#analysis-stat')) $('#analysis-stat').textContent = '';
    if ($('#analysis-out')) $('#analysis-out').textContent = '';
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
    toast(act ? T`Активный кейс: ${TICases.caseLabel(act)}` : T('Кейс не выбран'));
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
    toast(T('Кейс создан. Дайте ему название — оно видно в шапке'));
    /* Празднование ПОСЛЕ записи в хранилище: прыжок означает «кейс
     * создан», а не «кнопку нажали». Если storeSet упадёт, сюда
     * не дойдёт. */
    foxCelebrate();
  });

  $('#btn-case-delete').addEventListener('click', async () => {
    const act = TICases.activeCase(state.caseStore);
    if (!act) return;
    /* В вопросе названы НАЗВАНИЕ кейса и оба числа. Удаление кейса — это
     * удаление проделанной работы, а «Удалить кейс?» без названия и без
     * счёта слишком легко подтвердить не глядя. */
    if (!confirm(T`Удалить кейс «${TICases.caseLabel(act)}»?\n`
               + T`Удалятся ${act.items.length} индикаторов и ${act.timeline.length} событий хронологии.`)) return;
    state.caseStore = TICases.removeCase(state.caseStore, act.id);
    await ENV.storeSet(TICases.STORE_KEY, state.caseStore);
    syncFromActiveCase();
    toast(T('Кейс удалён'));
  });

  $('#case-import').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = TICases.importCase(state.caseStore, data);
      if (!r.ok) { toast(T('Импорт не выполнен: ') + r.error, 5000); return; }
      state.caseStore = r.store;
      await ENV.storeSet(TICases.STORE_KEY, state.caseStore);
      syncFromActiveCase();
      toast(T`Импортирован отдельный кейс: ${TICases.caseLabel(r.added)}`
        + (r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''), 6000);
    } catch (err) {
      toast(T('Файл не разбирается как JSON: ') + String(err.message || err).slice(0, 120), 5000);
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
    if (!vals.length) { toast(T('Ничего не выбрано')); return; }
    await navigator.clipboard.writeText(vals.map((v) => IOC.defang(v)).join('\n'));
    toast(T`Скопировано ДЕФАНГОМ: ${vals.length} — по ним не кликнут`);
  });
  $('#btn-copy-plain').addEventListener('click', async () => {
    const vals = selectedValues();
    if (!vals.length) { toast(T('Ничего не выбрано')); return; }
    await navigator.clipboard.writeText(vals.join('\n'));
    toast(T`Скопировано КАК ЕСТЬ: ${vals.length} — ссылки кликабельны`);
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

  /* Значение из карточки на странице («В консоли»).
   *
   * ПОВОД. В 0.57.0 фон клал значение в storage под ключом
   * ti_pivot_value и открывал консоль. Читать этот ключ было НЕКОМУ:
   * консоль открывалась пустой, а значение лежало в хранилище.
   * Снаружи это выглядело как «кнопка почти работает» — вкладка ведь
   * открылась, — и списывалось на случайность. Половина функции без
   * второй половины хуже её отсутствия.
   *
   * Теперь значение едет в адресе вкладки, как и ссылка из
   * контекстного меню, и здесь же разбирается: аналитик просил
   * «в консоли», то есть хочет карточку со всеми инструментами,
   * а не поле, в которое надо нажать «Разобрать».
   */
  const изКарточки = new URLSearchParams(location.search).get('ioc');
  if (изКарточки) {
    $('#smart-input').value = изКарточки;
    state.inputSource = T('карточка на странице');
    parseInput();
  }

  /* Ссылка из контекстного меню («забрать, не открывая»). Подставляем
   * в поле, но НЕ забираем автоматически: запрос уходит с адреса
   * аналитика, и решение об этом принимает он, а не пункт меню.
   * Кроме того, запрос разрешения <all_urls> всё равно требует жеста. */
  const wanted = new URLSearchParams(location.search).get('fetch');
  if (wanted && state.urlFetchAllowed) {
    $('#smart-url').value = wanted;
    $('#smart-url').focus();
    $('#parse-stat').textContent = T('ссылка подставлена — нажмите «Забрать и разобрать»');
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
  $('#smart-image')?.addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';           // иначе тот же файл второй раз не выберется
    runImageOcr(f);
  });
  $('#btn-ocr-close')?.addEventListener('click', clearOcr);
  $('#btn-eml-close')?.addEventListener('click', clearEml);
  $('#btn-har-close')?.addEventListener('click', clearHar);

  // --- черновики правил ---
  for (const id of ['#rl-format', '#rl-sid']) {
    $(id)?.addEventListener('change', renderRules);
  }
  $('#rl-copy')?.addEventListener('click', async () => {
    const текст = правилаТекст();
    if (!текст) { toast(T('Нечего копировать')); return; }
    try {
      await navigator.clipboard.writeText(текст);
      toast(T`Скопировано ${текст.split('\n').length} строк — это ЧЕРНОВИК, `
        + T('проверьте на инфраструктуре клиента'), 4200);
    } catch (_) {
      toast(T('Браузер не дал доступ к буферу — выделите текст и скопируйте вручную'));
    }
  });
  $('#rl-save')?.addEventListener('click', () => {
    const текст = правилаТекст();
    if (!текст) { toast(T('Нечего сохранять')); return; }
    const формат = $('#rl-format').value;
    const имя = TIRules.имяФайла(формат, new Date().toISOString().slice(0, 10));
    download(имя, текст, 'text/plain;charset=utf-8');
    logEvent('export.done', { format: T`черновик правил (${формат})` });
    toast(T`${имя} — ЧЕРНОВИК, не включайте без проверки`, 4200);
  });
  /* Переключение галочки ПЕРЕРАЗБИРАЕТ файл: тела не читаются, пока
   * их не попросили. Читать заранее и прятать значило бы держать
   * секреты клиента в памяти на случай, если попросят. */
  $('#har-bodies')?.addEventListener('change', harПереразобрать);

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
  $('#btn-analyze')?.addEventListener('click', runAnalysis);
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
        toast(T('Ссылка подставлена — нажмите «Забрать и разобрать»'));
      }
      return;
    }
    /* Определение вида файла переехало в loadFileIntoInput: оно нужно
     * всем входам, а не одному. Проверка по f.type здесь была ещё
     * и ненадёжна — он пуст у файла из архива и у части почтовых
     * клиентов. */
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
    if (!keys.length) { toast(T('Ничего не выбрано')); return; }
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
    toast(T`В кейс добавлено: ${added}`);
  });
  $('#tr-dismiss').addEventListener('click', async () => {
    const keys = triageSelected();
    if (!keys.length) { toast(T('Ничего не выбрано')); return; }
    state.triage = TITriage.dismiss(state.triage, keys);
    await saveTriage();
    toast(T`В отбой: ${keys.length}. Повторно предлагаться не будут`);
  });
  $('#tr-forget').addEventListener('click', async () => {
    const было = (state.triage.dismissed || []).length;
    if (!было) { toast(T('Отбой пуст')); return; }
    state.triage = TITriage.forgetDismissed(state.triage);
    await saveTriage();
    toast(T`Отбой очищен: ${было} значений снова будут предлагаться`);
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
  $('#searx-url')?.addEventListener('input', renderQueryPreview);

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
        extension: ENV.version() || T('неизвестна'),
        exported: new Date().toISOString(), items: state.caseItems,
        timeline: state.timeline,
      }, null, 2), 'application/json');
    logEvent('export.done', { format: 'JSON' });
  });
  /* «Только новые». Перерисовка полная: список меняется целиком,
   * терять тут нечего — в отличие от простановки вердикта, где
   * перерисовка схлопнула бы раскрытую карточку. */
  const чекНовые = $('#only-new');
  if (чекНовые) {
    чекНовые.addEventListener('change', (e) => {
      state.onlyNew = e.target.checked;
      renderResults();
    });
  }

  /* Слой ATT&CK Navigator.
   *
   * Режим данных передаётся в модуль, а не проверяется внутри него:
   * модуль чистый и о состоянии страницы не знает. Клиентский режим
   * обезличивает название кейса — имя заказчика живёт именно там. */
  const кнопкаСлой = $('#btn-export-navlayer');
  if (кнопкаСлой) {
    кнопкаСлой.addEventListener('click', () => {
      const A = globalThis.TIAttack;
      const св = A && A.сводка();
      const r = TINavLayer.собрать(
        { title: $('#case-title').value },
        state.caseItems,
        { 'версияATTACK': св ? св.версия : '',
          режим: state.tlp,
          /* Принадлежность к матрице — из каталога, а не по префиксу:
           * T1691/T1692/T1693 это ICS с обычным префиксом T1. */
          матрицаТехники: (id) => (A ? A.матрица(id) : null) },
      );
      if (!r.слой) { toast(r.заметки[0] || T('Слой собирать не из чего'), 4200); return; }

      download('attack-layer.json', JSON.stringify(r.слой, null, 2), 'application/json');
      /* Заметки проговариваются ВСЕГДА, а не только при беде: исключённые
       * техники ICS иначе неотличимы от «их там и не было». */
      toast(T`Слой ATT&CK: ${r.всего} техник`
        + (r.заметки.length ? ' · ' + r.заметки.join(' · ') : ''), 6000);
      logEvent('export.done', { format: 'ATT&CK Navigator' });
    });
  }

  $('#btn-export-stix').addEventListener('click', () => {
    const bundle = IOC.toStixBundle(state.caseItems, { labels: ['ti-console', $('#case-tlp').value] });
    const skipped = bundle._skipped || [];
    if (!bundle.objects.length) {
      toast(skipped.length
        ? T`Все ${skipped.length} индикаторов признаны чистыми — выгружать в STIX нечего`
        : T('Нет индикаторов, представимых в STIX'));
      return;
    }
    download('bundle.json', JSON.stringify(bundle, null, 2), 'application/json');
    // Про исключённые говорим прямо: иначе расхождение между числом строк
    // в кейсе и числом объектов в файле выглядит как потеря данных.
    toast(T`STIX-бандл: ${bundle.objects.length} индикаторов`
      + (skipped.length ? T` · ${skipped.length} не выгружено (вердикт «чистый»)` : ''));
    logEvent('export.done', { format: 'STIX 2.1', skipped: skipped.length });
  });
  $('#btn-report').addEventListener('click', () => {
    const md = buildReportSkeleton();
    const out = $('#report-out');
    out.textContent = md;
    out.hidden = false;
    download('report-skeleton.md', md, 'text/markdown;charset=utf-8');
    logEvent('export.done', { format: T('скелет отчёта') });
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
      .then(() => toast(T('Сводка скопирована в буфер')))
      .catch(() => toast(T('Сводка готова — скопируйте из поля ниже')));
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
     * «добавлен 203.0.113.31». Хронология содержит те же значения,
     * что и кейс, и жить дольше кейса она не имеет права. */
    const act = TICases.activeCase(state.caseStore);
    const n = state.caseItems.length;
    if (!confirm(T`Очистить кейс «${act ? TICases.caseLabel(act) : ''}»? `
               + T`Удалятся ${n} индикаторов и хронология (${state.timeline.length} событий). `
               + T('Сам кейс останется.'))) return;
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
            state.caseItems.push({ ...i, addedAt: new Date().toISOString(), source: msg.pageUrl || T('страница') });
          }
        }
        saveCase();
        toast(T`Из страницы добавлено: ${msg.iocs.length}`);
      }
      /* Боковая панель положила индикаторы в активный кейс напрямую
       * в хранилище. Без перечитывания вкладка показывала бы прежний
       * состав кейса до перезагрузки — и следующее сохранение с неё
       * затёрло бы добавленное панелью. */
      if (msg?.cmd === 'cases-changed') reloadCaseStore();
      /* Сбор с вкладки кладёт найденное в очередь из ФОНА. Без
       * перечитывания консоль показывала бы прежнюю очередь, а
       * следующее сохранение с неё затёрло бы собранное — ровно
       * та же беда, что была у боковой панели с кейсами. */
      if (msg?.cmd === 'triage-changed') loadTriage();
      /* Строка состояния сбора: она обязана гаснуть в тот же момент,
       * когда сбор кончился, а не через час. */
      if (msg?.cmd === 'capture-changed') показатьСбор(msg.сеанс);
    });
  }

  /* Настройки навешиваются последними: их обработчики трогают уже
   * готовую страницу, а первый запуск показывает строку тогда, когда
   * есть куда нажимать. */
  renderSettings();
  bindSettings();
  включитьУчётЩелчков();
  спроситьСбор();

  // Признак завершённой инициализации. Нужен демо-сборке и автотестам
  // вёрстки: init асинхронный, и обработчики навешиваются в самом конце —
  // подменять узлы раньше этого момента бессмысленно.
  globalThis.__tiReady = true;
  document.dispatchEvent(new CustomEvent('ti-ready'));
}

document.addEventListener('DOMContentLoaded', init);
/* Слежение за закрытием вешается здесь же, а не внутри init:
 * init асинхронный, и до его конца вкладку уже можно закрыть. */
следитьЗаЗакрытием();

/* ПЕРЕКЛЮЧАТЕЛЬ ЯЗЫКА.
 * Значение запоминается в storage.local и применяется перезагрузкой
 * вкладки. Перерисовывать живой интерфейс на другом языке не стали:
 * пришлось бы учить каждый блок переживать смену подписей без потери
 * состояния, а выигрыш — доли секунды. Кейс, настройки и очередь триажа
 * лежат в хранилище, перезагрузка для них незаметна. */
function настроитьПереключательЯзыка() {
  const sel = document.getElementById('lang-mode');
  if (!sel) return;
  sel.value = TII18n.язык();
  sel.addEventListener('change', async () => {
    await TII18n.сохранить(sel.value);
    location.reload();
  });
}
