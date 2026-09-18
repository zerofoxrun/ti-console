/* Проверка разделения кейсов. Запуск:
 *   node extension/lib/cases.test.js
 *
 * Здесь проверяется не «функция вернула объект», а четыре свойства,
 * ради которых всё и делалось:
 *   1. Кейсы РАЗДЕЛЕНЫ: индикаторы одного не видны в другом.
 *   2. Удаление кейса уносит и его хронологию — иначе «удалил»
 *      оставляет половину.
 *   3. Импорт создаёт НОВЫЙ кейс и никогда не дополняет активный.
 *   4. Отдельного поля «клиент» НЕТ (убрано решением заказчика),
 *      а уже введённая метка не теряется молча — она подклеивается
 *      к названию кейса.
 */
'use strict';
const C = require('./cases.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}
const NOW = '2026-09-16T10:00:00.000Z';
const item = (v) => ({ value: v, type: 'ipv4', typeLabel: 'IPv4' });

/* ------------------------------------------------------- создание ------ */
{
  let store = C.emptyStore();
  check('пустое хранилище без активного', C.activeCase(store) === null);

  const a = C.addCase(store, { title: 'фишинг .lnk', now: NOW, rnd: 0.1 });
  store = a.store;
  check('кейс создан', store.cases.length === 1);
  check('он сразу активен', C.activeCase(store).id === a.added.id);
  check('название сохранено', C.activeCase(store).title === 'фишинг .lnk');
  check('время проставлено', C.activeCase(store).createdAt === NOW);
  check('ОТДЕЛЬНОГО ПОЛЯ КЛИЕНТА НЕТ', !('client' in C.activeCase(store)),
        'убрано решением заказчика: имя заказчика пишется в названии кейса');

  const b = C.addCase(store, { title: 'C2', now: NOW, rnd: 0.9 });
  store = b.store;
  check('идентификаторы различаются', a.added.id !== b.added.id,
        `${a.added.id} / ${b.added.id}`);
  check('новый кейс становится активным', C.activeCase(store).title === 'C2',
        'иначе аналитик создаёт кейс и продолжает складывать в старый');
}

/* --------------------------------------- РАЗДЕЛЕНИЕ: главное свойство -- */
{
  let store = C.emptyStore();
  store = C.addCase(store, { title: 'первый', now: NOW, rnd: 0.1 }).store;
  const idA = store.activeId;
  store = C.updateCase(store, idA, { items: [item('1.1.1.1'), item('2.2.2.2')], now: NOW });

  store = C.addCase(store, { title: 'второй', now: NOW, rnd: 0.5 }).store;
  const idB = store.activeId;
  store = C.updateCase(store, idB, { items: [item('3.3.3.3')], now: NOW });

  check('в активном кейсе только свои индикаторы',
        C.activeCase(store).items.length === 1
        && C.activeCase(store).items[0].value === '3.3.3.3',
        JSON.stringify(C.activeCase(store).items.map((i) => i.value)));

  store = C.setActive(store, idA);
  check('переключение возвращает свои индикаторы',
        C.activeCase(store).items.map((i) => i.value).join() === '1.1.1.1,2.2.2.2');
  check('ИНДИКАТОРЫ КЕЙСОВ НЕ ПЕРЕМЕШАНЫ',
        !C.activeCase(store).items.some((i) => i.value === '3.3.3.3'),
        'ровно этот дефект и чинился');

  check('переключение на несуществующий кейс игнорируется',
        C.setActive(store, 'нет-такого').activeId === idA);
}

/* ------------------------------------------- удаление уносит хронологию */
{
  let store = C.emptyStore();
  store = C.addCase(store, { title: 'А', now: NOW, rnd: 0.2 }).store;
  const id = store.activeId;
  store = C.updateCase(store, id, {
    items: [item('9.9.9.9')],
    timeline: [{ t: NOW, kind: 'ioc.added', count: 1 }],
    now: NOW,
  });
  store = C.addCase(store, { title: 'Б', now: NOW, rnd: 0.3 }).store;

  const after = C.removeCase(store, id);
  check('кейс удалён', after.cases.length === 1);
  check('ХРОНОЛОГИЯ УДАЛЕНА ВМЕСТЕ С НИМ',
        !JSON.stringify(after).includes('9.9.9.9'),
        'иначе удалённый индикатор остаётся в профиле записью журнала');
  check('активный кейс переключён на оставшийся',
        after.activeId === after.cases[0].id);

  const last = C.removeCase(after, after.cases[0].id);
  check('удаление последнего оставляет пустое хранилище',
        last.cases.length === 0 && last.activeId === null);
}

/* ------------------------------------------------- перенос старого кейса */
{
  const legacy = {
    items: [item('45.151.45.31')],
    timeline: [{ t: NOW, kind: 'case.started' }],
  };
  const r = C.migrateLegacy(legacy, { now: NOW, rnd: 0.4 });
  check('старый кейс перенесён', r.migrated === true && r.store.cases.length === 1);
  check('индикаторы не потеряны', r.store.cases[0].items.length === 1);
  check('хронология не потеряна', r.store.cases[0].timeline.length === 1);
  check('название говорит, откуда кейс', /до разделения/.test(r.store.cases[0].title));

  const empty = C.migrateLegacy({ items: [], timeline: [] }, { now: NOW });
  check('пустой старый кейс не создаёт пустышку', empty.migrated === false);
  check('мусор вместо старого кейса не роняет', C.migrateLegacy(null).migrated === false);
}

/* ------------------------------------------------ устойчивость хранилища */
{
  const raw = {
    cases: [
      null,
      { id: 'ok', client: ' Банк А ', title: 'фишинг', items: [item('1.1.1.1')] },
      { title: 'без id' },
      'строка вместо кейса',
    ],
    activeId: 'нет-такого',
  };
  const store = C.normalizeStore(raw);
  check('битые записи выброшены', store.cases.length === 1, JSON.stringify(store.cases));
  /* Метка клиента из 0.28.0 не выбрасывается, а подклеивается
   * к названию: это текст, введённый руками. */
  check('МЕТКА КЛИЕНТА ПЕРЕЕХАЛА В НАЗВАНИЕ', store.cases[0].title === 'Банк А — фишинг',
        store.cases[0].title);
  check('поля клиента в модели больше нет', !('client' in store.cases[0]));
  check('повторного склеивания не происходит',
        C.normalizeStore({ cases: [{ id: 'y', client: 'Банк А', title: 'Банк А — фишинг' }] })
          .cases[0].title === 'Банк А — фишинг');
  check('кейс без метки не меняется',
        C.normalizeStore({ cases: [{ id: 'z', title: 'просто' }] }).cases[0].title === 'просто');
  check('несуществующий активный заменён первым', store.activeId === 'ok');
  check('отсутствующая хронология стала массивом', Array.isArray(store.cases[0].timeline));
  check('пустой вход даёт пустое хранилище', C.normalizeStore(undefined).cases.length === 0);
}

/* ------------------------------------------------------------- импорт -- */
{
  let store = C.emptyStore();
  store = C.addCase(store, { title: 'первый', now: NOW, rnd: 0.1 }).store;
  store = C.updateCase(store, store.activeId, { items: [item('1.1.1.1')], now: NOW });
  const idA = store.activeId;

  const file = {
    title: 'C2 из отчёта', tlp: 'TLP:RED',
    items: [item('3.3.3.3'), item('4.4.4.4')],
    timeline: [{ t: NOW, kind: 'ioc.added', count: 2 }],
  };
  const r = C.importCase(store, file, { now: NOW, rnd: 0.7 });
  check('импорт прошёл', r.ok === true, r.error);
  check('СОЗДАН НОВЫЙ КЕЙС, активный не тронут',
        r.store.cases.length === 2
        && r.store.cases.find((c) => c.id === idA).items.length === 1,
        'дополнение активного — это способ смешать двух клиентов одним кликом');
  check('импортированный стал активным', C.activeCase(r.store).title === 'C2 из отчёта');
  check('TLP взят из файла', C.activeCase(r.store).tlp === 'TLP:RED');
  check('хронология импортирована', C.activeCase(r.store).timeline.length === 1);

  const noTitle = C.importCase(store, { items: [item('5.5.5.5')] }, { now: NOW });
  check('файл без названия получает своё', noTitle.ok
        && C.activeCase(noTitle.store).title === 'Импортированный кейс');
  check('битые записи в файле пропущены с предупреждением',
        C.importCase(store, { items: [item('6.6.6.6'), null, { type: 'ipv4' }] }, { now: NOW })
          .warnings.some((w) => /без значения/.test(w)));
  check('не выгрузка кейса — отказ', C.importCase(store, { что: 'то' }).ok === false);
  check('мусор — отказ', C.importCase(store, null).ok === false);
}

/* ------------------------------------------------------------ подписи -- */
{
  const c = C.newCase({ title: 'фишинг .lnk', now: NOW, items: [item('1.1.1.1')] });
  check('в подписи есть название', C.caseLabel(c).startsWith('фишинг .lnk'), C.caseLabel(c));
  check('в подписи есть число индикаторов', /\(1\)$/.test(C.caseLabel(c)), C.caseLabel(c));
  const noTitle = C.newCase({ now: NOW });
  check('безымянный кейс подписан честно', /без названия/.test(C.caseLabel(noTitle)));
  check('в подписи нет ничего про клиента', !/клиент/i.test(C.caseLabel(c)));
}

/* -------------------------- добавление из боковой панели и вкладки ----- */
{
  /* Панель писала в старый ключ ti_case_items, вкладка читала ti_cases —
   * «В кейс» из панели молча никуда не попадало. Общая точка входа
   * закрывает расхождение; проверяем её правила. */
  let store = C.emptyStore();
  const r0 = C.addItemsToActive(store, [item('1.1.1.1')], { now: NOW, rnd: 0.1 });
  check('в пустом хранилище кейс создаётся сам', r0.ok && r0.созданКейс === true);
  check('индикатор действительно лёг в кейс',
        C.activeCase(r0.store).items[0].value === '1.1.1.1');
  check('созданный кейс без названия — чтобы его назвали',
        C.activeCase(r0.store).title === '',
        'правдоподобная выдумка хуже видимого пробела');
  check('проставлен источник', C.activeCase(r0.store).items[0].source === 'страница');

  const r1 = C.addItemsToActive(r0.store, [item('1.1.1.1'), item('2.2.2.2')], { now: NOW });
  check('повтор не дублируется', r1.added === 1 && r1.повторов === 1);
  check('в кейсе стало два', C.activeCase(r1.store).items.length === 2);

  /* Главное свойство: панель кладёт ТОЛЬКО в активный кейс. */
  let two = C.addCase(r1.store, { title: 'второй', now: NOW, rnd: 0.6 }).store;
  const idВторой = two.activeId;
  const r2 = C.addItemsToActive(two, [item('3.3.3.3')], { now: NOW });
  check('ДОБАВЛЯЕТСЯ ТОЛЬКО В АКТИВНЫЙ КЕЙС',
        C.activeCase(r2.store).id === idВторой
        && C.activeCase(r2.store).items.length === 1
        && r2.store.cases.find((c) => c.id !== idВторой).items.length === 2,
        'иначе панель — способ смешать двух заказчиков одним кликом');
  check('новый кейс при этом не создаётся', r2.созданКейс === false);

  check('мусор вместо списка не роняет', C.addItemsToActive(two, null, { now: NOW }).added === 0);
  check('запись без значения пропускается',
        C.addItemsToActive(two, [{ type: 'ipv4' }, null], { now: NOW }).added === 0);
  check('хранилище из старой сборки принимается',
        C.addItemsToActive({ cases: [{ id: 'x', title: 'т', items: [] }], activeId: 'x' },
                           [item('4.4.4.4')], { now: NOW }).added === 1);
}

/* --------------------------------------------------------- проблемы ---- */
{
  let store = C.emptyStore();
  check('без кейсов проблема названа', C.storeProblems(store)[0] === 'активный кейс не выбран');

  store = C.addCase(store, { title: '', now: NOW, rnd: 0.1 }).store;
  check('безымянный кейс — проблема',
        C.storeProblems(store).some((p) => /нет названия/.test(p)),
        JSON.stringify(C.storeProblems(store)));

  store = C.addCase(store, { title: 'названный', now: NOW, rnd: 0.2 }).store;
  check('у названного кейса проблем нет', C.storeProblems(store).length === 0,
        JSON.stringify(C.storeProblems(store)));
  check('про клиента больше не спрашивается',
        !C.storeProblems(store).some((p) => /клиент/i.test(p)));
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
