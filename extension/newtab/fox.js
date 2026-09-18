/* =============================================================================
 * fox.js — пиксельная лиса на пустой странице
 * =============================================================================
 *
 * ЗАЧЕМ ЭТО ЗДЕСЬ
 * ---------------
 * Стартовая страница TI-браузера — первое, что аналитик видит утром
 * и между задачами. Пустое поле ввода на чёрном фоне работает, но
 * инструментом, которым хочется пользоваться, его не делает.
 *
 * Лиса — не украшение ради украшения: она показывается ТОЛЬКО когда
 * работы нет, и исчезает, как только в выдаче появились индикаторы.
 * Занимать место рядом с результатами разбора она не должна.
 *
 * КАК СДЕЛАНО И ПОЧЕМУ ИМЕННО ТАК
 * -------------------------------
 * Кадры — текстовая матрица, а не файл картинки. Причины:
 *   - ни одного внешнего ресурса: главная страница браузера не делает
 *     сетевых запросов принципиально, иначе она сама становится
 *     телеметрией;
 *   - в XPI не попадает бинарник, а правка кадра — правка строки;
 *   - CSP не трогаем.
 *
 * Отрисовка в canvas с image-rendering: pixelated — пиксель остаётся
 * пикселем при любом масштабе.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО
 * ------------------------
 * Анимация останавливается, когда вкладка не видна, и не запускается
 * вовсе при prefers-reduced-motion. Браузер аналитика держит десятки
 * вкладок; жечь на них кадры ради украшения — плохой обмен.
 * ========================================================================== */

'use strict';

/* Палитра. Оранжевый взят теплее фирменного, чтобы читался на тёмном
 * фоне консоли и не спорил с синим акцентом интерфейса. */
const FOX_PALETTE = {
  '.': null,                 // прозрачный
  o: '#e26e30',              // мех
  d: '#96401f',              // тень, кончики ушей
  c: '#f8eee0',              // грудь, морда, кончик хвоста
  k: '#18161a',              // глаза и нос
  m: '#4a4a52',              // ремень намордника (режим клиентских данных)
};

/* Кадры 16x16. Отличаются только положением хвоста и глазами —
 * остальное тело общее, поэтому кадры выглядят почти одинаково
 * и различий в коде искать не надо: всё видно глазами. */
const FOX_FRAMES = {
  // Хвост опущен
  idle0: [
    '..d.......d.....',
    '..dd.....dd.....',
    '.dood...dood....',
    '.doooooooooo....',
    '..oooooooooo....',
    '..okooooooko....',
    '..oooooooooo....',
    '...occccccc.....',
    '...occkkcco.....',
    '....occcco......',
    '....oooooo......',
    '...occccccc..dd.',
    '...occcccco.docc',
    '...oooooooodoccc',
    '....ooooooodocc.',
    '.....oooooo.cc..',
  ],
  // Хвост поднят
  idle1: [
    '..d.......d.....',
    '..dd.....dd.....',
    '.dood...dood....',
    '.doooooooooo....',
    '..oooooooooo....',
    '..okooooooko..dd',
    '..oooooooooo.doc',
    '...occccccc..doc',
    '...occkkcco.doc.',
    '....occcco..do..',
    '....oooooo.do...',
    '...occccccodo...',
    '...occcccco.....',
    '...oooooooo.....',
    '....oooooo......',
    '.....oooo.......',
  ],
  /* Уши торчком и хвост поднят — «нашлось».
   * Два отличия сразу, а не одно: при 32 пикселях в шапке разницу
   * в один ряд пикселей не видно. */
  alert: [
    '..d.......d.....',
    '..dd.....dd.....',
    '..dd.....dd.....',
    '..dd.....dd...dd',
    '.dood...dood.doc',
    '.doooooooooo.doc',
    '..okkooookko.doc',
    '..ooooooooood.oc',
    '...occccccc.do..',
    '...occkkcco.o...',
    '....occcco......',
    '....oooooo......',
    '...occccccc.....',
    '...occcccco.....',
    '...oooooooo.....',
    '....oooooo......',
  ],
  /* Намордник — режим «клиентские данные».
   * Ремень поперёк морды и ремешки к ушам; морда остаётся видна.
   * Смысл прямой: в этом режиме браузеру запрещено ходить в публичные
   * сервисы, и видно это должно быть не открывая настройки. */
  muzzle: [
    '..d.......d.....',
    '..dd.....dd.....',
    '.dood...dood....',
    '.doooooooooo....',
    '..oooooooooo....',
    '..okooooooko....',
    '..omoooooomo....',
    '...mccccccm.....',
    '...mmmmmmmm.....',
    '....occcco......',
    '....oooooo......',
    '...occccccc..dd.',
    '...occcccco.docc',
    '...oooooooodoccc',
    '....ooooooodocc.',
    '.....oooooo.cc..',
  ],
  /* Спит — ошибка. Глаза закрыты, «z» в углу.
   * Выбор образа не мой: так предложил заказчик, и он прав в главном —
   * спящая лиса читается как «сейчас ничего не происходит», а это
   * и есть состояние после сбоя. */
  sleep: [
    '..d.......d..ccc',
    '..dd.....dd...c.',
    '.dood...dood.c..',
    '.doooooooooo.ccc',
    '..oooooooooo....',
    '..oddooooddo....',
    '..oooooooooo....',
    '...occccccc.....',
    '...occkkcco.....',
    '....occcco......',
    '....oooooo......',
    '...occccccc..dd.',
    '...occcccco.docc',
    '...oooooooodoccc',
    '....ooooooodocc.',
    '.....oooooo.cc..',
  ],
  /* Бежит — идёт разбор. Вид сбоку: сидящую лису в движение
   * не привести, а смена силуэта читается мгновенно. */
  run0: [
    '................',
    '..........d...d.',
    '.........dood.od',
    '........dooooood',
    '...cc...okoooooo',
    '..cccc..oooooccc',
    '.cccooooooooocc.',
    '.ccooooooooooo..',
    '..ooooooooooo...',
    '..ooooooooooo...',
    '..o.oo...oo.o...',
    '.o..o.....o..o..',
    '.o..o.....o..o..',
    '.c..c.....c..c..',
    '................',
    '................',
  ],
  run1: [
    '................',
    '..........d...d.',
    '.........dood.od',
    '........dooooood',
    '.cc.....okoooooo',
    'cccc....oooooccc',
    'cccooooooooocc..',
    '.cooooooooooo...',
    '..ooooooooooo...',
    '..ooooooooooo...',
    '...ooo...ooo....',
    '..o...o.o...o...',
    '.o....o.o....o..',
    '.c....c.c....c..',
    '................',
    '................',
  ],
  // Моргает — та же поза, что idle0, глаза закрыты.
  // Закрытый глаз шире открытого на пиксель: точка того же размера,
  // но другого цвета читается как «глаз потускнел», а не «моргнул».
  blink: [
    '..d.......d.....',
    '..dd.....dd.....',
    '.dood...dood....',
    '.doooooooooo....',
    '..oooooooooo....',
    '..oddooooddo....',
    '..oooooooooo....',
    '...occccccc.....',
    '...occkkcco.....',
    '....occcco......',
    '....oooooo......',
    '...occccccc..dd.',
    '...occcccco.docc',
    '...oooooooodoccc',
    '....ooooooodocc.',
    '.....oooooo.cc..',
  ],
};

