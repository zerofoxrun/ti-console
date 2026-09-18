/* =============================================================================
 * ioc.js — ядро распознавания индикаторов компрометации
 * =============================================================================
 *
 * КАК РЕАЛИЗОВАНО
 * ---------------
 * Чистый ES-модуль без зависимостей. Один и тот же файл используется:
 *   1) страницей «Разбор IOC» (newtab);
 *   2) content-script'ом расширения-парсера страниц;
 *   3) демо-стендом (инлайном).
 * Python-зеркало этой логики живёт в backend/app/detect.py — регулярные
 * выражения там ОБЯЗАНЫ совпадать один-в-один, иначе клиент и сервер дадут
 * разный результат на одном входе. Расхождение проверяется тестом
 * backend/tests/test_parity.py (см. концепт, раздел «Верификация»).
 *
 * ПОЧЕМУ СНАЧАЛА НОРМАЛИЗАЦИЯ, ПОТОМ МАТЧИНГ
 * ------------------------------------------
 * Попытка «зашить» все варианты дефанга (hxxp, [.], (.), [dot]) прямо в
 * регулярки даёт нечитаемые выражения и комбинаторный взрыв. Поэтому текст
 * сначала приводится к канонической форме (defang -> refang), и только затем
 * применяются простые регулярки. Побочный эффект: возвращается исходная
 * (дефангованная) форма тоже — она нужна для отчётов.
 *
 * ИЗВЕСТНЫЕ ОГРАНИЧЕНИЯ (не гипотеза — проверяется тестами в tests/)
 * -----------------------------------------------------------------
 *  - 32 hex-символа неотличимы от JA3-фингерпринта -> тип md5 + флаг ambiguous.
 *  - Домены отсекаются по allow-list TLD, иначе `main.js`, `report.pdf`,
 *    `payload.dll` попадают в выдачу как домены. Список TLD неполный
 *    (top-уровень + ccTLD + основные new gTLD) — редкие TLD будут пропущены.
 *  - Версии ПО вида 8.19.2 не матчатся как IPv4 (не 4 октета), но 1.2.3.4
 *    матчится всегда — это принципиально неразрешимо без контекста,
 *    поэтому такие адреса помечаются флагом `suspiciousVersionLike`.
 *
 * ПОВТОРНАЯ ИНЪЕКЦИЯ В СТРАНИЦУ — ЗАЧЕМ ОБЁРТКА НИЖЕ
 * ---------------------------------------------------
 * Этот файл внедряется в разбираемую страницу вместе с content/scan.js.
 * Все инъекции расширения в один документ выполняются в ОДНОЙ песочнице,
 * поэтому второй вызов executeScript выполняет файл повторно — в том же
 * глобальном окружении, где уже объявлены const'ы первого выполнения.
 *
 * Результат: SyntaxError «Identifier 'REFANG_RULES' has already been
 * declared», инъекция обрывается, content/scan.js не запускается.
 * Снаружи это выглядело так: «разобрать всю страницу» срабатывает ОДИН
 * РАЗ после загрузки страницы, а дальше кнопка и пункт меню молчат.
 * Ошибка при этом уходила в тост консоли — то есть в другую вкладку,
 * не ту, на которую человек смотрит.
 *
 * Поэтому модуль обёрнут в функцию и при повторном выполнении выходит
 * сразу. scan.js такую защиту имел с самого начала (__tiConsoleScanned),
 * а ядро — нет.
 *
 * Тело функции НАМЕРЕННО оставлено на прежнем уровне отступа: сдвиг
 * на два пробела изменил бы все 500 строк и спрятал бы содержательные
 * правки в шуме при следующем ревью. Обёртка — три строки сверху
 * и две снизу.
 * ========================================================================== */

'use strict';

