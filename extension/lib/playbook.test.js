/* Проверка планирования плейбуков. Запуск:
 *   node extension/lib/playbook.test.js
 *
 * Главное здесь — TLP-гейт. Плейбук не должен становиться способом
 * отправить клиентский индикатор в публичный сервис в обход фильтра:
 * если бы гейт применялся только к дереву инструментов, достаточно
 * было бы завести плейбук, чтобы его обойти.
 */
'use strict';
const P = require('./playbook.js');
const REGISTRY = require('../data/tools.json');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : '')); }
}

/* Маленький искусственный реестр: поведение планировщика проверяется
 * на нём, а не на настоящем, чтобы тесты не падали при каждом
 * добавлении инструмента. Настоящий реестр проверяется отдельно. */
const TOOLS = [
  { id: 'pub-a',  name: 'Публичный A',  types: ['domain'],       exposure: 'public' },
  { id: 'pub-b',  name: 'Публичный B',  types: ['domain', 'url'], exposure: 'public' },
  { id: 'lim-a',  name: 'Лимитированный', types: ['domain'],     exposure: 'limited' },
  { id: 'ip-only', name: 'Только IP',   types: ['ipv4'],         exposure: 'limited' },
];

/* ------------------------------------------------- 1. порядок шагов ---- */
{
  const pb = { id: 'x', name: 'X', types: ['domain'], steps: ['lim-a', 'pub-a', 'pub-b'] };
  const { steps } = P.planPlaybook(pb, TOOLS, 'domain', 'public');
  check('порядок шагов сохраняется',
        steps.map((s) => s.id).join(',') === 'lim-a,pub-a,pub-b',
        steps.map((s) => s.id).join(','));
  // Порядок — это содержание плейбука. Пересортировка (например,
  // по exposure, как в дереве) сломала бы его смысл: там сначала
  // дешёвое и быстрое, потом расходующее квоту.
}

/* ---------------------------------------------------- 2. TLP-гейт ------ */
{
  const pb = { id: 'x', name: 'X', types: ['domain'], steps: ['lim-a', 'pub-a', 'pub-b'] };
  const r = P.planPlaybook(pb, TOOLS, 'domain', 'client');
  check('в режиме клиентских данных публичные отброшены',
        r.steps.map((s) => s.id).join(',') === 'lim-a', r.steps.map((s) => s.id).join(','));
  check('отброшенные перечислены с причиной', r.skipped.length === 2);
  check('причина названа режимом данных',
        r.skipped.every((s) => s.why === P.PB_SKIP.TLP), JSON.stringify(r.skipped));

  // Плейбук целиком из публичных сервисов в клиентском режиме пуст.
  // Это правильное поведение, а не ошибка, — но интерфейс обязан
  // показать такой плейбук недоступным, а не дать нажать впустую.
  const allPub = { id: 'y', name: 'Y', types: ['domain'], steps: ['pub-a', 'pub-b'] };
  check('плейбук из одних публичных в клиентском режиме пуст',
        P.planPlaybook(allPub, TOOLS, 'domain', 'client').steps.length === 0);
  check('он же в публичном режиме полон',
        P.planPlaybook(allPub, TOOLS, 'domain', 'public').steps.length === 2);
}

/* ------------------------------------------- 3. несоответствие типа ---- */
{
  const pb = { id: 'x', name: 'X', types: ['domain'], steps: ['pub-a', 'ip-only'] };
  const r = P.planPlaybook(pb, TOOLS, 'domain', 'public');
  check('шаг чужого типа отброшен', r.steps.length === 1);
  check('причина — тип', r.skipped[0].why === P.PB_SKIP.TYPE, JSON.stringify(r.skipped));
}

/* ------------------------------------------ 4. отсутствующий инструмент */
{
  const pb = { id: 'x', name: 'X', types: ['domain'], steps: ['pub-a', 'нет-такого'] };
  const r = P.planPlaybook(pb, TOOLS, 'domain', 'public');
  check('несуществующий шаг не роняет планирование', r.steps.length === 1);
  check('причина — нет в реестре', r.skipped[0].why === P.PB_SKIP.MISSING);
}

/* ------------------------------------------------- 5. подбор по типу --- */
{
  const pbs = [
    { id: 'a', name: 'A', types: ['domain'], steps: [] },
    { id: 'b', name: 'B', types: ['ipv4'], steps: [] },
    { id: 'c', name: 'C', types: ['domain', 'url'], steps: [] },
  ];
  check('подбор по одному типу',
        P.playbooksFor(pbs, new Set(['domain'])).map((p) => p.id).join(',') === 'a,c');
  check('подбор по нескольким типам',
        P.playbooksFor(pbs, new Set(['ipv4', 'url'])).map((p) => p.id).join(',') === 'b,c');
  check('нет подходящих — пустой список',
        P.playbooksFor(pbs, new Set(['sha256'])).length === 0);
  check('пустой список плейбуков не роняет', P.playbooksFor(undefined, new Set(['domain'])).length === 0);
}

/* ------------------------------------- 6. целостность НАСТОЯЩЕГО реестра */
{
  const problems = P.validatePlaybooks(REGISTRY);
  /* Шаг, ссылающийся на несуществующий инструмент, молча выпадает
   * при выполнении: проверка, которую аналитик считает сделанной,
   * не делается, и в отчёте это никак не отражается. */
  const errors = problems.filter((p) => !p.startsWith('ПРЕДУПРЕЖДЕНИЕ'));
  check('в реестре нет битых шагов', errors.length === 0, errors.join('\n        '));

  check('плейбуки в реестре есть', (REGISTRY.playbooks || []).length > 0);
  for (const pb of REGISTRY.playbooks || []) {
    check(`«${pb.name}» работает хотя бы для одного типа`,
          pb.types.some((t) => P.planPlaybook(pb, REGISTRY.tools, t, 'public').steps.length > 0),
          `ни один шаг не выполняется ни для одного из типов ${pb.types.join(', ')}`);
  }

  // Предупреждения печатаем, но не валим ими сборку: плейбук, пустой
  // в клиентском режиме, — это осознанное следствие TLP-гейта.
  const warns = problems.filter((p) => p.startsWith('ПРЕДУПРЕЖДЕНИЕ'));
  if (warns.length) console.log('\n  ' + warns.join('\n  '));
}

console.log(`\n  Пройдено: ${pass}   Провалено: ${fail}\n`);
process.exit(fail ? 1 : 0);
