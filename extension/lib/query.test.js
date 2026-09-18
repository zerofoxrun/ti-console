/* Проверка сборки поискового запроса. Запуск:
 *   node extension/lib/query.test.js
 *
 * Все три дефекта, которые здесь ловятся, выглядели одинаково — «ничего
 * не найдено». Это худший класс ошибок в поиске: пустая выдача неотличима
 * от честного «ничего нет», и аналитик делает вывод об отсутствии данных
 * там, где был противоречивый запрос.
 */
'use strict';
const Q = require('./query.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}

/* ============ 1. ГЛАВНЫЙ ДЕФЕКТ: два набора site: через И ============ */
{
  /* Именно это поймала эксплуатация: шаблон «Свежие обсуждения» дал
   * (site:x.com OR site:infosec.exchange OR site:reddit.com), а профиль
   * «Отчёты вендоров» добавил свои девятнадцать. Страница не может лежать
   * на x.com и на unit42.paloaltonetworks.com одновременно. */
  const r = Q.buildQuery({
    query: 'группировка (site:x.com OR site:infosec.exchange OR site:reddit.com)',
    domains: ['unit42.paloaltonetworks.com', 'securelist.com'],
    scoped: true,
  });
  check('профиль не добавляется к шаблону со своими площадками',
        !r.q.includes('unit42'), r.q);
  check('в запросе ровно одна группа site:',
        (r.q.match(/\(\s*site:/g) || []).length === 1, r.q);
  check('про неприменённый профиль сказано', r.warnings.some((w) => /профиль/.test(w)));

  // -site: это исключение, а не сужение: с профилем оно сочетается.
  check('-site: не считается заданием площадок',
        !Q.dorkSetsScope('{{q}} -site:virustotal.com -site:abuseipdb.com'));
  check('site: в начале распознаётся', Q.dorkSetsScope('site:github.com {{q}}'));
  check('site: после скобки распознаётся',
        Q.dorkSetsScope('{{q}} (site:pastebin.com OR site:rentry.co)'));
  check('обычный шаблон площадок не задаёт', !Q.dorkSetsScope('{{q}} filetype:pdf'));

  const ok = Q.buildQuery({
    query: 'emotet -site:virustotal.com',
    domains: ['securelist.com', 'welivesecurity.com'],
    scoped: false,
  });
  check('исключающий шаблон сочетается с профилем',
        ok.q.includes('site:securelist.com') && ok.q.includes('-site:virustotal.com'), ok.q);
}

/* ============ 2. site: НЕ ПОНИМАЕТ ПУТЬ ============ */
{
  /* В профиле «Отчёты вендоров» десять записей из девятнадцати — с путём.
   * DuckDuckGo путь в site: игнорирует или отдаёт ноль. Даже без первого
   * дефекта половина профиля работала бы не так, как записана. */
  check('путь отбрасывается', Q.hostOf('crowdstrike.com/blog') === 'crowdstrike.com');
  check('глубокий путь отбрасывается',
        Q.hostOf('cloud.google.com/blog/topics/threat-intelligence') === 'cloud.google.com');
  check('домен без пути не меняется', Q.hostOf('securelist.com') === 'securelist.com');
  check('регистр приводится', Q.hostOf('Securelist.COM') === 'securelist.com');
  check('путь обнаруживается', Q.hasPath('bi.zone/expertise'));
  check('у домена без пути пути нет', !Q.hasPath('securelist.com'));

  const r = Q.buildQuery({
    query: 'lockbit',
    domains: ['crowdstrike.com/blog', 'securelist.com'],
  });
  check('в site: попадает только хост',
        r.q.includes('site:crowdstrike.com') && !r.q.includes('/blog'), r.q);
  check('про потерю точности сказано',
        r.warnings.some((w) => /раздел сайта/.test(w)), JSON.stringify(r.warnings));

  // Два раздела одного домена после отбрасывания пути — это один site:.
  const dup = Q.buildQuery({
    query: 'x',
    domains: ['github.com/SigmaHQ/sigma', 'github.com/elastic/detection-rules', 'github.com'],
  });
  check('дубли хостов схлопываются', dup.used.length === 1, JSON.stringify(dup.used));
  check('и в запросе он один раз',
        (dup.q.match(/site:github\.com/g) || []).length === 1, dup.q);
}

/* ============ 3. УСЕЧЕНИЕ СПИСКА ПЛОЩАДОК ============ */
{
  const many = Array.from({ length: 19 }, (_, i) => `site${i}.example`);
  const r = Q.buildQuery({ query: 'x', domains: many, limit: 8 });
  check('берётся ровно предел', r.used.length === 8, String(r.used.length));
  check('отброшенные перечислены', r.dropped.length === 11);
  check('про усечение сказано', r.warnings.some((w) => /предел длины/.test(w)));

  const all = Q.buildQuery({ query: 'x', domains: many, limit: 0 });
  check('limit=0 берёт все', all.used.length === 19);
  check('без усечения предупреждения нет',
        !all.warnings.some((w) => /предел длины/.test(w)));
}

/* ====== 3b. ПРИ УСЕЧЕНИИ ПРИОРИТЕТ У ПЛОЩАДОК БЕЗ ПУТИ ====== */
{
  /* Брать первые попавшиеся нельзя: microsoft.com/en-us/security/blog
   * после отбрасывания пути становится site:microsoft.com и топит выдачу
   * всем остальным майкрософтом. Площадка с собственным хостом даёт
   * точный результат — она и должна попасть в ограниченный список. */
  const r = Q.buildQuery({
    query: 'x',
    domains: ['microsoft.com/en-us/security/blog', 'securelist.com',
              'crowdstrike.com/blog', 'thedfirreport.com'],
    limit: 2,
  });
  check('в усечённый список идут хосты без пути',
        r.used.join(',') === 'securelist.com,thedfirreport.com', r.used.join(','));
  check('с путём отброшены',
        r.dropped.join(',') === 'microsoft.com,crowdstrike.com', r.dropped.join(','));

  // Порядок внутри группы — из профиля, он там осмысленный.
  const order = Q.buildQuery({
    query: 'x', domains: ['b.example', 'a.example', 'c.example'], limit: 3,
  });
  check('порядок профиля сохраняется', order.used.join(',') === 'b.example,a.example,c.example');

  // Без усечения порядок не трогаем вовсе: SearXNG берёт все площадки.
  const full = Q.buildQuery({
    query: 'x', domains: ['m.example/path', 'a.example'], limit: 0,
  });
  check('без усечения порядок исходный', full.used.join(',') === 'm.example,a.example', full.used.join(','));

  /* Дедупликация и путь считаются по одной записи, а не по номеру
   * в двух массивах: на первом же дубле индексы разъезжаются. */
  const dedup = Q.buildQuery({
    query: 'x',
    domains: ['github.com/SigmaHQ/sigma', 'github.com/elastic/detection-rules', 'clean.example'],
    limit: 1,
  });
  check('после дедупликации путь не теряется',
        dedup.used.join(',') === 'clean.example', dedup.used.join(','));
}

/* ============ 4. ВЫРОЖДЕННЫЕ СЛУЧАИ ============ */
{
  const empty = Q.buildQuery({ query: 'lockbit', domains: [] });
  check('без площадок запрос остаётся запросом', empty.q === 'lockbit', empty.q);
  check('без площадок нет пустых скобок', !empty.q.includes('()'), empty.q);

  const blank = Q.buildQuery({ query: 'x', domains: ['', '   ', 'ok.example'] });
  check('пустые записи профиля отбрасываются', blank.used.length === 1, JSON.stringify(blank.used));
}

/* ============ 5. АДРЕСА ============ */
{
  const u = Q.searxUrl('https://searx.internal', 'lockbit (site:a.com)', 'week', 'ru');
  check('SearXNG: путь /search', u.startsWith('https://searx.internal/search?'), u);
  check('SearXNG: запрос закодирован', u.includes('q=lockbit+%28site%3Aa.com%29'), u);
  check('SearXNG: период передан', u.includes('time_range=week'));
  check('SearXNG: язык передан', u.includes('language=ru'));
  /* Подпуть базы терять нельзя. В политике по умолчанию стоит
   * https://ti.example.ru/searx — SearXNG за обратным прокси рядом
   * с остальным. Ведущая косая в '/search' делала путь абсолютным,
   * и запрос уходил на https://ti.example.ru/search, то есть в 404.
   * Дефект был бы виден только на их настоящем развёртывании. */
  const sub = Q.searxUrl('https://ti.example.ru/searx', 'x', '', '');
  check('SearXNG: подпуть базы сохраняется',
        sub === 'https://ti.example.ru/searx/search?q=x&safesearch=0', sub);
  const slash = Q.searxUrl('https://ti.example.ru/searx/', 'x', '', '');
  check('SearXNG: лишняя косая в базе не удваивается',
        slash === 'https://ti.example.ru/searx/search?q=x&safesearch=0', slash);
  const root = Q.searxUrl('https://searx.internal', 'x', '', '');
  check('SearXNG: база без пути работает как раньше',
        root === 'https://searx.internal/search?q=x&safesearch=0', root);

  const d = Q.directUrl('lockbit (site:a.com)', 'week');
  check('DDG: адрес', d.startsWith('https://duckduckgo.com/?q='), d);
  check('DDG: период переведён в df=w', d.endsWith('&df=w'), d);
  check('DDG: без периода нет df', !Q.directUrl('x', '').includes('df='));
  check('DDG: неизвестный период не ломает', !Q.directUrl('x', 'век').includes('df='));
}

/* ------------------------- свёрнутые дубли домена называются вслух ----- */
{
  /* Десять записей github.com/<репозиторий> дают ОДИН site:github.com,
   * а в списке профиля значатся как десять площадок. Молчаливое
   * отбрасывание здесь — это завышенное представление об охвате. */
  const r = Q.buildQuery({
    query: 'sigma',
    domains: ['github.com/SigmaHQ/sigma', 'github.com/elastic/detection-rules',
              'github.com/Neo23x0', 'attack.mitre.org'],
    limit: 8,
  });
  check('дубли домена свёрнуты в один site:',
        r.used.slice().sort().join() === 'attack.mitre.org,github.com', r.used.join());
  check('О СВЁРНУТЫХ СКАЗАНО', r.warnings.some((w) => /свернулись/.test(w)),
        JSON.stringify(r.warnings));
  check('в предупреждении названы конкретные записи',
        r.warnings.some((w) => w.includes('github.com/elastic/detection-rules')));

  const чисто = Q.buildQuery({ query: 'x', domains: ['a.example', 'b.example'], limit: 8 });
  check('без дублей предупреждения нет', !чисто.warnings.some((w) => /свернулись/.test(w)));
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
