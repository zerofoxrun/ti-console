/* =============================================================================
 * pdftext.js — текст из PDF, на этой машине
 * =============================================================================
 *
 * ЗАЧЕМ
 * -----
 * Отчёты вендоров приходят PDF-ами. До этого файла «Загрузить файл» их
 * не принимал вовсе, и аналитик открывал PDF, выделял текст мышью и
 * вставлял руками — то есть терял часть текста и переносы вместе с ним.
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ: НЕ СКЛЕИТЬ ЛИШНЕГО
 * --------------------------------------
 * pdf.js отдаёт не строки, а КУСКИ: у каждого своя позиция на странице.
 * Как их соединить — решает этот файл, и решение видно в выдаче:
 *
 *   - соединить без пробела там, где он был, — получится `1.1.1.1evil.com`,
 *     то есть выдуманный индикатор в отчёте заказчику;
 *   - вставить пробел там, где его не было, — развалится настоящий URL,
 *     и он потеряется.
 *
 * Поэтому пробел ставится по ГЕОМЕТРИИ, а не «на всякий случай»: между
 * концом одного куска и началом следующего должен быть зазор. Порог —
 * доля от высоты шрифта самого куска, а не константа в пикселях: в PDF
 * координаты в единицах документа, и при 8 pt и при 24 pt «пробел»
 * выглядит по-разному.
 *
 * Перенос строки берётся из hasEOL самого pdf.js, а не вычисляется по Y:
 * в двухколоночной вёрстке Y прыгает вверх на каждой новой колонке, и
 * самодельная проверка «Y изменился — значит новая строка» рвёт абзацы
 * там, где их нет.
 *
 * ЧЕГО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ
 * ------------------------
 * Не распознаёт текст на картинках. Скан без текстового слоя вернёт
 * пусто — и об этом СКАЗАНО ВСЛУХ (`imagesOnly`), потому что «0
 * индикаторов» на сканированном бюллетене неотличимо от «их там нет».
 * Не расшифровывает PDF с паролем: `encrypted` возвращается отдельно.
 * Ничего не отправляет в сеть: pdf.js лежит в пакете расширения.
 * ========================================================================== */

'use strict';

(function initPdfText() {

/* Та же защита от повторного выполнения, что и в ioc.js: все инъекции
 * в один документ идут в одну песочницу. */
if (typeof globalThis !== 'undefined' && globalThis.TIPdf
    && typeof globalThis.TIPdf.textFromItems === 'function') return;

/* Потолки. PDF на 600 страниц существует, и разбирать его целиком
 * в интерфейсе — это минута белого экрана. Ограничение НАЗЫВАЕТСЯ
 * в результате (`truncated`), молча обрезать нельзя. */
const MAX_PAGES = 200;
const MAX_CHARS = 4_000_000;

/* Доля от высоты куска, начиная с которой зазор считается пробелом.
 * Не подобрана «на глаз»: пробел в типичных шрифтах отчётов — около
 * четверти кегля, а всё, что меньше, это кернинг внутри слова.
 * Проверяется тестом на настоящих PDF. */
const SPACE_RATIO = 0.25;

/* Высота куска не всегда приходит: у некоторых генераторов PDF в
 * textContent height = 0. Тогда за масштаб берётся модуль вертикальной
 * части матрицы преобразования — это тот же кегль. */
function itemHeight(it) {
  if (it.height > 0) return it.height;
  const t = it.transform || [];
  const a = Math.abs(t[3] || 0);
  return a > 0 ? a : Math.abs(t[0] || 0);
}

/* Сборка текста страницы из кусков pdf.js.
 *
 * Вынесена отдельной чистой функцией, чтобы её можно было проверить
 * тестом без браузера и без самого pdf.js: на вход — массив кусков,
 * на выход — строка.
 */
function textFromItems(items) {
  let out = '';
  let prev = null;
  for (const it of (items || [])) {
    const s = typeof it.str === 'string' ? it.str : '';

    if (prev !== null) {
      if (prev.hadEOL) {
        out += '\n';
      } else if (s && prev.str) {
        /* Зазор между концом предыдущего куска и началом текущего.
         * x берётся из матрицы: transform[4]. */
        const px = (prev.transform || [])[4];
        const cx = (it.transform || [])[4];
        const gap = (typeof px === 'number' && typeof cx === 'number')
          ? cx - (px + (prev.width || 0))
          : 0;
        const scale = itemHeight(it) || itemHeight(prev) || 0;
        const краяУжеСПробелом = /\s$/.test(out) || /^\s/.test(s);
        if (!краяУжеСПробелом && scale > 0 && gap > scale * SPACE_RATIO) out += ' ';
      }
    }
    out += s;
    prev = { str: s, transform: it.transform, width: it.width, height: it.height,
             hadEOL: !!it.hasEOL };
  }
  return out;
}

/* Загрузка pdf.js. Отдельно, потому что модуль весит полтора мегабайта
 * и грузить его при каждом открытии вкладки незачем: почти все разборы
 * идут по вставленному тексту. */
let pdfjsPromise = null;
function loadPdfjs(getURL) {
  if (!pdfjsPromise) {
    pdfjsPromise = import(getURL('vendor/pdfjs/shim.mjs')).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = getURL('vendor/pdfjs/worker-shim.mjs');
      return lib;
    });
  }
  return pdfjsPromise;
}