(function initIocModule() {

// Повторное выполнение в той же песочнице: модуль уже собран, выходим.
if (typeof globalThis !== 'undefined' && globalThis.IOC
    && typeof globalThis.IOC.extractIocs === 'function') return;

/* --------------------------------------------------------------------------
 * 1. Refang: приведение дефангованных индикаторов к каноническому виду.
 *    Порядок замен важен: сначала схемы, потом разделители.
 * ------------------------------------------------------------------------ */
/* Единой нотации дефанга не существует: каждый вендор обезвреживает
 * индикаторы по-своему, а аналитики поверх этого правят руками. Список
 * собран по тому, что реально встречается в отчётах.
 *
 * Правила применяются по порядку, поэтому схемы идут первыми: иначе
 * правило точки успеет съесть скобки внутри hxxps[://]. */
const REFANG_RULES = [
  // --- схемы --------------------------------------------------------
  // hxxp, hXXps, h**p, h_ttp, h-ttp, htxp, hxtp — искажают любую букву
  [/\bh[\-_xX*]{1,2}t?t?p(s?)\s*(?::|\[:\]|\(:\)|\[:\/\/\]|\(:\/\/\))\s*(?:\/\/|\[\/\/\]|\[\/\]\[\/\]|)/gi, 'http$1://'],
  [/\bht[\-_xX*]p(s?)\s*(?::\/\/|\[:\/\/\])/gi, 'http$1://'],
  // «hxxps[://]» и «https[://]» — скобка вокруг всего разделителя
  [/\b(https?)\s*\[\s*:\s*\/\s*\/\s*\]\s*/gi, '$1://'],
  [/\b(https?)\s*[\[\(]\s*:\s*[\]\)]\s*\/\//gi, '$1://'],
  [/\bmeow(s?):\/\//gi, 'http$1://'],
  [/\bfxp:\/\//gi, 'ftp://'],
  // --- точка --------------------------------------------------------
  [/\s*[\[\(\{<]\s*\.\s*[\]\)\}>]\s*/g, '.'],
  [/\s*[\[\(\{<]\s*(?:dot|DOT|точка|ТОЧКА)\s*[\]\)\}>]\s*/gi, '.'],
  // Юникодные точки: попадают при копировании из азиатских источников
  // и используются как дефанг. Выглядят как точка, ею не являются.
  [/[\u3002\uFF0E\uFF61\u06D4\u2024]/g, '.'],
  // Экранированная точка из regex-подобных выгрузок
  [/\\\./g, '.'],
  // --- @ ------------------------------------------------------------
  [/\s*[\[\(\{<]\s*(?:@|at|AT|собака)\s*[\]\)\}>]\s*/g, '@'],
  [/[\uFF20]/g, '@'],
  // --- двоеточие и слэши ---------------------------------------------
  [/\s*[\[\(\{<]\s*:\s*[\]\)\}>]\s*/g, ':'],
  [/\s*[\[\(\{<]\s*\/\/\s*[\]\)\}>]\s*/g, '//'],
  [/\s*[\[\(\{<]\s*\/\s*[\]\)\}>]\s*/g, '/'],
];

/* Бесскобочные написания: «evil dot com», «user at evil dot com».
 *
 * ВЫНЕСЕНЫ ОТДЕЛЬНО И ПРИМЕНЯЮТСЯ ВТОРЫМ ПРОХОДОМ — намеренно.
 * На обычном тексте слово «dot» между словами встречается само по себе
 * («the dot com bubble» даёт «the.com»), а «at» встречается постоянно.
 * Поэтому: результаты второго прохода помечаются флагом
 * ambiguous:refang и видны аналитику как догадка, а не как факт.
 *
 * Не делать этого вовсе тоже нельзя: отчёты с такой нотацией
 * существуют, и молча их пропускать — терять индикаторы. */
const REFANG_LOOSE_RULES = [
  /* «at» словом раскрывается ТОЛЬКО вместе со словом «dot», и правило
   * стоит ПЕРВЫМ — до того, как «dot» превратится в обычную точку.
   *
   * Отдельное правило `\s+at\s+` -> `@` брало обычную английскую прозу:
   * «(mirrored at link72[.]com/d/pkg.bin)» давало адрес
   * `mirrored@link72.com`, которого не существует. «hosted at»,
   * «available at», «served at» — то же самое, а это половина
   * предложений в отчёте.
   *
   * Смысл правила — развернуть запись «user at evil dot com», то есть
   * конвенцию целиком. Если точка в тексте настоящая, значит записи
   * такой нет, и «at» там предлог. Пометка ambiguous:refang остаётся:
   * раскрытие всё равно догадка, просто теперь обоснованная. */
  [/\b([A-Za-z0-9._%+-]+)\s+(?:at|AT|собака)\s+([A-Za-z0-9-]+(?:\s+(?:dot|DOT|точка)\s+[A-Za-z0-9-]+)+)/g,
    (m, l, h) => `${l}@${h.replace(/\s+(?:dot|DOT|точка)\s+/g, '.')}`],
  [/\s+(?:dot|DOT|точка)\s+/g, '.'],
  // «evil . com» — точка с пробелами по бокам. Только между непробельными
  // токенами; фильтр по TLD отсечёт разорванные предложения.
  [/(?<=[A-Za-z0-9])\s+\.\s+(?=[A-Za-z0-9])/g, '.'],
];

/* ============================ СКЛЕЙКА ЗНАЧЕНИЙ, РАЗОРВАННЫХ ПЕРЕНОСОМ ===
 *
 * Копирование из PDF и Word рвёт длинные значения по ширине колонки:
 *
 *     ccfc37014ce6183bb9268e15e8569fc8
 *     70e3ccc1123fc2fac9cf43862369f335
 *
 * Это ОДИН sha256, но парсер видит два коротких hex-огрызка и не находит
 * ни одного индикатора. Снаружи это неотличимо от честного «их там нет» —
 * тот же класс тихого пропуска, что «0 индикаторов» на JS-странице.
 *
 * ПОЧЕМУ СКЛЕЙКА КОНСЕРВАТИВНАЯ. Склеить можно что угодно и получить
 * правдоподобный мусор, а выдуманный индикатор в отчёте клиенту хуже
 * пропущенного. Поэтому склейка hex выполняется ТОЛЬКО если результат
 * имеет ровно длину настоящего хеша (32, 40, 64, 128), а склейка URL —
 * только если первая строка содержит схему и обрывается без пробела,
 * а вторая похожа на продолжение пути, а не на начало предложения.
 *
 * Найденное этим проходом помечается флагом `ambiguous:wrap`: это
 * догадка о вёрстке исходного документа, а не факт о тексте.
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ: СПИСОК — НЕ ПЕРЕНОС.
 *
 * Самый частый вход этого расширения — столбик индикаторов по одному
 * на строку. Первая версия склейки его не отличала от переноса и на
 *
 *     https://evil.example/panel/gate.php
 *     d41d8cd98f00b204e9800998ecf8427e
 *     CVE-2025-31324
 *
 * выдавала четвёртым индикатором `...gate.phpd41d8...CVE-2025-31324` —
 * значение, которого в тексте нет, на самом обычном вводе. Поймано
 * сплошным прогоном интерфейса, тестами — нет: в корпусе был перенос,
 * но не было списка.
 *
 * Отсюда правило: склеивать нечего, если правая строка сама по себе —
 * законченное значение. У переноса правая строка ВСЕГДА обрывок
 * (`gate.php?id=1&`, `/download/payload.exe`), а не индикатор.
 * ==================================================================== */

const HASH_LENGTHS = new Set([32, 40, 64, 128]);

/* Колонтитул между значением и его продолжением — см. furnitureCensus.
 *   FURNITURE_LINE_MAX    длина строки-штампа: номер страницы, дата,
 *                         идентификатор выпуска. Порог с запасом, но
 *                         заведомо меньше осмысленного хвоста URL.
 *   FURNITURE_MIN_REPEATS та же граница, что у hexCensus: два вхождения
 *                         ещё случайность, три — форма документа.
 *   FURNITURE_SKIP_MAX    сколько строк подряд разрешено перешагнуть.
 *                         Колонтитул — одна-две строки; больше означает,
 *                         что мы уже не в переносе, а в другом разделе. */
const FURNITURE_LINE_MAX = 24;
const FURNITURE_MIN_REPEATS = 3;
const FURNITURE_SKIP_MAX = 2;

/* Строка целиком — один законченный индикатор?
 * Проверяется по тем же спискам, что и основной разбор (в частности,
 * по allow-list TLD), иначе `gate.php` сошёл бы за домен и починка
 * сломала бы честный перенос URL. */
function isCompleteValue(s) {
  const v = String(s).trim();
  if (!v) return false;
  if (/^[0-9a-fA-F]+$/.test(v) && HASH_LENGTHS.has(v.length)) return true;
  if (/^CVE-\d{4}-\d{4,7}$/i.test(v)) return true;
  if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/.test(v)) return !!domainTld(v.split('@').pop());
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) return true;
  if (/^[0-9a-fA-F:]{6,}$/.test(v) && v.includes('::')) return true;   // IPv6
  if (/^(?:https?|hxxps?|ftp):\/\//i.test(v)) return true;
  if (/^[A-Za-z0-9.-]+$/.test(v) && v.includes('.')) return !!domainTld(v);
  return false;
}

function joinWrappedDetailed(text) {
  const lines = String(text || '').split(/\r?\n/);

  /* Перепись строк-«ровно один hex длиной N». Одно значение, разорванное
   * переносом, даёт РОВНО две такие строки. Третья означает, что это не
   * случайность вёрстки, а форма всего документа, то есть список хешей.
   * Граница «три» здесь не подобранная константа, а минимум, которого
   * перенос одного значения дать не может. */
  const hexCensus = new Map();
  for (const ln of lines) {
    const t = ln.trim();
    if (/^[0-9a-fA-F]{8,}$/.test(t)) hexCensus.set(t.length, (hexCensus.get(t.length) || 0) + 1);
  }

  /* Перепись коротких строк, повторяющихся по всему документу.
   *
   * Между разорванным значением и его продолжением может лежать
   * КОЛОНТИТУЛ. В отчёте заказчика так и было:
   *
   *     https://vendor.example/blog/from-ads-to-full-device-
   *                                        -01
   *       takeover-analysis-part-two    -01
   *
   * Склейка брала соседнюю строку, то есть штамп «-01», и выдавала
   * `...full-device--01` — адрес, которого не существует. Настоящий
   * хвост оставался строкой ниже и терялся.
   *
   * Отличить штамп от продолжения по одной строке нельзя — только по
   * документу: продолжение переноса уникально, штамп повторяется.
   * Граница «три» та же, что у hexCensus: два вхождения ещё могут быть
   * совпадением, три — уже форма документа. */
  const furnitureCensus = new Map();
  for (const ln of lines) {
    const t = ln.trim();
    if (t && t.length <= FURNITURE_LINE_MAX) furnitureCensus.set(t, (furnitureCensus.get(t) || 0) + 1);
  }
  const isFurniture = (t) => {
    if (!t || t.length > FURNITURE_LINE_MAX) return false;
    if ((furnitureCensus.get(t) || 0) < FURNITURE_MIN_REPEATS) return false;
    // Повторяющийся индикатор — не колонтитул: один и тот же адрес
    // на каждой странице отчёта остаётся адресом.
    return !isCompleteValue(t);
  };
  const isFurnitureLine = (ln) => isFurniture(String(ln).trim());

  /* Тот же штамп бывает не отдельной строкой, а ПРИСТАВЛЕННЫМ СПРАВА
   * в соседней колонке:
   *
   *       takeover-analysis-part-two           -01
   *
   * Для склейки это фатально: правая строка обязана быть одним токеном,
   * а здесь их два, и перенос не восстанавливается — URL остаётся
   * обрезанным. Обрезанный адрес не лучше выдуманного: он тоже
   * не существует.
   *
   * Снимаем только то, что уже опознано как штамп по всему документу,
   * и только за разрывом в два и более пробела — то есть за границей
   * колонки, а не за обычным пробелом внутри текста. */
  const stripFurnitureTail = (ln) => {
    const m = /^(.*?\S)\s{2,}(\S+)\s*$/.exec(String(ln));
    return m && isFurniture(m[2]) ? m[1] : ln;
  };

  const out = [];
  /* Для каждой СКЛЕЕННОЙ строки запоминаем, из чего она собрана.
   *
   * Без этого пометка `ambiguous:wrap` — тупик: аналитик видит «это
   * догадка» и не может её проверить, потому что исходника под рукой
   * может уже не быть (текст вставлен из буфера). Поэтому склейка
   * обязана уметь показать обе формы: как было в тексте и что из этого
   * получилось. Решение остаётся за человеком, но теперь оно основано
   * на том, что он видит, а не на доверии к парсеру. */
  const joins = [];
  for (let i = 0; i < lines.length; i++) {
    let cur = lines[i];
    const parts = [lines[i]];
    // Склеиваем цепочкой: хеш может быть разорван и на три строки.
    while (i + 1 < lines.length) {
      /* Перешагиваем колонтитулы между значением и его продолжением.
       * Пропущенные строки попадают в parts: аналитик обязан видеть,
       * ЧТО именно было перешагнуто, иначе склейка снова становится
       * непроверяемой догадкой. */
      let j = i + 1;
      const пропущено = [];
      while (j < lines.length && пропущено.length < FURNITURE_SKIP_MAX && isFurnitureLine(lines[j])) {
        пропущено.push(lines[j]);
        j++;
      }
      if (j >= lines.length) break;
      const next = stripFurnitureTail(lines[j]);
      const joined = tryJoin(cur, next, hexCensus);
      if (joined === null) break;
      cur = joined;
      // В parts — ИСХОДНЫЕ строки, а не очищенные: показывать аналитику
      // надо то, что было в документе.
      parts.push(...пропущено, lines[j]);
      i = j;
    }
    if (parts.length > 1) joins.push({ joined: cur, parts });
    out.push(cur);
  }
  return { text: out.join('\n'), joins };
}

/** Публичная форма: только текст. Зеркало в detect.py возвращает то же. */
function joinWrapped(text) { return joinWrappedDetailed(text).text; }

/* ---------------------------------------------- обрезки от переноса ----
 * Строгий проход идёт по ИСХОДНОМУ тексту и видит обрывок значения,
 * оборванный переносом, как законченное значение. Проход по склейке
 * потом находит целое. В выдаче оказываются оба — и обрывок БЕЗ ПОМЕТКИ,
 * то есть выглядящий фактом.
 *
 * Поймано на отчёте заказчика. В тексте:
 *
 *     https://vendor.example/blog/from-ads-to-full-device-
 *     takeover-analysis-part-two
 *
 * Выдача содержала строкой выше обрезанный адрес без флагов, а ниже —
 * склеенный с пометкой `ambiguous:wrap`. Аналитик, взявший первый,
 * пошёл бы проверять адрес, которого не существует. Это тот же класс
 * дефекта, что и выдуманный индикатор: парсер утверждает то, чего
 * в документе нет.
 *
 * Обрывок НЕ теряется: он виден в двух формах у склеенного значения
 * (`wrapSource` — «как в исходнике» и «как склеено»).
 *
 * Условие снятия узкое: тот же тип, значение — префикс склеенного,
 * и обрывок стоит В КОНЦЕ первой строки склейки. Последнее важно:
 * без него можно снять законный короткий адрес, случайно оказавшийся
 * префиксом длинного.
 * --------------------------------------------------------------------- */
function dropWrapFragments(list, joins) {
  if (!Array.isArray(list) || !joins || !joins.length) return list;

  const целые = list.filter((i) => (i.flags || []).includes('ambiguous:wrap'));
  if (!целые.length) return list;

  const снять = new Set();
  for (const whole of целые) {
    const parts = whole.wrapSource || wrapSourceOf(joins, whole.value);
    if (!parts || !parts.length) continue;
    const перваяСтрока = String(parts[0]).trimEnd().toLowerCase();
    const целоеЗнач = String(whole.value).toLowerCase();

    for (const other of list) {
      if (other === whole || other.type !== whole.type) continue;
      const v = String(other.value).toLowerCase();
      if (v.length >= целоеЗнач.length) continue;
      if (!целоеЗнач.startsWith(v)) continue;
      if (!перваяСтрока.endsWith(v)) continue;
      снять.add(other);
    }
  }
  const осталось = снять.size ? list.filter((i) => !снять.has(i)) : list;

  /* Обрывки ДРУГОГО типа снимать нельзя.
   *
   * Два MD5 на соседних строках — это либо один разорванный SHA-256,
   * либо честный список из двух хешей. Отличить нечем, и убрать половины
   * значило бы спрятать настоящие индикаторы. Но и молчать нельзя:
   * аналитик видит три значения там, где в документе могло быть одно.
   *
   * Поэтому они остаются, но с пометкой: «это ровно одна из строк,
   * из которых собрано склеенное значение». Дальше решает человек. */
  for (const whole of целые) {
    const parts = whole.wrapSource || wrapSourceOf(joins, whole.value);
    if (!parts || !parts.length) continue;
    const строки = new Set(parts.map((p) => String(p).trim().toLowerCase()));
    for (const other of осталось) {
      if (other === whole) continue;
      if (!строки.has(String(other.value).toLowerCase())) continue;
      const f = other.flags || (other.flags = []);
      if (!f.includes('ambiguous:wrap-part')) f.push('ambiguous:wrap-part');
    }
  }
  return осталось;
}

/** Из какой пары строк собралось значение. null, если ни из какой. */
function wrapSourceOf(joins, value) {
  const v = String(value || '');
  if (!v) return null;
  for (const j of (joins || [])) {
    /* Значение может быть как целой склеенной строкой, так и её частью
     * (в строке мог быть текст вокруг). Сравниваем в обе стороны. */
    if (j.joined.includes(v) || v.includes(j.joined)) return j.parts.slice();
  }
  return null;
}

function tryJoin(a, b, hexCensus) {
  const left = a.trimEnd();
  const right = b.trimStart();
  if (!left || !right) return null;

  // 1. Шестнадцатеричные куски, дающие ровно длину хеша.
  const mL = left.match(/([0-9a-fA-F]{8,})$/);
  const mR = right.match(/^([0-9a-fA-F]{8,})/);
  if (mL && mR) {
    const total = mL[1].length + mR[1].length;
    // Хвост правой строки после hex-части должен быть пустым или
    // разделителем: иначе это два разных значения в таблице.
    const tail = right.slice(mR[1].length);
    // Столбик из трёх и более строк одной hex-длины — список, не перенос.
    const списком = hexCensus
      && (hexCensus.get(mR[1].length) || 0) >= 3
      && right.trim().length === mR[1].length;

    /* ОБЕ ЧАСТИ — САМИ ПО СЕБЕ ХЕШИ. Это список, а не перенос.
     *
     * Два MD5 на соседних строках — обычная форма раздела индикаторов
     * у Securelist, Unit 42 и почти всех остальных:
     *
     *     7A95360B7E0EB5B107A3D231ABBC541A
     *     C0D1EAA15A2CEFBAB9735787575C8D8E
     *
     * 32 + 32 = 64, то есть ровно длина SHA-256, и склейка выдавала
     * третий хеш, которого не существует ни в одном отчёте. Правило
     * «три строки одной длины — список» его не ловило: строк было две.
     *
     * Признак переноса — ПРОИЗВОЛЬНАЯ длина обрывков. В бюллетене
     * заказчик разорванный SHA-256 дал 45 + 19 символов, а не 32 + 32:
     * перенос рвёт значение там, где кончилась ширина колонки, а не
     * по границе другого алгоритма. Если же обе части сами по себе
     * законной длины — перед нами два значения, а не одно. */
    const обеЧастиХеши = HASH_LENGTHS.has(mL[1].length) && HASH_LENGTHS.has(mR[1].length);

    if (!списком && !обеЧастиХеши && HASH_LENGTHS.has(total) && /^[\s.,;)\]]*$/.test(tail)) {
      return left.slice(0, left.length - mL[1].length) + mL[1] + right;
    }
  }

  // 2. Продолжение URL. Требуется схема слева, отсутствие пробелов
  //    справа и непохожесть правой строки на начало предложения.
  if (/https?:\/\/\S+$/.test(left) || /hxxps?:\/\/\S+$/i.test(left)) {
    /* Правая строка должна быть ОБРЫВКОМ: одним токеном, без своей схемы
     * и не законченным значением. Без этих трёх условий склеивался любой
     * столбик индикаторов — см. шапку раздела. */
    if (/\s/.test(right.trim())) return null;
    if (/^(?:https?|hxxps?|ftp):\/\//i.test(right)) return null;
    if (isCompleteValue(right)) return null;
    const cont = right.match(/^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{2,}/);
    if (cont && !/\s/.test(cont[0])) {
      /* Служебное слово считается прозой, только если за ним ПРОБЕЛ.
       *
       * Было `\b`, и оно срабатывало на дефисе. В отчёте заказчика
       * от 11.09.2026 хвост адреса начинался со слова the:
       *
       *     https://vendor.example/2026/the-shared-cache-inside-
       *                                          -01
       *       the-sandbox-part-two/
       *
       * Продолжение было объявлено прозой, склейка не состоялась,
       * и в выдачу ушёл обрезанный адрес — которого не существует.
       * Обрезанный адрес не лучше выдуманного.
       *
       * В прозе за словом идёт пробел; в слаге адреса — дефис. */
      const looksLikeProse = /^[A-ZА-ЯЁ][a-zа-яё]{2,}\s/.test(right)
        || /^(?:и|в|на|по|the|and|for)\s/i.test(right);
      const leftEndsSentence = /[.!?][)\]]?$/.test(left) && !/\/[.]?$/.test(left);
      if (!looksLikeProse && !leftEndsSentence) {
        return left + right;
      }
    }
  }
  return null;
}

/* ================================ ГОМОГЛИФЫ И СМЕШАННЫЕ АЛФАВИТЫ ======
 *
 * `аpple.com` с кириллической «а» в отчёте выглядит настоящим доменом.
 * В адресной строке это закрыто политикой network.IDN_show_punycode,
 * а в разбираемом ТЕКСТЕ ничем не закрыто.
 *
 * Два разных признака, и путать их нельзя:
 *   homograph   — внутри ОДНОЙ метки смешаны алфавиты (`аpple`).
 *                 Легитимных причин так писать практически нет.
 *   idn:mixed   — метка не латиницей, а зона латинская (`сбербанк.com`).
 *                 Бывает и законно, но посмотреть стоит.
 *   idn:puny    — метка уже в виде `xn--`: значение читается не глазами.
 *
 * Это ФЛАГИ, а не отсев: домен из выдачи не исчезает.
 * ==================================================================== */

const SCRIPT_TESTS = [
  ['latin', /[A-Za-z]/],
  ['cyrillic', /[\u0400-\u04FF]/],
  ['greek', /[\u0370-\u03FF]/],
  ['armenian', /[\u0530-\u058F]/],
];

function scriptsOf(label) {
  const out = [];
  for (const [name, re] of SCRIPT_TESTS) if (re.test(label)) out.push(name);
  return out;
}

/** Флаги для доменного имени. Пустой массив — вопросов нет. */
function homographFlags(domain) {
  const flags = [];
  const labels = String(domain || '').split('.');
  if (!labels.length) return flags;
  const tld = labels[labels.length - 1] || '';

  for (const label of labels) {
    if (/^xn--/i.test(label)) { if (!flags.includes('idn:puny')) flags.push('idn:puny'); continue; }
    const scripts = scriptsOf(label);
    if (scripts.length > 1 && !flags.includes('homograph')) flags.push('homograph');
  }
  // Зона латиницей, а имя — нет. Кириллический домен живёт в .рф,
  // и в .com он как минимум требует взгляда.
  const tldLatin = /^[A-Za-z]+$/.test(tld);
  const bodyNonLatin = labels.slice(0, -1).some((l) => !/^xn--/i.test(l)
    && scriptsOf(l).some((s) => s !== 'latin'));
  if (tldLatin && bodyNonLatin && !flags.includes('homograph')) flags.push('idn:mixed');
  return flags;
}

/* Обратная операция к refang: сделать значение некликабельным.
 *
 * Нужна на выходе, а не на входе: индикаторы уходят в тикеты, письма
 * и чаты, где по ссылке кликают не глядя. Дефанг — единственное, что
 * этому мешает, и делать его руками аналитик забывает. */
function defang(value) {
  return String(value == null ? '' : value)
    .replace(/^http(s?):\/\//i, (m, s) => `hxxp${s}://`)
    .replace(/^ftp:\/\//i, 'fxp://')
    .replace(/\./g, '[.]')
    .replace(/@/g, '[@]');
}

function refangLoose(text) {
  let out = refang(text);
  for (const [re, to] of REFANG_LOOSE_RULES) out = out.replace(re, to);
  return out;
}

function refang(text) {
  let out = String(text);
  for (const [re, repl] of REFANG_RULES) out = out.replace(re, repl);
  return out;
}

/* --------------------------------------------------------------------------
 * 2. TLD allow-list. Нужен только для типа `domain`.
 *
 *    СПИСОК СГЕНЕРИРОВАН, руками не править: tools/update_tlds.py берёт
 *    секцию ICANN из Public Suffix List. Зеркало — backend/app/detect.py,
 *    совпадение проверяется backend/tests/test_parity.py.
 *
 *    До 0.40.0 список был написан руками и содержал около двухсот зон
 *    из полутора тысяч. Индикатор с TLD не из списка не просто
 *    отбраковывался — он ПРОПАДАЛ, и сообщить об этом было нечем:
 *    в выдаче на одну строку меньше, и всё. В отчёте заказчика так
 *    потерялся `api.gitpanel2v[.]bet`, помеченный дефангом самим автором
 *    отчёта, то есть прямо названный индикатором.
 *
 *    Рукописный список смещён предсказуемо: в нём есть респектабельные
 *    зоны и нет дешёвых новых gTLD (.bet, .icu, .cfd, .sbs, .cyou,
 *    .buzz, .quest) — то есть ровно тех, на которых живёт вредоносная
 *    инфраструктура.
 * ------------------------------------------------------------------------ */
/* СПИСОК TLD НАЧАЛО */
const TLDS = new Set(`
aaa aarp abarth abb abbott abbvie abc able abogado abudhabi ac ac.id ac.uk academy accenture
accountant accountants aco actor ad adac ads adult ae aeg aero aetna af afamilycompany afl
africa ag agakhan agency ai aig aigo airbus airforce airtel akdn al alfaromeo alibaba alipay
allfinanz allstate ally alsace alstom am amazon americanexpress americanfamily amex amfam
amica amsterdam analytics android anquan anz ao aol apartments app apple aq aquarelle ar
arab aramco archi army arpa art arte as asda asia associates at athleta attorney au auction
audi audible audio auspost author auto autos avianca aw aws ax axa az azure ba baby baidu
banamex bananarepublic band bank bar barcelona barclaycard barclays barefoot bargains
baseball basketball bauhaus bayern bb bbc bbt bbva bcg bcn bd be beats beauty beer bentley
berlin best bestbuy bet bf bg bh bharti bi bible bid bike bing bingo bio biz biz.id bj black
blackfriday blockbuster blog bloomberg blue bm bms bmw bn bnpparibas bo boats boehringer
bofa bom bond boo book booking bosch bostik boston bot boutique box br bradesco bridgestone
broadway broker brother brussels bs bt budapest bugatti build builders business buy buzz bv
bw by bz bzh ca cab cafe cal call calvinklein cam camera camp cancerresearch canon capetown
capital capitalone car caravan cards care career careers cars casa case caseih cash casino
cat catering catholic cba cbn cbre cbs cc cd ceb center ceo cern cf cfa cfd cg ch chanel
channel charity chase chat cheap chintai christmas chrome church ci cipriani circle cisco
citadel citi citic city cityeats ck cl claims cleaning click clinic clinique clothing cloud
club clubmed cm cn co co.id co.il co.in co.jp co.kr co.nz co.uk co.za coach codes coffee
college cologne com com.ar com.au com.br com.cn com.hk com.mx com.ru com.sg com.tr com.tw
com.ua comcast commbank community company compare computer comsec condos construction
consulting contact contractors cooking cookingchannel cool coop corsica country coupon
coupons courses cpa cr credit creditcard creditunion cricket crown crs cruise cruises csc cu
cuisinella cv cw cx cy cymru cyou cz dabur dad dance data date dating datsun day dclk dds de
deal dealer deals degree delivery dell deloitte delta democrat dental dentist desi design
dev dhl diamonds diet digital direct directory discount discover dish diy dj dk dm dnp do
docs doctor dog domains dot download drive dtv dubai duck dunlop dupont durban dvag dvr dz
earth eat ec eco edeka edu education ee eg email emerck energy engineer engineering
enterprises epson equipment er ericsson erni es esq estate esurance et etisalat eu
eurovision eus events exchange expert exposed express extraspace fage fail fairwinds faith
family fan fans farm farmers fashion fast fedex feedback ferrari ferrero fi fiat fidelity
fido film final finance financial fire firestone firmdale fish fishing fit fitness fj fk
flickr flights flir florist flowers fly fm fo foo food foodnetwork football ford forex
forsale forum foundation fox fr free fresenius frl frogans frontdoor frontier ftr fujitsu
fujixerox fun fund furniture futbol fyi ga gal gallery gallo gallup game games gap garden
gay gb gbiz gd gdn ge gea gent genting george gf gg ggee gh gi gift gifts gives giving gl
glade glass gle global globo gm gmail gmbh gmo gmx gn go.id godaddy gold goldpoint golf goo
goodyear goog google gop got gov gov.uk gp gq gr grainger graphics gratis green gripe
grocery group gs gt gu guardian gucci guge guide guitars guru gw gy hair hamburg hangout
haus hbo hdfc hdfcbank health healthcare help helsinki here hermes hgtv hiphop hisamitsu
hitachi hiv hk hkt hm hn hockey holdings holiday homedepot homegoods homes homesense honda
horse hospital host hosting hot hoteles hotels hotmail house how hr hsbc ht hu hughes hyatt
hyundai ibm icbc ice icu id ie ieee ifm ikano il im imamat imdb immo immobilien in inc
industries infiniti info ing ink institute insurance insure int intel international intuit
investments io ipiranga iq ir irish is ismaili ist istanbul it itau itv iveco jaguar java
jcb jcp je jeep jetzt jewelry jio jll jm jmp jnj jo jobs joburg jot joy jp jpmorgan jprs
juegos juniper kaufen kddi ke kerryhotels kerrylogistics kerryproperties kfh kg kh ki kia
kim kinder kindle kitchen kiwi km kn koeln komatsu kosher kp kpmg kpn kr krd kred kuokgroup
kw ky kyoto kz la lacaixa lamborghini lamer lancaster lancia land landrover lanxess lasalle
lat latino latrobe law lawyer lb lc lds lease leclerc lefrak legal lego lexus lgbt li
liaison lidl life lifeinsurance lifestyle lighting like lilly limited limo lincoln linde
link lipsy live living lixil lk llc llp loan loans locker locus loft lol london lotte lotto
love lpl lplfinancial lr ls lt ltd ltda lu lundbeck lupin luxe luxury lv ly ma macys madrid
maif maison makeup man management mango map market marketing markets marriott marshalls
maserati mattel mba mc mckinsey md me med media meet melbourne meme memorial men menu
merckmsd metlife mg mh miami microsoft mil mini mint mit mitsubishi mk ml mlb mls mm mma mn
mo mobi mobile moda moe moi mom monash money monster mormon mortgage moscow moto motorcycles
mov movie movistar mp mq mr ms msd msk.ru mt mtn mtr mu museum mutual mv mw mx my mz na nab
nadex nagoya name nationwide natura navy nba nc ne nec net net.ru netbank netflix network
neustar new newholland news next nextdirect nexus nf nfl ng ngo nhk ni nico nike nikon ninja
nissan nissay nl no nokia northwesternmutual norton now nowruz nowtv np nr nra nrw ntt nu
nyc nz obi observer off office okinawa olayan olayangroup oldnavy ollo om omega one ong onl
online onyourside ooo open or.id oracle orange org org.ru org.uk organic origins osaka
otsuka ott ovh pa page panasonic paris pars partners parts party passagens pay pccw pe pet
pf pfizer pg ph pharmacy phd philips phone photo photography photos physio pics pictet
pictures pid pin ping pink pioneer pizza pk pl place play playstation plumbing plus pm pn
pnc pohl poker politie porn post pr pramerica praxi press prime pro prod productions prof
progressive promo properties property protection pru prudential ps pt pub pw pwc py qa qpon
quebec quest qvc racing radio raid re read realestate realtor realty recipes red redstone
redumbrella rehab reise reisen reit reliance ren rent rentals repair report republican rest
restaurant review reviews rexroth rich richardli ricoh rightathome ril rio rip rmit ro
rocher rocks rodeo rogers room rs rsvp ru rugby ruhr run rw rwe ryukyu sa saarland safe
safety sakura sale salon samsclub samsung sandvik sandvikcoromant sanofi sap sarl sas save
saxo sb sbi sbs sc sca scb schaeffler schmidt scholarships school schule schwarz science
scjohnson scor scot sd se search seat secure security seek select sener services ses seven
sew sex sexy sfr sg sh shangrila sharp shaw shell shia shiksha shoes shop shopping shouji
show showtime shriram si silk sina singles site sj sk ski skin sky skype sl sling sm smart
smile sn sncf so soccer social softbank software sohu solar solutions song sony soy spa
space spb.ru sport spot spreadbetting sr srl ss st stada staples star statebank statefarm
stc stcgroup stockholm storage store stream studio study style su sucks supplies supply
support surf surgery suzuki sv swatch swiftcover swiss sx sy sydney symantec systems sz tab
taipei talk taobao target tatamotors tatar tattoo tax taxi tc tci td tdk team tech
technology tel telefonica temasek tennis teva tf tg th thd theater theatre tiaa tickets
tienda tiffany tips tires tirol tj tjmaxx tjx tk tkmaxx tl tm tmall tn to today tokyo tools
top toray toshiba total tours town toyota toys tr trade trading training travel
travelchannel travelers travelersinsurance trust trv tt tube tui tunes tushu tv tvs tw tz ua
ubank ubs ug uk unicom university uno uol ups us uy uz va vacations vana vanguard vc ve
vegas ventures verisign vermögensberater vermögensberatung versicherung vet vg vi viajes
video vig viking villas vin vip virgin visa vision vistaprint viva vivo vlaanderen vn vodka
volkswagen volvo vote voting voto voyage vu vuelos wales walmart walter wang wanggou watch
watches weather weatherchannel webcam weber website wed wedding weibo weir wf whoswho wien
wiki williamhill win windows wine winners wme wolterskluwer woodside work works world wow ws
wtc wtf xbox xerox xfinity xihuan xin xn--11b4c3d xn--1ck2e1b xn--1qqw23a xn--2scrj9c
xn--30rr7y xn--3bst00m xn--3ds443g xn--3e0b707e xn--3hcrj9c xn--3oq18vl8pn36a xn--3pxu8k
xn--42c2d9a xn--45br5cyl xn--45brj9c xn--45q11c xn--4gbrim xn--54b7fta0cc xn--55qw42g
xn--55qx5d xn--5su34j936bgsg xn--5tzm5g xn--6frz82g xn--6qq986b3xl xn--80adxhks xn--80ao21a
xn--80aqecdr1a xn--80asehdb xn--80aswg xn--8y0a063a xn--90a3ac xn--90ae xn--90ais xn--9dbq2a
xn--9et52u xn--9krt00a xn--b4w605ferd xn--bck1b9a5dre4c xn--c1avg xn--c2br7g xn--cck2b3b
xn--cckwcxetd xn--cg4bki xn--clchc0ea0b2g2a9gcd xn--czr694b xn--czrs0t xn--czru2d
xn--d1acj3b xn--d1alf xn--e1a4c xn--eckvdtc9d xn--efvy88h xn--estv75g xn--fct429k xn--fhbei
xn--fiq228c5hs xn--fiq64b xn--fiqs8s xn--fiqz9s xn--fjq720a xn--flw351e xn--fpcrj9c3d
xn--fzc2c9e2c xn--fzys8d69uvgm xn--g2xx48c xn--gckr3f0f xn--gecrj9c xn--gk3at1e
xn--h2breg3eve xn--h2brj9c xn--h2brj9c8c xn--hxt814e xn--i1b6b1a6a2e xn--imr513n xn--io0a7i
xn--j1aef xn--j1amh xn--j6w193g xn--jlq480n2rg xn--jlq61u9w7b xn--jvr189m xn--kcrx77d1x4a
xn--kprw13d xn--kpry57d xn--kpu716f xn--kput3i xn--l1acc xn--lgbbat1ad8j xn--mgb2ddes
xn--mgb9awbf xn--mgba3a3ejt xn--mgba3a4f16a xn--mgba3a4fra xn--mgba7c0bbn0a xn--mgbaakc7dvf
xn--mgbaam7a8h xn--mgbab2bd xn--mgbah1a3hjkrd xn--mgbai9a5eva00b xn--mgbai9azgqp6j
xn--mgbayh7gpa xn--mgbbh1a xn--mgbbh1a71e xn--mgbc0a9azcg xn--mgbca7dzdo xn--mgberp4a5d4a87g
xn--mgberp4a5d4ar xn--mgbgu82a xn--mgbi4ecexp xn--mgbpl2fh xn--mgbqly7c0a67fbc
xn--mgbqly7cvafr xn--mgbt3dhd xn--mgbtf8fl xn--mgbtx2b xn--mgbx4cd0ab xn--mix082f
xn--mix891f xn--mk1bu44c xn--mxtq1m xn--ngbc5azd xn--ngbe9e0a xn--ngbrx xn--nnx388a xn--node
xn--nqv7f xn--nqv7fs00ema xn--nyqy26a xn--o3cw4h xn--ogbpf8fl xn--otu796d xn--p1acf xn--p1ai
xn--pbt977c xn--pgbs0dh xn--pssy2u xn--q9jyb4c xn--qcka1pmc xn--qxam xn--rhqv96g xn--rovu88b
xn--rvc1e0am3e xn--s9brj9c xn--ses554g xn--t60b56a xn--tckwe xn--tiq49xqyj xn--unup4y
xn--vermgensberater-ctb xn--vermgensberatung-pwb xn--vhquv xn--vuq861b xn--w4r85el8fhu5dnra
xn--w4rs40l xn--wgbh1c xn--wgbl6a xn--xhq521b xn--xkc2al3hye2a xn--xkc2dl3a5ee0h xn--y9a3aq
xn--yfro4i67o xn--ygbi2ammx xn--zfr164b xxx xyz yachts yahoo yamaxun yandex ye yodobashi
yoga yokohama you youtube yt yun zappos zara zero zip zm zone zuerich zw ελ бг бел дети ею
католик ком мкд мон москва онлайн орг рус рф сайт срб укр қаз հայ קום ابوظبي اتصالات ارامكو
الاردن الجزائر السعودية السعوديه السعودیة السعودیۃ العليان المغرب اليمن امارات ايران ایران
بارت بازار بيتك بھارت تونس سودان سوريا سورية شبكة عراق عرب عمان فلسطين قطر كاثوليك كوم مصر
مليسيا موريتانيا موقع همراه پاكستان پاکستان ڀارت कॉम नेट भारत भारतम् भारोत संगठन বাংলা ভারত
ভাৰত ਭਾਰਤ ભારત ଭାରତ இந்தியா இலங்கை சிங்கப்பூர் భారత్ ಭಾರತ ഭാരതം ලංකා คอม ไทย გე みんな アマゾン
クラウド グーグル コム ストア セール ファッション ポイント 世界 中信 中国 中國 中文网 亚马逊 企业 佛山 信息 健康 八卦 公司 公益 台湾 台灣 商城 商店 商标 嘉里
嘉里大酒店 在线 大众汽车 大拿 天主教 娱乐 家電 工行 广东 微博 慈善 我爱你 手机 手表 招聘 政务 政府 新加坡 新闻 时尚 書籍 机构 淡马锡 游戏 澳門 澳门 点看 珠宝
移动 组织机构 网址 网店 网站 网络 联通 臺灣 诺基亚 谷歌 购物 通販 集团 電訊盈科 飞利浦 食品 餐厅 香格里拉 香港 닷넷 닷컴 삼성 한국
`.trim().split(/\s+/));
/* СПИСОК TLD КОНЕЦ */

// Расширения файлов, которые синтаксически неотличимы от доменов
// (`invoice.doc`, `stage2.ps1`, `main.js`).
//
// ВАЖНО: часть расширений совпадает с реальными TLD — `.com` (домен и
// legacy-исполняемый файл DOS), `.sh` (Saint Helena и shell-скрипт),
// `.pl` (Польша и Perl), `.zip` (gTLD и архив). Разрешать этот конфликт
// синтаксически невозможно. Принято правило: ЕСЛИ расширение есть в списке
// TLD, оно считается доменом. Следствие — `install.sh` и `deploy.pl`
// попадут в выдачу как домены. Это осознанный размен: пропустить реальный
// домен `evil.com` (частота — постоянно) дороже, чем показать лишний
// `install.sh` (частота — редко, и аналитик отбрасывает его за секунду).
const FILE_EXT_DENYLIST = new Set(`
exe dll sys scr com bat cmd ps1 psm1 vbs vbe js jse wsf hta lnk msi msp cpl ocx drv
jar class py pyc rb pl php asp aspx jsp cgi sh bash zsh
doc docx docm xls xlsx xlsm xlsb ppt pptx pptm pdf rtf odt ods odp
zip rar 7z tar gz bz2 xz cab iso img vhd vmdk
txt log csv tsv json xml yaml yml ini cfg conf toml md
png jpg jpeg gif bmp svg ico webp mp3 mp4 avi mkv mov wav
html htm css scss less ts tsx jsx vue map lock sql db sqlite bak tmp dat bin
`.trim().split(/\s+/));

/* --------------------------------------------------------------------------
 * 3. Регулярные выражения (применяются к УЖЕ нормализованному тексту)
 * ------------------------------------------------------------------------ */
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';

const PATTERNS = {
  url:     new RegExp(String.raw`\b(?:https?|ftp)://[^\s<>"'\x60\[\]{}|\\^]+`, 'gi'),
  email:   new RegExp(String.raw`\b[A-Za-z0-9._%+\-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}\b`, 'g'),
  cidr:    new RegExp(String.raw`\b(?:${OCTET}\.){3}${OCTET}\/(?:3[0-2]|[12]?[0-9])\b`, 'g'),
  ipv4:    new RegExp(String.raw`\b(?:${OCTET}\.){3}${OCTET}\b`, 'g'),
  // Сокращённая, но практичная форма IPv6: требуется минимум одно "::" либо 8 групп
  ipv6:    new RegExp(String.raw`\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?\b`, 'g'),
  sha512:  /\b[A-Fa-f0-9]{128}\b/g,
  sha256:  /\b[A-Fa-f0-9]{64}\b/g,
  sha1:    /\b[A-Fa-f0-9]{40}\b/g,
  md5:     /\b[A-Fa-f0-9]{32}\b/g,
  cve:     /\bCVE-\d{4}-\d{4,7}\b/gi,
  // БДУ ФСТЭК России. Кириллическое написание — основное в русских
  // документах; приводится к латинице в canonicalId.
  bdu:     /(?:\bBDU|БДУ)\s*:\s*\d{4}-\d{5}\b/gi,
  // MITRE ATT&CK. Подтехника пишется и через точку, и через слэш
  // (`T1574.001`, `T1574/001/`) — обе формы, канон в canonicalId.
  attack:  /\bT\d{4}(?:[./]\d{3}\/?)?\b/g,
  asn:     /\bAS\d{1,10}\b/g,
  btc:     /\b(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,71})\b/g,
  eth:     /\b0x[a-fA-F0-9]{40}\b/g,
  regkey:  /\bHK(?:EY_)?(?:LM|CU|CR|U|CC|LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT|USERS|CURRENT_CONFIG)\\[^\s"'<>|]+/gi,
  /* Onion-адрес. Две формы:
   *   v3 — ровно 56 символов base32 (a-z, 2-7), действующая;
   *   v2 — 16 символов, сеть Tor отключила их в 2021 году, но в отчётах
   *        о старых кампаниях и в дампах они встречаются постоянно,
   *        и молча их терять нельзя.
   * `.onion` в allow-list TLD нет и быть не должно — это не домен
   * интернета, — поэтому отдельный тип, а не частный случай домена. */
  onion:   /\b(?:[a-z2-7]{56}|[a-z2-7]{16})\.onion\b/gi,
  winpath: /\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n\s]+/g,
  /* Подчёркивание допустимо ТОЛЬКО первым символом метки.
   *
   * В именах хостов подчёркивания нет вовсе, но записи вида _dmarc
   * и _acme-challenge в отчётах встречаются, и терять их не надо.
   * А вот разрешать его в середине нельзя: именно из-за этого
   * «exploit_cve_2026_31431.py» определялся как домен — имя файла
   * с расширением .py, которое по несчастью ещё и ccTLD Парагвая. */
  /* Последняя метка — буквы ЛИБО punycode (`xn--p1ai`).
   *
   * Было только `[A-Za-z]{2,24}`, и домены в интернационализированных
   * зонах не находились ни в одной записи: `xn--80ak6aa92e.xn--p1ai`
   * не подходил из-за дефисов и цифр, а `сайт.рф` — из-за кириллицы
   * (её ловит IDN_DOMAIN, где TLD тоже был ограничен латиницей).
   * Для российского SOC это означало, что зоны .рф, .рус, .москва
   * не разбирались вовсе. */
  domain:  new RegExp(String.raw`\b_?(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+(?:xn--[A-Za-z0-9\-]{2,59}|[A-Za-z]{2,24})\b`, 'g'),
};

// Порядок ОБЯЗАТЕЛЕН: длинные/специфичные типы забирают текст первыми,
// иначе sha256 распадётся на два md5, а url — на domain + путь.
/* Домен, в котором есть буквы не из латиницы.
 *
 * Отдельный шаблон, а не расширение основного: основной работает по ASCII
 * и по нему построены и паритет, и фильтр по TLD. Здесь нужен ровно один
 * узкий случай — токен с не-ASCII буквами и ЛАТИНСКОЙ зоной, то есть
 * `аpple.com`, а не кириллический домен в `.рф`.
 *
 * Границы заданы явными lookaround вместо `\b`: `\b` в JS считает по
 * ASCII, в Python — по юникоду, и именно на этом клиент с сервером
 * и разошлись. */
/* TLD здесь тоже юникодный: зоны .рф, .рус, .укр, .москва, .сайт
 * существуют и записываются кириллицей. Ограничение латиницей означало,
 * что такой домен не находился ни одним из двух шаблонов. Отсев
 * по allow-list TLD остаётся: `предложение.Далее` доменом не станет. */
const IDN_DOMAIN = /(?<![\p{L}\p{N}_.@-])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,24})(?![\p{L}\p{N}-])/gu;

