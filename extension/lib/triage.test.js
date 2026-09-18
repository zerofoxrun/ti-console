/* Входящие на триаж. Запуск: node extension/lib/triage.test.js
 *
 * Очередь существует ради одного свойства: разобранное не исчезает
 * при следующем разборе. Всё остальное здесь — про то, чтобы очередь
 * не превратилась в шум, который проще игнорировать целиком:
 *   - то, что уже в кейсе, в неё не попадает;
 *   - отклонённое не всплывает снова;
 *   - обрезка по потолку не молчаливая.
 */
'use strict';
const T = require('./triage.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}
const it = (v, type = 'ipv4') => ({ type, typeLabel: type, value: v });
const T1 = '2026-09-16T10:00:00.000Z';
const values = (s) => s.items.map((i) => i.value);

/* ------------------------------- главное: разбор не теряется ----------- */
{
  let s = T.emptyStore();
  s = T.addMany(s, [it('1.1.1.1'), it('2.2.2.2')], { source: 'письмо', now: T1 }).store;
  const r = T.addMany(s, [it('3.3.3.3')], { source: 'отчёт', now: T1 });
  s = r.store;
  check('ПЕРВЫЙ РАЗБОР ПЕРЕЖИЛ ВТОРОЙ', values(s).join() === '1.1.1.1,2.2.2.2,3.3.3.3',
        values(s).join());
  check('источник у каждого свой',
        s.items.find((i) => i.value === '1.1.1.1').source === 'письмо'
        && s.items.find((i) => i.value === '3.3.3.3').source === 'отчёт');
  check('добавлено посчитано', r.added === 1);
}

/* ---------------------------------------- повтор не плодит строки ------ */
{
  let s = T.addMany(T.emptyStore(), [it('1.1.1.1')], { now: T1 }).store;
  const r = T.addMany(s, [it('1.1.1.1')], { now: T1 });
  check('повтор не добавляет строку', r.store.items.length === 1);
  check('повтор увеличивает счётчик', r.store.items[0].count === 2);
  check('и назван повтором', r.повторов === 1 && r.added === 0);
}

/* --------------------------------- то, что уже в кейсе, не предлагается */
{
  const s = T.addMany(T.emptyStore(), [it('1.1.1.1'), it('2.2.2.2')],
                      { now: T1, inCase: [it('1.1.1.1')] });
  check('УЖЕ В КЕЙСЕ — В ОЧЕРЕДЬ НЕ ПОПАДАЕТ', values(s.store).join() === '2.2.2.2',
        values(s.store).join());
  check('и это посчитано', s.вКейсе === 1);
  const строками = T.addMany(T.emptyStore(), [it('9.9.9.9')],
                             { now: T1, inCase: ['ipv4|9.9.9.9'] });
  check('кейс можно передать готовыми ключами', строками.store.items.length === 0);
}

/* ------------------------------------------- отбой помнится ------------ */
{
  let s = T.addMany(T.emptyStore(), [it('1.1.1.1'), it('2.2.2.2')], { now: T1 }).store;
  s = T.dismiss(s, ['ipv4|1.1.1.1'], T1);
  check('отклонённое ушло из очереди', values(s).join() === '2.2.2.2');

  const снова = T.addMany(s, [it('1.1.1.1')], { now: T1 });
  check('ОТКЛОНЁННОЕ НЕ ВСПЛЫВАЕТ СНОВА', values(снова.store).join() === '2.2.2.2',
        'иначе очередь превращается в шум, который игнорируют целиком');
  check('и это посчитано', снова.отклонено === 1);

  const забыли = T.forgetDismissed(снова.store);
  const вернулось = T.addMany(забыли, [it('1.1.1.1')], { now: T1 });
  check('отбой можно пересмотреть', вернулось.store.items.length === 2);
}

/* ------------------------------------------ отбой не вечен ------------- */
{
  let s = T.addMany(T.emptyStore(), [it('1.1.1.1')], { now: T1 }).store;
  s = T.dismiss(s, ['ipv4|1.1.1.1'], '2026-01-01T00:00:00.000Z');   // давно
  const поздно = T.addMany(s, [it('1.1.1.1')], { now: T1 });
  check('старый отбой забывается', поздно.store.items.some((i) => i.value === '1.1.1.1'),
        `срок ${T.DISMISS_DAYS} дней`);
}

/* --------------------------------------- перенос в кейс без отбоя ------ */
{
  let s = T.addMany(T.emptyStore(), [it('1.1.1.1'), it('2.2.2.2')], { now: T1 }).store;
  s = T.take(s, ['ipv4|1.1.1.1']);
  check('взятое ушло из очереди', values(s).join() === '2.2.2.2');
  check('взятое НЕ попало в отбой', s.dismissed.length === 0,
        'иначе индикатор, удалённый потом из кейса, уже не вернётся в очередь');
}

/* ------------------------------------------------ обрезка вслух -------- */
{
  let s = T.emptyStore();
  const много = Array.from({ length: T.MAX_ITEMS + 25 }, (_, k) => it(`10.0.${(k / 256) | 0}.${k % 256}`));
  s = T.addMany(s, много, { now: T1 }).store;
  check('очередь обрезана по потолку', s.items.length === T.MAX_ITEMS, String(s.items.length));
  check('ОБРЕЗКА ЗАПОМНЕНА', s.truncated === 25, String(s.truncated));
  check('обрезали самое старое', s.items[0].value !== '10.0.0.0');
  check('сводка называет обрезанное', T.summary(s).обрезано === 25);
}

/* ------------------------------------------------------ устойчивость --- */
{
  check('мусор вместо хранилища', T.normalize(null).items.length === 0);
  check('мусор вместо находок', T.addMany(T.emptyStore(), null, { now: T1 }).added === 0);
  check('записи без значения пропускаются',
        T.addMany(T.emptyStore(), [{ type: 'ipv4' }, null, it('1.1.1.1')], { now: T1 }).added === 1);
  check('битые записи в хранилище выброшены',
        T.normalize({ items: [null, 'строка', { value: 'x' }, it('1.1.1.1')] }).items.length === 1);
  const сводка = T.summary(T.addMany(T.emptyStore(),
    [it('1.1.1.1'), it('evil.top', 'domain')], { now: T1 }).store);
  check('сводка считает по типам', сводка.всего === 2 && сводка.поТипам.ipv4 === 1);
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
