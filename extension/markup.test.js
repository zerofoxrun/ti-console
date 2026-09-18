/* Сверка разметки со стилями и кодом. Запуск:
 *   node extension/markup.test.js
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ
 * ---------------
 * Страницы расширения модульными тестами не покрыты: newtab.js и panel.js
 * — документы, а не библиотеки. Все дефекты, которые здесь ловятся,
 * выглядят снаружи одинаково — «ничего не произошло»:
 *
 *   - код обращается к #id, которого в разметке нет → null и обрыв
 *     обработчика на первой же строке;
 *   - класс стоит в разметке, а правила для него нет → элемент выглядит
 *     не так, как задумано, и никто этого не замечает годами
 *     (.btn-secondary висел на тринадцати кнопках без единого правила);
 *   - повторяющийся id → getElementById находит не тот элемент;
 *   - label for= и aria-controls в пустоту → интерфейс недоступен
 *     с клавиатуры и для экранного диктора;
 *   - <script src> на несуществующий файл → страница молча неполная.
 *
 * Проверка статическая и быстрая: браузер для неё не нужен.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname) + '/';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}
const load = (p) => fs.readFileSync(R + p, 'utf8');

/* Проверки «этого в коде быть не должно» обязаны смотреть на КОД.
 * Без снятия комментариев такая проверка запрещает объяснить в тексте
 * файла, почему старый ключ больше не используется, — то есть наказывает
 * ровно за то, что нужно сохранить. */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/* Классы, у которых правила быть не должно: это зацепки для кода
 * и разметочные маркеры, а не оформление. Список ЗАКРЫТЫЙ — новый
 * класс без стиля придётся либо оформить, либо внести сюда осознанно. */
const БЕЗ_СТИЛЯ_НАМЕРЕННО = new Set([]);

const pages = [
  { name: 'newtab', html: 'newtab/newtab.html', js: ['newtab/newtab.js'], css: 'newtab/newtab.css' },
  { name: 'panel', html: 'panel/panel.html', js: ['panel/panel.js'], css: null },
  /* Попап подключает общий newtab.css и добавляет свой <style>. Проверять
   * классы надо по обоим, иначе собственные классы попапа выглядели бы
   * как «класс без правила». */
  { name: 'popup', html: 'popup/popup.html', js: ['popup/popup.js'],
    css: 'newtab/newtab.css', плюсСвойСтиль: true },
];

for (const pg of pages) {
  const html = load(pg.html);
  const js = pg.js.map(load).join('\n');
  const dir = pg.html.replace(/[^/]+$/, '');

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const счёт = new Map();
  for (const id of ids) счёт.set(id, (счёт.get(id) || 0) + 1);
  const повторы = [...счёт].filter(([, n]) => n > 1).map(([id]) => id);
  check(`${pg.name}: повторяющихся id нет`, повторы.length === 0, повторы.join(', '));

  const have = new Set(ids);
  // Элементы, которые код создаёт сам (el.id = 'x'), в разметке не нужны.
  for (const m of js.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)) have.add(m[1]);

  const wanted = new Set();
  for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) wanted.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) wanted.add(m[1]);
  for (const m of js.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)) wanted.add(m[1]);
  const нет = [...wanted].filter((id) => !have.has(id));
  check(`${pg.name}: код не обращается к несуществующим id`, нет.length === 0,
        нет.map((x) => '#' + x).join(', '));

  const мимоLabel = [...html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)]
    .map((m) => m[1]).filter((x) => !have.has(x));
  check(`${pg.name}: label for= ведёт на существующий элемент`, мимоLabel.length === 0,
        мимоLabel.join(', '));

  const мимоAria = [];
  for (const m of html.matchAll(/aria-(controls|labelledby|describedby)="([^"]+)"/g)) {
    for (const ref of m[2].split(/\s+/)) if (ref && !have.has(ref)) мимоAria.push(`aria-${m[1]}="${ref}"`);
  }
  check(`${pg.name}: aria-ссылки ведут на существующие элементы`, мимоAria.length === 0,
        мимоAria.join(', '));

  const безПанели = [...new Set([...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]))]
    .filter((t) => !have.has(`panel-${t}`));
  check(`${pg.name}: у каждой вкладки есть панель`, безПанели.length === 0, безПанели.join(', '));

  const нетФайла = [];
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    if (!fs.existsSync(R + dir + m[1])) нетФайла.push(`script ${m[1]}`);
  }
  for (const m of html.matchAll(/<link[^>]*\shref="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) { нетФайла.push(`ВНЕШНЯЯ ССЫЛКА ${m[1]}`); continue; }
    if (!fs.existsSync(R + dir + m[1])) нетФайла.push(`link ${m[1]}`);
  }
  check(`${pg.name}: все подключённые файлы на месте и локальны`, нетФайла.length === 0,
        нетФайла.join(', '));

  if (pg.css) {
    /* Комментарии снимаются: упоминание класса в пояснении — не правило,
     * а именно в пояснении чаще всего и написано, почему класс появился. */
    let css = stripComments(load(pg.css));
    if (pg.плюсСвойСтиль) {
      for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) css += '\n' + stripComments(m[1]);
    }
    const used = new Set();
    for (const m of html.matchAll(/\sclass="([^"]+)"/g)) {
      m[1].split(/\s+/).forEach((c) => c && used.add(c));
    }
    for (const m of js.matchAll(/classList\.(?:add|toggle)\('([A-Za-z0-9_-]+)'/g)) used.add(m[1]);
    const безПравила = [...used]
      .filter((c) => !БЕЗ_СТИЛЯ_НАМЕРЕННО.has(c))
      .filter((c) => !new RegExp(`\\.${c.replace(/-/g, '\\-')}\\b`).test(css));
    check(`${pg.name}: у каждого класса разметки есть правило в стилях`,
          безПравила.length === 0, безПравила.join(', '));
  }
}

