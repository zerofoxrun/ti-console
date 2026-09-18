/* Проверка кадров пиксельной лисы. Запуск:
 *   node extension/newtab/fox.test.js
 *
 * Кажется мелочью, но ловит ровно ту ошибку, которую глазами на 16x16
 * не увидеть: кириллическая «о» вместо латинской. Палитра такой символ
 * не знает, пиксель молча пропадает, и найти это можно только пристально
 * сличая матрицу с картинкой.
 */
'use strict';
const F = require('./fox.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}

const problems = F.validateFrames();
check('все кадры валидны', problems.length === 0, problems.join('\n        '));

check('кадры на месте', Object.keys(F.FOX_FRAMES).length >= 3);
for (const [name, rows] of Object.entries(F.FOX_FRAMES)) {
  check(`${name}: 16 строк`, rows.length === 16);
  check(`${name}: все строки по 16`, rows.every((r) => r.length === 16));
  check(`${name}: только ASCII`, rows.every((r) => /^[\x20-\x7e]*$/.test(r)),
        'кириллица в матрице даёт молча пропавший пиксель');
  check(`${name}: непустой`, rows.join('').replace(/\./g, '').length > 40);
}

// Моргание — та же поза, что idle0: меняются только глаза.
{
  const a = F.FOX_FRAMES.idle0, b = F.FOX_FRAMES.blink;
  const diff = a.map((r, y) => [...r].filter((c, x) => c !== b[y][x]).length)
    .reduce((s, n) => s + n, 0);
  check('моргание меняет только глаза', diff > 0 && diff <= 6, `изменено пикселей: ${diff}`);
}

// Последовательность: кадры существуют, паузы разумные.
for (const [frame, hold] of F.FOX_SEQUENCE) {
  check(`в последовательности есть кадр ${frame}`, !!F.FOX_FRAMES[frame]);
  check(`пауза ${frame} разумна`, hold >= 100 && hold <= 6000, String(hold));
}
// Ровный «мультик» в рабочем инструменте отвлекает: лиса должна
// в основном просто сидеть.
{
  const total = F.FOX_SEQUENCE.reduce((s, [, h]) => s + h, 0);
  const idle0 = F.FOX_SEQUENCE.filter(([f]) => f === 'idle0').reduce((s, [, h]) => s + h, 0);
  check('большую часть времени лиса неподвижна', idle0 / total > 0.6,
        `${Math.round(idle0 / total * 100)}%`);
}

/* --------------------------------------------- состояния лисы ------- */
{
  // Приоритеты — не вкусовщина, а решение, которое должно быть видно
  // в тесте: ошибка важнее занятости, режим данных важнее находок.
  check('простой', F.foxStateFor({}) === 'idle');
  check('разбор идёт', F.foxStateFor({ busy: true }) === 'busy');
  check('найдено', F.foxStateFor({ found: 3 }) === 'found');
  check('клиентский режим', F.foxStateFor({ tlp: 'client' }) === 'client');
  check('ошибка', F.foxStateFor({ error: true }) === 'error');

  check('ОШИБКА важнее занятости',
        F.foxStateFor({ error: true, busy: true }) === 'error',
        'сбой, прикрытый бодрой картинкой, — худшее, что может сделать индикатор');
  check('занятость важнее режима', F.foxStateFor({ busy: true, tlp: 'client' }) === 'busy');
  check('РЕЖИМ важнее находок',
        F.foxStateFor({ tlp: 'client', found: 9 }) === 'client',
        'находки видны в таблице, режим — больше нигде');
  check('ноль находок это не находка', F.foxStateFor({ found: 0 }) === 'idle');
  check('мусор в found не ломает', F.foxStateFor({ found: 'много' }) === 'idle');
  check('неизвестный режим данных не даёт намордник',
        F.foxStateFor({ tlp: 'какой-то' }) === 'idle');
  check('без аргументов не падает', F.foxStateFor() === 'idle');

  // Каждое состояние обязано ссылаться на существующие кадры и иметь
  // подпись: значок без подписи — это загадка, а не интерфейс.
  for (const [name, st] of Object.entries(F.FOX_STATES)) {
    check(`${name}: есть подпись`, typeof st.label === 'string' && st.label.length > 3);
    check(`${name}: непустая последовательность`, Array.isArray(st.seq) && st.seq.length > 0);
    check(`${name}: все кадры существуют`,
          st.seq.every(([f]) => !!F.FOX_FRAMES[f]),
          st.seq.map(([f]) => f).join(','));
    check(`${name}: паузы разумные`,
          st.seq.every(([, h]) => h >= 100 && h <= 6000),
          JSON.stringify(st.seq.map(([, h]) => h)));
  }
  // Состояния обязаны РАЗЛИЧАТЬСЯ первым кадром, иначе индикатор
  // ничего не индицирует.
  const firsts = Object.values(F.FOX_STATES).map((st) => st.seq[0][0]);
  check('первые кадры состояний различны', new Set(firsts).size === firsts.length,
        firsts.join(','));
  // Разбор — единственное состояние, где анимация быстрая.
  check('бег заметно быстрее простоя',
        F.FOX_STATES.busy.seq.every(([, h]) => h <= 200));
  check('намордник не мельтешит', F.FOX_STATES.client.seq.length === 1);
}

/* Сдвиг последовательности. Лис на странице две (шапка и пустая выдача),
 * и запущенные с одного шага они моргают синхронно — это читается как
 * одна анимация в двух местах, то есть как ошибка. */
{
  const N = F.FOX_SEQUENCE.length;
  check('сдвиг 0 — начало последовательности', F.normalizeOffset(0) === 0);
  check('сдвиг в пределах длины не меняется', F.normalizeOffset(3) === 3 % N);
  check('сдвиг больше длины заворачивается', F.normalizeOffset(N + 2) === 2 % N);
  check('отрицательный сдвиг заворачивается вперёд',
        F.normalizeOffset(-1) === (N - 1) % N, String(F.normalizeOffset(-1)));
  check('мусор вместо сдвига не роняет лису', F.normalizeOffset(undefined) === 0
        && F.normalizeOffset('нет') === 0 && F.normalizeOffset(NaN) === 0);
  check('сдвиг всегда индекс существующего кадра',
        [0, 1, 5, 99, -7].every((o) => !!F.FOX_SEQUENCE[F.normalizeOffset(o)]));
  // Сдвиг, которым пользуется шапка, обязан давать ДРУГОЙ кадр, иначе
  // смысла в нём нет. Проверяем тот, что стоит в newtab.js.
  const HEADER_OFFSET = 3;
  check('сдвиг шапки расходится с началом',
        F.FOX_SEQUENCE[F.normalizeOffset(HEADER_OFFSET)][0] !== F.FOX_SEQUENCE[0][0],
        `оба кадра ${F.FOX_SEQUENCE[0][0]}`);
}

/* Отрисовка не должна зависеть от окружения браузера: drawFox получает
 * контекст и обязан обращаться к нему предсказуемо. Подсовываем заглушку
 * и считаем вызовы — заодно ловим кадр, который рисует пустоту. */
{
  const calls = [];
  const ctx = {
    set fillStyle(v) { calls.push(['color', v]); },
    clearRect() { calls.push(['clear']); },
    fillRect(x, y, w, h) { calls.push(['rect', x, y, w, h]); },
  };
  F.drawFox(ctx, 'idle0', 3);
  const rects = calls.filter((c) => c[0] === 'rect');
  check('перед кадром холст очищается', calls[0] && calls[0][0] === 'clear');
  check('кадр рисует пиксели', rects.length > 80, `нарисовано ${rects.length}`);
  check('пиксели кратны масштабу', rects.every((r) => r[1] % 3 === 0 && r[2] % 3 === 0));
  check('размер пикселя равен масштабу', rects.every((r) => r[3] === 3 && r[4] === 3));
  check('ни один пиксель не вышел за 16×16',
        rects.every((r) => r[1] >= 0 && r[2] >= 0 && r[1] < 48 && r[2] < 48));
  const colors = new Set(calls.filter((c) => c[0] === 'color').map((c) => c[1]));
  check('в кадре больше одного цвета', colors.size >= 3, [...colors].join(' '));
  check('прозрачный символ не рисуется', !colors.has(null) && !colors.has(undefined));
}

/* Неизвестный кадр не должен ронять страницу: лиса — украшение,
 * и опечатка в имени кадра не повод оставить аналитика без консоли. */
{
  let threw = false;
  const ctx = { set fillStyle(v) {}, clearRect() {}, fillRect() {} };
  try { F.drawFox(ctx, 'нет-такого-кадра', 2); } catch (e) { threw = true; }
  check('неизвестный кадр не выбрасывает исключение', !threw);
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
