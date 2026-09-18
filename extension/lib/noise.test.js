/* Проверка отсева обвязки страницы. Запуск:
 *   node extension/lib/noise.test.js
 *
 * Поводом стал разбор отчёта BI.ZONE: из одиннадцати «индикаторов»
 * настоящими не были ни одного — восемь ссылок на площадки самой
 * компании и два её адреса почты.
 *
 * Обратная ошибка опаснее прямой: спрятать настоящий индикатор хуже,
 * чем показать лишний. Поэтому половина проверок здесь — о том,
 * что НЕ должно отсеиваться.
 */
'use strict';
const N = require('./noise.js');
const F = require('./fetchpage.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}
const noise = (type, value, host) => N.classify({ type, value }, { sourceHost: host }).noise;

/* ============ 1. РОВНО ТОТ СЛУЧАЙ, ЧТО ПОЙМАЛА ЭКСПЛУАТАЦИЯ ============ */
{
  const SRC = 'bi.zone';
  const seen = [
    'https://bi.zone/expertise/blog/idem-po-sledam-feral-wolf-novye-instrumenty-i-tekhniki-atak/',
    'https://bi-zone.medium.com/',
    'https://habr.com/ru/users/bizone_team/posts/',
    'https://max.ru/bizone_channel',
    'https://ru.linkedin.com/company/bi.zone',
    'https://telegram.me/+0sSgHmKYGVVjNzRi',
    'https://vk.com/bi_zone_vk',
    'https://x.com/bizone_en',
  ];
  for (const u of seen) {
    check(`отсеивается: ${u.slice(0, 44)}`, noise('url', u, SRC), 'осталось бы в выдаче');
  }
  check('почта источника отсеивается', noise('email', 'info@bi.zone', SRC));
  check('домен источника отсеивается', noise('domain', 'bi.zone', SRC));
  check('поддомен источника отсеивается', noise('domain', 'cdn.bi.zone', SRC));

  const reasons = seen.map((u) => N.classify({ type: 'url', value: u }, { sourceHost: SRC }).reason);
  check('у каждого отсеянного есть причина', reasons.every(Boolean));
  check('сайт источника назван своей причиной',
        reasons[0] === N.REASON.SOURCE, reasons[0]);
  check('площадка названа своей причиной',
        reasons[1] === N.REASON.PLATFORM, reasons[1]);
}

/* ============ 2. ЧТО ОТСЕИВАТЬ НЕЛЬЗЯ — ЭТО ВАЖНЕЕ ============ */
{
  const SRC = 'bi.zone';
  /* Настоящие индикаторы из отчётов. Если хоть один попадёт в обвязку,
   * аналитик не увидит его вовсе, а понять, что он был, будет неоткуда. */
  const real = [
    ['domain', 'cdn-update.delivery'],
    ['domain', 'feral-wolf-c2.top'],
    ['url', 'https://evil.example/panel/gate.php'],
    ['email', 'billing@acme-invoices.top'],
    // Бесплатные хостинги и репозитории — там регулярно лежит нагрузка.
    ['url', 'https://github.com/attacker/loader'],
    ['domain', 'github.com'],
    ['url', 'https://gitlab.com/attacker/payload'],
    ['url', 'https://pastebin.com/raw/AbCdEf12'],
    ['domain', 'malware.blogspot.com'],
    ['domain', 'phish.wordpress.com'],
    // Похожий, но чужой домен — классическая подделка под вендора.
    ['domain', 'bi-zone.top'],
    ['domain', 'bizone.support'],
    // Не заканчивается на bi.zone как поддомен, а просто содержит подстроку.
    ['domain', 'notbi.zone.evil.com'],
  ];
  for (const [t, v] of real) {
    check(`НЕ отсеивается: ${v}`, !noise(t, v, SRC), 'настоящий индикатор был бы спрятан');
  }

  // Типы, к которым правила не применяются вовсе.
  for (const [t, v] of [['ipv4', '8.8.8.8'], ['sha256', 'a'.repeat(64)], ['cve', 'CVE-2021-44228']]) {
    check(`тип ${t} не трогаем`, !noise(t, v, SRC));
  }
}

/* ============ 3. БЕЗ ИЗВЕСТНОГО ИСТОЧНИКА ============ */
{
  // Текст вставили руками — хоста источника нет, но площадки известны всегда.
  check('площадка отсеивается и без источника', noise('url', 'https://t.me/channel', ''));
  check('домен вендора без источника НЕ отсеивается', !noise('domain', 'bi.zone', ''));
  check('пустое значение не роняет', !noise('url', '', 'bi.zone'));
  check('битый URL не роняет', !noise('url', 'httpx://не url', 'bi.zone'));
}

/* ============ 4. СПИСКИ НЕ ДОЛЖНЫ РАЗРАСТАТЬСЯ ============ */
{
  /* Каждая запись прячет индикаторы. Список, в который «на всякий случай»
   * добавляют хостинги и репозитории, превращается из отсева шума
   * в сокрытие данных. */
  for (const forbidden of ['github.com', 'gitlab.com', 'pastebin.com',
                           'blogspot.com', 'wordpress.com', 'bitly.com', 'ipfs.io']) {
    check(`${forbidden} не в списке площадок`, !N.PLATFORM_HOSTS.includes(forbidden),
          'на таких площадках лежит вредоносная нагрузка — прятать нельзя');
  }
  check('список площадок не раздут', N.PLATFORM_HOSTS.length <= 30,
        String(N.PLATFORM_HOSTS.length));
}

/* ============ 5. РАЗМЕТКА СПИСКА ============ */
{
  const list = [
    { type: 'url', value: 'https://x.com/bizone_en' },
    { type: 'domain', value: 'cdn-update.delivery' },
    { type: 'email', value: 'info@bi.zone' },
  ];
  N.markNoise(list, { sourceHost: 'bi.zone' });
  check('ничего не выброшено', list.length === 3);
  check('обвязка помечена', list[0].noise === true && list[2].noise === true);
  check('индикатор не помечен', list[1].noise === false);
  check('у непомеченного нет причины', !('noiseReason' in list[1]));

  // Повторная разметка с другим источником должна снимать прежнюю метку.
  N.markNoise(list, { sourceHost: 'other.example' });
  check('метка снимается при смене источника',
        list[2].noise === false && !('noiseReason' in list[2]));
}

/* ============ 6. ХОСТ ИСТОЧНИКА ============ */
{
  check('хост из ссылки', N.sourceHostOf('https://bi.zone/expertise/blog/x/') === 'bi.zone');
  check('регистр приводится', N.sourceHostOf('https://BI.Zone/x') === 'bi.zone');
  check('мусор даёт пустоту', N.sourceHostOf('не ссылка') === '');
  check('пустота даёт пустоту', N.sourceHostOf('') === '');
}

/* ============ 7. ОБВЯЗКА СТРАНИЦЫ: ЧИСТЫЕ ПРАВИЛА ============ */
{
  /* Сам обход дерева в Node не проверить — DOMParser'а нет. Проверяем
   * решающее правило: по каким именам классов элемент считается обвязкой. */
  const P = F.CHROME_PATTERN;
  for (const cls of ['footer', 'site-footer', 'main_nav', 'social-links',
                     'share buttons', 'cookie-banner', 'sidebar', 'related-posts',
                     'newsletter-form', 'breadcrumb', 'copyright']) {
    check(`обвязка по классу: ${cls}`, P.test(cls));
  }
  /* И обратное: класс статьи не должен попасть под правило. «article-body»
   * с «body» внутри, «content», «post» — их вырезать нельзя. */
  for (const cls of ['article-body', 'post-content', 'entry', 'ioc-table',
                     'indicators', 'report-text', 'markdown-body']) {
    check(`НЕ обвязка: ${cls}`, !P.test(cls), 'вырезали бы саму статью');
  }
  check('блочные теги перечислены',
        /\bdiv\b/.test(F.BLOCK_TAGS) && /\btr\b/.test(F.BLOCK_TAGS) && /\bli\b/.test(F.BLOCK_TAGS));
  check('таблицы разбиваются построчно',
        /\btd\b/.test(F.BLOCK_TAGS) && /\bth\b/.test(F.BLOCK_TAGS),
        'таблица индикаторов склеится в одну строку');
}

/* ===================================================================== *
 * СТРУКТУРА ДОКУМЕНТА: колонтитулы и раздел ссылок
 *
 * Поймано на отчёте заказчика: строка «Email: soc@example.org» стоит
 * колонтитулом на каждой из пятнадцати страниц и уезжала в основной
 * список как индикатор ×15; два адреса статей из раздела «Ссылки
 * и дополнительные материалы» — туда же.
 * ===================================================================== */
{
  const IOC = require('./ioc.js');

  /* Документ-образец: колонтитул на каждой «странице», индикаторы
   * в середине, раздел ссылок в конце. */
  const страница = (n) => [
    'Email: soc@example.org',
    'DIGEST-EXAMPLE-0001',
    String(n),
    `Индикаторы страницы ${n}:`,
    `185.220.101.${n}`,
    `evil-${n}.top`,
    '',
  ];
  const док = [
    ...страница(1), ...страница(2), ...страница(3), ...страница(4), ...страница(5),
    'Ссылки и дополнительные материалы',
    ' https://news.example/malicious-modules/',
    ' https://vendor.example/blog/ref',
  ].join('\n');

  const parts = N.documentParts(док);
  check('колонтитул найден', parts.furniture.size >= 10, String(parts.furniture.size));
  check('раздел ссылок найден', parts.refsFrom !== null, String(parts.refsFrom));

  const iocs = IOC.extractIocs(док, { withContext: false });
  N.markNoise(iocs, { sourceHost: '' });
  const итог = N.markDocumentNoise(iocs, док, IOC.extractIocs);

  const шум = iocs.filter((i) => i.noise);
  const чисто = iocs.filter((i) => !i.noise);
  const знач = (list) => list.map((i) => i.value).sort().join(',');

  check('АДРЕС ИЗ КОЛОНТИТУЛА УШЁЛ В ОБВЯЗКУ',
        шум.some((i) => i.value === 'soc@example.org'), знач(шум));
  check('причина названа колонтитулом',
        (шум.find((i) => i.value === 'soc@example.org') || {}).noiseReason === N.REASON.FURNITURE);
  check('АДРЕСА ИЗ РАЗДЕЛА ССЫЛОК УШЛИ В ОБВЯЗКУ',
        шум.filter((i) => i.type === 'url').length === 2, знач(шум));
  check('причина названа разделом ссылок',
        шум.filter((i) => i.type === 'url').every((i) => i.noiseReason === N.REASON.REFS));
  check('счётчики совпадают с разметкой', итог.furniture === 1 && итог.refs === 2,
        JSON.stringify(итог));

  check('НАСТОЯЩИЕ ИНДИКАТОРЫ ОСТАЛИСЬ',
        чисто.filter((i) => i.type === 'ipv4').length === 5
        && чисто.filter((i) => i.type === 'domain').length === 5,
        знач(чисто));

  /* Главная защита правила: значение, стоящее И в колонтитуле, И в теле,
   * остаётся индикатором. Иначе взломанный домен вендора, упомянутый
   * в подвале, исчез бы из выдачи. */
  const док2 = док.replace('Индикаторы страницы 3:', 'Индикаторы страницы 3: soc@example.org');
  const iocs2 = IOC.extractIocs(док2, { withContext: false });
  N.markNoise(iocs2, { sourceHost: '' });
  N.markDocumentNoise(iocs2, док2, IOC.extractIocs);
  check('ВСТРЕЧАЕТСЯ И ВНЕ ОБВЯЗКИ — ОСТАЁТСЯ',
        !iocs2.find((i) => i.value === 'soc@example.org').noise,
        'иначе исчезнет индикатор, упомянутый ещё и в подвале');

  /* Короткий документ и документ без обвязки не должны ничего терять. */
  const простой = '185.220.101.34\nevil-host.top\nbilling@evil-host.top';
  const iocs3 = IOC.extractIocs(простой, { withContext: false });
  N.markNoise(iocs3, { sourceHost: '' });
  const пусто = N.markDocumentNoise(iocs3, простой, IOC.extractIocs);
  check('в коротком тексте обвязки нет', пусто.furniture === 0 && пусто.refs === 0);
  check('и ничего не помечено', iocs3.every((i) => !i.noise));

  /* Повторы ПОДРЯД — это не колонтитул, а список. Растянутость
   * вхождений по документу — обязательное условие. */
  const подряд = ['шапка', 'один и тот же адрес 9.9.9.9', 'один и тот же адрес 9.9.9.9',
                  'один и тот же адрес 9.9.9.9', 'дальше текст', 'ещё текст', 'и ещё',
                  'и ещё раз', 'конец'].join('\n');
  const p2 = N.documentParts(подряд);
  check('ПОВТОРЫ ПОДРЯД НЕ КОЛОНТИТУЛ', p2.furniture.size === 0,
        'иначе правило съело бы таблицу с одинаковыми строками');

  /* Заголовок «Ссылки» в СЕРЕДИНЕ документа разделом ссылок не считается. */
  const середина = ['Ссылки', 'http://evil-host.top/a', ...Array(20).fill('текст отчёта')].join('\n');
  check('«Ссылки» в середине — не раздел ссылок',
        N.documentParts(середина).refsFrom === null,
        'в середине отчёта это заголовок таблицы не реже, чем список литературы');

  check('порог положения раздела назван', N.REFS_MIN_POSITION >= 0.5);
  check('порог повторов назван', N.FURNITURE_MIN_REPEATS >= 3);

  /* КОНТАКТНАЯ СТРОКА В КОНЦЕ ОТЧЁТА.
   *
   * Securelist заканчивает разбор строкой «Чтобы узнать больше об отчётах,
   * напишите нам: intelreports@kaspersky.com». Это адрес вендора.
   * Правило по хосту его не видит — у вставленного текста нет источника;
   * правило про колонтитул тоже — строка встречается один раз. */
  const хвост = [
    'Индикаторы компрометации', 'update.cloudmsnews[.]com', '185.82.202[.]77',
    'Письмо отправлено с адреса rita.morozova@mail-delivery[.]top',
    'и содержало вложение.', 'Далее разбор второй стадии.', 'Ещё текст отчёта.',
    'И ещё немного текста.', '',
    'Чтобы узнать больше об отчётах, напишите',
    'нам: intelreports@kaspersky.com',
  ].join('\n');
  const хв = IOC.extractIocs(хвост, { withContext: false });
  N.markNoise(хв, { sourceHost: '' });
  const ит = N.markDocumentNoise(хв, хвост, IOC.extractIocs);
  const найти = (v) => хв.find((i) => i.value.toLowerCase() === v);
  check('контактный адрес отсеян', !!найти('intelreports@kaspersky.com')?.noise,
        'адрес вендора в подвале — не индикатор');
  check('причина названа контактной строкой', ит.contact === 1);
  check('АДРЕС ИЗ РАЗБОРА ИНЦИДЕНТА ОСТАЛСЯ',
        найти('rita.morozova@mail-delivery.top')
        && !найти('rita.morozova@mail-delivery.top').noise,
        'иначе правило прячет отправителя фишинга');

  /* Приглашение без адреса и адрес без приглашения — не контакт. */
  const без = [
    'Отчёт', 'Первая строка', 'Вторая строка', 'Третья строка',
    'Четвёртая строка', 'Пятая строка', 'Шестая строка',
    'Злоумышленник писал с billing@acme-invoices[.]top',
  ].join('\n');
  const б = IOC.extractIocs(без, { withContext: false });
  N.markNoise(б, { sourceHost: '' });
  N.markDocumentNoise(б, без, IOC.extractIocs);
  check('АДРЕС БЕЗ ПРИГЛАШЕНИЯ НЕ ОТСЕИВАЕТСЯ',
        б.every((i) => !i.noise), 'одного положения в конце документа мало');
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