/* ------------------------------------------------- hidden обязан скрывать */
{
  /* Браузер задаёт [hidden] { display:none } в СВОЕЙ таблице стилей,
   * а любое авторское правило с display её перебивает. Поэтому
   * `el.hidden = true` на элементе с классом `display:flex` не делает
   * ничего, и в коде это не видно: строка «скрыть» есть, элемент на месте.
   *
   * Так на пустом стартовом экране висела панель «Выбрать все · Добавить
   * в кейс · Плейбук…», а боковая панель писала «нажмите кнопку TI»
   * поверх найденных индикаторов. Правило должно быть одно на все
   * элементы — точечное «на каждый обнаруженный класс» не работает,
   * потому что находится он только глазами. */
  const общее = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/;
  check('newtab: hidden скрывает безусловно', общее.test(load('newtab/newtab.css')),
        'нужно правило [hidden] { display: none !important; }');
  check('панель: hidden скрывает безусловно', общее.test(load('panel/panel.html')),
        'нужно правило [hidden] { display: none !important; }');

  /* Диагностика: перечислить элементы, которых это касается. Не падение —
   * общее правило их уже закрывает, но список полезен при разборе. */
  const js = load('newtab/newtab.js');
  const html = load('newtab/newtab.html');
  const css = load('newtab/newtab.css');
  const ids = new Set();
  for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)\.hidden\s*=/g)) ids.add(m[1]);
  const рискованные = [];
  for (const id of ids) {
    const tag = (html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`)) || [''])[0];
    const cls = ((tag.match(/class="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    for (const c of cls) {
      if (new RegExp(`\\.${c.replace(/-/g, '\\-')}\\b[^{]*\\{[^}]*display\\s*:`).test(css)) {
        рискованные.push(`#${id} (.${c})`);
      }
    }
  }
  if (рискованные.length) {
    console.log(`  [инфо] hidden против display у ${рискованные.length} элементов — `
              + `закрыто общим правилом: ${рискованные.join(', ')}`);
  }
}

/* ------------------------------------------- боковая панель и кейсы ---- */
{
  const panelJs = stripComments(load('panel/panel.js'));
  const panelHtml = load('panel/panel.html');
  /* Панель писала в ti_case_items, когда вкладка уже читала ti_cases:
   * «В кейс» отвечало «+7» и не клало никуда. Проверка ровно на это. */
  check('панель не пишет в старый ключ ti_case_items',
        !/ti_case_items/.test(panelJs),
        'кейсы живут в ti_cases с 0.28.0 — запись в старый ключ теряется');
  check('панель кладёт индикаторы через общую точку',
        /TICases\.addItemsToActive/.test(panelJs),
        'иначе правило «только активный кейс» существует в двух копиях');
  check('панель подключает lib/cases.js',
        /<script src="\.\.\/lib\/cases\.js"><\/script>/.test(panelHtml),
        'без него TICases не определён и кнопка падает');
}