/**
 * Достать текст из PDF.
 *
 * @param {ArrayBuffer} buf         содержимое файла
 * @param {object}      opts
 * @param {function}    opts.getURL  путь к файлу расширения (browser.runtime.getURL)
 * @param {function}    [opts.onPage] (номер, всего) — для строки состояния
 * @param {number}      [opts.maxPages]
 * @returns {Promise<{text, pages, pagesRead, truncated, encrypted, imagesOnly, error}>}
 */
async function extract(buf, opts = {}) {
  const getURL = opts.getURL;
  const maxPages = opts.maxPages || MAX_PAGES;
  const пусто = { text: '', pages: 0, pagesRead: 0, truncated: false,
                  encrypted: false, imagesOnly: false, error: null };
  if (!buf || !getURL) return { ...пусто, error: 'нечего разбирать' };

  let lib;
  try {
    lib = await loadPdfjs(getURL);
  } catch (e) {
    /* Сюда попадаем, если модуль не подключился — например, сборка
     * собрана без каталога vendor. Молчать нельзя: снаружи это ровно
     * то же «ничего не нашлось». */
    return { ...пусто, error: 'модуль разбора PDF не загрузился: ' + (e.message || e) };
  }

  let doc;
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(buf),
      /* Шрифты и картинки нам не нужны — нужен текст. Отключение
       * экономит и время, и память на больших отчётах. */
      disableFontFace: true,
      isEvalSupported: false,          // CSP расширения eval запрещает
      useSystemFonts: false,
    }).promise;
  } catch (e) {
    const name = e && (e.name || '');
    if (/Password/i.test(name) || /password/i.test(String(e.message || ''))) {
      return { ...пусто, encrypted: true, error: 'PDF защищён паролем' };
    }
    return { ...пусто, error: 'PDF не разбирается: ' + (e.message || e) };
  }

  const pages = doc.numPages;
  const pagesRead = Math.min(pages, maxPages);
  const parts = [];
  let chars = 0;
  let обрезаноПоОбъёму = false;

  for (let n = 1; n <= pagesRead; n++) {
    if (opts.onPage) opts.onPage(n, pagesRead);
    let page;
    try {
      page = await doc.getPage(n);
      const content = await page.getTextContent();
      const t = textFromItems(content.items);
      chars += t.length;
      parts.push(t);
    } catch (e) {
      /* Одна битая страница не должна отменять весь отчёт, но и
       * промолчать о ней нельзя. */
      parts.push(`\n[страница ${n}: не разобралась — ${e.message || e}]\n`);
    } finally {
      if (page && page.cleanup) page.cleanup();
    }
    if (chars > MAX_CHARS) { обрезаноПоОбъёму = true; break; }
  }
  if (doc.destroy) doc.destroy();

  const text = parts.join('\n');
  return {
    text,
    pages,
    pagesRead: parts.length,
    truncated: pages > pagesRead || обрезаноПоОбъёму,
    encrypted: false,
    /* Главный честный признак: страницы прочитаны, а текста нет.
     * Значит это скан, и «0 индикаторов» здесь означает «мы не читали»,
     * а не «их там нет». */
    imagesOnly: parts.length > 0 && text.trim().length === 0,
    error: null,
  };
}

/** Человеческая строка о том, что получилось. Показывается рядом с выдачей. */
function describe(r, fileName) {
  if (!r) return '';
  const имя = fileName ? `${fileName}: ` : '';
  if (r.error) return `${имя}${r.error}`;
  if (r.encrypted) return `${имя}PDF защищён паролем — текст недоступен`;
  if (r.imagesOnly) {
    return `${имя}страниц ${r.pages}, текстового слоя нет — это скан. `
         + 'Индикаторов не будет: разобрать нечего, а не «их там нет».';
  }
  let s = `${имя}разобрано страниц ${r.pagesRead} из ${r.pages}`;
  if (r.truncated) s += ` — остальные пропущены (потолок ${MAX_PAGES} страниц)`;
  return s;
}

const API = { extract, textFromItems, describe, MAX_PAGES, MAX_CHARS, SPACE_RATIO };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.TIPdf = API;

})();