const EXTRACTION_ORDER = [
  'url', 'email', 'regkey', 'winpath', 'cidr', 'ipv6', 'ipv4',
  'sha512', 'sha256', 'sha1', 'md5',
  'cve', 'bdu', 'attack', 'asn', 'eth', 'btc', 'onion', 'domain',
];

const TYPE_LABELS = {
  url: 'URL', email: 'E-mail', regkey: 'Ключ реестра', winpath: 'Путь Windows',
  cidr: 'Подсеть', ipv6: 'IPv6', ipv4: 'IPv4',
  sha512: 'SHA-512', sha256: 'SHA-256', sha1: 'SHA-1', md5: 'MD5',
  cve: 'CVE', bdu: 'БДУ ФСТЭК', attack: 'ATT&CK', asn: 'ASN',
  eth: 'ETH-кошелёк', btc: 'BTC-кошелёк', onion: 'Onion-адрес', domain: 'Домен',
};

/* --------------------------------------------------------------------------
 * 4. Служебные проверки
 * ------------------------------------------------------------------------ */

// RFC1918 / RFC5735 / RFC3927 и прочие неглобальные диапазоны.
// Такие адреса не должны молча уезжать во внешние сервисы.
function ipv4Class(ip) {
  const p = ip.split('.').map(Number);
  if (p[0] === 10) return 'private';
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return 'private';
  if (p[0] === 192 && p[1] === 168) return 'private';
  if (p[0] === 127) return 'loopback';
  if (p[0] === 169 && p[1] === 254) return 'link-local';
  if (p[0] === 0) return 'reserved';
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'cgnat';
  if (p[0] >= 224) return 'multicast-reserved';
  return 'global';
}