/* Проверка кадров при загрузке.
 *
 * Ловушка, на которую я уже наступил при рисовании: в матрице легко
 * оставить кириллическую «о» вместо латинской. Палитра такой символ
 * не знает, пиксель молча пропадает, и найти это глазами на 16x16
 * практически невозможно. Поэтому — явная проверка, а не надежда. */
function validateFrames() {
  const problems = [];
  for (const [name, rows] of Object.entries(FOX_FRAMES)) {
    if (rows.length !== 16) problems.push(`${name}: ${rows.length} строк вместо 16`);
    rows.forEach((row, y) => {
      if (row.length !== 16) problems.push(`${name}[${y}]: ${row.length} символов вместо 16`);
      for (const ch of row) {
        if (!(ch in FOX_PALETTE)) {
          problems.push(`${name}[${y}]: символ ${JSON.stringify(ch)} `
                      + `(код ${ch.codePointAt(0)}) не из палитры`);
        }
      }
    });
  }
  return problems;
}

const FOX_SIZE = 16;

function drawFox(ctx, frame, scale) {
  const rows = FOX_FRAMES[frame] || FOX_FRAMES.idle0;
  ctx.clearRect(0, 0, FOX_SIZE * scale, FOX_SIZE * scale);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const color = FOX_PALETTE[rows[y][x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}

/* Последовательность кадров. Долгие паузы на idle0 и редкое моргание:
 * ровный «мультик» в углу рабочего инструмента отвлекает, а лиса,
 * которая просто сидит и изредка шевелится, — нет. */
const FOX_SEQUENCE = [
  ['idle0', 2600], ['blink', 130], ['idle0', 1800],
  ['idle1', 900], ['idle0', 2200], ['blink', 130], ['idle0', 3000],
  ['idle1', 700],
];

/* ===================================== ЛИСА КАК ИНДИКАТОР СОСТОЯНИЯ ====
 *
 * Идея заказчика, и у неё есть проверяемая польза: режим данных сейчас
 * виден только в выпадающем списке в шапке, а перепутать его дорого —
 * в режиме «клиентские данные» браузеру запрещено ходить в публичные
 * сервисы. Лиса в наморднике видна боковым зрением.
 *
 * ГРАНИЦА, КОТОРУЮ ЭТА ФУНКЦИЯ НЕ ПЕРЕХОДИТ. Лиса — ВТОРОЙ индикатор,
 * а не единственный. Значок, смысл которого надо помнить наизусть,
 * это украшение, а не интерфейс: поэтому у неё есть подпись (title),
 * а выпадающий список режима никуда не девается. Решение «можно ли
 * отправить индикатор наружу» по-прежнему принимает TLP-гейт, а не
 * картинка.
 * ==================================================================== */
const FOX_STATES = {
  idle: {
    label: 'простой',
    seq: FOX_SEQUENCE,
  },
  busy: {
    label: 'идёт разбор',
    seq: [['run0', 110], ['run1', 110]],
  },
  found: {
    label: 'индикаторы найдены',
    seq: [['alert', 1400], ['idle1', 800], ['alert', 2000], ['blink', 130]],
  },
  client: {
    label: 'режим «клиентские данные»: публичные сервисы скрыты',
    // Намордник не моргает и не шевелится: это не событие, а режим.
    seq: [['muzzle', 5000]],
  },
  error: {
    label: 'последнее действие не выполнилось',
    seq: [['sleep', 4000]],
  },
};

/* Какое состояние показывать. Чистая функция — именно поэтому её можно
 * проверить тестом, а приоритеты обсудить, не читая код интерфейса.
 *
 * Порядок приоритетов не случаен:
 *   1. ОШИБКА важнее всего. Сбой, прикрытый бодрой картинкой, — худшее,
 *      что может сделать индикатор состояния.
 *   2. РАЗБОР идёт: видно, что инструмент занят, а не завис.
 *   3. РЕЖИМ КЛИЕНТСКИХ ДАННЫХ важнее находок. Находки видны в таблице
 *      и в счётчике, а режим больше нигде боковым зрением не виден,
 *      и цена ошибки в нём — отправленный наружу клиентский индикатор.
 *   4. НАХОДКИ.
 *   5. Простой. */
function foxStateFor(st = {}) {
  if (st.error) return 'error';
  if (st.busy) return 'busy';
  if (st.tlp === 'client') return 'client';
  if (Number(st.found) > 0) return 'found';
  return 'idle';
}

/* Начальный шаг последовательности.
 *
 * Нужен потому, что лис на странице теперь две: маленькая в шапке живёт
 * всегда, большая — пока ничего не разобрано. Запущенные с одного шага,
 * они моргают синхронно, и это сразу читается как анимация одного
 * объекта в двух местах. Сдвиг убирает совпадение. */
function normalizeOffset(offset) {
  const n = Number(offset);
  if (!Number.isFinite(n)) return 0;
  return ((Math.trunc(n) % FOX_SEQUENCE.length) + FOX_SEQUENCE.length) % FOX_SEQUENCE.length;
}

function startFox(canvas, opts = {}) {
  const scale = opts.scale || 4;
  const problems = validateFrames();
  if (problems.length) {
    // Не роняем страницу из-за картинки, но и не прячем поломку.
    console.warn('пиксельная лиса: кадры с ошибками\n' + problems.join('\n'));
    return { stop() {} };
  }

  canvas.width = FOX_SIZE * scale;
  canvas.height = FOX_SIZE * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const still = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) { drawFox(ctx, 'idle0', scale); return { stop() {} }; }

  let state = FOX_STATES[opts.state] ? opts.state : 'idle';
  let seq = FOX_STATES[state].seq;
  let step = normalizeOffset(opts.offset);
  let timer = null;
  const tick = () => {
    const [frame, hold] = seq[step % seq.length];
    drawFox(ctx, frame, scale);
    step++;
    timer = setTimeout(tick, hold);
  };
  tick();

  /* Вкладка не видна — кадры не рисуем. Консоль открыта постоянно,
   * и фоновая анимация в скрытой вкладке это просто расход батареи. */
  const onVis = () => {
    if (document.hidden) { clearTimeout(timer); timer = null; }
    else if (!timer) tick();
  };
  document.addEventListener('visibilitychange', onVis);

  return {
    /* Смена состояния. Возвращает применённое имя — вызывающему коду
     * не надо гадать, принято ли неизвестное состояние. */
    setState(next) {
      if (!FOX_STATES[next] || next === state) return state;
      state = next;
      seq = FOX_STATES[state].seq;
      step = 0;
      clearTimeout(timer);
      if (still) { drawFox(ctx, seq[0][0], scale); return state; }
      tick();
      return state;
    },
    get state() { return state; },
    label() { return FOX_STATES[state].label; },
    stop() {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}

const FOX_API = {
  FOX_FRAMES, FOX_PALETTE, FOX_SEQUENCE, FOX_STATES,
  validateFrames, drawFox, startFox, normalizeOffset, foxStateFor,
};
if (typeof module !== 'undefined' && module.exports) module.exports = FOX_API;
if (typeof globalThis !== 'undefined') globalThis.TIFox = FOX_API;
