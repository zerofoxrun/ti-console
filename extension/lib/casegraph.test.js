/* Схема кейса. Запуск: node extension/lib/casegraph.test.js
 *
 * Главное, что здесь проверяется, — чего в схеме НЕТ.
 *
 * Картинка убеждает сильнее таблицы: ребро между двумя хостами аналитик
 * прочитает как «они связаны» и понесёт это в отчёт. Поэтому рёбра только
 * двух видов, оба вычисляются из самих значений, и ни одно не появляется
 * из догадки. Узел, которого аналитик не добавлял, не дорисовывается —
 * это был бы тот же выдуманный индикатор, только нарисованный.
 */
'use strict';
const G = require('./casegraph.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}
const it = (type, value, source) => ({ type, typeLabel: type, value, source });
const edgesOf = (g, kind) => g.edges.filter((e) => e.kind === kind);
const nodeOf = (g, label) => g.nodes.find((n) => n.label === label);
const hasEdge = (g, fromLabel, toLabel, kind) => {
  const a = nodeOf(g, fromLabel); const b = nodeOf(g, toLabel);
  return !!(a && b && g.edges.some((e) => e.from === a.id && e.to === b.id && e.kind === kind));
};

/* ------------------------------------------------- «из источника» ------ */
{
  const g = G.buildGraph([
    it('ipv4', '1.1.1.1', 'report.pdf'),
    it('domain', 'evil.top', 'report.pdf'),
    it('md5', 'd41d8cd98f00b204e9800998ecf8427e', 'вставленный текст'),
  ]);
  check('источники стали узлами', g.sources.length === 2,
        g.sources.map((s) => s.label).join(', '));
  check('каждый индикатор привязан к источнику', edgesOf(g, 'from-source').length === 3);
  check('ИНДИКАТОРЫ НЕ СОЕДИНЕНЫ ДРУГ С ДРУГОМ НАПРЯМУЮ',
        !g.edges.some((e) => e.kind === 'from-source'
          && g.nodes.find((n) => n.id === e.to).kind === 'ioc'),
        'иначе «встретились в одном источнике» превращается в паутину из n² линий');
  check('у ребра есть объяснение', edgesOf(g, 'from-source').every((e) => /извлечён из/.test(e.why)));
  check('источник считает своих', g.sources.find((s) => s.label === 'report.pdf').count === 2);

  const безИсточника = G.buildGraph([{ type: 'ipv4', value: '8.8.8.8' }]);
  check('без источника узел-источник не выдумывается', безИсточника.sources.length === 0);
}

/* --------------------------------------------------- «часть целого» ---- */
{
  const g = G.buildGraph([
    it('url', 'https://panel.evil.top/gate.php', 'a'),
    it('domain', 'panel.evil.top', 'a'),
    it('domain', 'evil.top', 'a'),
    it('email', 'billing@evil.top', 'a'),
    it('ipv4', '185.220.101.34', 'a'),
    it('cidr', '185.220.101.0/24', 'a'),
    it('onion', 'expyuzz4wqqyqhjn.onion', 'a'),
  ]);
  check('URL → его хост', hasEdge(g, 'https://panel.evil.top/gate.php', 'panel.evil.top', 'part-of'));
  check('поддомен → домен', hasEdge(g, 'panel.evil.top', 'evil.top', 'part-of'));
  check('почта → домен', hasEdge(g, 'billing@evil.top', 'evil.top', 'part-of'));
  check('адрес → подсеть', hasEdge(g, '185.220.101.34', '185.220.101.0/24', 'part-of'));
  check('у каждого такого ребра есть объяснение',
        edgesOf(g, 'part-of').every((e) => e.why && e.why.length > 5));
  check('onion без родителя ни к чему не цепляется',
        !g.edges.some((e) => e.from === nodeOf(g, 'expyuzz4wqqyqhjn.onion').id && e.kind === 'part-of'));
}

/* ------------------------ узлы не дорисовываются: главное ограничение -- */
{
  /* Домена evil.top в кейсе НЕТ. Нарисовать его «потому что он есть
   * в URL» — значит показать индикатор, которого аналитик не добавлял. */
  const g = G.buildGraph([
    it('url', 'https://evil.top/a', 'a'),
    it('email', 'x@evil.top', 'a'),
  ]);
  check('ОТСУТСТВУЮЩИЙ ДОМЕН НЕ ДОРИСОВЫВАЕТСЯ', !nodeOf(g, 'evil.top'),
        'узел, которого аналитик не добавлял, — это выдуманный индикатор');
  check('и рёбер «часть целого» тогда нет', edgesOf(g, 'part-of').length === 0);
}

/* ------------------------------------ ближайший предок, а не любой ----- */
{
  const g = G.buildGraph([
    it('domain', 'b.a.evil.top', 'x'),
    it('domain', 'a.evil.top', 'x'),
    it('domain', 'evil.top', 'x'),
  ]);
  check('поддомен цепляется к БЛИЖАЙШЕМУ предку',
        hasEdge(g, 'b.a.evil.top', 'a.evil.top', 'part-of')
        && !hasEdge(g, 'b.a.evil.top', 'evil.top', 'part-of'));
}

/* --------------------------------------------------------- подсети ----- */
{
  check('адрес внутри подсети', G.ipInCidr('10.1.2.3', '10.1.2.0/24'));
  check('адрес снаружи подсети', !G.ipInCidr('10.1.3.3', '10.1.2.0/24'));
  check('/32 — ровно один адрес',
        G.ipInCidr('10.1.2.3', '10.1.2.3/32') && !G.ipInCidr('10.1.2.4', '10.1.2.3/32'));
  check('/0 — все', G.ipInCidr('8.8.8.8', '0.0.0.0/0'));
  check('мусор не роняет', !G.ipInCidr('не адрес', '10.0.0.0/8') && !G.ipInCidr('1.2.3.4', 'мусор'));
  check('битая маска отвергается', !G.ipInCidr('1.2.3.4', '1.2.3.4/33'));
}

/* ---------------------------------------------------------- порог ------ */
{
  const мало = G.buildGraph(Array.from({ length: 10 }, (_, k) => it('ipv4', `10.0.0.${k}`, 's')));
  check('десять индикаторов — схему не показываем', мало.enough === false);
  check('и сказано почему', /больше 10/.test(G.whyNotShown(мало)), G.whyNotShown(мало));

  const хватит = G.buildGraph(Array.from({ length: 11 }, (_, k) => it('ipv4', `10.0.0.${k}`, 's')));
  check('одиннадцать — показываем', хватит.enough === true);
  check('когда показываем, объяснения нет', G.whyNotShown(хватит) === '');
}

/* ------------------------------------------------------- устойчивость -- */
{
  check('пустой кейс не роняет', G.buildGraph([]).nodes.length === 0);
  check('мусор не роняет', G.buildGraph(null).total === 0);
  check('записи без значения пропускаются',
        G.buildGraph([{ type: 'ipv4' }, null, it('ipv4', '1.1.1.1', 's')]).total === 1);

  const дубли = G.buildGraph([it('ipv4', '1.1.1.1', 's'), it('ipv4', '1.1.1.1', 's')]);
  check('повтор значения — один узел', дубли.total === 1);
  check('и одно ребро', дубли.edges.length === 1);

  const регистр = G.buildGraph([
    it('url', 'https://EVIL.top/a', 's'), it('domain', 'evil.top', 's'),
  ]);
  check('регистр хоста не мешает связать', hasEdge(g0(регистр), 'https://EVIL.top/a', 'evil.top', 'part-of'));
  function g0(x) { return x; }
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