function domainTld(value) {
  const parts = value.toLowerCase().split('.');
  const last = parts[parts.length - 1];
  const last2 = parts.slice(-2).join('.');
  if (TLDS.has(last2)) return last2;
  if (TLDS.has(last)) return last;
  return null;
}

/* Расширения файлов, которые ОДНОВРЕМЕННО являются настоящими TLD.
 * Их девять: cab com map md mov pl py sh zip.
 *
 * Пока список TLD был рукописным, конфликтов почти не было и действовало
 * правило «TLD выигрывает». С полным списком правило сломалось сразу:
 * `backup.zip` и `install.sh` стали доменами, потому что .zip и .sh —
 * настоящие зоны.
 *
 * Общего правила здесь нет, и придумывать его — значит выдавать догадку
 * за факт. Решение принято по каждому расширению отдельно, по тому, что
 * чаще встречается В ОТЧЁТАХ:
 *
 *   com  домен  `evil.com` — повсюду; .COM-исполняемый файл DOS вымер
 *   pl   домен  польские домены в европейских отчётах; Perl-скрипты — нет
 *   ---- остальные семь: файл ----
 *   zip  `payload.zip`, `invoice.zip` против почти неиспользуемой зоны .zip
 *   sh   `install.sh`, `run.sh` против острова Святой Елены
 *   py   `stage2.py` против Парагвая
 *   mov  `video.mov` против зоны .mov
 *   cab  `update.cab` против зоны .cab
 *   map  `bundle.js.map` против зоны .map
 *   md   `README.md` против Молдовы — на страницах с индикаторами
 *        README.md встречается заметно чаще молдавского домена
 *
 * Решение перекрывается ДОКАЗАТЕЛЬСТВОМ: если автор отчёта сам пометил
 * значение дефангом (`backup[.]zip`), он прямо сказал «это индикатор»,
 * и спорить с ним нельзя. */
