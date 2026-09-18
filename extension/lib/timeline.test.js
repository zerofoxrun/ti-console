/* Проверка хронологии кейса и сводки для передачи смены. Запуск:
 *   node extension/lib/timeline.test.js
 *
 * Что здесь проверяется в первую очередь — не форматирование, а три
 * свойства, каждое из которых уже ломалось бы тихо:
 *   1. склейка событий не теряет данные и не выдумывает их;
 *   2. обрезка журнала не молчит о том, что обрезала;
 *   3. «требует решения» — проверяемый признак, а не настроение.
 */
'use strict';
const T = require('./timeline.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}
const iso = (ms) => new Date(Date.UTC(2026, 8, 15, 10, 0, 0) + ms).toISOString();

/* ------------------------------------------------ добавление событий */
{
  let tl = [];
  tl = T.addEvent(tl, { kind: 'case.started', title: 'Рассылка .lnk' }, { now: iso(0) });
  check('событие добавлено', tl.length === 1);
  check('время проставлено', tl[0].t === iso(0));
  check('поля события сохранены', tl[0].title === 'Рассылка .lnk');

  const before = tl;
  const after = T.addEvent(tl, { kind: 'ioc.added', count: 3 }, { now: iso(1000) });
  check('исходный массив не мутируется', before.length === 1 && after.length === 2,
        `before=${before.length} after=${after.length}`);

  check('событие без kind игнорируется',
        T.addEvent(after, { count: 5 }, { now: iso(2000) }).length === 2);
  check('мусор вместо журнала не роняет', T.addEvent(null, { kind: 'ioc.added', count: 1 }).length === 1);
}

/* ------------------------------------------------------------ склейка */
{
  let tl = [];
  tl = T.addEvent(tl, { kind: 'ioc.added', count: 3, source: 'ссылка' }, { now: iso(0) });
  tl = T.addEvent(tl, { kind: 'ioc.added', count: 4, source: 'ссылка' }, { now: iso(5000) });
  check('добавления из одного источника склеиваются', tl.length === 1, JSON.stringify(tl));
  check('счётчик при склейке суммируется', tl[0].count === 7, String(tl[0].count));

  tl = T.addEvent(tl, { kind: 'ioc.added', count: 2, source: 'файл' }, { now: iso(6000) });
  check('другой источник не склеивается', tl.length === 2);

  // Разные источники не должны складываться — иначе в сводке появится
  // «добавлено 9 из файла», чего не было.
  check('счётчик чужого источника отдельный', tl[1].count === 2);

  let far = [];
  far = T.addEvent(far, { kind: 'ioc.added', count: 1, source: 'текст' }, { now: iso(0) });
  far = T.addEvent(far, { kind: 'ioc.added', count: 1, source: 'текст' }, { now: iso(600000) });
  check('склейка не работает через десять минут', far.length === 2);
}

/* ---------------------------------------------------- склейка вердикта */
{
  let tl = [];
  tl = T.addEvent(tl, { kind: 'verdict.set', value: '1.2.3.4', from: 'unknown', to: 'malicious' }, { now: iso(0) });
  tl = T.addEvent(tl, { kind: 'verdict.set', value: '1.2.3.4', from: 'malicious', to: 'suspicious' }, { now: iso(3000) });
  check('перещёлкивание вердикта даёт одно событие', tl.length === 1, JSON.stringify(tl));
  check('склейка сохраняет ИСХОДНОЕ значение', tl[0].from === 'unknown', tl[0].from);
  check('склейка сохраняет ПОСЛЕДНЕЕ значение', tl[0].to === 'suspicious', tl[0].to);

  // Вернулись к исходному — события нет вовсе.
  let back = [];
  back = T.addEvent(back, { kind: 'verdict.set', value: 'evil.com', from: 'unknown', to: 'clean' }, { now: iso(0) });
  back = T.addEvent(back, { kind: 'verdict.set', value: 'evil.com', from: 'clean', to: 'unknown' }, { now: iso(1000) });
  check('возврат к исходному вердикту не оставляет события', back.length === 0,
        JSON.stringify(back));

  // Разные индикаторы не склеиваются никогда: это разные факты.
  let two = [];
  two = T.addEvent(two, { kind: 'verdict.set', value: 'a.com', from: 'unknown', to: 'malicious' }, { now: iso(0) });
  two = T.addEvent(two, { kind: 'verdict.set', value: 'b.com', from: 'unknown', to: 'malicious' }, { now: iso(1000) });
  check('вердикты разных индикаторов не склеиваются', two.length === 2);
}

/* ------------------------------------------------ что НЕ склеивается */
{
  let tl = [];
  tl = T.addEvent(tl, { kind: 'playbook.run', playbook: 'C2', value: '1.1.1.1', opened: 5 }, { now: iso(0) });
  tl = T.addEvent(tl, { kind: 'playbook.run', playbook: 'C2', value: '1.1.1.1', opened: 5 }, { now: iso(1000) });
  check('повторный запуск плейбука — отдельное событие', tl.length === 2,
        'два запуска это два факта, а не один');

  let ex = [];
  ex = T.addEvent(ex, { kind: 'export.done', format: 'CSV' }, { now: iso(0) });
  ex = T.addEvent(ex, { kind: 'export.done', format: 'CSV' }, { now: iso(1000) });
  check('повторный экспорт — отдельное событие', ex.length === 2);
}

/* ------------------------------------------------------------ обрезка */
{
  let tl = [];
  for (let i = 0; i < 12; i++) {
    tl = T.addEvent(tl, { kind: 'ioc.removed', value: `x${i}.com` }, { now: iso(i * 1000), cap: 5 });
  }
  check('журнал не превышает потолок', tl.length <= 5, String(tl.length));
  check('обрезка не молчит', tl[0].kind === T.KIND_TRUNCATED, JSON.stringify(tl[0]));
  check('счётчик обрезанного растёт', tl[0].n === 12 - (tl.length - 1), String(tl[0].n));
  check('последние события сохранены',
        tl[tl.length - 1].value === 'x11.com', tl[tl.length - 1].value);
  check('запись об обрезке одна', tl.filter((e) => e.kind === T.KIND_TRUNCATED).length === 1);
  check('обрезка читается словами', T.formatEvent(tl[0]).includes(String(tl[0].n)));
}

/* --------------------------------------------------------- отображение */
{
  check('известное событие читается по-русски',
        T.formatEvent({ kind: 'ioc.added', count: 7, source: 'ссылка' })
          .includes('добавлено в кейс: 7'));
  check('незнакомое событие не пропадает',
        T.formatEvent({ kind: 'какое-то.новое' }) === 'какое-то.новое');
  check('битое событие не роняет форматирование',
        typeof T.formatEvent({ kind: 'source.parsed' }) === 'string');
  check('время в формате ЧЧ:ММ', /^\d{2}:\d{2}$/.test(T.fmtTime(iso(0))), T.fmtTime(iso(0)));
  check('битое время не даёт Invalid Date', T.fmtTime('не дата') === '--:--');
  check('дата в формате ДД.ММ.ГГГГ', /^\d{2}\.\d{2}\.\d{4}$/.test(T.fmtDay(iso(0))));

  const days = T.groupByDay([
    { t: iso(0), kind: 'ioc.added', count: 1 },
    { t: iso(3600 * 1000), kind: 'ioc.added', count: 1 },
    { t: iso(30 * 3600 * 1000), kind: 'ioc.added', count: 1 },
  ]);
  check('события сгруппированы по дням', days.length === 2, JSON.stringify(days.map((d) => d.day)));
  check('внутри дня события не потерялись', days[0].events.length === 2);
  check('пустая хронология группируется в ничто', T.groupByDay([]).length === 0);
  check('отсутствующая хронология не роняет', T.groupByDay(undefined).length === 0);
}

/* ------------------------------------------------------------- сводка */
{
  const timeline = [
    { t: iso(0), kind: 'source.parsed', source: 'ссылка', found: 12, noise: 3 },
    { t: iso(1000), kind: 'ioc.added', count: 9, source: 'ссылка' },
    { t: iso(2000), kind: 'verdict.set', value: '45.151.45.31', from: 'unknown', to: 'malicious' },
    { t: iso(3000), kind: 'playbook.run', playbook: 'C2', value: '45.151.45.31', opened: 11, skipped: 2 },
    { t: iso(4000), kind: 'tools.opened', count: 3, value: 'evil.com' },
    { t: iso(5000), kind: 'export.done', format: 'CSV' },
  ];
  const w = T.summarizeWork(timeline);
  check('сводка работы: источники', w.sources === 1);
  check('сводка работы: добавлено', w.added === 9);
  check('сводка работы: вердикты', w.verdicts === 1);
  check('сводка работы: плейбуки', w.playbooks === 1);
  check('сводка работы: открыто сервисов считает и плейбук, и вручную',
        w.toolsOpened === 14, String(w.toolsOpened));
  check('сводка работы: границы времени', w.first === iso(0) && w.last === iso(5000));
  check('пустая хронология даёт нули', T.summarizeWork([]).added === 0);

  const items = [
    { value: '45.151.45.31', typeLabel: 'IPv4', verdict: 'malicious', verdictSource: 'VT 43/70' },
    { value: '46.166.79.31', typeLabel: 'IPv4', verdict: 'malicious', verdictSource: '' },
    { value: 'evil.com', typeLabel: 'Домен', verdict: 'suspicious', verdictSource: 'urlscan' },
    { value: 'ok.com', typeLabel: 'Домен', verdict: 'clean', verdictSource: 'вручную' },
    { value: 'd41d8cd98f00b204e9800998ecf8427e', typeLabel: 'MD5' },
    { value: 'guess.com', typeLabel: 'Домен', flags: ['ambiguous:refang'] },
    { value: 'shot.com', typeLabel: 'Домен', verdict: 'clean', verdictSource: 'глазами', needsVisualCheck: true },
  ];

  const nd = T.needsDecision(items);
  const values = nd.map((n) => n.value);
  check('вердикт без источника требует решения', values.includes('46.166.79.31'));
  check('индикатор с картинки требует решения', values.includes('shot.com'));
  check('бесскобочный дефанг требует решения', values.includes('guess.com'));
  check('проверенный с источником не требует решения', !values.includes('45.151.45.31'));
  check('непроверенный сам по себе НЕ требует решения', !values.includes('d41d8cd98f00b204e9800998ecf8427e'),
        'непроверенное — это раздел «что осталось», а не «требует решения»');
  check('причина названа словами', nd.every((n) => n.reasons.length > 0));

  const text = T.buildHandover({ title: 'Рассылка .lnk', tlp: 'TLP:AMBER', items, timeline, now: iso(6000) });
  check('в сводке есть все четыре раздела',
        ['ЧТО СДЕЛАНО', 'ЧТО УСТАНОВЛЕНО', 'ЧТО ОСТАЛОСЬ', 'ТРЕБУЕТ РЕШЕНИЯ'].every((s) => text.includes(s)));
  check('в сводке есть название кейса', text.includes('Рассылка .lnk'));
  check('в сводке есть TLP', text.includes('TLP:AMBER'));
  check('в сводке перечислены вредоносные', text.includes('45.151.45.31'));
  check('рядом с вердиктом указано, чем проверен', text.includes('VT 43/70'));
  check('непроверенный индикатор назван', text.includes('d41d8cd98f00b204e9800998ecf8427e'));
  check('в сводке есть счётчик непроверенных', /Не проверено: 2 из 7/.test(text), text);

  const empty = T.buildHandover({ items: [], timeline: [], now: iso(0) });
  check('пустой кейс не ломает сводку', empty.includes('Кейс пуст.'));
  check('пустая хронология объясняется, а не молчит', empty.includes('Действий не записано'));
  check('в пустой сводке нет ложных «требует решения»', /ТРЕБУЕТ РЕШЕНИЯ\n {2}Нет\./.test(empty), empty);
  check('сводка без аргументов не падает', typeof T.buildHandover() === 'string');

  // Длинные списки обязаны обрезаться с указанием остатка: сводка на
  // четыре экрана не читается, а «…и ещё N» читается.
  const many = Array.from({ length: 45 }, (_, n) => ({ value: `h${n}.com`, typeLabel: 'Домен' }));
  const longText = T.buildHandover({ items: many, timeline: [], now: iso(0) });
  check('длинный список непроверенных обрезан', longText.includes('…и ещё 15'), 'ожидалось 45-30');
  check('обрезка не скрывает общее число', longText.includes('Не проверено: 45 из 45'));
}

/* ------------------------------------------- хронология в скелет отчёта */
{
  const timeline = [
    { t: iso(0), kind: 'source.parsed', source: 'ссылка', found: 12, url: 'https://blog.example/r' },
    { t: iso(1000), kind: 'ioc.added', count: 9, source: 'ссылка' },
  ];
  const md = T.buildTimelineMarkdown(timeline);
  check('в markdown есть день', /\*\*\d{2}\.\d{2}\.\d{4}\*\*/.test(md), md);
  check('в markdown есть время', /`\d{2}:\d{2}`/.test(md), md);
  check('многострочное событие схлопнуто в строку', !/\n\s{2}https/.test(md), md);
  check('пустая хронология говорит об этом прямо',
        T.buildTimelineMarkdown([]).includes('не записывалась'));
  check('лимит событий соблюдается',
        T.buildTimelineMarkdown(
          Array.from({ length: 50 }, (_, n) => ({ t: iso(n * 1000), kind: 'ioc.removed', value: `x${n}` })),
          { limit: 10 },
        ).includes('первые 10'));
}

/* ------------------------------------------------- устойчивость к мусору */
{
  const junk = [{ t: 'нет', kind: 'verdict.set' }, { kind: 'ioc.added' }, {}, null];
  let ok = true;
  try {
    T.buildTimelineMarkdown(junk.filter(Boolean));
    T.summarizeWork(junk.filter(Boolean));
    T.buildHandover({ items: [null, {}].filter(Boolean), timeline: junk.filter(Boolean) });
  } catch (e) { ok = false; console.error(e); }
  check('битые записи не роняют сводку и отчёт', ok);
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
