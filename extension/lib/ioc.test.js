/* Проверка ядра распознавания. Запуск: node extension/lib/ioc.test.js
 * Без фреймворков — чтобы тест запускался на любой машине, где есть node. */
'use strict';
const IOC = require('./ioc.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}
function has(iocs, type, value) {
  return iocs.some((i) => i.type === type && i.value.toLowerCase() === value.toLowerCase());
}
function none(iocs, type, value) { return !has(iocs, type, value); }

/* ---------------------------------------------------- 1. базовые типы -- */
{
  const t = `
    C2: 185.220.101.34 и 2001:db8::dead:beef
    Payload: hxxps://cdn-update[.]delivery/panel/gate.php
    Домен: acme-invoices[.]top
    SHA256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
    MD5: d41d8cd98f00b204e9800998ecf8427e
    SHA1: da39a3ee5e6b4b0d3255bfef95601890afd80709
    Почта: billing@acme-invoices[.]top
    CVE-2025-31324, BDU:2024-01234
    AS207812, подсеть 91.219.236.0/24
    Кошелёк 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
    HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\\updater
    C:\\Users\\Public\\stage2.dll
  `;
  const r = IOC.extractIocs(t);
  check('IPv4', has(r, 'ipv4', '185.220.101.34'));
  check('IPv6', has(r, 'ipv6', '2001:db8::dead:beef'));
  check('URL c дефангом hxxps + [.]', has(r, 'url', 'https://cdn-update.delivery/panel/gate.php'));
  check('домен с дефангом', has(r, 'domain', 'acme-invoices.top'));
  check('SHA-256', has(r, 'sha256', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'));
  check('MD5', has(r, 'md5', 'd41d8cd98f00b204e9800998ecf8427e'));
  check('SHA-1', has(r, 'sha1', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'));
  check('e-mail с [.]', has(r, 'email', 'billing@acme-invoices.top'));
  check('CVE', has(r, 'cve', 'CVE-2025-31324'));
  check('БДУ ФСТЭК', has(r, 'bdu', 'BDU:2024-01234'));
  check('ASN', has(r, 'asn', 'AS207812'));
  check('CIDR', has(r, 'cidr', '91.219.236.0/24'));
  check('BTC', has(r, 'btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'));
  check('ключ реестра', r.some((i) => i.type === 'regkey'));
  check('путь Windows', r.some((i) => i.type === 'winpath' && i.value.includes('stage2.dll')));

  // SHA-256 не должен распасться на два MD5 — это главный риск порядка извлечения
  check('SHA-256 не распался на MD5', none(r, 'md5', '9f86d081884c7d659a2feaa0c55ad015'));
  // URL не должен продублироваться доменом
  check('URL не дублируется доменом', none(r, 'domain', 'cdn-update.delivery'));
  // e-mail не должен продублироваться доменом
  check('e-mail не дублируется доменом', none(r, 'domain', 'acme-invoices.top') === false,
        'домен acme-invoices.top встречается отдельной строкой — это ожидаемо');
}

/* -------------------------------------- 2. ложные срабатывания (главное) */
{
  const t = `
    Загрузите отчёт report.pdf, скрипт main.js, библиотеку payload.dll,
    архив backup.zip и конфиг nginx.conf. Версия сборки 8.19.2, релиз 1.0.0.4.
    Локальный сервер 127.0.0.1 и шлюз 192.168.1.1, узел 10.20.30.40.
    Деталь T1234 в накладной. Компания ASUS выпустила обновление.
  `;
  const r = IOC.extractIocs(t);
  check('report.pdf не домен', none(r, 'domain', 'report.pdf'));
  check('main.js не домен', none(r, 'domain', 'main.js'));
  check('payload.dll не домен', none(r, 'domain', 'payload.dll'));
  check('backup.zip не домен', none(r, 'domain', 'backup.zip'));
  check('nginx.conf не домен', none(r, 'domain', 'nginx.conf'));
  check('версия 8.19.2 не IPv4', none(r, 'ipv4', '8.19.2'));
  check('T1234 без контекста ATT&CK отброшен', none(r, 'attack', 'T1234'));
  check('ASUS не распознан как ASN', none(r, 'asn', 'AS'));

  const lo = r.find((i) => i.type === 'ipv4' && i.value === '127.0.0.1');
  check('127.0.0.1 помечен как loopback', !!lo && lo.flags.includes('non-routable:loopback'));
  const pr = r.find((i) => i.type === 'ipv4' && i.value === '192.168.1.1');
  check('192.168.1.1 помечен как private', !!pr && pr.flags.includes('non-routable:private'));
  const pr2 = r.find((i) => i.type === 'ipv4' && i.value === '10.20.30.40');
  check('10.20.30.40 помечен как private', !!pr2 && pr2.flags.includes('non-routable:private'));

  // 1.0.0.4 синтаксически валидный IPv4 — не отбрасываем, но это известное поведение
  check('1.0.0.4 всё же считается IPv4 (известное ограничение)', has(r, 'ipv4', '1.0.0.4'));
}

/* -------------------------------------------- 3. дефанг разных вариантов */
{
  const variants = [
    ['1.1.1[.]1', 'ipv4', '1.1.1.1'],
    ['1.1.1(.)1', 'ipv4', '1.1.1.1'],
    ['1.1.1{.}1', 'ipv4', '1.1.1.1'],
    ['evil[dot]com', 'domain', 'evil.com'],
    ['evil(dot)com', 'domain', 'evil.com'],
    ['hxxp://evil[.]com/a', 'url', 'http://evil.com/a'],
    ['hXXps[:]//evil[.]com', 'url', 'https://evil.com'],
    ['user[at]evil[.]com', 'email', 'user@evil.com'],
    ['evil\\.com', 'domain', 'evil.com'],
  ];
  for (const [input, type, expect] of variants) {
    const r = IOC.extractIocs(input);
    check(`refang: ${input}`, has(r, type, expect),
          `получено: ${JSON.stringify(r.map((i) => `${i.type}:${i.value}`))}`);
  }
  const r = IOC.extractIocs('1.1.1[.]1');
  check('флаг defanged проставлен', r[0] && r[0].defanged === true);
}

/* ------------------------------------------------------ 4. дедупликация */
{
  const r = IOC.extractIocs('8.8.8.8 8.8.8.8 8.8.8.8 и ещё 8.8.8.8');
  const ip = r.filter((i) => i.type === 'ipv4');
  check('дедупликация: одна запись', ip.length === 1);
  check('дедупликация: счётчик = 4', ip[0]?.count === 4, `count=${ip[0]?.count}`);
}

/* ------------------------------------------------------- 5. detectType  */
{
  check('detectType ipv4', IOC.detectType('8.8.8.8').type === 'ipv4');
  check('detectType domain', IOC.detectType('evil[.]com').type === 'domain');
  check('detectType sha256', IOC.detectType('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08').type === 'sha256');
  check('detectType cve', IOC.detectType('cve-2021-44228').type === 'cve');
  check('detectType keyword', IOC.detectType('Lazarus Group').type === 'keyword');
  check('detectType на файле -> keyword', IOC.detectType('report.pdf').type === 'keyword');
}

/* ------------------------------------------------------------ 6. экспорт */
{
  const r = IOC.extractIocs('8.8.8.8 evil.com d41d8cd98f00b204e9800998ecf8427e');
  const csv = IOC.toCsv(r);
  check('CSV: заголовок',
        csv.startsWith('type,value,count,defanged,flags,verdict,verdict_source,note,tags,source,context'),
        csv.split('\n')[0]);

  // Вердикт и заметка обязаны доезжать до выгрузки. Если бы они жили
  // только в интерфейсе, работа аналитика терялась бы при первом экспорте,
  // а экспорт — это то, что уходит клиенту.
  const withVerdict = IOC.toCsv([{ ...r[0], verdict: 'malicious',
    verdictSource: 'VT 43/70', note: 'C2 маяк', tags: ['c2', 'apt'] }]);
  check('CSV: вердикт выгружается', withVerdict.includes('"malicious"'), withVerdict);
  check('CSV: чем проверен выгружается', withVerdict.includes('"VT 43/70"'));
  check('CSV: теги через ;', withVerdict.includes('"c2;apt"'));
  // Кавычка в заметке не должна разваливать файл — RFC 4180 требует удвоения.
  const quoted = IOC.toCsv([{ ...r[0], note: 'он сказал "это C2"' }]);
  check('CSV: кавычки в заметке экранированы',
        quoted.includes('""это C2""'), quoted.split('\n')[1]);
  check('CSV: строк = индикаторов + 1', csv.split('\n').length === r.length + 1);

  const b = IOC.toStixBundle(r);
  check('STIX: тип bundle', b.type === 'bundle');
  check('STIX: верхний ключ objects', Array.isArray(b.objects));
  check('STIX: id начинается с bundle--', /^bundle--[0-9a-f-]{36}$/.test(b.id));
  const ind = b.objects.find((o) => o.name === '8.8.8.8');
  check('STIX: паттерн ipv4-addr', ind?.pattern === "[ipv4-addr:value = '8.8.8.8']");
  check('STIX: spec_version 2.1', ind?.spec_version === '2.1');
  check('STIX: valid_until отсутствует', !('valid_until' in (ind || {})));
  check('STIX: pattern_type stix', ind?.pattern_type === 'stix');
  check('STIX: без вердикта confidence низкий', ind?.confidence === 15, String(ind?.confidence));

  /* Индикатор, проверенный и признанный ЧИСТЫМ, в бандл попадать
   * не должен. Объект STIX типа indicator означает «признак
   * компрометации»; выгрузив туда заведомо чистый адрес, мы отправим
   * в OpenCTI, а оттуда в правила детекта, ложный индикатор. Обнаружится
   * это не при экспорте, а через месяц — потоком ложных срабатываний. */
  const mixed = [
    { ...r[0], verdict: 'malicious', verdictSource: 'VT 43/70', note: 'C2', tags: ['c2'] },
    { ...r[1], verdict: 'clean' },
  ];
  const mb = IOC.toStixBundle(mixed);
  check('STIX: чистый индикатор исключён', mb.objects.length === 1,
        JSON.stringify(mb.objects.map((o) => o.name)));
  check('STIX: исключённые перечислены', (mb._skipped || []).length === 1);
  // _skipped нужен интерфейсу, но в файле его быть не должно: лишний
  // верхнеуровневый ключ рискует отправить импорт в OpenCTI на отказ.
  check('STIX: _skipped не попадает в файл', !JSON.stringify(mb).includes('_skipped'));
  const m0 = mb.objects[0];
  check('STIX: вредоносный получает высокий confidence', m0.confidence === 85, String(m0.confidence));
  check('STIX: вердикт в labels', (m0.labels || []).includes('verdict:malicious'),
        JSON.stringify(m0.labels));
  check('STIX: тег в labels', (m0.labels || []).includes('c2'));
  check('STIX: чем проверен в описании', /VT 43\/70/.test(m0.description || ''), m0.description);

  // Все чистые — бандл пустой, и это правильный результат, а не ошибка.
  const allClean = IOC.toStixBundle([{ ...r[0], verdict: 'clean' }]);
  check('STIX: все чистые дают пустой бандл', allClean.objects.length === 0);
}

/* --------------------------------------------------- 7. производительность */
/* Что здесь проверяется и почему именно так.
 *
 * Раньше стоял порог по абсолютному времени: «302 КБ быстрее 5000 мс».
 * Такой тест краснеет от загрузки машины, а не от кода: на общем раннере
 * CI он падает случайно. Красный конвейер, который «наверное, просто
 * тормозит», приучает не смотреть на красный конвейер — вреда больше,
 * чем пользы от самой проверки.
 *
 * Настоящий риск здесь другой: случайно получить квадратичную сложность.
 * Она ловится не абсолютным временем, а формой роста: при удвоении входа
 * линейный разбор замедляется примерно вдвое, квадратичный — вчетверо.
 * Эта проверка от скорости машины не зависит.
 *
 * Абсолютная скорость печатается всегда, но валит сборку только при
 * катастрофическом провале (ниже 10 КБ/с) — это уже не «раннер занят»,
 * а сломанный алгоритм. */
{
  const unit = 'фрагмент отчёта 185.220.101.34 evil-domain.top ' +
               'd41d8cd98f00b204e9800998ecf8427e https://x.example/path ';
  const measure = (times) => {
    const text = unit.repeat(times);
    // Прогрев: первый прогон включает компиляцию регулярных выражений,
    // и без него N выглядит медленнее 2N.
    IOC.extractIocs(unit.repeat(200), { withContext: false });
    const t0 = Date.now();
    const r = IOC.extractIocs(text, { withContext: false });
    return { ms: Math.max(Date.now() - t0, 1), kb: text.length / 1024, count: r.length };
  };

  const a = measure(1500);
  const b = measure(3000);
  const ratio = b.ms / a.ms;
  const kbs = (b.kb / (b.ms / 1000)).toFixed(0);

  console.log(`  [инфо] ${a.kb.toFixed(0)} КБ: ${a.ms} мс · ` +
              `${b.kb.toFixed(0)} КБ: ${b.ms} мс · ${kbs} КБ/с · ` +
              `рост ×${ratio.toFixed(2)} при удвоении входа`);

  // Линейному разбору соответствует ×2. Порог ×3 оставляет запас
  // на шум измерения и ловит квадратичность (она дала бы ×4 и выше).
  check(`сложность близка к линейной (рост ×${ratio.toFixed(2)} при удвоении)`,
        ratio < 3.0,
        'похоже на квадратичную сложность — проверьте порядок извлечения');

  check(`скорость разбора не катастрофическая (${kbs} КБ/с)`,
        Number(kbs) > 10,
        'ниже 10 КБ/с — это не загруженная машина, а сломанный алгоритм');

  check('дедупликация на большом объёме', b.count < 20, `уникальных: ${b.count}`);
}

/* ============ ЗООПАРК НАПИСАНИЙ ДЕФАНГА ============
 *
 * Собран по реальным отчётам. Поводом стал блок индикаторов BI.ZONE:
 * адреса вида 45.151.45[.]31 и десять SHA-256 в обратных кавычках.
 * Парсер их брал, но проверки на это не было — а без проверки любое
 * следующее изменение регулярок могло их потерять молча.
 */
{
  const zoo = [
    // точка
    ['45.151.45[.]31', 'ipv4', '45.151.45.31'],
    ['45[.]151[.]45[.]31', 'ipv4', '45.151.45.31'],
    ['45.151.45(.)31', 'ipv4', '45.151.45.31'],
    ['45.151.45{.}31', 'ipv4', '45.151.45.31'],
    ['45.151.45[dot]31', 'ipv4', '45.151.45.31'],
    ['45.151.45[точка]31', 'ipv4', '45.151.45.31'],
    ['45.151.45 [.] 31', 'ipv4', '45.151.45.31'],
    ['evil[.]co[.]uk', 'domain', 'evil.co.uk'],
    // юникодные точки: копирование из азиатских источников и дефанг
    ['uni1。com', 'domain', 'uni1.com'],
    ['uni2．com', 'domain', 'uni2.com'],
    // схемы
    ['hxxps://evil.com/a', 'url', 'https://evil.com/a'],
    ['hXXps://evil.com/a', 'url', 'https://evil.com/a'],
    ['h**ps://evil.com/a', 'url', 'https://evil.com/a'],
    ['h_ttps://evil.com/a', 'url', 'https://evil.com/a'],
    ['htxps://evil.com/a', 'url', 'https://evil.com/a'],
    ['hxxps[:]//evil.com/a', 'url', 'https://evil.com/a'],
    ['hxxps[://]evil.com/a', 'url', 'https://evil.com/a'],
    // Проверка на однобуквенный TLD-домен не нужна: список TLD отсекает
    // несуществующие зоны раньше, чем сработает дефанг. Векторы взяты
    // на реальных TLD намеренно — иначе тест проверял бы список TLD,
    // а не правила дефанга.
    ['https[://]evil.com/a', 'url', 'https://evil.com/a'],
    ['meow://evil.com/a', 'url', 'http://evil.com/a'],
    // почта
    ['user[@]evil.com', 'email', 'user@evil.com'],
    ['user(at)evil.com', 'email', 'user@evil.com'],
    ['user[at]evil[.]com', 'email', 'user@evil.com'],
  ];
  for (const [inp, type, want] of zoo) {
    const got = IOC.extractIocs(inp).find((i) => i.type === type && i.value === want);
    check(`дефанг: ${inp}`, !!got,
          JSON.stringify(IOC.extractIocs(inp).map((i) => i.type + '=' + i.value)));
  }

  // Блок индикаторов целиком — ровно как в отчёте BI.ZONE.
  const block = [
    'memfix.zip',
    '`487886e5058294b7d965421f1d937b721fad95c63374f7dd0570d1b1e9d96c41`',
    'exploit_cve_2026_31431.py',
    '`1e2e08a36b6126f2363c24b5fe7a6dbd755c35b1cb6f15cdea13fc93274019f3`',
    'fscan', 'gs-dbus (GSocket)', 'RDPSocksProxy',
    '* `45.151.45[.]31`', '* `46.166.79[.]31`',
  ].join('\n');
  const r = IOC.extractIocs(block);
  const t = (k) => r.filter((i) => i.type === k).map((i) => i.value);
  check('блок IOC: оба адреса', t('ipv4').length === 2, JSON.stringify(t('ipv4')));
  check('блок IOC: оба хеша', t('sha256').length === 2, JSON.stringify(t('sha256')));
  /* Имя файла с расширением .py — ccTLD Парагвая, и раньше оно
   * определялось как домен. В имени хоста подчёркивания не бывает. */
  check('имя файла не стало доменом', !t('domain').includes('exploit_cve_2026_31431.py'),
        JSON.stringify(t('domain')));
  check('memfix.zip не стал доменом', !t('domain').includes('memfix.zip'));
  // Служебные записи DNS терять нельзя — там подчёркивание законно.
  check('_dmarc сохраняется',
        IOC.extractIocs('_dmarc.example.com').some((i) => i.value === '_dmarc.example.com'));
  check('подчёркивание в середине домена отвергается',
        !IOC.extractIocs('a_b.com').some((i) => i.value === 'a_b.com'));
}

/* ============ БЕССКОБОЧНЫЙ ДЕФАНГ — ТОЛЬКО С ФЛАГОМ ============ */
{
  /* «dot» и «at» встречаются в обычном тексте сами по себе, поэтому
   * результат второго прохода — догадка, и он обязан быть помечен.
   * Не искать их вовсе тоже нельзя: отчёты с такой нотацией есть. */
  const d = IOC.extractIocs('evil dot com').find((i) => i.type === 'domain');
  check('бесскобочный dot находится', d && d.value === 'evil.com');
  check('и помечен как догадка', d && (d.flags || []).includes('ambiguous:refang'),
        JSON.stringify(d && d.flags));

  const e = IOC.extractIocs('user at evil dot com').find((i) => i.type === 'email');
  check('бесскобочный at находится', e && e.value === 'user@evil.com');
  check('и тоже помечен', e && (e.flags || []).includes('ambiguous:refang'));

  // Обычный дефанг флагом НЕ помечается: это не догадка, а известная нотация.
  const s1 = IOC.extractIocs('evil[.]com').find((i) => i.type === 'domain');
  check('скобочный дефанг без флага догадки',
        s1 && !(s1.flags || []).includes('ambiguous:refang'));

  // Второй проход можно выключить.
  check('loose отключается',
        IOC.extractIocs('evil dot com', { loose: false }).length === 0);
  // И он не должен ничего менять там, где бесскобочных написаний нет.
  const plain = 'C2 185.220.101.34 и hxxps://evil[.]com/x';
  check('без бесскобочных написаний результат тот же',
        JSON.stringify(IOC.extractIocs(plain).map((i) => i.value))
        === JSON.stringify(IOC.extractIocs(plain, { loose: false }).map((i) => i.value)));
}

/* ------------------------------ ПОВТОРНАЯ ИНЪЕКЦИЯ В ОДНУ ПЕСОЧНИЦУ ---
 *
 * Файл внедряется в разбираемую страницу вместе с content/scan.js, и все
 * инъекции расширения в один документ идут в ОДНУ песочницу. Значит,
 * второй разбор той же страницы выполняет этот файл повторно — в том же
 * глобальном окружении.
 *
 * Без защиты это SyntaxError: «Identifier 'REFANG_RULES' has already been
 * declared». Инъекция обрывается на первом файле, scan.js не запускается,
 * и снаружи выглядит так, будто кнопка перестала работать.
 *
 * Проверяем не «функция вернула то же самое», а именно ПОВТОРНОЕ
 * ВЫПОЛНЕНИЕ ФАЙЛА в общем контексте — иначе тест ничего не ловит. */
{
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'ioc.js'), 'utf8');

  const ctx = { console: { warn() {}, log() {}, error() {} } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  let err = null;
  try {
    vm.runInContext(src, ctx);   // первая инъекция
    vm.runInContext(src, ctx);   // вторая — здесь и падало
    vm.runInContext(src, ctx);   // третья, для верности
  } catch (e) { err = e; }

  check('файл выдерживает повторную инъекцию', !err, err && err.message);
  check('после трёх инъекций парсер на месте',
        !!ctx.IOC && typeof ctx.IOC.extractIocs === 'function');
  check('после трёх инъекций парсер работает',
        !!ctx.IOC && ctx.IOC.extractIocs('45.151.45[.]31').length === 1);
  // Защита не должна подменять уже собранный модуль: ссылка та же.
  const first = ctx.IOC;
  vm.runInContext(src, ctx);
  check('повторная инъекция не пересобирает модуль', ctx.IOC === first);
}

/* ------------------------------ СКЛЕЙКА ПЕРЕНОСОВ: список — не перенос --
 *
 * Самый частый ввод расширения — столбик индикаторов по одному на строку.
 * Первая версия склейки считала его разорванным значением и выдавала
 * несуществующий индикатор — на обычном вводе, без всякой экзотики.
 * Дефект прожил релиз: в корпусе был перенос, но не было списка.
 *
 * Здесь проверяется И ТО И ДРУГОЕ: выдуманного значения нет, а честный
 * перенос по-прежнему склеивается. Проверка только одной половины
 * чинится ломанием второй. */
{
  const список = [
    'https://evil.example/panel/gate.php',
    'd41d8cd98f00b204e9800998ecf8427e',
    'CVE-2025-31324',
    'billing@acme-invoices.top',
    'good-domain.top',
  ].join('\n');
  const r = IOC.extractIocs(список);
  const выдуманные = r.filter((i) => (i.flags || []).includes('ambiguous:wrap'));
  check('СПИСОК НЕ СКЛЕИВАЕТСЯ', выдуманные.length === 0,
        выдуманные.map((i) => i.value).join(' | '));
  check('все пять значений списка на месте',
        has(r, 'url', 'https://evil.example/panel/gate.php')
        && has(r, 'md5', 'd41d8cd98f00b204e9800998ecf8427e')
        && has(r, 'cve', 'CVE-2025-31324')
        && has(r, 'email', 'billing@acme-invoices.top')
        && has(r, 'domain', 'good-domain.top'));

  const урлы = IOC.extractIocs('https://a.example/x\nhttps://b.example/y\nhttps://c.example/z');
  check('столбик URL не склеивается',
        none(урлы, 'url', 'https://a.example/xhttps://b.example/yhttps://c.example/z'));
  check('все три URL на месте', урлы.filter((i) => i.type === 'url').length === 3);

  /* Столбик хешей одной длины — список, а не перенос. */
  const хеши = IOC.extractIocs([
    'd41d8cd98f00b204e9800998ecf8427e',
    '098f6bcd4621d373cade4e832627b4f6',
    '5d41402abc4b2a76b9719d911017c592',
    '7d793037a0760186574b0282f2f435e7',
  ].join('\n'));
  check('столбик md5 не даёт выдуманных sha256',
        хеши.filter((i) => i.type === 'sha256').length === 0,
        хеши.filter((i) => i.type === 'sha256').map((i) => i.value).join(' | '));
  check('все четыре md5 на месте', хеши.filter((i) => i.type === 'md5').length === 4);

  /* ДВА md5 подряд — тоже список.
   *
   * Раньше здесь стояла обратная проверка: две строки по 32 знака
   * считались переносом sha256 и склеивались. Правило было выведено
   * из рассуждения, а не из документов, и на настоящих отчётах
   * оказалось неверным: раздел индикаторов из двух MD5 — обычная форма
   * у Securelist и Unit 42, и разбор выдавал третий хеш, которого
   * не существует. Признак переноса — произвольная длина обрывков,
   * а не совпадение с длиной другого алгоритма. */
  const параMd5 = IOC.extractIocs(
    '7A95360B7E0EB5B107A3D231ABBC541A\nC0D1EAA15A2CEFBAB9735787575C8D8E');
  check('два md5 подряд не дают выдуманный sha256',
        параMd5.filter((i) => i.type === 'sha256').length === 0,
        параMd5.filter((i) => i.type === 'sha256').map((i) => i.value).join(' | '));
  check('оба md5 на месте', параMd5.filter((i) => i.type === 'md5').length === 2);

  /* Вторая половина: честный перенос обязан по-прежнему склеиваться.
   * Длины обрывков произвольные — так рвёт настоящая вёрстка. */
  const пдф = IOC.extractIocs(
    'ccfc37014ce6183bb9268e15e8569fc870e3ccc112\n3fc2fac9cf43862369f335');
  check('перенос sha256 из PDF по-прежнему склеивается',
        has(пдф, 'sha256', 'ccfc37014ce6183bb9268e15e8569fc870e3ccc1123fc2fac9cf43862369f335'));
  const пдфUrl = IOC.extractIocs('https://evil.example/panel/\ngate.php?id=1234');
  check('перенос URL из PDF по-прежнему склеивается',
        has(пдфUrl, 'url', 'https://evil.example/panel/gate.php?id=1234'));
  const пдфТокен = IOC.extractIocs('https://evil.example/download/pay\nload.exe');
  check('перенос посреди токена склеивается',
        has(пдфТокен, 'url', 'https://evil.example/download/payload.exe'));
  check('склеенное помечено как догадка',
        пдф.find((i) => i.type === 'sha256').flags.includes('ambiguous:wrap'));
}

/* ===================================================================== *
 * ОБРЫВОК ОТ ПЕРЕНОСА НЕ ЕДЕТ ОТДЕЛЬНЫМ ИНДИКАТОРОМ
 *
 * Бюллетень заказчик, раздел ссылок:
 *
 *     https://vendor.example/blog/from-ads-to-full-device-
 *     takeover-analysis-part-two
 *
 * Выдача содержала ОБА: обрезанный адрес без единой пометки и склеенный
 * с `ambiguous:wrap`. Аналитик, взявший первый, пошёл бы проверять
 * адрес, которого не существует. Тот же класс дефекта, что выдуманный
 * индикатор: парсер утверждает то, чего в документе нет.
 * ===================================================================== */
{
  const t = 'https://vendor.example/blog/from-ads-to-full-device-\n'
          + 'takeover-analysis-part-two\n';
  const urls = IOC.extractIocs(t, { withContext: false }).filter((i) => i.type === 'url');
  check('ОБРЫВОК СНЯТ, ОСТАЛСЯ ОДИН АДРЕС', urls.length === 1,
        urls.map((i) => i.value).join(' | '));
  check('остался именно склеенный',
        urls[0] && urls[0].value.endsWith('takeover-analysis-part-two'),
        urls[0] && urls[0].value);
  check('и он помечен как догадка',
        urls[0] && (urls[0].flags || []).includes('ambiguous:wrap'));
  check('обе исходные строки приложены',
        urls[0] && Array.isArray(urls[0].wrapSource) && urls[0].wrapSource.length === 2,
        'без них пометка «это догадка» — тупик');

  /* Короткий адрес, случайно оказавшийся префиксом длинного, снимать
   * нельзя: он не стоит в конце строки склейки. */
  const t2 = 'http://evil-host.top/a и отдельно\n'
           + 'http://evil-host.top/ab-\ncdef\n';
  const u2 = IOC.extractIocs(t2, { withContext: false })
    .filter((i) => i.type === 'url').map((i) => i.value).sort();
  check('ЧУЖОЙ ПРЕФИКС НЕ СНИМАЕТСЯ', u2.includes('http://evil-host.top/a'), u2.join(' | '));

  /* Два MD5 на соседних строках: раньше выдавались ОБА варианта —
   * две половины с пометкой и склеенный SHA-256. Отличить было нечем,
   * и правило выбирало «показать всё».
   *
   * Настоящие отчёты этот выбор сняли: список из двух MD5 — обычная
   * форма раздела индикаторов, а перенос рвёт значение по ширине
   * колонки, то есть на куски произвольной длины. Выдавать третий хеш
   * «на всякий случай» значит выдавать несуществующее значение,
   * и аналитик понесёт его в отчёт. */
  const t3 = 'Хеш:\nccfc37014ce6183bb9268e15e8569fc8\n70e3ccc1123fc2fac9cf43862369f335\nдалее';
  const r3 = IOC.extractIocs(t3, { withContext: false });
  check('оба хеша остались', r3.filter((i) => i.type === 'md5').length === 2);
  check('ВЫДУМАННОГО SHA-256 НЕТ',
        r3.filter((i) => i.type === 'sha256').length === 0,
        r3.filter((i) => i.type === 'sha256').map((i) => i.value).join(' | '));

  /* А обрывок настоящего переноса по-прежнему снимается: строгий проход
   * видит `https://evil-host.top/panel/` законченным значением. */
  const t4 = 'URL:\nhttps://evil-host.top/panel/\ngate.php?id=1234\nдалее';
  const r4 = IOC.extractIocs(t4, { withContext: false }).filter((i) => i.type === 'url');
  check('обрывок переноса снят', r4.length === 1, r4.map((i) => i.value).join(' | '));
  check('склеенное помечено догадкой', (r4[0].flags || []).includes('ambiguous:wrap'));
}

/* =====================================================================
 * ТИПОВЫЕ ОШИБКИ РАЗБОРА, НАЙДЕННЫЕ НА НАСТОЯЩИХ ОТЧЁТАХ
 * =====================================================================
 *
 * Каждая проверка ниже — не придуманный случай, а форма, взятая
 * с конкретной площадки. Корпус целиком лежит в tools/corpus/texts,
 * там же указано, откуда взята каждая форма; здесь — минимальный
 * пример, чтобы поломка называлась своим именем, а не «корпус красный».
 * ================================================================== */
{
  /* 1. TLD не из списка. Домен ПРОПАДАЛ молча.
   *    Отчёт заказчика: api.gitpanel2v[.]bet, помечен дефангом автором. */
  const r = IOC.extractIocs('api.gitpanel2v[.]bet evil[.]icu shop[.]cfd panel[.]sbs x[.]cyou');
  check('редкие gTLD находятся', r.filter((i) => i.type === 'domain').length === 5,
        r.map((i) => i.value).join(' | '));

  /* 2. Расширение файла против TLD. Полный список TLD сделал
   *    `backup.zip` и `install.sh` доменами. */
  const ф = IOC.extractIocs('дроппер сохраняет backup.zip, запускает install.sh и stage2.py');
  check('имена файлов не стали доменами', ф.length === 0, ф.map((i) => i.value).join(' | '));
  const фд = IOC.extractIocs('индикатор backup[.]zip');
  check('но дефанг автора сильнее правила', has(фд, 'domain', 'backup.zip'));
  check('evil.com остаётся доменом', has(IOC.extractIocs('домен evil.com'), 'domain', 'evil.com'));

  /* 3. Знаки препинания, прилипшие к значению. Microsoft и DFIR Report
   *    дают ссылки в скобках и markdown-ссылками. */
  const п = IOC.extractIocs('см. (https://evil.com/a), затем https://evil.com/b; и путь C:\\T\\p.exe.');
  check('хвост URL обрезан',
        has(п, 'url', 'https://evil.com/a') && has(п, 'url', 'https://evil.com/b'),
        п.filter((i) => i.type === 'url').map((i) => i.value).join(' | '));
  check('хвост пути обрезан', has(п, 'winpath', 'C:\\T\\p.exe'));
  check('ПАРНАЯ СКОБКА НЕ СНИМАЕТСЯ',
        has(IOC.extractIocs('https://ru.wikipedia.org/wiki/X_(Y)'), 'url',
            'https://ru.wikipedia.org/wiki/X_(Y)'),
        'иначе ломаются настоящие ссылки со скобкой в пути');

  /* 4. Порт и путь отбрасывались молча. */
  const пп = IOC.extractIocs('C2: 202.95.14[.]237:5090 и загрузка с evil[.]com/gate.php');
  check('порт сохранён флагом',
        (пп.find((i) => i.type === 'ipv4').flags || []).includes('port:5090'));
  check('ссылка без схемы стала URL', has(пп, 'url', 'evil.com/gate.php'));
  check('и помечена как догадка',
        (пп.find((i) => i.type === 'url').flags || []).includes('ambiguous:no-scheme'));

  /* 5. Написание идентификаторов: Unit 42 пишет подтехнику через слэш,
   *    русские документы пишут БДУ кириллицей. */
  const и = IOC.extractIocs('ATT&CK techniques: T1574/001/, T1070/006/. Уязвимость БДУ:2026-01234');
  check('подтехника через слэш не теряется',
        has(и, 'attack', 'T1574.001') && has(и, 'attack', 'T1070.006'),
        и.filter((x) => x.type === 'attack').map((x) => x.value).join(' | '));
  check('БДУ кириллицей находится', has(и, 'bdu', 'BDU:2026-01234'));
  check('ATT&CK опознаётся по своему написанию',
        has(IOC.extractIocs('ATT&CK T1620 Reflective Code Loading'), 'attack', 'T1620'),
        'амперсанд в названии не подходил под шаблон «attack»');
  check('T-номер без контекста по-прежнему мусор',
        IOC.extractIocs('деталь T1234 из спецификации').length === 0);

  /* 6. Колонтитул между строками переноса. Отчёт заказчика: штамп «-01»
   *    вставал между обрывками адреса, и склейка брала его. */
  const к = [
    'Ссылки', '  https://example.org/a-very-long-article-name-',
    '                         -01', '  takeover-part-two           -01',
    'x', '-01', 'y', '-01', 'z', '-01',
  ].join('\n');
  const ку = IOC.extractIocs(к, { withContext: false }).filter((i) => i.type === 'url');
  check('перенос через колонтитул собран',
        ку.some((i) => i.value === 'https://example.org/a-very-long-article-name-takeover-part-two'),
        ку.map((i) => i.value).join(' | '));
  check('ВЫДУМАННОГО АДРЕСА СО ШТАМПОМ НЕТ',
        !ку.some((i) => i.value.includes('-01')), ку.map((i) => i.value).join(' | '));

  /* 7. Зоны .рф, .рус, .москва не разбирались ВОВСЕ: в обоих шаблонах
   *    последняя метка была ограничена латиницей. Для российского SOC
   *    это половина работы. */
  const рф = IOC.extractIocs('вход-банк[.]рф, мэрия.москва, почта.рус, xn--80ak6aa92e.xn--p1ai');
  check('кириллические зоны находятся',
        рф.filter((i) => i.type === 'domain').length === 4,
        рф.map((i) => i.value).join(' | '));
  check('punycode помечен', (рф.find((i) => i.value.startsWith('xn--')).flags || [])
        .includes('idn:puny'));
  check('путь у кириллического домена не теряется',
        has(IOC.extractIocs('вход-банк[.]рф/auth/login'), 'url', 'вход-банк.рф/auth/login'),
        'кириллические домены находит отдельный проход, и хвост там забывали');
  check('ГРАНИЦА ПРЕДЛОЖЕНИЯ НЕ ДОМЕН',
        IOC.extractIocs('В отчёте.Далее следует раздел').length === 0,
        'иначе кириллический TLD превращает прозу в индикаторы');

  /* 8. Ссылка без схемы выдавала ЕЩЁ И голый хост. Отчёт заказчика
   *    от 11.09.2026: девять ссылок на аккаунты дали сверху `github.com`
   *    со счётчиком 8 — значение, которого в отчёте нет, и оно же
   *    оказывалось первым в списке. */
  const гх = IOC.extractIocs('repohost3w[.]com/user-a7120 repohost3w[.]com/user-b3355', { withContext: false });
  check('голый хост не выдаётся отдельно',
        гх.every((i) => i.type !== 'domain'), гх.map((i) => i.value).join(' | '));
  check('сами ссылки на месте', гх.filter((i) => i.type === 'url').length === 2);
  check('ХОСТ САМ ПО СЕБЕ ОСТАЁТСЯ',
        has(IOC.extractIocs('evil[.]com/gate.php и отдельно evil[.]com'), 'domain', 'evil.com'),
        'поглощается ОДНО вхождение, а не значение целиком');

  /* 9. Хвост адреса, начинающийся со служебного слова. В том же
   *    дайджесте продолжение начиналось с «the-», правило прозы
   *    срабатывало на дефисе, и в выдачу уходил обрезанный адрес. */
  const хв = IOC.extractIocs(
    ['Ссылки', 'https://example.org/2026/the-shared-cache-inside-',
     '                    -01', '   -01', 'the-sandbox-part-two/',
     'x', '-01', 'y', '-01'].join('\n'), { withContext: false })
    .filter((i) => i.type === 'url');
  check('хвост со служебным словом склеивается',
        хв.some((i) => i.value === 'https://example.org/2026/the-shared-cache-inside-the-sandbox-part-two/'),
        хв.map((i) => i.value).join(' | '));
  check('ОБРЕЗАННОГО АДРЕСА НЕТ',
        !хв.some((i) => i.value.endsWith('inside-')), хв.map((i) => i.value).join(' | '));
  check('НАСТОЯЩАЯ ПРОЗА ПО-ПРЕЖНЕМУ НЕ КЛЕИТСЯ',
        IOC.extractIocs('https://example.org/page\nthe report continues here', { withContext: false })
          .every((i) => !i.value.includes('the')),
        'за словом в прозе идёт пробел, в слаге адреса — дефис');

  /* 10. «at» словом в английской прозе. DFIR Report: «(mirrored at
   *    link72[.]com/d/pkg.bin)» давало несуществующий адрес почты. */
  check('проза не даёт адреса почты',
        IOC.extractIocs('payload hosted at evil.com').every((i) => i.type !== 'email'));
  check('но конвенция целиком раскрывается',
        has(IOC.extractIocs('пишите user at evil dot com'), 'email', 'user@evil.com'));
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