const TLD_WINS_OVER_EXT = new Set(['com', 'pl']);

/* Значения, которые в ИСХОДНОМ тексте были дефангованы.
 *
 * Дефанг — это утверждение автора: «здесь индикатор, не кликайте».
 * Оно сильнее любой нашей эвристики, поэтому собирается отдельно
 * и до рефанга, когда разметку ещё видно. */
function defangedValues(original) {
  const out = new Set();
  const re = /[A-Za-z0-9][A-Za-z0-9._-]*(?:\s*[[({<]\s*(?:\.|dot|точка)\s*[\])}>]\s*[A-Za-z0-9][A-Za-z0-9._-]*)+/gi;
  let m;
  while ((m = re.exec(String(original || ''))) !== null) {
    out.add(refang(m[0]).toLowerCase());
  }
  return out;
}

/* ХВОСТ URL: знаки препинания, не принадлежащие адресу.
 *
 * Шаблон URL забирает всё до пробела, а в тексте за адресом почти всегда
 * что-то стоит: точка в конце предложения, запятая в перечислении,
 * закрывающая скобка, если ссылку дали в скобках или markdown-ссылкой.
 * В выдаче оказывались
 *
 *     https://evil.com/path.      https://evil.com/path)
 *     https://evil.com/a,         https://evil.com/b;
 *
 * — адреса, которых не существует. Это тот же класс, что выдуманный
 * индикатор: значение выглядит фактом и уедет в отчёт.
 *
 * Скобка снимается ТОЛЬКО непарная: в адресе она встречается законно
 * (`/wiki/Пример_(значения)`), и резать её всегда — значит ломать
 * настоящие ссылки. Слэш, `=` и `-` на конце законны и не трогаются.
 */