/* ------------------------------------------------------- разбор PDF ---- */
{
  const nt = load('newtab/newtab.js');
  const html = load('newtab/newtab.html');
  const fs2 = require('fs');
  check('pdf.js лежит в пакете расширения',
        fs2.existsSync(R + 'vendor/pdfjs/pdf.min.mjs')
        && fs2.existsSync(R + 'vendor/pdfjs/pdf.worker.min.mjs'),
        'без него разбор PDF не работает, а сеть расширению запрещена');
  check('лицензия pdf.js на месте', fs2.existsSync(R + 'vendor/pdfjs/LICENSE'));
  check('шим с Promise.withResolvers подключён перед pdf.js',
        /withResolvers/.test(load('vendor/pdfjs/shim.mjs'))
        && /withResolvers/.test(load('vendor/pdfjs/worker-shim.mjs')),
        'на Firefox 115 pdf.js без него падает в первой же операции');
  check('страница подключает pdftext.js',
        /<script src="\.\.\/lib\/pdftext\.js"><\/script>/.test(html));
  check('PDF принимается полем загрузки файла', /accept="\.pdf,/.test(html));
  check('PDF опознаётся по содержимому, а не по расширению',
        /%PDF-/.test(nt), 'иначе report.pdf.txt и файл без расширения пролетают мимо');
  check('пустой результат разбора PDF не уходит молча',
        /imagesOnly/.test(nt), 'скан без текстового слоя обязан быть назван');
  /* addons-linter помечает pdf.js двумя DANGEROUS_EVAL: внутри есть путь
   * через конструктор Function. Под CSP расширения он запрещён, и без
   * isEvalSupported:false pdf.js упал бы на первом же PDF со встроенным
   * шрифтом. Однажды на этом проекте DANGEROUS_EVAL уже сочли шумом —
   * и это был настоящий дефект. Проверено прогоном под CSP: с этим
   * флагом Function недоступен, а текст извлекается. */
  check('pdf.js запущен без eval', /isEvalSupported:\s*false/.test(load('lib/pdftext.js')),
        'CSP расширения запрещает Function — без флага pdf.js упадёт');
}

/* -------------------------------------------- профили глобального поиска */
{
  const nt = load('newtab/newtab.js');
  const m = nt.match(/const SEARCH_PROFILES = \[[\s\S]*?\n\];/);
  check('профили источников на месте', !!m);
  if (m) {
    // eslint-disable-next-line no-eval
    const P = eval(m[0].replace('const SEARCH_PROFILES =', ''));
    check('шесть профилей', P.length === 6, String(P.length));
    const пустые = P.filter((p) => !p.domains || p.domains.length < 8).map((p) => p.label);
    check('в каждом профиле хотя бы восемь площадок', пустые.length === 0, пустые.join(', '));
    /* Прямой режим берёт только первые несколько площадок. Профиль,
     * у которого в этой головной части нет ни одного русскоязычного
     * источника, для российского SOC в прямом режиме бесполезен —
     * и заметить это по выдаче нельзя. */
    const RU = /\.(ru|su|рф)(\/|$)/;
    const безРусских = P.filter((p) => !p.domains.slice(0, 8).some((d) => RU.test(d)))
      .map((p) => p.label);
    check('в голове каждого профиля есть русскоязычные площадки',
          безРусских.length <= 2, 'без них: ' + безРусских.join(', '));
    const дубли = P.filter((p) => new Set(p.domains).size !== p.domains.length).map((p) => p.label);
    check('внутри профиля нет повторов', дубли.length === 0, дубли.join(', '));
  }
}

/* ------------------------------------------------ инструменты без IOC -- */
{
  const nt = load('newtab/newtab.js');
  check('клик по инструменту без индикатора открывает корень сайта',
        /new URL\(tool\.url\)\.origin/.test(nt),
        'иначе открывается обрубок вида https://www.abuseipdb.com/check/');
}

/* --------------------------------------------- манифест ссылается верно */
{
  const mf = load('manifest.json');
  const refs = new Set();
  mf.replace(/"([A-Za-z0-9_./-]+\.(?:js|html|css|png|svg|json))"/g, (_, f) => { refs.add(f); return _; });
  const нет = [...refs].filter((f) => !fs.existsSync(R + f));
  check('все файлы из manifest.json существуют', нет.length === 0, нет.join(', '));
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
