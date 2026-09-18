/* Проверка разбора ссылок. Запуск:
 *   node extension/lib/fetchpage.test.js
 *
 * Сеть не нужна и не используется: тестируются чистые функции — разбор
 * ссылки и отбор атрибутов. Сам сетевой запрос и обход DOM в Node не
 * проверяются; почему — написано в комментарии к htmlToText.
 */
'use strict';
const IOC = require('./ioc.js');
globalThis.IOC = IOC;               // normalizeUrl снимает дефанг через IOC.refang
const F = require('./fetchpage.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}
function throws(fn, re) {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
}

/* --------------------------------------------------- 1. разбор ссылки -- */
{
  check('обычная ссылка проходит',
        F.normalizeUrl('https://example.com/a?b=1') === 'https://example.com/a?b=1');

  // Схему дописываем: аналитик копирует домен из отчёта без неё постоянно.
  check('без схемы добавляется https',
        F.normalizeUrl('example.com/report') === 'https://example.com/report');
  check('http сохраняется, а не подменяется на https',
        F.normalizeUrl('http://example.com/') === 'http://example.com/');

  // Дефанг — не исключение, а норма: в отчётах ссылки всегда обезврежены.
  // Без снятия дефанга самый частый способ использования не работал бы.
  check('дефанг hxxps снимается',
        F.normalizeUrl('hxxps://evil[.]com/gate.php') === 'https://evil.com/gate.php');
  check('дефанг в скобках снимается',
        F.normalizeUrl('evil[.]com') === 'https://evil.com/');
  check('hxxp даёт http, а не https',
        F.normalizeUrl('hxxp://evil[.]com/') === 'http://evil.com/');

  check('пустая строка отвергается', throws(() => F.normalizeUrl('   '), /пустая/));
  check('мусор отвергается', throws(() => F.normalizeUrl('это не ссылка вообще'), /не похоже|только http/));

  // Двоеточие в host:port — это порт, а не схема. Проверяем на ВНЕШНЕМ
  // хосте: внутренние зоны теперь отвергаются отдельным правилом, и на
  // них эта проверка проверяла бы уже не то.
  check('порт не принимается за схему',
        F.normalizeUrl('vendor.example:8080/report') === 'https://vendor.example:8080/report');
  check('mailto отвергается', throws(() => F.normalizeUrl('mailto:a@b.com'), /не поддерживается/));
}

/* ------------------------------------------- 2. опасные схемы ссылок --- */
{
  /* Смысл проверки: file:// и chrome:// нельзя дать забрать, иначе поле
   * «забрать по ссылке» становится способом прочитать локальный файл
   * и отправить его содержимое в анализ. Схема дописывается ТОЛЬКО там,
   * где её нет, — поэтому явную чужую схему надо именно отвергнуть. */
  for (const bad of ['file:///C:/Windows/win.ini', 'file:///etc/passwd',
                     'chrome://settings', 'about:config',
                     'javascript:alert(1)', 'ftp://example.com/f',
                     'resource://gre/modules/', 'moz-extension://abc/x.html']) {
    check(`схема отвергается: ${bad}`,
          throws(() => F.normalizeUrl(bad), /только http|не похоже|не поддерживается/),
          'разрешена ссылка, которую разрешать нельзя');
  }

  // data: — тот же класс: не адрес, а встроенное содержимое.
  check('data-URL отвергается',
        throws(() => F.normalizeUrl('data:text/html,<h1>x</h1>'), /не поддерживается/));
}

/* ------------------------------------------- 3. отбор адресов из HTML -- */
{
  check('обычный href берётся', F.isUsefulAttrValue('https://evil.com/gate.php'));
  check('относительный путь берётся', F.isUsefulAttrValue('/downloads/payload.exe'));

  // Эти значения адресами не являются. Особенно важен data: — картинка
  // в base64 на мегабайт даёт парсеру мегабайт случайных букв, в которых
  // он найдёт «домены», которых не существует.
  check('javascript: не берётся', !F.isUsefulAttrValue('javascript:void(0)'));
  check('data: не берётся', !F.isUsefulAttrValue('data:image/png;base64,iVBORw0KGgo'));
  check('blob: не берётся', !F.isUsefulAttrValue('blob:https://x/abc'));
  check('якорь не берётся', !F.isUsefulAttrValue('#section-2'));
  check('пустое не берётся', !F.isUsefulAttrValue(''));
  check('пробел перед схемой не обходит проверку',
        !F.isUsefulAttrValue('  javascript:alert(1)'));
  check('регистр не обходит проверку', !F.isUsefulAttrValue('JavaScript:alert(1)'));

  check('теги-пустышки вырезаются до разбора',
        /script/.test(F.PAGE_DROP_TAGS) && /style/.test(F.PAGE_DROP_TAGS)
        && /iframe/.test(F.PAGE_DROP_TAGS));
}

/* -------------------------------------------------------- 4. пределы --- */
{
  // Предел размера нужен не ради памяти, а чтобы ссылка на дистрибутив
  // не подвесила вкладку намертво.
  check('предел размера страницы задан и разумен',
        F.PAGE_MAX_BYTES >= 1024 * 1024 && F.PAGE_MAX_BYTES <= 20 * 1024 * 1024,
        String(F.PAGE_MAX_BYTES));
  check('таймаут задан и разумен',
        F.PAGE_TIMEOUT_MS >= 5000 && F.PAGE_TIMEOUT_MS <= 60000,
        String(F.PAGE_TIMEOUT_MS));
}

/* ====== 5. СТРАНИЦЫ, ОТРИСОВАННЫЕ СКРИПТАМИ ====== */
{
  /* Регрессия, найденная в эксплуатации: после вырезания обвязки
   * от отчёта BI.ZONE осталось 639 символов и «0 индикаторов».
   * Причина оказалась глубже вырезания — статьи в HTML не было
   * никогда, страница отрисовывается скриптами, а 10406 символов
   * до этого были обвязкой.
   *
   * Сказать «0 индикаторов» про страницу, которую мы не прочитали, —
   * это утверждение о странице, а не о нашем заборе. Разница решает,
   * пойдёт аналитик дальше или закроет вопрос. */
  check('оболочка распознаётся',
        F.looksLikeShell('<html>' + 'x'.repeat(50000) + '</html>', 'коротко'));
  check('нормальная статья не считается оболочкой',
        !F.looksLikeShell('x'.repeat(50000), 'т'.repeat(5000)));
  check('короткая, но плотная страница не оболочка',
        !F.looksLikeShell('<p>' + 'т'.repeat(1000) + '</p>', 'т'.repeat(1000)));
  check('порог статьи задан разумно',
        F.MIN_ARTICLE_CHARS >= 300 && F.MIN_ARTICLE_CHARS <= 3000,
        String(F.MIN_ARTICLE_CHARS));

  // Восстановление текста из встроенного JSON: это JSON.parse, не выполнение.
  const next = '<script type="application/json" id="__NEXT_DATA__">'
    + JSON.stringify({ props: { body:
        'Группировка использовала домен evil-c2.top и загрузчик с хешем '
        + 'd41d8cd98f00b204e9800998ecf8427e для закрепления на узле жертвы.',
        slug: 'x1', id: 7 } })
    + '</script>';
  const got = F.extractJsonText(next);
  check('текст статьи извлечён из JSON', /evil-c2\.top/.test(got), got);
  check('хеш не потерян', /d41d8cd98f00b204e9800998ecf8427e/.test(got));
  check('короткие значения отброшены', !/x1/.test(got) && !got.includes('slug'));

  // HTML внутри JSON встречается постоянно — теги снимаются.
  const withTags = '<script type="application/ld+json">'
    + JSON.stringify({ articleBody: '<p>Домен <b>evil.example</b> использовался '
        + 'как сервер управления в течение всей кампании против клиентов.</p>' })
    + '</script>';
  check('теги внутри JSON снимаются',
        !/<p>|<b>/.test(F.extractJsonText(withTags)), F.extractJsonText(withTags));
  check('домен из JSON-HTML остался', /evil\.example/.test(F.extractJsonText(withTags)));

  // Битый JSON не должен ронять разбор всей страницы.
  check('битый JSON не роняет',
        F.extractJsonText('<script type="application/json">{это не json</script>') === '');
  check('без скриптов JSON пуст', F.extractJsonText('<html><p>текст</p></html>') === '');
}


/* --------------------------- внутренний контур забирать нельзя --------- */
{
  /* Политика Firefox закрывает внутренние зоны WebsiteFilter'ом, но он
   * запрещает ПЕРЕХОД, а не fetch из расширения: до этой проверки забор
   * ходил мимо главного технического барьера проекта, и содержимое
   * внутренней вики попадало в разбор, кейс и выгрузку. */
  const внутренние = ['https://wiki.corp/x', 'http://portal.internal/', 'https://n.local/a',
                      'http://host.lan/', 'https://x.intranet/', 'http://localhost:8080/',
                      'http://192.168.1.5/', 'https://10.2.3.4/', 'http://172.20.0.1/',
                      'http://127.0.0.1/', 'http://169.254.1.1/', 'http://100.70.0.1/'];
  let отвергнуты = 0;
  for (const u of внутренние) {
    if (throws(() => F.normalizeUrl(u), /внутренн|локальная машина/)) отвергнуты++;
    else console.error('        пропущен внутренний адрес: ' + u);
  }
  check('ВНУТРЕННИЕ АДРЕСА НЕ ЗАБИРАЮТСЯ', отвергнуты === внутренние.length,
        `отвергнуто ${отвергнуты} из ${внутренние.length}`);

  const внешние = ['https://securelist.com/a', 'https://11.0.0.1/', 'https://172.15.0.1/',
                   'https://100.63.0.1/', 'https://corporate.example/'];
  let прошли = 0;
  for (const u of внешние) { try { F.normalizeUrl(u); прошли++; } catch (e) { console.error('        зря отвергнут: ' + u + ' — ' + e.message); } }
  check('внешние адреса не задеты', прошли === внешние.length, `прошло ${прошли} из ${внешние.length}`);
}

/* ------------------------- риски конкретной ссылки --------------------- */
{
  /* Постоянный баннер убран; вместо него — предупреждения, зависящие
   * от самой ссылки. Проверяется и то, что они появляются, и то,
   * что на обычной ссылке их НЕТ: предупреждение, которое видно всегда,
   * перестаёт читаться. */
  const known = ['cdn-update.delivery'];
  check('обычная ссылка без предупреждений',
        F.fetchRisks('https://vendor.example/report/2026', known).length === 0);
  check('УНИКАЛЬНАЯ ССЫЛКА НАЗВАНА',
        F.fetchRisks('https://x.example/r?token=a1b2c3d4e5f6g7h8', []).some((w) => /персональн/.test(w)));
  check('токен в пути тоже виден',
        F.fetchRisks('https://x.example/d/9f3ac21b77de4410/report', []).some((w) => /персональн/.test(w)));
  check('ХОСТ ИЗ РАЗБОРА НАЗВАН',
        F.fetchRisks('https://cdn-update.delivery/panel/', known).some((w) => /интересуются/.test(w)));
  check('поддомен расследуемого хоста тоже',
        F.fetchRisks('https://a.cdn-update.delivery/x', known).some((w) => /интересуются/.test(w)));
  check('осмысленное слово не считается токеном',
        !F.looksLikeToken('recommendations') && !F.looksLikeToken('threatintelligence'));
  check('мусор вместо ссылки не роняет', F.fetchRisks('не ссылка', known).length === 0);
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