const URL_TAIL_PUNCT = '.,;:!?\'"«»<>';

function trimUrlTail(u) {
  let v = String(u);
  for (;;) {
    const last = v[v.length - 1];
    if (!last) break;
    if (URL_TAIL_PUNCT.includes(last)) { v = v.slice(0, -1); continue; }
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      const n = (s, ch) => s.split(ch).length - 1;
      if (n(v, last) > n(v, open)) { v = v.slice(0, -1); continue; }
    }
    break;
  }
  return v;
}

/* КАНОНИЧЕСКАЯ ФОРМА ИДЕНТИФИКАТОРОВ.
 *
 * Один и тот же идентификатор в отчётах пишут по-разному:
 *   T1574/001/      Unit 42 — подтехника через слэш
 *   T1574.001       каноническая запись MITRE
 *   БДУ:2026-01234  русские документы, включая сам ФСТЭК
 *   BDU:2026-01234  латиница
 *
 * Без приведения подтехника терялась (`T1574/001/` давал `T1574`),
 * а кириллическое написание БДУ не находилось вовсе — в документах
 * на русском, то есть в основном потоке работы.
 *
 * Это не догадка и не рефанг значения: идентификатор тот же самый,
 * меняется только запись. */
/* Строка со значением плюс предыдущая непустая: контекст для типов,
 * которые без него дают мусор (техники ATT&CK, номера AS). Меряется
 * структурой документа, а не числом знаков. */
function lineContext(chars, index) {
  let l = index;
  while (l > 0 && chars[l - 1] !== '\n') l--;
  let r = index;
  while (r < chars.length && chars[r] !== '\n') r++;
  const сама = chars.slice(l, r).join('');

  let p2 = l - 1, найдено = '';
  while (p2 > 0) {
    let p1 = p2 - 1;
    while (p1 > 0 && chars[p1 - 1] !== '\n') p1--;
    const пред = chars.slice(p1, p2).join('');
    if (пред.trim()) { найдено = пред; break; }
    p2 = p1 - 1;
  }
  return найдено + '\n' + сама;
}

function canonicalId(type, raw) {
  const v = String(raw).trim();
  if (type === 'attack') {
    const m = /^T(\d{4})(?:[./](\d{3}))?/.exec(v);
    if (!m) return v;
    return m[2] ? `T${m[1]}.${m[2]}` : `T${m[1]}`;
  }
  if (type === 'bdu') {
    const m = /(\d{4}-\d{5})/.exec(v);
    return m ? `BDU:${m[1]}` : v;
  }
  return v;
}

function isLikelyFilename(value, marked) {
  const ext = value.toLowerCase().split('.').pop();
  if (!FILE_EXT_DENYLIST.has(ext)) return false;
  // Автор отчёта пометил значение дефангом — это индикатор, а не файл.
  if (marked && marked.has(String(value).toLowerCase())) return false;
  if (TLDS.has(ext) && TLD_WINS_OVER_EXT.has(ext)) return false;
  return true;
}

/* --------------------------------------------------------------------------
 * 5. Основная функция извлечения
 *
 *    Алгоритм: «маскирующее» извлечение. После того как тип забрал подстроку,
 *    её символы заменяются на \x00 в рабочей копии текста — так следующий тип
 *    физически не может её пересопоставить. Это дешевле и предсказуемее,
 *    чем интервальные проверки пересечений.
 * ------------------------------------------------------------------------ */
/**
 * Извлечение индикаторов.
 *
 * options.loose (по умолчанию включено) — второй проход по тексту,
 * в котором дополнительно раскрываются бесскобочные написания
 * («evil dot com», «user at evil dot com»). Найденное только вторым
 * проходом помечается флагом ambiguous:refang.
 *
 * Почему второй проход, а не одно правило: «dot» и «at» встречаются
 * в обычном тексте сами по себе, и слить их с основным разбором
 * значит выдавать догадку за факт. Отдельный проход с флагом даёт
 * и то и другое: индикатор не теряется, и видно, что он — догадка.
 */
