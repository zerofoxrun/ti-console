/* Сборка текста из кусков pdf.js. Запуск:
 *   node extension/lib/pdftext.test.js
 *
 * Проверяется ровно то место, где рождаются выдуманные индикаторы:
 * решение «ставить ли пробел между двумя кусками». Ошибка в любую
 * сторону молчалива:
 *   нет пробела там, где он был  → `1.1.1.1evil.com`, значения нет в тексте;
 *   пробел там, где его не было  → развалился настоящий URL, он потерян.
 *
 * Сам pdf.js здесь не нужен: textFromItems — чистая функция от массива
 * кусков. Разбор настоящего PDF проверяется браузерным прогоном
 * (tools/ui-audit), здесь — арифметика склейки.
 */
'use strict';
const P = require('./pdftext.js');
const IOC = require('./ioc.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}

/* Кусок как его отдаёт pdf.js: x в transform[4], высота шрифта в transform[3]. */
const it = (str, x, width, { h = 10, eol = false } = {}) =>
  ({ str, width, height: h, hasEOL: eol, transform: [h, 0, 0, h, x, 700] });

/* --------------------------------------------- пробел по геометрии ---- */
{
  /* Два слова рядом: зазор 4 при кегле 10 — это пробел (0,4 > 0,25). */
  const t = P.textFromItems([it('первое', 0, 30), it('второе', 34, 30)]);
  check('заметный зазор даёт пробел', t === 'первое второе', JSON.stringify(t));

  /* Кернинг внутри слова: зазор 0,5 при кегле 10 — не пробел. */
  const k = P.textFromItems([it('evil', 0, 20), it('.com', 20.5, 20)]);
  check('КЕРНИНГ НЕ ДАЁТ ПРОБЕЛА', k === 'evil.com', JSON.stringify(k));

  /* Впритык — тем более не пробел. */
  const j = P.textFromItems([it('185.220.', 0, 40), it('101.34', 40, 30)]);
  check('впритык склеивается', j === '185.220.101.34', JSON.stringify(j));
}

/* ------------------------------------------------- перенос строки ----- */
{
  const t = P.textFromItems([
    it('185.220.101.34', 0, 70, { eol: true }),
    it('evil-domain.top', 0, 60, { eol: true }),
    it('CVE-2026-1111', 0, 60),
  ]);
  check('hasEOL даёт перенос', t === '185.220.101.34\nevil-domain.top\nCVE-2026-1111',
        JSON.stringify(t));
  /* И главное: из такого текста парсер достаёт ровно три значения
   * и ничего не выдумывает — это проверка стыка двух модулей. */
  const r = IOC.extractIocs(t);
  check('ТРИ ЗНАЧЕНИЯ, НИ ОДНОГО ЛИШНЕГО', r.length === 3,
        r.map((i) => i.value).join(' | '));
}

/* --------------------------------- две колонки: Y скачет, строки нет --- */
{
  /* В двухколоночной вёрстке Y возвращается наверх на новой колонке.
   * Самодельная проверка «Y изменился — новая строка» порвала бы абзац;
   * мы опираемся на hasEOL, поэтому склейки не происходит. */
  const t = P.textFromItems([
    { str: 'конец', width: 30, height: 10, hasEOL: true, transform: [10, 0, 0, 10, 40, 100] },
    { str: 'начало', width: 30, height: 10, hasEOL: false, transform: [10, 0, 0, 10, 300, 700] },
  ]);
  check('новая колонка не склеивается со старой', t === 'конец\nначало', JSON.stringify(t));
}

/* ------------------------------------------------- край без данных ---- */
{
  check('пустой вход не роняет', P.textFromItems([]) === '');
  check('мусор не роняет', P.textFromItems(null) === '');
  /* Генераторы PDF, которые не проставляют height: масштаб берётся
   * из матрицы. Без этого зазор сравнивался бы с нулём и пробел
   * появлялся бы всегда. */
  const t = P.textFromItems([
    { str: 'evil', width: 20, height: 0, transform: [12, 0, 0, 12, 0, 0] },
    { str: '.com', width: 20, height: 0, transform: [12, 0, 0, 12, 20.5, 0] },
  ]);
  check('без height масштаб берётся из матрицы', t === 'evil.com', JSON.stringify(t));

  /* Пробел уже есть в самом куске — второй не нужен. */
  const s = P.textFromItems([it('слово ', 0, 30), it('другое', 40, 30)]);
  check('двойной пробел не ставится', s === 'слово другое', JSON.stringify(s));
}

/* ------------------------------------------------------- describe ----- */
{
  check('скан назван сканом',
        /скан/.test(P.describe({ pages: 12, pagesRead: 12, imagesOnly: true }, 'r.pdf')));
  check('о пароле сказано',
        /парол/i.test(P.describe({ encrypted: true }, 'r.pdf')));
  check('обрезка названа',
        /потолок/.test(P.describe({ pages: 900, pagesRead: 200, truncated: true }, 'r.pdf')));
  check('в обычном случае названы страницы',
        /страниц 5 из 5/.test(P.describe({ pages: 5, pagesRead: 5 }, 'r.pdf')));
  check('ошибка проходит как есть',
        P.describe({ error: 'PDF не разбирается: то-то' }, 'r.pdf').includes('то-то'));
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