function extractIocs(rawText, options = {}) {
  const { withContext = true, contextChars = 60, loose = true } = options;
  const original0 = String(rawText || '');
  if (loose) {
    const strict = extractIocs(rawText, { ...options, loose: false });
    const seen = new Set(strict.map((i) => `${i.type}|${i.value.toLowerCase()}`));

    /* Дополнительные проходы по ПРЕОБРАЗОВАННОМУ тексту. Каждый — догадка
     * своего рода, и у каждого свой флаг; найденное ими подмешивается
     * к фактам только с пометкой.
     *
     * Ранний выход здесь стоял раньше и был ошибкой: если бесскобочного
     * дефанга в тексте нет, функция возвращалась ДО прохода по склейке
     * переносов, и склейка не работала никогда. Поймано на первом же
     * ручном прогоне после её добавления. Теперь проходы перечислены
     * списком — добавить четвёртый и снова споткнуться об чужой return
     * уже не получится. */
    const wrap = joinWrappedDetailed(original0);
    const passes = [
      ['ambiguous:refang', refangLoose(original0), refang(original0)],
      ['ambiguous:wrap', wrap.text, original0],
    ];
    for (const [flag, transformed, baseline] of passes) {
      if (transformed === baseline) continue;
      for (const i of extractIocs(transformed, { ...options, loose: false })) {
        const key = `${i.type}|${i.value.toLowerCase()}`;
        if (seen.has(key)) continue;
        i.flags = [...(i.flags || []), flag];
        /* Для склейки прикладываем ИСХОДНЫЕ строки. Пометка «это догадка»
         * без возможности её проверить — тупик: исходника у аналитика
         * может уже не быть, текст пришёл из буфера. Две формы рядом
         * превращают догадку в решение человека. */
        if (flag === 'ambiguous:wrap') {
          const parts = wrapSourceOf(wrap.joins, i.value);
          if (parts) i.wrapSource = parts;
        }
        strict.push(i);
        seen.add(key);
      }
    }
    return dropWrapFragments(strict, wrap.joins);
  }

  const original = String(rawText || '');
  const text = refang(original);
  const found = new Map();         // ключ: `${type}|${value}` -> запись

  /* Маскирование найденного хранится в МАССИВЕ символов, а не в строке.
   *
   * Строки в JS неизменяемы: `mask = mask.slice(0,i) + ... + mask.slice(j)`
   * пересобирает весь документ на КАЖДОЕ совпадение. При m совпадениях
   * это O(n·m), то есть квадратично по объёму текста: отчёт на 300 КБ
   * разбирался пять секунд, файл на мегабайт — минуту.
   *
   * Массив правится на месте за O(длина совпадения), а строка для
   * регулярного выражения собирается один раз на тип — восемнадцать
   * раз за весь разбор вместо тысяч.
   *
   * split('') а не Array.from(): нужны единицы UTF-16, потому что
   * индексы regex считаются в них же. Array.from режет по кодовым
   * точкам, и на суррогатных парах (эмодзи) индексы разъехались бы. */
  const maskChars = text.split('');
  let mask = text;
  /* Что автор отчёта пометил дефангом — собираем ДО рефанга. */
  const marked = defangedValues(original);
  const refangChanged = original !== text;


  /* ХВОСТ ЗА ЗНАЧЕНИЕМ: порт и путь.
   *
   * В отчётах C2 пишут целиком — `202.95.14[.]237:5090`,
   * `evil[.]com/gate.php`, а Microsoft пишет ссылки вообще без схемы:
   * `newopt001.oss-cn-hongkong.aliyuncs[.]com/innstll.1.0.61.zip`.
   * Разбор до 0.40.0 брал из этого только адрес, а порт и путь
   * ВЫБРАСЫВАЛ, ничего не сообщая. Аналитик получал меньше, чем было
   * в отчёте, и не знал об этом.
   *
   *   порт  -> флаг `port:N` на самом адресе. Значение не меняется:
   *            по нему идёт сведение дубликатов и сверка с кейсом,
   *            а один адрес на трёх портах даёт три флага.
   *   путь  -> ОТДЕЛЬНЫЙ индикатор типа url с пометкой
   *            `ambiguous:no-scheme`. Схема не дописывается: http
   *            вместо https — это выдуманный факт, а пометка честно
   *            говорит, что схемы в отчёте не было.
   *
   * Функция, а не кусок цикла, потому что вызывается ДВАЖДЫ: из общего
   * прохода и из прохода по не-латинским доменам. Пока это был кусок
   * цикла, `вход-банк[.]рф/auth/login` терял путь — кириллические
   * домены находит другой проход. */
  function хвостЗаЗначением(type, value, start, matchedLen) {
    if (type !== 'ipv4' && type !== 'domain' && type !== 'ipv6') {
      return { порт: null, поглощён: false };
    }
    /* Смотрим вперёд ОГРАНИЧЕННЫЙ кусок, а не собираем строку целиком.
     *
     * `maskChars.join('')` здесь стоил бы O(длина документа) на каждое
     * совпадение, то есть возвращал бы ту самую квадратичную сложность,
     * ради ухода от которой маска и хранится массивом. Тест роста
     * это поймал: ×4.12 при удвоении объёма вместо ×2.
     *
     * 320 знаков хватает с запасом: порт не длиннее шести, путь
     * ограничен тремя сотнями. */
    const ХВОСТ_ОКНО = 320;
    const после = maskChars
      .slice(start + matchedLen, start + matchedLen + ХВОСТ_ОКНО).join('');
    let портФлаг = null;
    const портM = /^:(\d{1,5})(?![\d.])/.exec(после);
    const портЕсть = портM && Number(портM[1]) >= 1 && Number(портM[1]) <= 65535;
    if (портЕсть) {
      портФлаг = `port:${портM[1]}`;
      for (let i = 0; i < портM[0].length; i++) maskChars[start + matchedLen + i] = '\u0000';
    }
    const сдвиг = портЕсть ? портM[0].length : 0;
    const путьM = /^\/[A-Za-z0-9._~\-/%?#&=+,;:@!$'*]{1,300}/.exec(после.slice(сдвиг));
    if (!путьM) return { порт: портФлаг, поглощён: false };
    {
      const адрес = value + (портЕсть ? портM[0] : '') + trimUrlTail(путьM[0]);
      const kurl = `url|${адрес.toLowerCase()}`;
      if (!found.has(kurl)) {
        found.set(kurl, {
          type: 'url', typeLabel: TYPE_LABELS.url, value: адрес,
          count: 0, defanged: refangChanged && !original.includes(адрес),
          flags: ['ambiguous:no-scheme'],
          context: withContext
            ? text.slice(Math.max(0, start - contextChars),
                         start + адрес.length + contextChars).replace(/\s+/g, ' ').trim()
            : '',
        });
      }
      found.get(kurl).count += 1;
      for (let i = 0; i < путьM[0].length; i++) {
        maskChars[start + matchedLen + сдвиг + i] = '\u0000';
      }
    }
    /* Адрес ПОГЛОЩЁН ссылкой и отдельным индикатором не становится.
     *
     * Для ссылки со схемой так было всегда: `https://evil.com/x` целиком
     * забирает тип url, и домен отдельно не выдаётся. Для ссылки без
     * схемы получалось иначе — сначала находился домен, потом к нему
     * дописывался путь, и в выдаче оказывались оба.
     *
     * На другом отчёте заказчика это дало `github.com`
     * со счётчиком 8 и `pastebin.com` — рядом с девятью ссылками
     * на конкретные аккаунты. В отчёте таких индикаторов нет: там
     * перечислены аккаунты, а не площадка. Счётчик 8 при этом выносит
     * `github.com` в начало списка, то есть самым заметным индикатором
     * документа становится значение, которого в нём не было.
     *
     * Если тот же хост встречается в документе и сам по себе, он
     * найдётся на своём вхождении — поглощается ОДНО вхождение,
     * а не значение целиком. */
    return { порт: портФлаг, поглощён: true };
  }

  /* ПЕРВЫМ ДЕЛОМ — домены с не-латинскими буквами.
   *
   * Иначе происходит вот что. Основной шаблон домена — только ASCII,
   * а `\b` в JS работает по ASCII: в строке `аpple.com` (первая буква
   * кириллическая) граница слова оказывается ПЕРЕД `p`, и парсер
   * выдаёт `pple.com` — значение, которого в тексте нет. Выдуманный
   * индикатор хуже пропущенного: его понесут в отчёт.
   *
   * Python ведёт себя иначе (`\b` там юникодный) и не находил ничего.
   * То есть клиент и сервер расходились на гомоглифах — нашлось, когда
   * в корпус паритета добавили такой домен.
   *
   * Поэтому: сначала находим токен целиком, помечаем флагами и
   * МАСКИРУЕМ. После этого основной проход по нему уже не пройдёт. */
  for (const m of text.matchAll(IDN_DOMAIN)) {
    const value = m[0];
    if (!/[^\x00-\x7F]/.test(value)) continue;        // чистый ASCII — не наш случай
    if (!domainTld(value)) continue;
    const flags = homographFlags(value);
    const key = `domain|${value.toLowerCase()}`;
    if (!found.has(key)) {
      found.set(key, {
        type: 'domain', typeLabel: TYPE_LABELS.domain, value,
        count: 0, defanged: refangChanged, flags,
        tld: domainTld(value),
        context: withContext
          ? text.slice(Math.max(0, m.index - contextChars),
                       m.index + value.length + contextChars).replace(/\s+/g, ' ').trim()
          : '',
      });
    }
    found.get(key).count++;
    for (let i = m.index; i < m.index + value.length; i++) maskChars[i] = '\u0000';
    const хв = хвостЗаЗначением('domain', value, m.index, value.length);
    if (хв.поглощён) {
      found.get(key).count--;
      if (found.get(key).count <= 0) found.delete(key);
    } else if (хв.порт && !found.get(key).flags.includes(хв.порт)) {
      found.get(key).flags.push(хв.порт);
    }
  }

  for (const type of EXTRACTION_ORDER) {
    mask = maskChars.join('');     // снимок с учётом всего, что замаскировано
    const re = new RegExp(PATTERNS[type].source, PATTERNS[type].flags);
    let m;
    while ((m = re.exec(mask)) !== null) {
      /* Совпадение и ЗНАЧЕНИЕ — не одно и то же.
       *
       * Знаки препинания, прилипшие за значением: шаблон URL берёт всё
       * до пробела, и `C:\\Users\\test\\payload.exe.` в конце
       * предложения давал путь с точкой на конце, которого на диске нет.
       *
       * Написание идентификатора: `T1574/001/` у Unit 42 и `БДУ:2026-01234`
       * в русских документах — те же самые идентификаторы, записанные
       * иначе. Приводим к канонической форме, как это делает рефанг.
       *
       * Маскирование при этом идёт по ДЛИНЕ СОВПАДЕНИЯ, а не значения:
       * иначе после укорачивания часть текста осталась бы открытой
       * и была бы разобрана ещё раз другим типом. */
      const matched = m[0];
      const matchedLen = matched.length;
      let value = matched;
      if (type === 'url' || type === 'winpath' || type === 'regkey') value = trimUrlTail(matched);
      else if (type === 'attack' || type === 'bdu') value = canonicalId(type, matched);
      const start = m.index;
      if (!value) continue;

      // --- фильтры ложных срабатываний, специфичные для типа ---
      if (type === 'domain') {
        if (isLikelyFilename(value, marked)) continue;
        if (!domainTld(value)) continue;
      }
      if (type === 'attack') {
        // T1234 без контекста — почти всегда мусор (номера деталей, тайминги).
        /* Окно в сорок знаков — неверная мера. В строке
         * «MITRE ATT&CK techniques observed: T1574/001/, T1070/006/,
         * T1055/012/.» третий идентификатор до слова techniques уже
         * не доставал, и терялся ровно в том месте, где принадлежность
         * к ATT&CK очевиднее всего — в перечислении под заголовком.
         *
         * Контекст задаёт не расстояние, а СТРОКА: своя и предыдущая
         * непустая, где обычно и стоит заголовок раздела. */
        const around = lineContext(maskChars, start);
        /* `ATT&CK` — самое частое написание названия, и именно оно
         * НЕ подходило под `attack`: между ATT и CK стоит амперсанд.
         * То есть фильтр отбрасывал технику ровно там, где рядом
         * написано название фреймворка.
         *
         * `techniq` — по той же причине: в списке было `техник`
         * кириллицей и не было латиницей, и в английском отчёте
         * «techniques observed: T1574/001/, T1070/006/, T1055/012/»
         * третий идентификатор терялся: до слова MITRE окно в сорок
         * знаков уже не доставало, а слово techniques правило
         * не опознавало. */
        if (!/att&?ck|mitre|techniq|техник|tactic|тактик|TTP/i.test(around)) continue;
      }
      if (type === 'asn') {
        const around = maskChars.slice(Math.max(0, start - 20),
                                       start + value.length + 20).join('');
        if (!/\bAS\d/.test(value) || /[A-Za-z]{2}AS\d/.test(around)) continue;
      }

      const хвост = хвостЗаЗначением(type, value, start, matchedLen);
      if (хвост.поглощён) {
        for (let i = start, e = start + matchedLen; i < e; i++) maskChars[i] = '\u0000';
        re.lastIndex = start + matchedLen;
        continue;
      }
      const портФлаг = хвост.порт;

      const key = `${type}|${value.toLowerCase()}`;
      if (!found.has(key)) {
        const rec = {
          type,
          typeLabel: TYPE_LABELS[type],
          value,
          count: 0,
          defanged: false,
          flags: [],
        };
        if (type === 'ipv4') {
          const cls = ipv4Class(value);
          rec.scope = cls;
          if (cls !== 'global') rec.flags.push(`non-routable:${cls}`);
        }
        if (type === 'md5') rec.flags.push('ambiguous:md5-or-ja3');
        if (type === 'domain') {
          rec.tld = domainTld(value);
          // Для ASCII-домена это даёт только idn:puny — метку вида xn--,
          // значение которой глазами не прочитать.
          rec.flags.push(...homographFlags(value));
        }
        if (withContext) {
          rec.context = text
            .slice(Math.max(0, start - contextChars), start + value.length + contextChars)
            .replace(/\s+/g, ' ')
            .trim();
        }
        // Был ли индикатор дефангован в исходном тексте?
        // Проверка: исходник не содержит канонической формы, но содержит её части.
        // includes() просматривает документ целиком, поэтому сначала
        // дешёвая проверка: если refang ничего не изменил, дефанга
        // не было нигде, и искать нечего.
        if (refangChanged && !original.includes(value)) rec.defanged = true;
        found.set(key, rec);
      }
      if (портФлаг && !found.get(key).flags.includes(портФлаг)) {
        found.get(key).flags.push(портФлаг);
      }
      found.get(key).count += 1;

      // маскируем найденное, чтобы не пересопоставить другим типом
      for (let i = start, end = start + matchedLen; i < end; i++) maskChars[i] = '\x00';
      re.lastIndex = start + matchedLen;
    }
  }

  return Array.from(found.values()).sort(
    (a, b) => EXTRACTION_ORDER.indexOf(a.type) - EXTRACTION_ORDER.indexOf(b.type) ||
              b.count - a.count ||
              a.value.localeCompare(b.value)
  );
}

/* --------------------------------------------------------------------------
 * 6. Определение типа одиночной строки (для поля ввода «один IOC»)
 * ------------------------------------------------------------------------ */
function detectType(input) {
  const raw = String(input || '').trim();
  const value = refang(raw);
  if (!value) return null;
  const marked = defangedValues(raw);
  for (const type of EXTRACTION_ORDER) {
    const re = new RegExp(`^(?:${PATTERNS[type].source})$`, PATTERNS[type].flags.replace('g', ''));
    if (re.test(value)) {
      if (type === 'domain' && (isLikelyFilename(value, marked) || !domainTld(value))) continue;
      return { type, typeLabel: TYPE_LABELS[type], value };
    }
  }
  return { type: 'keyword', typeLabel: 'Ключевое слово', value };
}

/* --------------------------------------------------------------------------
 * 7. Экспорт результатов
 * ------------------------------------------------------------------------ */
/* Вердикт и заметка выгружаются наравне с самим значением.
 * Если бы они оставались только в интерфейсе, работа аналитика терялась
 * при первом же экспорте, а экспорт — это то, что уходит клиенту. */
function toCsv(iocs) {
  const head = 'type,value,count,defanged,flags,verdict,verdict_source,note,tags,source,context';
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  return [head, ...iocs.map((i) =>
    [i.type, i.value, i.count, i.defanged, (i.flags || []).join(';'),
     i.verdict || 'unknown', i.verdictSource || '', i.note || '',
     (i.tags || []).join(';'), i.source || '', i.context || '']
      .map(esc).join(',')
  )].join('\n');
}

// Минимальный валидный STIX 2.1 bundle.
// ВАЖНО: верхнеуровневый ключ должен называться именно `objects` —
// иначе OpenCTI отклоняет файл на ImportFileStix (проверено на 6.8.x).
const STIX_PATTERN_BY_TYPE = {
  ipv4:   (v) => `[ipv4-addr:value = '${v}']`,
  ipv6:   (v) => `[ipv6-addr:value = '${v}']`,
  cidr:   (v) => `[ipv4-addr:value = '${v}']`,
  domain: (v) => `[domain-name:value = '${v}']`,
  url:    (v) => `[url:value = '${v.replace(/'/g, "\\'")}']`,
  email:  (v) => `[email-addr:value = '${v}']`,
  md5:    (v) => `[file:hashes.'MD5' = '${v}']`,
  sha1:   (v) => `[file:hashes.'SHA-1' = '${v}']`,
  sha256: (v) => `[file:hashes.'SHA-256' = '${v}']`,
  sha512: (v) => `[file:hashes.'SHA-512' = '${v}']`,
  /* Onion в STIX выражается как domain-name: отдельного типа в стандарте
   * нет, а OpenCTI и MISP принимают именно так. Без этой строки
   * onion-адрес молча выпадал бы из выгрузки. */
  onion:  (v) => `[domain-name:value = '${v}']`,
  btc:    (v) => `[cryptocurrency-wallet:value = '${v}']`,
  eth:    (v) => `[cryptocurrency-wallet:value = '${v}']`,
};

/* Вердикт -> confidence STIX. Значения не выдуманы на месте, а отражают
 * смысл шкалы: 85 — «проверено и подтверждено», 50 — «есть основания,
 * но не доказано», 15 — «нашли и не проверяли». Ровняющий всех по 50
 * экспорт обесценивает работу аналитика ровно в тот момент, когда она
 * уходит наружу. */
const VERDICT_CONFIDENCE = { malicious: 85, suspicious: 50, unknown: 15 };

/* Вердикты, при которых индикатор В БАНДЛ НЕ ПОПАДАЕТ.
 *
 * Это не фильтр для удобства. Объект STIX типа indicator означает
 * «признак компрометации». Выгрузить туда адрес, который аналитик
 * проверил и признал чистым, — значит отправить в OpenCTI, а оттуда
 * в правила детекта, заведомо ложный индикатор. Ошибка такого рода
 * обнаруживается не при экспорте, а через месяц, в виде потока ложных
 * срабатываний у клиента.
 */
const STIX_EXCLUDED_VERDICTS = new Set(['clean', 'irrelevant']);

function toStixBundle(iocs, meta = {}) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const objects = [];
  const skipped = [];
  for (const i of iocs) {
    const build = STIX_PATTERN_BY_TYPE[i.type];
    if (!build) continue;
    const verdict = i.verdict || 'unknown';
    if (STIX_EXCLUDED_VERDICTS.has(verdict)) { skipped.push(i.value); continue; }
    const labels = [...(meta.labels || ['ti-browser'])];
    labels.push('verdict:' + verdict);
    for (const t of i.tags || []) labels.push(t);
    const description = [
      i.note ? i.note : '',
      i.verdictSource ? `Проверен: ${i.verdictSource}` : '',
      i.context ? `Контекст: ${i.context}` : '',
    ].filter(Boolean).join('\n') || undefined;
    objects.push({
      type: 'indicator',
      spec_version: '2.1',
      id: `indicator--${uuidv4()}`,
      created: now,
      modified: now,
      name: i.value,
      pattern: build(i.value),
      pattern_type: 'stix',
      valid_from: now,
      // valid_until НЕ проставляем: если valid_until <= valid_from,
      // OpenCTI отбрасывает объект на валидации STIX.
      labels,
      confidence: meta.confidence ?? VERDICT_CONFIDENCE[verdict] ?? 15,
      description,
      object_marking_refs: meta.tlpRef ? [meta.tlpRef] : undefined,
    });
  }
  const bundle = { type: 'bundle', id: `bundle--${uuidv4()}`, objects };
  /* skipped нужен интерфейсу, чтобы СКАЗАТЬ, что часть индикаторов
   * не выгружена, и почему: молчаливое исключение выглядит как потеря
   * данных. Но в самом файле его быть не должно — верхнеуровневые ключи
   * бандла фиксированы, и лишний ключ рискует отправить весь импорт
   * в OpenCTI на отказ по валидации.
   *
   * Поэтому свойство неперечисляемое: JSON.stringify его не увидит
   * физически, а не «мы не забыли его удалить». */
  Object.defineProperty(bundle, '_skipped', { value: skipped, enumerable: false });
  return bundle;
}

function uuidv4() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/* --------------------------------------------------------------------------
 * Экспорт: работает и как ES-модуль, и как классический скрипт
 * (content-script'ы в MV3 Firefox подключаются без type="module").
 * ------------------------------------------------------------------------ */
const IOC = {
  refang, refangLoose, extractIocs, detectType, toCsv, toStixBundle,
  joinWrapped, joinWrappedDetailed, wrapSourceOf, homographFlags, defang, scriptsOf,
  ipv4Class, domainTld, TYPE_LABELS, EXTRACTION_ORDER,
  // Экспортируются, чтобы паритетный тест мог сравнить шкалу с серверной:
  // одна и та же оценка обязана получаться на обоих путях выгрузки.
  VERDICT_CONFIDENCE, STIX_EXCLUDED_VERDICTS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = IOC;
if (typeof globalThis !== 'undefined') globalThis.IOC = IOC;

})();
